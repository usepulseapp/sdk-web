// transport.ts — HTTP transport layer: fetch + sendBeacon + retry policy.
//
// Retry policy (from the ingest route — the reliability spec):
//   200 {accepted, rejected}  → remove ONLY the sent chunk's ids from buffer.
//   400 / 404                 → DROP (permanent client error). 404 also disables SDK.
//   413                       → split-and-retry: halve the chunk; drop irreducible singles.
//   429 (Retry-After header)  → retry after delay; keep in buffer.
//   500 / network throw       → retry with exponential backoff + jitter; keep in buffer.
//
// sendBeacon path (unload only):
//   - Own byte cap (BEACON_MAX_BYTES) — Chrome silently drops above ~64 KB.
//   - Must check boolean return; fall back to fetch({keepalive: true}) on false.
//   - Beacon-sent events cleared optimistically (dedup via client_event_id covers
//     the rare double-send — telemetry is directional per the design spec).

import {
  MAX_BATCH_EVENTS,
  MAX_BATCH_BYTES,
  BEACON_MAX_BYTES,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_FLUSH_RETRIES,
} from "./constants.js";
import type { BufferedEvent, BatchContext } from "./types.js";
import { assembleBatch } from "./batch.js";

export type FlushResult =
  | { status: "ok"; acceptedIds: Set<string>; rejected: { index: number; code: string }[] }
  | { status: "drop"; reason: string }
  | { status: "disable"; reason: string }
  | { status: "split" }
  | { status: "retry"; retryAfterMs?: number }
  | { status: "error" };

/**
 * Send one chunk via fetch. Returns a FlushResult describing what the caller
 * should do. Does NOT mutate the buffer — caller owns that.
 */
export async function sendChunk(
  url: string,
  context: BatchContext,
  chunk: BufferedEvent[],
  fetchFn: typeof fetch = fetch,
): Promise<FlushResult> {
  const envelope = assembleBatch(context, chunk);
  const body = JSON.stringify(envelope);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch {
    return { status: "retry" };
  }

  if (response.status === 200) {
    let data: { accepted?: number; rejected?: { index: number; code: string }[] } = {};
    try {
      data = (await response.json()) as typeof data;
    } catch {
      // Malformed 200 body — treat accepted as all, rejected as none
    }
    const rejectedList = data.rejected ?? [];
    // Build the set of ids we sent so the caller removes exactly those
    const acceptedIds = new Set(chunk.map((e) => e.client_event_id));
    return { status: "ok", acceptedIds, rejected: rejectedList };
  }

  if (response.status === 400) {
    return { status: "drop", reason: "bad_envelope" };
  }

  if (response.status === 404) {
    return { status: "disable", reason: "unknown_sdk_key" };
  }

  if (response.status === 413) {
    return { status: "split" };
  }

  if (response.status === 429) {
    const retryAfterSec = parseFloat(response.headers.get("Retry-After") ?? "60");
    const retryAfterMs = isFinite(retryAfterSec) ? retryAfterSec * 1000 : 60_000;
    return { status: "retry", retryAfterMs };
  }

  // 500 or any unexpected status
  return { status: "retry" };
}

/**
 * Chunk an event array into batches that satisfy both count and byte caps.
 * Each returned chunk is safe to send as a single request body.
 */
export function chunkEvents(events: BufferedEvent[], context: BatchContext): BufferedEvent[][] {
  const chunks: BufferedEvent[][] = [];
  let current: BufferedEvent[] = [];

  for (const event of events) {
    const candidate = [...current, event];
    if (candidate.length > MAX_BATCH_EVENTS) {
      if (current.length > 0) chunks.push(current);
      current = [event];
      continue;
    }
    // Check byte size of the full envelope with this candidate set
    const envelope = assembleBatch(context, candidate);
    const size = JSON.stringify(envelope).length;
    if (size > MAX_BATCH_BYTES && current.length > 0) {
      chunks.push(current);
      current = [event];
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Compute exponential backoff with jitter (full-jitter strategy).
 * attempt: 0-based retry count.
 */
export function backoffMs(attempt: number): number {
  const exp = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
  return Math.random() * exp;
}

/**
 * Build the telemetry endpoint URL for a given sdkKey.
 */
export function buildEndpointUrl(apiHost: string, sdkKey: string): string {
  const base = apiHost.replace(/\/$/, "");
  return `${base}/api/telemetry/${sdkKey}`;
}

/**
 * Send a beacon (unload path). Returns true if the beacon was accepted by the
 * browser. Returns false and the caller must fall back to fetch keepalive.
 * Only used when navigator.sendBeacon is available AND the payload is under
 * BEACON_MAX_BYTES.
 */
export function sendBeacon(url: string, body: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") {
    return false;
  }
  const blob = new Blob([body], { type: "application/json" });
  if (blob.size > BEACON_MAX_BYTES) return false;
  return navigator.sendBeacon(url, blob);
}

/**
 * Flush one chunk on unload — try sendBeacon first, fall back to fetch keepalive.
 * Beacon-sent events are cleared optimistically; keepalive path handles its own
 * response but cannot await it on unload (fire-and-forget).
 */
export function flushOnUnload(
  url: string,
  context: BatchContext,
  chunk: BufferedEvent[],
  onBeaconSuccess: (ids: Set<string>) => void,
): void {
  if (chunk.length === 0) return;

  const envelope = assembleBatch(context, chunk);
  const body = JSON.stringify(envelope);

  const beaconOk = sendBeacon(url, body);
  if (beaconOk) {
    // Optimistic clear — client_event_id dedup protects against double-send
    onBeaconSuccess(new Set(chunk.map((e) => e.client_event_id)));
    return;
  }

  // Fall back to fetch keepalive (fire-and-forget on unload)
  if (typeof fetch === "function") {
    try {
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      });
    } catch {
      // swallow — unload path cannot recover
    }
  }
}
