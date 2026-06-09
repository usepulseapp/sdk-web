// client.ts — PulseClient: the stateful SDK instance.
//
// One instance is created by init() and held as a module-level singleton.
// All public API methods delegate here. The client is intentionally not exported
// directly — callers use the functional API in index.ts.
//
// Design invariants:
//   - Every public method is a no-op when disabled or in SSR (no window).
//   - Exceptions never propagate to the host app — analytics must never crash a page.
//   - Events are stamped at enqueue (not at flush): client_event_id, occurred_at,
//     distinct_id, session_id, external_user_id are all fixed at creation time.
//   - flush() always resolves (never rejects).

import {
  PULSE_DEFAULT_API_HOST,
  SDK_VERSION,
  LS_DISABLED,
  LS_INSTALL_FIRED,
  DEFAULT_MAX_BUFFER_EVENTS,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  RESERVED_EVENT_NAMES,
  MAX_FLUSH_RETRIES,
} from "./constants.js";
import type { PulseOptions, Props, BufferedEvent, BatchContext } from "./types.js";
import { isBrowser, lsGet, lsSet, lsRemove } from "./storage.js";
import { uuidv4 } from "./uuid.js";
import {
  loadOrMintDistinctId,
  rotateDistinctId,
  loadExternalUserId,
  saveExternalUserId,
  clearExternalUserId,
} from "./identity.js";
import { loadOrStartSession, touchSession, startNewSession, clearSession } from "./session.js";
import { bufferLoad, bufferAppend, bufferRemoveByIds } from "./buffer.js";
import { coerceProperties } from "./events.js";
import { captureAttribution } from "./attribution.js";
import { sendChunk, chunkEvents, backoffMs, buildEndpointUrl, flushOnUnload } from "./transport.js";

export class PulseClient {
  private readonly sdkKey: string;
  private readonly opts: Required<PulseOptions>;
  private readonly endpointUrl: string;

  private _disabled: boolean;
  private _destroyed: boolean = false;
  private _distinctId: string = "";
  private _externalUserId: string | undefined;
  private _sessionId: string = "";
  private _flushTimer: ReturnType<typeof setInterval> | undefined;
  private _flushing: boolean = false;
  private _unloadBound: boolean = false;
  private _onlineBound: boolean = false;
  private _visibilityBound: boolean = false;

  constructor(sdkKey: string, opts: PulseOptions = {}) {
    this.sdkKey = sdkKey;
    this.opts = {
      environment: opts.environment ?? "production",
      apiHost: opts.apiHost ?? PULSE_DEFAULT_API_HOST,
      flushIntervalMs: opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      sessionTimeoutMs: opts.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS,
      autoCapture: opts.autoCapture ?? true,
      disabled: opts.disabled ?? false,
      maxBufferEvents: opts.maxBufferEvents ?? DEFAULT_MAX_BUFFER_EVENTS,
      debug: opts.debug ?? false,
    };
    this.endpointUrl = buildEndpointUrl(this.opts.apiHost, this.sdkKey);

    // Resolve initial disabled state: option OR persisted LS flag
    const persistedDisabled = lsGet(LS_DISABLED) === "1";
    this._disabled = this.opts.disabled || persistedDisabled;

    if (this._disabled) {
      if (this.opts.debug) console.log("[Pulse] SDK initialised in disabled state.");
      return;
    }

    if (!isBrowser()) {
      // SSR — skip storage/network/listener setup entirely
      if (this.opts.debug) console.log("[Pulse] SSR context detected; SDK is a no-op.");
      this._disabled = true;
      return;
    }

    this._boot();
  }

  // ── Internal boot (browser, enabled) ────────────────────────────────────

  private _boot(): void {
    // Load persistent identity
    this._distinctId = loadOrMintDistinctId();
    this._externalUserId = loadExternalUserId();

    // Start/resume session — may fire session_end + session_start if timed out
    const sessionState = loadOrStartSession(this.opts.sessionTimeoutMs);
    this._sessionId = sessionState.sessionId;

    if (this.opts.autoCapture) {
      // If a previous session expired, fire session_end for it first
      if (sessionState.expiredSessionId) {
        this._enqueue("session_end", undefined, sessionState.expiredSessionId);
      }

      // Fire install once per browser (independently of distinct_id)
      const installFired = lsGet(LS_INSTALL_FIRED) === "1";
      if (!installFired) {
        lsSet(LS_INSTALL_FIRED, "1");
        const attribution = coerceProperties(captureAttribution() ?? undefined, this.opts.debug);
        this._enqueue("install", attribution);
      }

      // app_open + session_start on every init
      this._enqueue("app_open");
      if (sessionState.isNew) {
        this._enqueue("session_start");
      }
    }

    // Register lifecycle listeners (browser-only)
    this._bindListeners();

    // Start flush interval
    this._startFlushTimer();

    // Flush any buffered offline events immediately on init
    void this._flush();
  }

  private _bindListeners(): void {
    if (!isBrowser()) return;

    // pagehide: most reliable unload signal across browsers
    if (!this._unloadBound) {
      window.addEventListener("pagehide", this._onPageHide, { passive: true });
      window.addEventListener("visibilitychange", this._onVisibilityChange, { passive: true });
      this._unloadBound = true;
      this._visibilityBound = true;
    }

    // online: flush buffered events when connectivity is restored
    if (!this._onlineBound) {
      window.addEventListener("online", this._onOnline, { passive: true });
      this._onlineBound = true;
    }
  }

  private _unbindListeners(): void {
    if (!isBrowser()) return;
    window.removeEventListener("pagehide", this._onPageHide);
    window.removeEventListener("visibilitychange", this._onVisibilityChange);
    window.removeEventListener("online", this._onOnline);
    this._unloadBound = false;
    this._visibilityBound = false;
    this._onlineBound = false;
  }

  private readonly _onPageHide = (): void => {
    if (this._disabled) return;
    this._flushOnUnload();
  };

  private readonly _onVisibilityChange = (): void => {
    if (this._disabled) return;
    if (document.visibilityState === "hidden") {
      this._flushOnUnload();
    }
  };

  private readonly _onOnline = (): void => {
    if (this._disabled) return;
    void this._flush();
  };

  private _startFlushTimer(): void {
    if (this._flushTimer !== undefined) return;
    this._flushTimer = setInterval(() => {
      if (!this._disabled) void this._flush();
    }, this.opts.flushIntervalMs);
  }

  private _stopFlushTimer(): void {
    if (this._flushTimer !== undefined) {
      clearInterval(this._flushTimer);
      this._flushTimer = undefined;
    }
  }

  // ── Core enqueue ─────────────────────────────────────────────────────────

  /**
   * Stamp and enqueue one event. All public-API track calls funnel here.
   * Fields are fixed at enqueue time; a re-flush carries the same client_event_id.
   */
  private _enqueue(eventName: string, properties?: Props, overrideSessionId?: string): void {
    if (this._disabled) return;
    if (!isBrowser()) return;

    const event: BufferedEvent = {
      client_event_id: uuidv4(),
      event: eventName,
      occurred_at: new Date().toISOString(),
      distinct_id: this._distinctId,
      ...(this._externalUserId !== undefined && { external_user_id: this._externalUserId }),
      session_id: overrideSessionId ?? this._sessionId,
      ...(properties !== undefined && Object.keys(properties).length > 0 && { properties }),
    };

    bufferAppend(event, this.opts.maxBufferEvents, this.opts.debug);
    touchSession();
  }

  // ── Flush logic ──────────────────────────────────────────────────────────

  private _buildContext(): BatchContext {
    return {
      platform: "web",
      environment: this.opts.environment,
      sdkVersion: SDK_VERSION,
    };
  }

  /**
   * Flush the buffer via fetch. Respects the retry policy from the ingest route.
   * Always resolves (never rejects) so callers can fire-and-forget.
   */
  private async _flush(retryCount: number = 0): Promise<void> {
    if (this._disabled) return;
    if (this._flushing) return; // prevent concurrent flushes
    if (!isBrowser()) return;

    const events = bufferLoad();
    if (events.length === 0) return;

    this._flushing = true;
    const context = this._buildContext();

    try {
      const chunks = chunkEvents(events, context);
      for (const chunk of chunks) {
        if (this._disabled) break; // may be disabled mid-flush (e.g. 404)
        await this._sendChunkWithRetry(chunk, context, retryCount);
      }
    } catch {
      // Unexpected error — swallow; events remain in buffer for next flush
      if (this.opts.debug) console.warn("[Pulse] Unexpected error during flush; events retained.");
    } finally {
      this._flushing = false;
    }
  }

  private async _sendChunkWithRetry(
    chunk: BufferedEvent[],
    context: BatchContext,
    retryCount: number,
  ): Promise<void> {
    if (this._destroyed || this._disabled) return; // abort if torn down or disabled while in-flight
    const result = await sendChunk(this.endpointUrl, context, chunk);

    switch (result.status) {
      case "ok": {
        // Remove ONLY the ids we sent — events enqueued while in-flight survive
        bufferRemoveByIds(result.acceptedIds);
        if (this.opts.debug && result.rejected.length > 0) {
          console.warn("[Pulse] Server rejected events:", result.rejected);
        }
        break;
      }

      case "drop": {
        // Permanent client error (400) — drop the chunk; retrying won't help
        if (this.opts.debug) console.warn(`[Pulse] Dropping chunk: ${result.reason}`);
        const ids = new Set(chunk.map((e) => e.client_event_id));
        bufferRemoveByIds(ids);
        break;
      }

      case "disable": {
        // 404 — misconfigured sdkKey; disable the SDK to stop retry-storm
        if (this.opts.debug)
          console.warn(`[Pulse] Unknown sdkKey (404); disabling SDK. Reason: ${result.reason}`);
        this._disableInternal();
        break;
      }

      case "split": {
        // 413 — split the chunk in half and re-enqueue
        if (chunk.length <= 1) {
          // Irreducible single event — drop it
          if (this.opts.debug) console.warn("[Pulse] Single event too large for server; dropping.");
          const ids = new Set(chunk.map((e) => e.client_event_id));
          bufferRemoveByIds(ids);
        } else {
          const mid = Math.floor(chunk.length / 2);
          const left = chunk.slice(0, mid);
          const right = chunk.slice(mid);
          // Send each half (simple recursive call; won't infinite-loop because
          // a single event is irreducible and we drop it above)
          await this._sendChunkWithRetry(left, context, retryCount);
          await this._sendChunkWithRetry(right, context, retryCount);
        }
        break;
      }

      case "retry": {
        // 429 or 500 or network error
        if (retryCount >= MAX_FLUSH_RETRIES) {
          if (this.opts.debug)
            console.warn("[Pulse] Max retry attempts reached; events remain in buffer.");
          return;
        }
        const delayMs = result.retryAfterMs ?? backoffMs(retryCount);
        await sleep(delayMs);
        // Re-check after sleeping — destroy() or disable() may have been called during the delay.
        if (this._destroyed || this._disabled) return;
        await this._sendChunkWithRetry(chunk, context, retryCount + 1);
        break;
      }
    }
  }

  /**
   * Unload-path flush: sendBeacon first, fall back to fetch keepalive.
   * Uses a small subset of buffered events to stay under the beacon byte cap.
   */
  private _flushOnUnload(): void {
    if (this._disabled) return;
    const events = bufferLoad();
    if (events.length === 0) return;
    const context = this._buildContext();
    const chunks = chunkEvents(events, context);
    const firstChunk = chunks[0];
    if (!firstChunk || firstChunk.length === 0) return;
    flushOnUnload(this.endpointUrl, context, firstChunk, (ids) => {
      bufferRemoveByIds(ids);
    });
  }

  // ── Internal disable (called on 404) ────────────────────────────────────

  private _disableInternal(): void {
    this._disabled = true;
    lsSet(LS_DISABLED, "1");
    this._stopFlushTimer();
    this._unbindListeners();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  identify(externalUserId: string): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    if (externalUserId.length === 0) {
      if (this.opts.debug) console.warn("[Pulse] identify() called with empty string; ignoring.");
      return;
    }
    // Truncate to server max (256) — server also validates but guard client-side
    const id = externalUserId.slice(0, 256);
    this._externalUserId = id;
    saveExternalUserId(id);
  }

  reset(): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    // Rotate identity synchronously FIRST. Every buffered event was already
    // stamped with the old distinct_id at enqueue time, so those events are
    // correct to send and must remain in the buffer. New events enqueued after
    // this point carry the new distinct_id. No bufferClear — offline events
    // must survive logout and flush on reconnect (the design spec: buffer offline, flush on
    // reconnect). Fire-and-forget flush; identity rotation does not block on it.
    this._distinctId = rotateDistinctId();
    clearExternalUserId();
    this._externalUserId = undefined;
    // Start a fresh session
    clearSession();
    this._sessionId = startNewSession();
    // Best-effort flush of any remaining events from the old identity
    void this._flush();
    if (this.opts.autoCapture) {
      this._enqueue("app_open");
      this._enqueue("session_start");
    }
  }

  track(name: string, properties?: Record<string, unknown>): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    if (name.length < 1 || name.length > 128) {
      if (this.opts.debug)
        console.warn(`[Pulse] track() name must be 1–128 chars; got "${name.slice(0, 64)}".`);
      return;
    }
    // Reserved-name guard: warn but allow (the telemetry spec §11, the server schema note)
    if ((RESERVED_EVENT_NAMES as readonly string[]).includes(name)) {
      if (this.opts.debug)
        console.warn(
          `[Pulse] track("${name}") uses a reserved event name. This is allowed but consider using the dedicated helper instead.`,
        );
    }
    const coerced = coerceProperties(properties, this.opts.debug);
    this._enqueue(name, coerced);
  }

  screenView(name?: string, properties?: Record<string, unknown>): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    const base = name ? { screen_name: name } : {};
    const coerced = coerceProperties({ ...base, ...(properties ?? {}) }, this.opts.debug);
    this._enqueue("screen_view", coerced);
  }

  paywallImpression(properties?: Record<string, unknown>): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    const coerced = coerceProperties(properties, this.opts.debug);
    this._enqueue("paywall_impression", coerced);
  }

  paywallDismiss(properties?: Record<string, unknown>): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    const coerced = coerceProperties(properties, this.opts.debug);
    this._enqueue("paywall_dismiss", coerced);
  }

  cancelReason(reason: string, properties?: Record<string, unknown>): void {
    if (this._disabled) return;
    if (!isBrowser()) return;
    const merged: Record<string, unknown> = { reason, ...(properties ?? {}) };
    const coerced = coerceProperties(merged, this.opts.debug);
    this._enqueue("cancel_reason", coerced);
  }

  async flush(): Promise<void> {
    if (this._disabled) return;
    await this._flush();
  }

  /**
   * Tear down timers and event listeners. Marks this instance inert.
   * Safe to call multiple times (idempotent). Does NOT write to localStorage —
   * buffered events survive so they can be flushed by the next client.
   * Call this before discarding a PulseClient (e.g. in tests, or before re-init).
   */
  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this._disabled = true; // in-memory only — no lsSet, no LS_DISABLED written
    this._stopFlushTimer();
    this._unbindListeners();
  }

  disable(): void {
    if (this._disabled) return;
    this._disabled = true;
    lsSet(LS_DISABLED, "1");
    this._stopFlushTimer();
    this._unbindListeners();
    if (this.opts.debug) console.log("[Pulse] SDK disabled.");
  }

  enable(): void {
    // A destroyed instance is permanently inert — never resurrect it.
    if (this._destroyed) return;
    if (!this._disabled) return;
    lsRemove(LS_DISABLED);
    this._disabled = false;
    if (!isBrowser()) return;
    // A client constructed with { disabled: true } (or restored from a persisted
    // LS_DISABLED flag) never ran _boot(), so identity/session are uninitialized.
    // Boot now — _boot() binds listeners, starts the timer, and flushes — so we
    // must NOT fall through to the rebind path below.
    if (this._distinctId.length === 0 || this._sessionId.length === 0) {
      this._boot();
      if (this.opts.debug) console.log("[Pulse] SDK enabled (first boot).");
      return;
    }
    this._bindListeners();
    this._startFlushTimer();
    void this._flush();
    if (this.opts.debug) console.log("[Pulse] SDK enabled.");
  }

  isEnabled(): boolean {
    return !this._disabled;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
