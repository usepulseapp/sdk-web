// types.ts — public TypeScript surface for @usepulseapp/sdk-web
// All types in this file are re-exported from src/index.ts.
// the telemetry spec §11, the wire contract.

/**
 * Flat primitive property values — the only types the server accepts.
 * Nested objects and arrays are NOT supported; the SDK drops them client-side.
 */
export type PropValue = string | number | boolean | null;

/**
 * Flat property bag for all track() and helper calls.
 */
export type Props = Record<string, PropValue>;

/**
 * SDK initialisation options.
 */
export interface PulseOptions {
  /** "test" | "production" — client-declared, not a trust boundary (the design spec). Default: "production". */
  environment?: "test" | "production";
  /**
   * Base URL of the Pulse ingestion API.
   * Default: the production Pulse origin constant (PULSE_DEFAULT_API_HOST).
   * Override in tests or when self-hosting via onboarding's getOrigin().
   */
  apiHost?: string;
  /** Flush interval in ms. Default: 10_000 (10 s). */
  flushIntervalMs?: number;
  /** Session idle timeout in ms. Default: 1_800_000 (30 min). */
  sessionTimeoutMs?: number;
  /** Auto-capture install / app_open / session_start / session_end. Default: true. */
  autoCapture?: boolean;
  /** Start the SDK in the disabled state (no network, no storage). Default: false. */
  disabled?: boolean;
  /** Ring-buffer cap (event count). Default: 500. */
  maxBufferEvents?: number;
  /** Log debug info to console. Default: false. */
  debug?: boolean;
}

/**
 * A single event as stored in the in-memory / localStorage buffer.
 * All fields are stamped at enqueue time (never at flush).
 */
export interface BufferedEvent {
  client_event_id: string;
  event: string;
  occurred_at: string; // ISO-8601, stamped at enqueue
  distinct_id: string;
  external_user_id?: string;
  session_id?: string;
  properties?: Props;
}

/**
 * Batch context sent with every request — batch-invariant fields the server
 * stamps onto every stored telemetry_events row.
 */
export interface BatchContext {
  platform: "web";
  environment: "test" | "production";
  sdkVersion: string;
}

/**
 * The wire envelope — exactly what POST /api/telemetry/{sdkKey} expects.
 */
export interface BatchEnvelope {
  context: BatchContext;
  events: BufferedEvent[];
}
