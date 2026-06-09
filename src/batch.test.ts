// batch.test.ts — unit tests for assembleBatch (pure, no side effects)
// Runs in jsdom via vitest.config.ts environment setting.

import { describe, it, expect } from "vitest";
import { assembleBatch } from "./batch.js";
import type { BatchContext, BufferedEvent } from "./types.js";

function makeContext(overrides: Partial<BatchContext> = {}): BatchContext {
  return {
    platform: "web",
    environment: "production",
    sdkVersion: "0.0.0-dev",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<BufferedEvent> = {}): BufferedEvent {
  return {
    client_event_id: "test-id-001",
    event: "install",
    occurred_at: new Date(Date.now() - 1000).toISOString(),
    distinct_id: "anon-001",
    session_id: "sess-001",
    ...overrides,
  };
}

describe("assembleBatch — envelope shape", () => {
  it("returns an object with context and events properties", () => {
    const ctx = makeContext();
    const events = [makeEvent()];
    const batch = assembleBatch(ctx, events);
    expect(batch).toHaveProperty("context");
    expect(batch).toHaveProperty("events");
  });

  it("context in the envelope is the exact object passed in", () => {
    const ctx = makeContext();
    const batch = assembleBatch(ctx, [makeEvent()]);
    expect(batch.context).toBe(ctx);
  });

  it("events in the envelope is the exact array passed in", () => {
    const events = [makeEvent()];
    const batch = assembleBatch(makeContext(), events);
    expect(batch.events).toBe(events);
  });

  it("platform in context is 'web' (hardcoded per spec)", () => {
    const ctx = makeContext({ platform: "web" });
    const batch = assembleBatch(ctx, [makeEvent()]);
    expect(batch.context.platform).toBe("web");
  });

  it("produces exactly the expected envelope shape for a single event", () => {
    const ctx = makeContext();
    const event = makeEvent();
    const batch = assembleBatch(ctx, [event]);
    expect(batch).toEqual({ context: ctx, events: [event] });
  });

  it("handles zero events (empty array)", () => {
    // assembleBatch is pure — it does not validate event count; that's the server's job
    const batch = assembleBatch(makeContext(), []);
    expect(batch.events).toHaveLength(0);
  });

  it("preserves all event fields in the envelope", () => {
    const event: BufferedEvent = {
      client_event_id: "abc-123",
      event: "screen_view",
      occurred_at: "2024-01-01T10:00:00.000Z",
      distinct_id: "user-abc",
      external_user_id: "ext-456",
      session_id: "sess-xyz",
      properties: { screen_name: "Home", plan: "pro" },
    };
    const batch = assembleBatch(makeContext(), [event]);
    expect(batch.events[0]).toEqual(event);
  });

  it("handles 100 events (the server max batch count)", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ client_event_id: `id-${i}`, event: "app_open" }),
    );
    const batch = assembleBatch(makeContext(), events);
    expect(batch.events).toHaveLength(100);
  });

  it("is pure: does not mutate the input arrays or objects", () => {
    const ctx = makeContext();
    const events = [makeEvent()];
    const ctxCopy = { ...ctx };
    const eventsCopy = [...events];
    assembleBatch(ctx, events);
    expect(ctx).toEqual(ctxCopy);
    expect(events).toEqual(eventsCopy);
  });
});
