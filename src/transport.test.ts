// transport.test.ts — transport layer unit tests.
// Tests sendChunk (fetch injection), chunkEvents (count/byte caps), backoffMs,
// buildEndpointUrl, sendBeacon, flushOnUnload.
// Runs in jsdom via vitest.config.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  sendChunk,
  chunkEvents,
  backoffMs,
  buildEndpointUrl,
  sendBeacon,
  flushOnUnload,
} from "./transport.js";
import { assembleBatch } from "./batch.js";
import { MAX_BATCH_EVENTS, MAX_BATCH_BYTES, BEACON_MAX_BYTES } from "./constants.js";
import type { BufferedEvent, BatchContext } from "./types.js";

function makeContext(): BatchContext {
  return { platform: "web", environment: "test", sdkVersion: "0.0.0-dev" };
}

function makeEvent(id: string, eventName: string = "track"): BufferedEvent {
  return {
    client_event_id: id,
    event: eventName,
    occurred_at: new Date(Date.now() - 1000).toISOString(),
    distinct_id: "anon-test",
  };
}

function makeFetch(status: number, body: object = {}, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  });
}

// ── sendChunk — happy path ────────────────────────────────────────────────────

describe("sendChunk — 200 ok", () => {
  it("returns status 'ok' with accepted ids set equal to all sent event ids", async () => {
    const events = [makeEvent("id-1"), makeEvent("id-2")];
    const fetchFn = makeFetch(200, { accepted: 2, rejected: [] });
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      events,
      fetchFn,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.acceptedIds).toEqual(new Set(["id-1", "id-2"]));
      expect(result.rejected).toHaveLength(0);
    }
  });

  it("returns rejected list from response body", async () => {
    const events = [makeEvent("id-1"), makeEvent("id-2")];
    const fetchFn = makeFetch(200, {
      accepted: 1,
      rejected: [{ index: 1, code: "invalid_event" }],
    });
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      events,
      fetchFn,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.code).toBe("invalid_event");
    }
  });

  it("200 with malformed body: treats as ok with all ids accepted", async () => {
    const events = [makeEvent("id-1")];
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new Error("bad json")),
    });
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      events,
      fetchFn,
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.acceptedIds.has("id-1")).toBe(true);
    }
  });
});

// ── sendChunk — 4xx responses ─────────────────────────────────────────────────

describe("sendChunk — 400 drop", () => {
  it("returns status 'drop' on 400", async () => {
    const fetchFn = makeFetch(400);
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("drop");
  });
});

describe("sendChunk — 404 disable", () => {
  it("returns status 'disable' on 404", async () => {
    const fetchFn = makeFetch(404);
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("disable");
  });
});

describe("sendChunk — 413 split", () => {
  it("returns status 'split' on 413", async () => {
    const fetchFn = makeFetch(413);
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1"), makeEvent("id-2")],
      fetchFn,
    );
    expect(result.status).toBe("split");
  });
});

describe("sendChunk — 429 retry", () => {
  it("returns status 'retry' on 429", async () => {
    const fetchFn = makeFetch(429, {}, { "Retry-After": "30" });
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
  });

  it("parses Retry-After header into retryAfterMs", async () => {
    const fetchFn = makeFetch(429, {}, { "Retry-After": "30" });
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
    if (result.status === "retry") {
      expect(result.retryAfterMs).toBe(30_000);
    }
  });

  it("uses 60s fallback when Retry-After is absent", async () => {
    const fetchFn = makeFetch(429, {});
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
    if (result.status === "retry") {
      expect(result.retryAfterMs).toBe(60_000);
    }
  });
});

describe("sendChunk — 500 retry", () => {
  it("returns status 'retry' on 500", async () => {
    const fetchFn = makeFetch(500);
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
  });

  it("returns status 'retry' for unexpected status codes (e.g. 503)", async () => {
    const fetchFn = makeFetch(503);
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
  });
});

describe("sendChunk — network error (fetch throws)", () => {
  it("returns status 'retry' when fetch throws (network error)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("network failure"));
    const result = await sendChunk(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      fetchFn,
    );
    expect(result.status).toBe("retry");
  });
});

// ── chunkEvents — count cap ───────────────────────────────────────────────────

describe("chunkEvents — count cap (≤100 events per chunk)", () => {
  it("returns a single chunk when events ≤ MAX_BATCH_EVENTS (100)", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS }, (_, i) => makeEvent(`id-${i}`));
    const chunks = chunkEvents(events, makeContext());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(MAX_BATCH_EVENTS);
  });

  it("splits into 2 chunks for 101 events", () => {
    const events = Array.from({ length: MAX_BATCH_EVENTS + 1 }, (_, i) => makeEvent(`id-${i}`));
    const chunks = chunkEvents(events, makeContext());
    expect(chunks).toHaveLength(2);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    expect(total).toBe(MAX_BATCH_EVENTS + 1);
  });

  it("each chunk has at most MAX_BATCH_EVENTS events", () => {
    const events = Array.from({ length: 250 }, (_, i) => makeEvent(`id-${i}`));
    const chunks = chunkEvents(events, makeContext());
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
    }
  });

  it("returns an empty array for no events", () => {
    expect(chunkEvents([], makeContext())).toHaveLength(0);
  });
});

describe("chunkEvents — byte cap (~900 KB per chunk)", () => {
  it("splits events when total envelope byte size would exceed MAX_BATCH_BYTES", () => {
    // Each event is ~150 bytes; 7000 events ≈ 1.05 MB total.
    // We want to test chunking at the byte level with fewer, larger events.
    const largeEvent = (): BufferedEvent => ({
      client_event_id: "x".repeat(36),
      event: "track",
      occurred_at: new Date().toISOString(),
      distinct_id: "anon-test",
      properties: { value: "y".repeat(9000) }, // ~9KB per event
    });
    // 110 large events → far exceeds the 900KB cap, so chunking by byte is expected
    const events = Array.from({ length: 110 }, () => largeEvent());
    const chunks = chunkEvents(events, makeContext());
    // Must have produced more than 1 chunk
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk's serialized envelope must fit within MAX_BATCH_BYTES
    for (const chunk of chunks) {
      const envelope = assembleBatch(makeContext(), chunk);
      const size = JSON.stringify(envelope).length;
      expect(size).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it("preserves all events across all chunks (no event lost or duplicated)", () => {
    const events = Array.from({ length: 200 }, (_, i) => makeEvent(`id-${i}`));
    const chunks = chunkEvents(events, makeContext());
    const allIds = chunks.flat().map((e) => e.client_event_id);
    expect(allIds).toHaveLength(200);
    expect(new Set(allIds).size).toBe(200); // no duplicates
  });
});

// ── backoffMs ─────────────────────────────────────────────────────────────────

describe("backoffMs — exponential backoff with jitter", () => {
  it("returns a non-negative value", () => {
    for (let i = 0; i < 5; i++) {
      expect(backoffMs(i)).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns a value not exceeding MAX_BACKOFF_MS (60_000)", () => {
    for (let i = 0; i < 10; i++) {
      expect(backoffMs(i)).toBeLessThanOrEqual(60_000);
    }
  });

  it("increases (on average) with retry count", () => {
    // With full jitter, exact ordering isn't guaranteed on a single sample,
    // so run multiple times and verify the max seen at attempt=5 > max seen at attempt=0.
    const samples0 = Array.from({ length: 20 }, () => backoffMs(0));
    const samples5 = Array.from({ length: 20 }, () => backoffMs(5));
    expect(Math.max(...samples5)).toBeGreaterThan(Math.max(...samples0));
  });
});

// ── buildEndpointUrl ──────────────────────────────────────────────────────────

describe("buildEndpointUrl", () => {
  it("constructs the expected URL from host + sdkKey", () => {
    expect(buildEndpointUrl("https://example.com", "pk_abc123")).toBe(
      "https://example.com/api/telemetry/pk_abc123",
    );
  });

  it("strips trailing slash from host before appending path", () => {
    expect(buildEndpointUrl("https://example.com/", "pk_abc123")).toBe(
      "https://example.com/api/telemetry/pk_abc123",
    );
  });
});

// ── sendBeacon ───────────────────────────────────────────────────────────────

describe("sendBeacon — browser beacon path", () => {
  beforeEach(() => {
    // jsdom doesn't have sendBeacon by default; we stub it
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: vi.fn().mockReturnValue(true),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when navigator.sendBeacon returns true", () => {
    const result = sendBeacon("https://example.com/api/telemetry/pk_test", "{}");
    expect(result).toBe(true);
  });

  it("calls navigator.sendBeacon with a Blob containing the body", () => {
    sendBeacon("https://example.com/api/telemetry/pk_test", '{"events":[]}');
    const mockSendBeacon = vi.mocked(navigator.sendBeacon);
    expect(mockSendBeacon).toHaveBeenCalledOnce();
    const [_url, blob] = mockSendBeacon.mock.calls[0] as [string, Blob];
    expect(blob).toBeInstanceOf(Blob);
  });

  it("returns false when navigator.sendBeacon returns false", () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: vi.fn().mockReturnValue(false),
    });
    const result = sendBeacon("https://example.com/api/telemetry/pk_test", "{}");
    expect(result).toBe(false);
  });

  it(`returns false when payload exceeds BEACON_MAX_BYTES (${BEACON_MAX_BYTES})`, () => {
    // BEACON_MAX_BYTES is 50_000; a 60_000 byte body should return false WITHOUT calling sendBeacon
    const bigBody = "x".repeat(BEACON_MAX_BYTES + 1);
    const mockSendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: mockSendBeacon });
    const result = sendBeacon("https://example.com/api/telemetry/pk_test", bigBody);
    expect(result).toBe(false);
    expect(mockSendBeacon).not.toHaveBeenCalled();
  });

  it("returns false when navigator is absent (SSR-like)", () => {
    vi.stubGlobal("navigator", undefined);
    const result = sendBeacon("https://example.com/api/telemetry/pk_test", "{}");
    expect(result).toBe(false);
  });
});

// ── flushOnUnload — beacon-first, fallback to fetch keepalive ─────────────────

describe("flushOnUnload — sendBeacon path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls onBeaconSuccess with the event ids when sendBeacon returns true", () => {
    const mockBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: mockBeacon });
    const onBeaconSuccess = vi.fn();
    const events = [makeEvent("id-1"), makeEvent("id-2")];
    flushOnUnload(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      events,
      onBeaconSuccess,
    );
    expect(onBeaconSuccess).toHaveBeenCalledOnce();
    const [ids] = onBeaconSuccess.mock.calls[0] as [Set<string>];
    expect(ids).toEqual(new Set(["id-1", "id-2"]));
  });

  it("falls back to fetch keepalive when sendBeacon returns false", () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      sendBeacon: vi.fn().mockReturnValue(false),
    });
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    const onBeaconSuccess = vi.fn();
    flushOnUnload(
      "https://example.com/api/telemetry/pk_test",
      makeContext(),
      [makeEvent("id-1")],
      onBeaconSuccess,
    );
    expect(mockFetch).toHaveBeenCalledOnce();
    // onBeaconSuccess is NOT called on keepalive path (fetch is fire-and-forget)
    expect(onBeaconSuccess).not.toHaveBeenCalled();
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.keepalive).toBe(true);
  });

  it("does nothing when the event chunk is empty", () => {
    const mockBeacon = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: mockBeacon });
    const onBeaconSuccess = vi.fn();
    flushOnUnload("https://example.com/api/telemetry/pk_test", makeContext(), [], onBeaconSuccess);
    expect(mockBeacon).not.toHaveBeenCalled();
    expect(onBeaconSuccess).not.toHaveBeenCalled();
  });
});
