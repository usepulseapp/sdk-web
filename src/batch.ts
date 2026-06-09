// batch.ts — pure, side-effect-free wire envelope assembly.
//
// assembleBatch() is the single source of truth for the batch envelope shape.
// It is imported by transport.ts (for chunking size checks and sends) and
// re-exported from index.ts (for the conformance test).
// Keeping it in its own module breaks the transport ↔ index circular dependency.

import type { BatchContext, BatchEnvelope, BufferedEvent } from "./types.js";

/**
 * Build the exact wire envelope from in-memory context + events.
 * PURE: no network, no storage, no clock.
 * The conformance test imports this (via index.ts) without requiring a dist/ build.
 */
export function assembleBatch(context: BatchContext, events: BufferedEvent[]): BatchEnvelope {
  return { context, events };
}
