// index.ts — public entry point for @usepulseapp/sdk-web.
//
// Exports:
//   - Functional SDK API: init, identify, reset, track, screenView,
//     paywallImpression, paywallDismiss, cancelReason, flush, disable, enable,
//     isEnabled, destroy.
//   - assembleBatch(): pure, side-effect-free batch envelope builder. Exported
//     for use by the conformance test suite without requiring a built dist/.
//   - mountCancellationSurvey(): drop-in churn-survey UI (a later phase PR-E).
//   - Public types: PulseOptions, Props, PropValue, BufferedEvent, BatchContext,
//     BatchEnvelope, ReservedEventName, RESERVED_EVENT_NAMES, SDK_VERSION,
//     CancellationSurveyTheme, CANCELLATION_SURVEY_OPTIONS.
//
// the telemetry spec §11, §14, the wire contract, the design spec.

import { PulseClient } from "./client.js";
import type { PulseOptions, Props } from "./types.js";
import { _registerCancelReason } from "./survey.js";

// ── assembleBatch — re-exported from batch.ts (pure, no circular deps) ────────
//
// The conformance test imports assembleBatch directly from @usepulseapp/sdk-web source.
// Keeping it in batch.ts breaks the potential transport ↔ index circular import.
export { assembleBatch } from "./batch.js";

// ── Module-level singleton ────────────────────────────────────────────────────

let _client: PulseClient | null = null;

function getClient(method: string): PulseClient | null {
  if (!_client) {
    // In production builds warn once; in test environments this is expected.
    if (typeof console !== "undefined") {
      console.warn(`[Pulse] ${method}() called before init(). Call Pulse.init(sdkKey) first.`);
    }
    return null;
  }
  return _client;
}

// ── Public functional API ─────────────────────────────────────────────────────

/**
 * Initialise the Pulse SDK. Must be called once before any other method.
 * Safe to call in SSR — the client detects the absence of browser globals and
 * becomes a no-op without throwing.
 *
 * @param sdkKey  Publishable SDK key (pk_…). NEVER an ingestKey or secret.
 * @param opts    Optional configuration.
 */
export function init(sdkKey: string, opts?: PulseOptions): void {
  try {
    // Dispose the previous client before replacing it, so its flush interval
    // and event listeners do not outlive the re-init.
    _client?.destroy();
    _client = new PulseClient(sdkKey, opts);
  } catch (err) {
    // Never let SDK init crash the host app.
    if (typeof console !== "undefined") {
      console.error("[Pulse] init() failed:", err);
    }
  }
}

/**
 * Link the current anonymous identity to the developer's own user id.
 * The id is opaque — Pulse never inspects its contents. Persisted across sessions.
 * Does NOT change distinct_id. Call on user login.
 *
 * @param externalUserId  The developer's own user id (≤ 256 chars, non-empty).
 */
export function identify(externalUserId: string): void {
  try {
    getClient("identify")?.identify(externalUserId);
  } catch {
    // swallow
  }
}

/**
 * Rotate distinct_id, clear external_user_id, and start a new session.
 * Flushes pending events first. Call on user logout.
 *
 * Identity rotation is synchronous — distinct_id and session rotate immediately.
 * Buffered pre-logout events (already stamped with the old distinct_id) are
 * flushed best-effort in the background; they are NOT cleared, so they survive
 * offline logout and flush on reconnect.
 */
export function reset(): void {
  try {
    getClient("reset")?.reset();
  } catch {
    // swallow
  }
}

/**
 * Track a custom event.
 *
 * @param name        Event name, 1–128 chars. Reserved names trigger a debug warn
 *                    but are still sent (server-side the name is stored verbatim).
 * @param properties  Optional flat property bag. Nested objects/arrays are dropped
 *                    with a debug warn; non-finite numbers and oversized strings are
 *                    coerced or dropped.
 */
export function track(name: string, properties?: Props): void {
  try {
    getClient("track")?.track(name, properties);
  } catch {
    // swallow
  }
}

/**
 * Track a screen view. Emits event name "screen_view".
 *
 * @param name        Optional screen name, attached as the "screen_name" property.
 * @param properties  Additional flat properties.
 */
export function screenView(name?: string, properties?: Props): void {
  try {
    getClient("screenView")?.screenView(name, properties);
  } catch {
    // swallow
  }
}

/**
 * Track a paywall impression. Emits event name "paywall_impression".
 */
export function paywallImpression(properties?: Props): void {
  try {
    getClient("paywallImpression")?.paywallImpression(properties);
  } catch {
    // swallow
  }
}

/**
 * Track a paywall dismissal. Emits event name "paywall_dismiss".
 */
export function paywallDismiss(properties?: Props): void {
  try {
    getClient("paywallDismiss")?.paywallDismiss(properties);
  } catch {
    // swallow
  }
}

/**
 * Track a cancellation reason (churn-survey component). Emits event name
 * "cancel_reason". The reason string is attached as the "reason" property.
 *
 * @param reason      Structured reason string (e.g. "too_expensive").
 * @param properties  Additional flat properties (e.g. free_text).
 */
export function cancelReason(reason: string, properties?: Props): void {
  try {
    getClient("cancelReason")?.cancelReason(reason, properties);
  } catch {
    // swallow
  }
}

// Register cancelReason with the survey module so mountCancellationSurvey()'s
// default emit path can call it without importing from index.ts (which would
// create a parse-time circular execution issue since index.ts exports survey.ts).
_registerCancelReason(cancelReason);

/**
 * Force-flush the event buffer. Resolves when the flush attempt completes.
 * Safe to call without awaiting; never rejects.
 */
export async function flush(): Promise<void> {
  try {
    await getClient("flush")?.flush();
  } catch {
    // swallow
  }
}

/**
 * Disable the SDK. Persisted — survives page reloads.
 * All subsequent API calls are no-ops until enable() is called.
 */
export function disable(): void {
  try {
    getClient("disable")?.disable();
  } catch {
    // swallow
  }
}

/**
 * Re-enable a previously disabled SDK. Reverses disable().
 */
export function enable(): void {
  try {
    getClient("enable")?.enable();
  } catch {
    // swallow
  }
}

/**
 * Returns true if the SDK is currently enabled (i.e. not disabled).
 */
export function isEnabled(): boolean {
  try {
    return getClient("isEnabled")?.isEnabled() ?? false;
  } catch {
    return false;
  }
}

/**
 * Tear down the active SDK instance — stops the flush timer and removes all
 * lifecycle listeners, marking it permanently inert. Buffered events are kept
 * in localStorage so the next init() can flush them. Safe to call when no
 * client exists; never throws. Call this when a page or app shell unmounts.
 */
export function destroy(): void {
  try {
    _client?.destroy();
    _client = null;
  } catch {
    // swallow
  }
}

// ── Re-exports — types and constants the conformance test and callers need ──

export type {
  PulseOptions,
  Props,
  PropValue,
  BufferedEvent,
  BatchContext,
  BatchEnvelope,
} from "./types.js";
export { RESERVED_EVENT_NAMES, SDK_VERSION, PULSE_DEFAULT_API_HOST } from "./constants.js";
export type { ReservedEventName } from "./constants.js";

// ── Cancellation survey — a later phase PR-E ──────────────────────────────────────

export { mountCancellationSurvey, CANCELLATION_SURVEY_OPTIONS } from "./survey.js";
export type {
  CancellationSurveyTheme,
  CancellationSurveyOption,
  CancellationSurveyMountOptions,
} from "./survey.js";
