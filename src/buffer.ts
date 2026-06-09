// buffer.ts — localStorage ring buffer for offline event storage.
// Caps by BOTH event count (maxEvents) and serialized bytes (MAX_BUFFER_BYTES).
// Drops the OLDEST events on overflow (ring-buffer semantics).
// All operations are safe to call in SSR — lsGet/lsSet no-op when !isBrowser().

import { LS_BUFFER, MAX_BUFFER_BYTES, DEFAULT_MAX_BUFFER_EVENTS } from "./constants.js";
import { lsGet, lsSet } from "./storage.js";
import type { BufferedEvent } from "./types.js";

/** Load the current buffer from localStorage. Returns [] on error or SSR. */
export function bufferLoad(): BufferedEvent[] {
  const raw = lsGet(LS_BUFFER);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as BufferedEvent[];
  } catch {
    return [];
  }
}

/** Persist the buffer to localStorage. */
function bufferSave(events: BufferedEvent[]): void {
  try {
    lsSet(LS_BUFFER, JSON.stringify(events));
  } catch {
    // Storage quota — swallow; events are in-memory until next flush
  }
}

/**
 * Append one event to the buffer, enforcing ring-buffer caps.
 * Drops oldest events when either the count cap or byte cap would be exceeded.
 */
export function bufferAppend(
  event: BufferedEvent,
  maxEvents: number = DEFAULT_MAX_BUFFER_EVENTS,
  debug: boolean = false,
): void {
  const events = bufferLoad();
  events.push(event);

  // Enforce count cap
  while (events.length > maxEvents) {
    const dropped = events.shift();
    if (debug && dropped)
      console.warn(
        `[Pulse] Buffer count cap (${maxEvents}) reached; dropped oldest event "${dropped.event}".`,
      );
  }

  // Enforce byte cap
  let serialized = JSON.stringify(events);
  while (serialized.length > MAX_BUFFER_BYTES && events.length > 0) {
    const dropped = events.shift();
    if (debug && dropped)
      console.warn(`[Pulse] Buffer byte cap reached; dropped oldest event "${dropped.event}".`);
    serialized = JSON.stringify(events);
  }

  bufferSave(events);
}

/**
 * Remove a specific set of events from the buffer by client_event_id.
 * Used after a successful flush to remove ONLY the acknowledged chunk —
 * events enqueued while the request was in-flight are preserved.
 */
export function bufferRemoveByIds(ids: Set<string>): void {
  const events = bufferLoad();
  const remaining = events.filter((e) => !ids.has(e.client_event_id));
  bufferSave(remaining);
}

/**
 * Replace the entire buffer (used after split-and-retry to re-enqueue halves).
 */
export function bufferReplaceAll(events: BufferedEvent[]): void {
  bufferSave(events);
}

/** Clear the entire buffer. */
export function bufferClear(): void {
  bufferSave([]);
}
