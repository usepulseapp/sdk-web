// constants.ts — SDK-wide constants.
// the duplicate-not-import convention: RESERVED_EVENT_NAMES is DUPLICATED here (not imported from server).
// The server's copy lives in the Pulse ingestion server; both must stay
// in sync manually if a new reserved name is added to the telemetry spec §11.

/**
 * Reserved event names (the telemetry spec §11 — bare, no prefix).
 * Duplicated from the Pulse ingestion server per the duplicate-not-import convention.
 * a later phase funnel keys on this set; collision with track() triggers a debug warn.
 */
export const RESERVED_EVENT_NAMES = [
  "install",
  "app_open",
  "session_start",
  "session_end",
  "screen_view",
  "paywall_impression",
  "paywall_dismiss",
  "cancel_reason",
] as const;

export type ReservedEventName = (typeof RESERVED_EVENT_NAMES)[number];

/**
 * Default Pulse API host — the production ingestion origin.
 * The onboarding panel injects the resolved origin via getOrigin() when
 * rendering the install snippet; SDKs in production use this default.
 * Override via PulseOptions.apiHost in tests or self-hosted deployments.
 *
 * NOTE: no fixed hostname exists in the repo yet (PULSE_APP_ORIGIN is resolved
 * per-request from env + headers in the Pulse server). Using a clearly-marked placeholder
 * constant here; the onboarding the dashboard will inject the real origin.
 */
export const PULSE_DEFAULT_API_HOST = "https://api.usepulseapp.dev";

/** SDK version — injected by tsup at build time; fallback for source/dev runs. */
declare const __PULSE_SDK_VERSION__: string | undefined;
export const SDK_VERSION: string =
  (typeof __PULSE_SDK_VERSION__ !== "undefined" ? __PULSE_SDK_VERSION__ : undefined) ?? "0.0.0-dev";

/** Max events in one batch request (server cap). */
export const MAX_BATCH_EVENTS = 100;

/** Max body bytes per request (server cap 1 MB; we stay under with ~900 KB headroom). */
export const MAX_BATCH_BYTES = 900_000;

/** Max events in the localStorage ring buffer before oldest are dropped. */
export const DEFAULT_MAX_BUFFER_EVENTS = 500;

/** Max localStorage buffer bytes (2 MB — conservative; most browsers allow 5-10 MB). */
export const MAX_BUFFER_BYTES = 2_000_000;

/** Max bytes in a sendBeacon payload (Chrome silently drops above ~64 KB). */
export const BEACON_MAX_BYTES = 50_000;

/** Default flush interval ms. */
export const DEFAULT_FLUSH_INTERVAL_MS = 10_000;

/** Default session idle timeout ms (30 min). */
export const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** localStorage keys. */
export const LS_DISTINCT_ID = "__pulse_did";
export const LS_INSTALL_FIRED = "__pulse_installed";
export const LS_SESSION_ID = "__pulse_sid";
export const LS_SESSION_LAST_ACTIVITY = "__pulse_sla";
export const LS_EXTERNAL_USER_ID = "__pulse_euid";
export const LS_BUFFER = "__pulse_buf";
export const LS_DISABLED = "__pulse_disabled";

/** Max retries for transient errors before giving up (events stay in buffer). */
export const MAX_FLUSH_RETRIES = 5;

/** Initial backoff ms for exponential retry. */
export const INITIAL_BACKOFF_MS = 1_000;

/** Max backoff ms (cap). */
export const MAX_BACKOFF_MS = 60_000;

/** Property constraints — mirror the server Zod schema exactly. */
export const MAX_PROPERTY_KEYS = 50;
export const MAX_PROPERTY_KEY_LEN = 128;
export const MAX_PROPERTY_VALUE_LEN = 1024;
