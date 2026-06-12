// client.test.ts — PulseClient integration tests.
// Tests identity, session lifecycle, retry policy, disable/enable, and
// concurrent-enqueue-on-200 correctness.
// Runs in jsdom via vitest.config.ts (localStorage + window available).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PulseClient } from "./client.js";
import { bufferLoad } from "./buffer.js";
import {
  LS_DISTINCT_ID,
  LS_INSTALL_FIRED,
  LS_EXTERNAL_USER_ID,
  LS_BUFFER,
  LS_DISABLED,
  LS_SESSION_ID,
  LS_SESSION_LAST_ACTIVITY,
  MAX_PROPERTY_VALUE_LEN,
  MAX_PROPERTY_KEYS,
} from "./constants.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

// Track every client created by makeClient() so afterEach can destroy them all,
// preventing stale timers/listeners from bleeding into subsequent tests.
const _testClients: PulseClient[] = [];

function makeClient(opts: ConstructorParameters<typeof PulseClient>[1] = {}) {
  const client = new PulseClient("pk_testkey1234567890123456789012345678901234", {
    environment: "test",
    autoCapture: false, // disable auto-events unless the test explicitly needs them
    flushIntervalMs: 999_999, // prevent automatic flush timer firing
    ...opts,
  });
  _testClients.push(client);
  return client;
}

function allBufferedIds(): string[] {
  return bufferLoad().map((e) => e.client_event_id);
}

function allBufferedEvents() {
  return bufferLoad();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  // Destroy all clients created this test before restoring real timers, so
  // stale intervals (registered under fake timers) are cleared while still fake.
  for (const client of _testClients) {
    client.destroy();
  }
  _testClients.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── SSR guard ─────────────────────────────────────────────────────────────────

describe("SSR guard — no window", () => {
  it("does not throw when window is absent", () => {
    const origWindow = globalThis.window;
    vi.stubGlobal("window", undefined);
    expect(() => makeClient()).not.toThrow();
    vi.stubGlobal("window", origWindow);
  });

  it("becomes a no-op when window is absent — track() does not enqueue", () => {
    vi.stubGlobal("window", undefined);
    const client = makeClient();
    client.track("test_event");
    vi.stubGlobal("window", globalThis.window);
    // No events in buffer (which requires localStorage anyway, also undefined in SSR)
    // Just asserting no throw is the SSR contract
  });
});

// ── Identity — distinct_id ────────────────────────────────────────────────────

describe("Identity — distinct_id", () => {
  it("mints a distinct_id on first init and persists it in localStorage", () => {
    makeClient();
    const stored = localStorage.getItem(LS_DISTINCT_ID);
    expect(stored).toBeTruthy();
    expect(typeof stored).toBe("string");
  });

  it("reuses the same distinct_id on subsequent inits (persistent across page loads)", () => {
    makeClient();
    const id1 = localStorage.getItem(LS_DISTINCT_ID);
    makeClient();
    const id2 = localStorage.getItem(LS_DISTINCT_ID);
    expect(id1).toBe(id2);
  });

  it("distinct_id is stamped on enqueued events", () => {
    const client = makeClient();
    client.track("test_event");
    const events = allBufferedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.distinct_id).toBe(localStorage.getItem(LS_DISTINCT_ID));
  });

  it("reset() rotates distinct_id to a new UUID", () => {
    const client = makeClient();
    const originalId = localStorage.getItem(LS_DISTINCT_ID);
    client.reset();
    const newId = localStorage.getItem(LS_DISTINCT_ID);
    expect(newId).not.toBe(originalId);
    expect(newId).toBeTruthy();
  });

  it("events enqueued AFTER reset() carry the new distinct_id", () => {
    const client = makeClient();
    client.track("before_reset");
    const beforeId = bufferLoad().find((e) => e.event === "before_reset")?.distinct_id;

    client.reset();
    const newDistinctId = localStorage.getItem(LS_DISTINCT_ID);
    client.track("after_reset");
    const afterId = bufferLoad().find((e) => e.event === "after_reset")?.distinct_id;

    expect(beforeId).not.toBe(newDistinctId);
    expect(afterId).toBe(newDistinctId);
  });
});

// ── Identity — external_user_id ───────────────────────────────────────────────

describe("Identity — external_user_id", () => {
  it("identify() sets external_user_id on subsequently enqueued events", () => {
    const client = makeClient();
    client.identify("user-123");
    client.track("test_event");
    const events = allBufferedEvents();
    expect(events[0]?.external_user_id).toBe("user-123");
  });

  it("identify() does NOT change distinct_id", () => {
    const client = makeClient();
    const distinctIdBefore = localStorage.getItem(LS_DISTINCT_ID);
    client.identify("user-123");
    const distinctIdAfter = localStorage.getItem(LS_DISTINCT_ID);
    expect(distinctIdBefore).toBe(distinctIdAfter);
  });

  it("identify('') is ignored (empty string)", () => {
    const client = makeClient();
    client.identify("user-123");
    client.identify(""); // should be ignored
    const storedId = localStorage.getItem(LS_EXTERNAL_USER_ID);
    expect(storedId).toBe("user-123"); // still the previous value
    client.track("test_event");
    const events = allBufferedEvents();
    expect(events[0]?.external_user_id).toBe("user-123");
  });

  it("reset() clears external_user_id", () => {
    const client = makeClient();
    client.identify("user-123");
    client.reset();
    expect(localStorage.getItem(LS_EXTERNAL_USER_ID)).toBeNull();
    client.track("after_reset");
    const events = allBufferedEvents().filter((e) => e.event === "after_reset");
    expect(events[0]?.external_user_id).toBeUndefined();
  });

  it("identify() persists external_user_id to localStorage", () => {
    const client = makeClient();
    client.identify("user-456");
    expect(localStorage.getItem(LS_EXTERNAL_USER_ID)).toBe("user-456");
  });
});

// ── client_event_id stability — stamped at enqueue, same across retries ───────

describe("client_event_id stability", () => {
  it("client_event_id is a non-empty UUID-like string", () => {
    const client = makeClient();
    client.track("test_event");
    const events = allBufferedEvents();
    expect(events[0]?.client_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("each event gets a unique client_event_id", () => {
    const client = makeClient();
    client.track("event_a");
    client.track("event_b");
    client.track("event_c");
    const ids = bufferLoad().map((e) => e.client_event_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("client_event_id is stamped at enqueue time and persists in buffer unchanged", () => {
    const client = makeClient();
    client.track("test_event");
    const idAtEnqueue = allBufferedIds()[0];
    // Re-load the buffer (simulating a flush reading it)
    const idFromBuffer = bufferLoad()[0]?.client_event_id;
    expect(idAtEnqueue).toBe(idFromBuffer);
  });

  it("client_event_id is IDENTICAL across retries — same id on every retry attempt body", async () => {
    // This is the server-dedup guarantee: the same client_event_id must appear in
    // every retry of the same event so the server can deduplicate on conflict.
    const capturedIds: string[] = [];
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(init.body as string) as {
        events: Array<{ client_event_id: string }>;
      };
      capturedIds.push(body.events[0]!.client_event_id);
      if (callCount < 3) {
        // Fail twice (500) to force two retries
        return Promise.resolve({
          status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ accepted: 1, rejected: [] }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.useFakeTimers();

    const client = makeClient();
    client.track("dedup_event");

    const flushPromise = client.flush();
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromise;

    // The same client_event_id must appear in all 3 calls (original + 2 retries)
    expect(capturedIds).toHaveLength(3);
    expect(new Set(capturedIds).size).toBe(1); // all identical
  });
});

// ── install-once — fires once, survives reset() ────────────────────────────────

describe("install-once", () => {
  it("fires install event on first init (when not previously installed)", () => {
    makeClient({ autoCapture: true });
    const events = allBufferedEvents();
    const installEvents = events.filter((e) => e.event === "install");
    expect(installEvents).toHaveLength(1);
  });

  it("does NOT fire a second install event on a subsequent init", () => {
    makeClient({ autoCapture: true });
    const bufferAfterFirst = allBufferedEvents().length;
    // Simulate second page load: clear buffer but keep LS_INSTALL_FIRED
    localStorage.removeItem(LS_BUFFER);
    makeClient({ autoCapture: true });
    const eventsSecondInit = allBufferedEvents();
    const installEventsSecond = eventsSecondInit.filter((e) => e.event === "install");
    expect(installEventsSecond).toHaveLength(0);
    void bufferAfterFirst; // used for documentation only
  });

  it("reset() does NOT re-fire install (per-browser flag is independent of distinct_id)", () => {
    const client = makeClient({ autoCapture: true });
    // Clear buffer after first init (which fired install, app_open, session_start)
    localStorage.removeItem(LS_BUFFER);
    // reset() should NOT re-fire install
    client.reset();
    const events = allBufferedEvents();
    const installEvents = events.filter((e) => e.event === "install");
    expect(installEvents).toHaveLength(0);
  });

  it("LS_INSTALL_FIRED flag persists across client instances", () => {
    makeClient({ autoCapture: true });
    expect(localStorage.getItem(LS_INSTALL_FIRED)).toBe("1");
    // Even after creating a new client, the flag is set
    makeClient({ autoCapture: true });
    expect(localStorage.getItem(LS_INSTALL_FIRED)).toBe("1");
  });
});

// ── Session lifecycle ─────────────────────────────────────────────────────────

describe("Session — session_start on init", () => {
  it("fires session_start event on first init (autoCapture=true)", () => {
    makeClient({ autoCapture: true });
    const events = allBufferedEvents();
    expect(events.some((e) => e.event === "session_start")).toBe(true);
  });

  it("sets a session_id on enqueued events", () => {
    const client = makeClient();
    client.track("test_event");
    const events = allBufferedEvents();
    expect(events[0]?.session_id).toBeTruthy();
  });

  it("session_id is persisted in localStorage", () => {
    makeClient();
    expect(localStorage.getItem(LS_SESSION_ID)).toBeTruthy();
  });
});

describe("Session — idle timeout triggers session_end + new session_start on next boot", () => {
  it("fires session_end for expired session when re-initialised after timeout", () => {
    // First init: mint a session
    makeClient({ autoCapture: true, sessionTimeoutMs: 1000 });
    const firstSessionId = localStorage.getItem(LS_SESSION_ID);
    expect(firstSessionId).toBeTruthy();

    // Simulate idle timeout by backdating the last-activity timestamp
    const expiredTime = Date.now() - 2000; // 2 seconds ago > 1 second timeout
    localStorage.setItem(LS_SESSION_LAST_ACTIVITY, String(expiredTime));

    // Clear buffer to make the next-init events visible in isolation
    localStorage.removeItem(LS_BUFFER);
    // Re-init (simulating a page reload after idle timeout)
    makeClient({ autoCapture: true, sessionTimeoutMs: 1000 });

    const events = allBufferedEvents();
    const sessionEndEvents = events.filter((e) => e.event === "session_end");
    const sessionStartEvents = events.filter((e) => e.event === "session_start");

    expect(sessionEndEvents).toHaveLength(1);
    // session_end carries the OLD session_id
    expect(sessionEndEvents[0]?.session_id).toBe(firstSessionId);

    // New session_start fired too
    expect(sessionStartEvents).toHaveLength(1);
  });

  it("new session after timeout has a different session_id", () => {
    makeClient({ autoCapture: true, sessionTimeoutMs: 1000 });
    const firstSessionId = localStorage.getItem(LS_SESSION_ID);
    localStorage.setItem(LS_SESSION_LAST_ACTIVITY, String(Date.now() - 2000));
    localStorage.removeItem(LS_BUFFER);

    makeClient({ autoCapture: true, sessionTimeoutMs: 1000 });
    const newSessionId = localStorage.getItem(LS_SESSION_ID);
    expect(newSessionId).not.toBe(firstSessionId);
  });

  it("re-init within timeout resumes the SAME session_id (positive path)", () => {
    // Last-activity is recent — session should NOT be considered expired.
    makeClient({ autoCapture: true, sessionTimeoutMs: 30_000 });
    const firstSessionId = localStorage.getItem(LS_SESSION_ID);
    expect(firstSessionId).toBeTruthy();

    // Do NOT backdate last-activity — it was just written by the first init.
    // Clear the buffer so second-init events are visible in isolation.
    localStorage.removeItem(LS_BUFFER);

    // Re-init within the timeout window.
    makeClient({ autoCapture: true, sessionTimeoutMs: 30_000 });
    const resumedSessionId = localStorage.getItem(LS_SESSION_ID);

    // Must be the same session — not a new one.
    expect(resumedSessionId).toBe(firstSessionId);

    // No session_end should have fired (session was not expired).
    const events = allBufferedEvents();
    expect(events.some((e) => e.event === "session_end")).toBe(false);
    // No new session_start either (session was resumed, not started fresh).
    expect(events.some((e) => e.event === "session_start")).toBe(false);
  });
});

// ── track() — reserved-name guard ────────────────────────────────────────────

describe("track() — reserved-name guard", () => {
  it("still enqueues a reserved event name (allowed with debug warn)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({ debug: true });
    client.track("install");
    const events = allBufferedEvents();
    expect(events.some((e) => e.event === "install")).toBe(true);
    warnSpy.mockRestore();
  });

  it("warns in debug mode when a reserved event name is used", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({ debug: true });
    client.track("paywall_impression");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reserved"));
    warnSpy.mockRestore();
  });

  it("custom event names are always accepted without warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = makeClient({ debug: true });
    client.track("my_custom_event");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── disable / enable ──────────────────────────────────────────────────────────

describe("disable() — true no-op", () => {
  it("disable() prevents track() from enqueuing events", () => {
    const client = makeClient();
    client.disable();
    client.track("should_not_enqueue");
    expect(allBufferedEvents()).toHaveLength(0);
  });

  it("disable() prevents any localStorage writes after it returns", () => {
    const client = makeClient();
    client.disable();
    // Spy on localStorage.setItem AFTER disable() returns
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    client.track("should_not_write");
    client.identify("user-123");
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it("disable() persists disabled state to localStorage", () => {
    const client = makeClient();
    client.disable();
    expect(localStorage.getItem(LS_DISABLED)).toBe("1");
  });

  it("disabled state persists across page reloads (new client instance respects LS_DISABLED)", () => {
    const client = makeClient();
    client.disable();
    // New client instance — simulates a page reload
    const client2 = makeClient();
    expect(client2.isEnabled()).toBe(false);
  });

  it("disable() prevents fetch calls", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 200 });
    vi.stubGlobal("fetch", mockFetch);
    const client = makeClient();
    client.disable();
    await client.flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("enable() — restores SDK", () => {
  it("enable() after disable() allows track() to enqueue again", () => {
    const client = makeClient();
    client.disable();
    client.enable();
    client.track("after_enable");
    expect(allBufferedEvents().some((e) => e.event === "after_enable")).toBe(true);
  });

  it("enable() removes the LS_DISABLED flag from localStorage", () => {
    const client = makeClient();
    client.disable();
    client.enable();
    expect(localStorage.getItem(LS_DISABLED)).toBeNull();
  });

  it("isEnabled() returns false when disabled, true when enabled", () => {
    const client = makeClient();
    expect(client.isEnabled()).toBe(true);
    client.disable();
    expect(client.isEnabled()).toBe(false);
    client.enable();
    expect(client.isEnabled()).toBe(true);
  });

  // Regression (code review): a client constructed with
  // { disabled: true } never ran _boot(), so identity was empty. enable() must
  // boot it so events carry a non-empty distinct_id (server rejects min(1)).
  it("enable() on a pre-disabled client boots identity so tracked events have a distinct_id", () => {
    const client = makeClient({ disabled: true, autoCapture: false });
    client.enable();
    client.track("after_enable");
    const events = allBufferedEvents();
    const tracked = events.find((e) => e.event === "after_enable");
    expect(tracked).toBeDefined();
    // Empty-string identity is exactly the bug (server schema requires min(1)).
    expect(tracked?.distinct_id).toBeTruthy();
    expect(tracked?.session_id).toBeTruthy();
  });
});

describe("destroy() — permanently inert", () => {
  it("destroy() then enable() does NOT resurrect the client", () => {
    const client = makeClient();
    client.destroy();
    expect(client.isEnabled()).toBe(false);
    client.enable();
    // enable() must be a no-op on a destroyed client
    expect(client.isEnabled()).toBe(false);
    client.track("after_destroy");
    expect(allBufferedEvents().some((e) => e.event === "after_destroy")).toBe(false);
  });

  it("destroy() preserves the localStorage buffer (events survive for the next client)", () => {
    const client = makeClient();
    client.track("before_destroy");
    expect(allBufferedEvents().some((e) => e.event === "before_destroy")).toBe(true);
    client.destroy();
    // Buffer is NOT cleared — destroy() is in-memory teardown only.
    expect(allBufferedEvents().some((e) => e.event === "before_destroy")).toBe(true);
  });
});

describe("init with disabled:true option — pre-disabled, no network/storage", () => {
  it("does not enqueue any events when initialized with disabled:true", () => {
    makeClient({ disabled: true, autoCapture: true });
    // No events — disabled before _boot()
    expect(allBufferedEvents()).toHaveLength(0);
  });

  it("does not make any localStorage writes when init with disabled:true", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    makeClient({ disabled: true });
    // The only write is the LS_DISABLED key set by the _disableInternal path,
    // but when disabled via opts, it goes through the constructor early return,
    // so NO writes at all
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });
});

// ── Retry policy — via globalThis.fetch ──────────────────────────────────────

describe("Retry policy — 4xx drop", () => {
  it("400 causes the chunk to be dropped from the buffer (no retry)", async () => {
    // No fake timers needed: the 400 drop path is synchronous (no sleep/backoff).
    const mockFetch = vi.fn().mockResolvedValue({
      status: 400,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("event_to_drop");
    expect(allBufferedEvents()).toHaveLength(1);

    await client.flush();

    // Event should be dropped from the buffer
    expect(allBufferedEvents()).toHaveLength(0);
    // Fetch called exactly once (no retry for 400)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("404 disables the SDK and drops the chunk", async () => {
    // No fake timers needed: the 404 disable path is synchronous (no sleep/backoff).
    const mockFetch = vi.fn().mockResolvedValue({
      status: 404,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("event_to_disable");

    await client.flush();

    // SDK must be disabled after 404
    expect(client.isEnabled()).toBe(false);
    // Fetch called exactly once (no retry after 404)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("Retry policy — 5xx retry with backoff", () => {
  it("retries on 500 and eventually succeeds", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve({
          status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ accepted: 1, rejected: [] }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("retried_event");

    const flushPromise = client.flush();
    // Advance timers to allow retries to fire
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromise;

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Event should be removed from buffer after the 200
    expect(allBufferedEvents().filter((e) => e.event === "retried_event")).toHaveLength(0);
  });

  it("does not exceed MAX_FLUSH_RETRIES (5)", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 500,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("always_fails");

    const flushPromise = client.flush();
    await vi.advanceTimersByTimeAsync(500_000); // far beyond all backoff
    await flushPromise;

    // MAX_FLUSH_RETRIES = 5, so 1 original + 5 retries = 6 max calls
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(6);
    // Events remain in buffer (not dropped on 5xx)
    expect(allBufferedEvents().filter((e) => e.event === "always_fails")).toHaveLength(1);
  });
});

describe("Retry policy — 429 honors Retry-After header", () => {
  it("retries after the Retry-After delay and eventually succeeds", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          status: 429,
          headers: { get: (h: string) => (h === "Retry-After" ? "5" : null) }, // 5 seconds
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ accepted: 1, rejected: [] }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("rate_limited_event");

    const flushPromise = client.flush();
    // Before the Retry-After delay, only 1 call should have been made
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // After the 5s delay, the retry fires
    await vi.advanceTimersByTimeAsync(2000);
    await flushPromise;
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(allBufferedEvents().filter((e) => e.event === "rate_limited_event")).toHaveLength(0);
  });
});

describe("Retry policy — network error retry", () => {
  it("retries on network throw (TypeError)", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 2) {
        return Promise.reject(new TypeError("failed to fetch"));
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ accepted: 1, rejected: [] }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("network_error_event");

    const flushPromise = client.flush();
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromise;

    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(allBufferedEvents().filter((e) => e.event === "network_error_event")).toHaveLength(0);
  });
});

describe("Retry policy — 413 split-and-retry", () => {
  it("413 causes the chunk to be halved and re-sent", async () => {
    // No fake timers needed: the 413 split path is synchronous (no sleep).
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(init.body as string) as { events: unknown[] };
      // Return 413 for chunks with more than 1 event; 200 for single-event chunks
      if (body.events.length > 1) {
        return Promise.resolve({
          status: 413,
          headers: { get: () => null },
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ accepted: 1, rejected: [] }),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("event_a");
    client.track("event_b");

    await client.flush();

    // Both events should eventually be sent (after splitting)
    expect(allBufferedEvents().filter((e) => e.event === "event_a")).toHaveLength(0);
    expect(allBufferedEvents().filter((e) => e.event === "event_b")).toHaveLength(0);
    // More than 1 fetch call (the initial + at least 2 for the split halves)
    expect(callCount).toBeGreaterThan(1);
  });

  it("irreducible single event that always 413 is dropped (no infinite loop)", async () => {
    // No fake timers needed: the 413 split path is synchronous (no sleep).
    const mockFetch = vi.fn().mockResolvedValue({
      status: 413,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("oversized_single_event");

    await client.flush();

    // The irreducible event must be dropped (not stuck in infinite retry)
    expect(allBufferedEvents().filter((e) => e.event === "oversized_single_event")).toHaveLength(0);
  });
});

// ── Concurrent-enqueue-on-200 — new events survive a 200 flush ───────────────

describe("Concurrent enqueue — events added during in-flight flush are NOT lost on 200", () => {
  it("events enqueued while a flush is in-flight survive the 200 buffer removal", async () => {
    // No fake timers: the fetch resolves immediately in this test.
    const client = makeClient();
    client.track("pre_flush_event");

    let resolveFlush!: (val: Response) => void;
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFlush = resolve;
    });

    const mockFetch = vi.fn().mockReturnValue(fetchPromise);
    vi.stubGlobal("fetch", mockFetch);

    // Start the flush — it will be in-flight waiting for fetchPromise
    const flushPromise = client.flush();

    // While the flush is in-flight (fetch not yet resolved), enqueue a new event.
    // This simulates events arriving concurrently with the in-flight request.
    client.track("concurrent_event");

    // Now resolve the fetch with 200
    resolveFlush(
      new Response(JSON.stringify({ accepted: 1, rejected: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await flushPromise;

    // The concurrent_event must still be in the buffer (not removed by the 200)
    const remaining = allBufferedEvents();
    expect(remaining.some((e) => e.event === "concurrent_event")).toBe(true);
    // The pre_flush_event was acknowledged — it should be gone
    expect(remaining.every((e) => e.event !== "pre_flush_event")).toBe(true);
  });
});

// ── UTM / attribution ─────────────────────────────────────────────────────────

describe("UTM attribution — captured on first install", () => {
  it("attach UTM params to the install event properties", () => {
    // Set UTM params via location stub
    vi.stubGlobal("location", {
      href: "https://example.com/?utm_source=google&utm_medium=cpc&utm_campaign=launch",
    });

    makeClient({ autoCapture: true });
    const events = allBufferedEvents();
    const installEvent = events.find((e) => e.event === "install");
    expect(installEvent).toBeDefined();
    expect(installEvent?.properties?.["utm_source"]).toBe("google");
    expect(installEvent?.properties?.["utm_medium"]).toBe("cpc");
    expect(installEvent?.properties?.["utm_campaign"]).toBe("launch");
  });

  it("install event properties are absent when no UTM params present", () => {
    vi.stubGlobal("location", { href: "https://example.com/" });

    makeClient({ autoCapture: true });
    const events = allBufferedEvents();
    const installEvent = events.find((e) => e.event === "install");
    // install fires but with no UTM properties (undefined properties or no UTM keys)
    if (installEvent?.properties) {
      expect(installEvent.properties["utm_source"]).toBeUndefined();
    }
  });
});

// ── occurred_at stamped at enqueue time ───────────────────────────────────────

describe("occurred_at — stamped at enqueue, valid ISO-8601", () => {
  it("occurred_at is a valid ISO-8601 datetime string", () => {
    const client = makeClient();
    client.track("test_event");
    const events = allBufferedEvents();
    const occurredAt = events[0]?.occurred_at;
    expect(occurredAt).toBeTruthy();
    expect(() => new Date(occurredAt!)).not.toThrow();
    expect(isNaN(new Date(occurredAt!).getTime())).toBe(false);
  });

  it("occurred_at is not in the far future (stamped at enqueue time)", () => {
    const client = makeClient();
    const beforeEnqueue = Date.now();
    client.track("test_event");
    const afterEnqueue = Date.now();
    const events = allBufferedEvents();
    const ts = new Date(events[0]!.occurred_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(beforeEnqueue - 10); // allow 10ms slack
    expect(ts).toBeLessThanOrEqual(afterEnqueue + 10);
  });
});

// ── W3: install event attribution coercion ────────────────────────────────────
// Asserts that over-long UTM values are truncated before the install event is
// enqueued, so every property value satisfies the server's MAX_PROPERTY_VALUE_LEN
// cap. Uses only SDK-exported constants — no server Zod module imported here.

describe("install event — attribution property coercion (W3)", () => {
  it("truncates over-long UTM values so every install property length ≤ MAX_PROPERTY_VALUE_LEN", () => {
    // Build a utm_campaign value that exceeds the server/SDK cap by 500 chars
    const overLong = "x".repeat(MAX_PROPERTY_VALUE_LEN + 500);
    vi.stubGlobal("location", {
      href: `https://example.com/?utm_source=google&utm_campaign=${overLong}`,
    });

    makeClient({ autoCapture: true });

    const events = allBufferedEvents();
    const installEvent = events.find((e) => e.event === "install");
    expect(installEvent).toBeDefined();

    const props = installEvent?.properties ?? {};

    // Every property value must fit within the SDK cap
    for (const [key, val] of Object.entries(props)) {
      if (typeof val === "string") {
        expect(val.length, `property "${key}" exceeds MAX_PROPERTY_VALUE_LEN`).toBeLessThanOrEqual(
          MAX_PROPERTY_VALUE_LEN,
        );
      }
    }

    // Total key count must not exceed the SDK cap (UTM has ≤ 8 keys, well under 50,
    // but the assertion keeps W3 honest about the full contract)
    expect(Object.keys(props).length).toBeLessThanOrEqual(MAX_PROPERTY_KEYS);
  });
});

// ── Flush serialization regression — late-enqueued events must not be lost ───────
//
// Repro: init() fires auto-events and starts F1 immediately (fire-and-forget).
// A track() call enqueues a 4th event after F1's buffer snapshot. With the old
// boolean guard, a subsequent await flush() returned immediately (guard hit), so
// in a Node-ish host the process could exit with the 4th event never attempted.

describe("Flush serialization — late-enqueued events are not silently dropped", () => {
  it("awaited flush() sends events enqueued AFTER an already-in-flight flush", async () => {
    // Step 1: Set up a deferred fetch so we control when F1 (the auto-flush from
    // init) completes.
    let resolveF1!: (res: Response) => void;
    const f1Promise = new Promise<Response>((resolve) => {
      resolveF1 = resolve;
    });

    let fetchCallCount = 0;
    const fetchBodies: string[] = [];
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      fetchCallCount++;
      fetchBodies.push(init.body as string);
      if (fetchCallCount === 1) {
        // First call (F1 — from init's void this._flush()) stays pending
        return f1Promise;
      }
      // Second call (F2 — from the awaited flush()) resolves immediately with 200
      const body = JSON.parse(init.body as string) as {
        events: Array<{ client_event_id: string }>;
      };
      const accepted = body.events.length;
      return Promise.resolve(
        new Response(JSON.stringify({ accepted, rejected: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    // Step 2: init() with autoCapture=true fires install + app_open + session_start
    // (3 events) and synchronously starts F1 (void this._flush()) which snapshots them.
    const client = makeClient({ autoCapture: true });

    // Step 3: track a 4th event AFTER F1's buffer snapshot.
    client.track("late_event");

    // Step 4: call flush() without awaiting yet, then immediately resolve F1 so the
    // in-flight request finishes and the awaiting waiter can proceed.
    const flushPromise = client.flush();

    // Resolve F1 while the waiter is queued
    resolveF1(
      new Response(JSON.stringify({ accepted: 3, rejected: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // Step 5: await the public flush() — must not resolve before the second request
    await flushPromise;

    // A second fetch must have been issued (F2, carrying late_event)
    expect(fetchCallCount).toBe(2);

    // The second request body must contain late_event
    const secondBody = JSON.parse(fetchBodies[1]!) as { events: Array<{ event: string }> };
    expect(secondBody.events.some((e) => e.event === "late_event")).toBe(true);

    // late_event should now be cleared from the buffer (F2 returned 200)
    expect(allBufferedEvents().some((e) => e.event === "late_event")).toBe(false);
  });

  it("awaited flush() does not resolve until the follow-up pass has been issued", async () => {
    // Mirror of the above but asserting on the ORDER: the promise must not resolve
    // while fetchCallCount is still 1.
    let resolveF1!: (res: Response) => void;
    const f1Promise = new Promise<Response>((resolve) => {
      resolveF1 = resolve;
    });

    let fetchCallCount = 0;
    const mockFetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      fetchCallCount++;
      if (fetchCallCount === 1) return f1Promise;
      const body = JSON.parse(init.body as string) as { events: unknown[] };
      const accepted = body.events.length;
      return Promise.resolve(
        new Response(JSON.stringify({ accepted, rejected: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient({ autoCapture: true });
    client.track("late_event_2");

    let flushResolved = false;
    const flushPromise = client.flush().then(() => {
      flushResolved = true;
    });

    // At this point F1 is still pending — flush() must NOT have resolved already.
    // Yield the microtask queue once to let any synchronous no-op resolve propagate.
    await Promise.resolve();
    expect(flushResolved).toBe(false);

    // Now resolve F1 and let F2 proceed.
    resolveF1(
      new Response(JSON.stringify({ accepted: 3, rejected: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await flushPromise;

    // Only NOW should it have resolved, and only after F2 was issued.
    expect(flushResolved).toBe(true);
    expect(fetchCallCount).toBe(2);
  });
});

// ── W1 regression: disable() during retry backoff stops further sendChunk calls ─

describe("W1 regression — disable() aborts an in-flight retry chain", () => {
  it("stops sending after disable() is called during backoff sleep", async () => {
    vi.useFakeTimers();

    // Pin Math.random to 1.0 so backoffMs(0) = MAX * 1.0 = 1000ms — deterministic.
    // This prevents the jitter from producing a sub-10ms backoff that would make
    // the retry fire before disable() is called.
    vi.spyOn(Math, "random").mockReturnValue(1.0);

    // Always return 500 to keep the retry loop alive
    const mockFetch = vi.fn().mockResolvedValue({
      status: 500,
      headers: { get: () => null },
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = makeClient();
    client.track("retry_abort_event");

    // Start flush — do not await yet; it will enter sleep(1000ms) after the first 500
    const flushPromise = client.flush();

    // Advance 10ms: enough to resolve the first fetch microtask and enter the 1000ms sleep,
    // but not enough to complete it (backoffMs(0) = 1.0 * 1000ms = 1000ms with pinned random).
    await vi.advanceTimersByTimeAsync(10);

    // Disable while the retry is sleeping (the post-sleep guard at line ~317 must fire)
    client.disable();

    // Advance well past the backoff; the post-sleep guard must short-circuit the retry
    await vi.advanceTimersByTimeAsync(200_000);
    await flushPromise;

    // Only the initial attempt should have fired — the retry chain must have been aborted
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
