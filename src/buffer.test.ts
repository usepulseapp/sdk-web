// buffer.test.ts — ring-buffer unit tests (count cap + byte cap + oldest-dropped)
// Runs in jsdom via vitest.config.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { bufferLoad, bufferAppend, bufferRemoveByIds } from "./buffer.js";
import type { BufferedEvent } from "./types.js";

function makeEvent(id: string, eventName: string = "track"): BufferedEvent {
  return {
    client_event_id: id,
    event: eventName,
    occurred_at: new Date().toISOString(),
    distinct_id: "anon-test",
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("bufferLoad — empty state", () => {
  it("returns an empty array when nothing is stored", () => {
    expect(bufferLoad()).toEqual([]);
  });

  it("returns an empty array for corrupt localStorage data", () => {
    localStorage.setItem("__pulse_buf", "not-json{{{");
    expect(bufferLoad()).toEqual([]);
  });

  it("returns an empty array when stored value is not an array", () => {
    localStorage.setItem("__pulse_buf", JSON.stringify({ not: "an-array" }));
    expect(bufferLoad()).toEqual([]);
  });
});

describe("bufferAppend — basic persistence", () => {
  it("appends an event and bufferLoad returns it", () => {
    const evt = makeEvent("id-1");
    bufferAppend(evt, 500, false);
    const loaded = bufferLoad();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.client_event_id).toBe("id-1");
  });

  it("appends multiple events in order", () => {
    bufferAppend(makeEvent("id-1"), 500, false);
    bufferAppend(makeEvent("id-2"), 500, false);
    bufferAppend(makeEvent("id-3"), 500, false);
    const loaded = bufferLoad();
    expect(loaded.map((e) => e.client_event_id)).toEqual(["id-1", "id-2", "id-3"]);
  });
});

describe("bufferAppend — count cap (oldest dropped on overflow)", () => {
  it("drops the oldest event when count cap is reached", () => {
    // maxEvents = 3
    bufferAppend(makeEvent("id-1"), 3, false);
    bufferAppend(makeEvent("id-2"), 3, false);
    bufferAppend(makeEvent("id-3"), 3, false);
    // Should all fit
    expect(bufferLoad()).toHaveLength(3);

    // Adding a 4th drops the oldest (id-1)
    bufferAppend(makeEvent("id-4"), 3, false);
    const loaded = bufferLoad();
    expect(loaded).toHaveLength(3);
    expect(loaded.map((e) => e.client_event_id)).toEqual(["id-2", "id-3", "id-4"]);
  });

  it("correctly maintains newest events when repeatedly overflowing", () => {
    // Add 10 events to a cap-5 buffer
    for (let i = 1; i <= 10; i++) {
      bufferAppend(makeEvent(`id-${i}`), 5, false);
    }
    const loaded = bufferLoad();
    expect(loaded).toHaveLength(5);
    // Only the newest 5 survive
    expect(loaded.map((e) => e.client_event_id)).toEqual(["id-6", "id-7", "id-8", "id-9", "id-10"]);
  });
});

describe("bufferAppend — byte cap", () => {
  it("drops oldest events when byte cap (MAX_BUFFER_BYTES=2_000_000) is exceeded", () => {
    // Each event with a large property will accumulate bytes.
    // We use many small events to force the byte cap first by filling the buffer.
    // We do this by using a large value that forces the byte cap.
    const largeValue = "x".repeat(100_000); // 100KB per event
    // Add 25 events = ~2.5MB total — should exceed 2MB cap
    for (let i = 0; i < 25; i++) {
      bufferAppend(
        { ...makeEvent(`byte-${i}`), properties: { big: largeValue } },
        1000, // count cap: 1000 (not the binding constraint here)
        false,
      );
    }
    const loaded = bufferLoad();
    // The byte cap (2MB) must have kicked in and dropped the oldest events
    const totalBytes = JSON.stringify(loaded).length;
    expect(totalBytes).toBeLessThanOrEqual(2_000_000);
    // And it kept the newest events (last ones appended)
    const ids = loaded.map((e) => e.client_event_id);
    expect(ids[ids.length - 1]).toBe("byte-24");
  });
});

describe("bufferRemoveByIds — removes only the specified ids", () => {
  it("removes exactly the specified ids and leaves the rest", () => {
    bufferAppend(makeEvent("id-1"), 500, false);
    bufferAppend(makeEvent("id-2"), 500, false);
    bufferAppend(makeEvent("id-3"), 500, false);
    bufferRemoveByIds(new Set(["id-1", "id-3"]));
    const loaded = bufferLoad();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.client_event_id).toBe("id-2");
  });

  it("does nothing when the id set is empty", () => {
    bufferAppend(makeEvent("id-1"), 500, false);
    bufferRemoveByIds(new Set());
    expect(bufferLoad()).toHaveLength(1);
  });

  it("handles removing non-existent ids gracefully", () => {
    bufferAppend(makeEvent("id-1"), 500, false);
    bufferRemoveByIds(new Set(["id-does-not-exist"]));
    expect(bufferLoad()).toHaveLength(1);
  });

  it("removes all events when all ids are specified", () => {
    bufferAppend(makeEvent("id-1"), 500, false);
    bufferAppend(makeEvent("id-2"), 500, false);
    bufferRemoveByIds(new Set(["id-1", "id-2"]));
    expect(bufferLoad()).toHaveLength(0);
  });
});
