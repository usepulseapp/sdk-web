// survey.ts — drop-in cancellation-survey UI component for @usepulseapp/sdk-web.
//
// Public API:
//   mountCancellationSurvey(options) → { destroy(): void }
//
// The component is a pure DOM renderer over the existing cancelReason() analytics
// event. It never introduces new event types, transport, or triggering logic.
// All purchase-flow concerns are outside scope per the telemetry spec §11–12 and D1.
//
// Wire contract (verified against MERGED server source — do NOT change):
//   - Preset selections emit cancelReason("<code>") verbatim.
//   - "Other" emits cancelReason("<typed text>") — the raw text, NOT "other".
//     normalizeSurveyReason() on the server buckets it to {code:"other",freeText}.
//   - cancelReason("other") would silently drop the free text — NEVER emit it.
//   - Never emit "unknown" or involuntary/system codes (billing_error, etc.).
//
// Theming: CSS custom properties (--pulse-cs-*) on the root element;
//          semantic class names (pulse-cs-*) for host-side override via CSS.
//
// SSR safety: mountCancellationSurvey is a no-op when window/document are absent.
//
// a later phase PR-E. the telemetry spec §14, the design notes, the design spec.

// ── Option set — locked. Order must not change. ──────────────────────────────

/**
 * A single preset survey option. `value` is passed verbatim to cancelReason()
 * for preset selections. For the freeform ("Other") entry the user's typed text
 * is emitted instead — never the literal value string "other".
 */
export interface CancellationSurveyOption {
  /** Human-readable label shown in the UI. */
  label: string;
  /**
   * The reason code emitted for preset (non-freeform) selections.
   * For the "Other" entry this field is a sentinel key only; the emitted value
   * is the user's typed text.
   */
  value: string;
  /**
   * When true, shows a freeform text field instead of emitting value directly.
   * The user's typed text (trimmed) becomes the emitted reason string.
   */
  freeform: boolean;
}

/**
 * Ordered preset list — exactly 6 options in the locked order.
 * Exported so integrators can render custom UI using the same data without
 * drifting from the server vocabulary.
 */
export const CANCELLATION_SURVEY_OPTIONS: readonly CancellationSurveyOption[] = [
  { label: "Too expensive", value: "too_expensive", freeform: false },
  { label: "Not using it", value: "unused", freeform: false },
  { label: "Missing a feature", value: "missing_features", freeform: false },
  { label: "Found an alternative", value: "switched_service", freeform: false },
  { label: "Too hard to use", value: "too_complex", freeform: false },
  { label: "Other", value: "other", freeform: true },
] as const;

// ── Theme type ────────────────────────────────────────────────────────────────

/**
 * Theme overrides for mountCancellationSurvey().
 * Each key maps 1:1 to a CSS custom property (--pulse-cs-<key>) set on the root
 * panel element. Omit any key to keep the neutral default.
 */
export interface CancellationSurveyTheme {
  /** Accent / highlight colour — selected option border, submit button fill. */
  accent?: string;
  /** Primary text colour. */
  text?: string;
  /** Muted / secondary text colour — option labels, textarea placeholder. */
  muted?: string;
  /** Panel background colour. */
  bg?: string;
  /** Border colour — option outlines, textarea border, panel border. */
  border?: string;
  /** Font-family stack applied to the whole component. */
  font?: string;
  /** Border-radius for buttons, option rows, and the panel. */
  radius?: string;
  /** Gap between option rows in the list. */
  gap?: string;
}

// ── Mount options ─────────────────────────────────────────────────────────────

/**
 * Options accepted by mountCancellationSurvey().
 */
export interface CancellationSurveyMountOptions {
  /**
   * Target element for inline rendering. When omitted the component is mounted
   * as a centred modal overlay appended to document.body.
   */
  container?: HTMLElement;
  /**
   * Called with the emitted reason string immediately after it has been sent.
   * The component has already been dismissed before this callback fires.
   */
  onSubmit?: (reason: string) => void;
  /**
   * Called when the user closes the survey without answering (Escape key,
   * backdrop click, or the close button). No analytics event is emitted.
   */
  onDismiss?: () => void;
  /**
   * Override the emit function used to send the analytics event.
   * Default: the SDK's functional cancelReason().
   * Inject a spy here in tests to capture the emitted reason string without
   * any network calls. The injected function is called with exactly one argument:
   * the reason string to be recorded.
   */
  emit?: (reason: string) => void;
  /** Visual theme overrides. */
  theme?: CancellationSurveyTheme;
  /** UI copy overrides. */
  texts?: {
    /** Survey panel heading. Default: "Why are you cancelling?" */
    title?: string;
    /** Textarea placeholder for the "Other" freeform field. Default: "Tell us more…" */
    otherPlaceholder?: string;
    /** Submit button label. Default: "Submit" */
    submitLabel?: string;
    /** Dismiss / skip button label. Default: "Skip" */
    dismissLabel?: string;
  };
}

// ── Pure logic — injectable testability seam ──────────────────────────────────

/**
 * Compute the reason string to emit for a given (option, freeText) pair.
 *
 * For preset options (freeform=false): returns option.value verbatim.
 * For the freeform option (freeform=true): returns the trimmed freeText.
 *
 * IMPORTANT: for the freeform path this returns the typed text, NOT the literal
 * string "other". Emitting "other" to the server would drop the free text because
 * normalizeSurveyReason("other") → {code:"other", freeText:null}. The correct
 * path is normalizeSurveyReason("<typed text>") → {code:"other", freeText:"<text>"}.
 *
 * Callers must verify canSubmit() before calling computeReason(), ensuring the
 * freeform case always receives non-empty text.
 */
export function computeReason(option: CancellationSurveyOption, freeText: string): string {
  if (option.freeform) {
    return freeText.trim();
  }
  return option.value;
}

/**
 * Returns true when the current state allows submission.
 * - No option selected → false.
 * - Preset option selected → true.
 * - Freeform option selected + non-empty trimmed text → true; otherwise false.
 */
export function canSubmit(
  selectedOption: CancellationSurveyOption | null,
  freeText: string,
): boolean {
  if (!selectedOption) return false;
  if (selectedOption.freeform) return freeText.trim().length > 0;
  return true;
}

// ── Embedded CSS ──────────────────────────────────────────────────────────────
//
// All class names are prefixed pulse-cs-* to avoid collisions with host app CSS.
// Theme properties are --pulse-cs-* custom properties applied to the panel root.

const SURVEY_CSS = `
.pulse-cs-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.pulse-cs-panel {
  font-family: var(--pulse-cs-font, system-ui, -apple-system, sans-serif);
  background: var(--pulse-cs-bg, #ffffff);
  color: var(--pulse-cs-text, #111827);
  border: 1px solid var(--pulse-cs-border, #e5e7eb);
  border-radius: var(--pulse-cs-radius, 12px);
  padding: 24px;
  width: min(420px, calc(100vw - 32px));
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  position: relative;
  box-sizing: border-box;
}
.pulse-cs-panel--inline {
  box-shadow: none;
  width: 100%;
}
.pulse-cs-close {
  position: absolute;
  top: 12px;
  right: 12px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--pulse-cs-muted, #6b7280);
  font-size: 20px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 6px;
}
.pulse-cs-close:hover {
  color: var(--pulse-cs-text, #111827);
}
.pulse-cs-title {
  font-size: 17px;
  font-weight: 600;
  margin: 0 0 16px 0;
  padding-right: 28px;
  color: var(--pulse-cs-text, #111827);
}
.pulse-cs-options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--pulse-cs-gap, 8px);
}
.pulse-cs-option {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--pulse-cs-border, #e5e7eb);
  border-radius: var(--pulse-cs-radius, 8px);
  padding: 10px 14px;
  cursor: pointer;
  background: transparent;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
  color: var(--pulse-cs-text, #111827);
}
.pulse-cs-option:hover {
  border-color: var(--pulse-cs-accent, #6366f1);
}
.pulse-cs-option--selected {
  border-color: var(--pulse-cs-accent, #6366f1);
  background: rgba(99,102,241,0.06);
}
.pulse-cs-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--pulse-cs-border, #d1d5db);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pulse-cs-option--selected .pulse-cs-radio {
  border-color: var(--pulse-cs-accent, #6366f1);
}
.pulse-cs-radio-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pulse-cs-accent, #6366f1);
  display: none;
}
.pulse-cs-option--selected .pulse-cs-radio-dot {
  display: block;
}
.pulse-cs-freetext {
  margin-top: 8px;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--pulse-cs-border, #e5e7eb);
  border-radius: var(--pulse-cs-radius, 8px);
  padding: 8px 12px;
  font-family: var(--pulse-cs-font, system-ui, -apple-system, sans-serif);
  font-size: 14px;
  color: var(--pulse-cs-text, #111827);
  background: var(--pulse-cs-bg, #ffffff);
  resize: vertical;
  min-height: 72px;
  outline: none;
}
.pulse-cs-freetext:focus {
  border-color: var(--pulse-cs-accent, #6366f1);
}
.pulse-cs-freetext::placeholder {
  color: var(--pulse-cs-muted, #9ca3af);
}
.pulse-cs-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
}
.pulse-cs-btn {
  padding: 9px 18px;
  border-radius: var(--pulse-cs-radius, 8px);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
}
.pulse-cs-btn--dismiss {
  background: transparent;
  color: var(--pulse-cs-muted, #6b7280);
  border: 1px solid var(--pulse-cs-border, #e5e7eb);
}
.pulse-cs-btn--dismiss:hover {
  color: var(--pulse-cs-text, #111827);
}
.pulse-cs-btn--submit {
  background: var(--pulse-cs-accent, #6366f1);
  color: #ffffff;
}
.pulse-cs-btn--submit:disabled {
  opacity: 0.4;
  cursor: default;
}
.pulse-cs-btn--submit:not(:disabled):hover {
  opacity: 0.85;
}
`;

// ── Shared style tag — ref-counted so multiple concurrent surveys don't leak ──

let _sharedStyleEl: HTMLStyleElement | null = null;
let _sharedStyleRefs = 0;

function injectStyles(): void {
  _sharedStyleRefs++;
  if (_sharedStyleEl) return;
  _sharedStyleEl = document.createElement("style");
  _sharedStyleEl.id = "__pulse-cs-styles";
  _sharedStyleEl.textContent = SURVEY_CSS;
  document.head.appendChild(_sharedStyleEl);
}

function releaseStyles(): void {
  _sharedStyleRefs = Math.max(0, _sharedStyleRefs - 1);
  if (_sharedStyleRefs === 0 && _sharedStyleEl) {
    _sharedStyleEl.remove();
    _sharedStyleEl = null;
  }
}

// ── applyTheme ────────────────────────────────────────────────────────────────

const THEME_CSS_VARS: Record<keyof CancellationSurveyTheme, string> = {
  accent: "--pulse-cs-accent",
  text: "--pulse-cs-text",
  muted: "--pulse-cs-muted",
  bg: "--pulse-cs-bg",
  border: "--pulse-cs-border",
  font: "--pulse-cs-font",
  radius: "--pulse-cs-radius",
  gap: "--pulse-cs-gap",
};

function applyTheme(el: HTMLElement, theme: CancellationSurveyTheme | undefined): void {
  if (!theme) return;
  for (const key of Object.keys(THEME_CSS_VARS) as (keyof CancellationSurveyTheme)[]) {
    const val = theme[key];
    if (val !== undefined) {
      el.style.setProperty(THEME_CSS_VARS[key]!, val);
    }
  }
}

// ── mountCancellationSurvey ───────────────────────────────────────────────────

/**
 * Mount the cancellation survey UI.
 *
 * Returns a handle with a destroy() method that removes all DOM and listeners
 * without emitting any analytics event. Calling destroy() after the user has
 * already submitted is safe (idempotent cleanup).
 *
 * SSR safe: if window or document is absent this is a no-op and the returned
 * handle's destroy() is also a no-op.
 *
 * @param opts  Configuration — container, callbacks, theme, copy overrides.
 */
export function mountCancellationSurvey(opts: CancellationSurveyMountOptions = {}): {
  destroy(): void;
} {
  const noOp = { destroy() {} };

  // SSR guard — never reference document/window at module evaluation time.
  if (typeof window === "undefined" || typeof document === "undefined") {
    return noOp;
  }

  const { container, onSubmit, onDismiss, theme, texts = {} } = opts;

  const titleText = texts.title ?? "Why are you cancelling?";
  const otherPlaceholder = texts.otherPlaceholder ?? "Tell us more…";
  const submitLabel = texts.submitLabel ?? "Submit";
  const dismissLabel = texts.dismissLabel ?? "Skip";

  // Resolve the emit function. Default resolves cancelReason lazily (not at
  // module-eval time) to keep the index.ts ↔ survey.ts re-export safe.
  const emitFn: (reason: string) => void = opts.emit ?? defaultEmit;

  const isModal = !container;

  // ── Mutable state ──────────────────────────────────────────────────────────

  let selectedOption: CancellationSurveyOption | null = null;
  let freeText = "";
  let submitted = false;
  let destroyed = false;

  // ── Build DOM ──────────────────────────────────────────────────────────────

  injectStyles();

  const panel = document.createElement("div");
  panel.className = isModal ? "pulse-cs-panel" : "pulse-cs-panel pulse-cs-panel--inline";
  applyTheme(panel, theme);

  // Title
  const titleEl = document.createElement("h2");
  titleEl.className = "pulse-cs-title";
  titleEl.textContent = titleText;
  panel.appendChild(titleEl);

  // Close button (X in the corner; present for both modal and inline variants)
  const closeBtn = document.createElement("button");
  closeBtn.className = "pulse-cs-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  panel.appendChild(closeBtn);

  // Option list
  const listEl = document.createElement("ul");
  listEl.className = "pulse-cs-options";
  listEl.setAttribute("role", "radiogroup");
  panel.appendChild(listEl);

  // Freeform textarea — created once, toggled visible when "Other" is selected
  const freeTextArea = document.createElement("textarea");
  freeTextArea.className = "pulse-cs-freetext";
  freeTextArea.placeholder = otherPlaceholder;
  freeTextArea.setAttribute("aria-label", otherPlaceholder);
  freeTextArea.style.display = "none";
  panel.appendChild(freeTextArea);

  // Build one button per option
  const optionBtns: HTMLButtonElement[] = [];

  for (const opt of CANCELLATION_SURVEY_OPTIONS) {
    const li = document.createElement("li");

    const btn = document.createElement("button");
    btn.className = "pulse-cs-option";
    btn.type = "button";
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.dataset["optionValue"] = opt.value;

    // Custom radio indicator
    const radioEl = document.createElement("span");
    radioEl.className = "pulse-cs-radio";
    radioEl.setAttribute("aria-hidden", "true");

    const dotEl = document.createElement("span");
    dotEl.className = "pulse-cs-radio-dot";
    radioEl.appendChild(dotEl);

    const labelEl = document.createElement("span");
    labelEl.textContent = opt.label;

    btn.appendChild(radioEl);
    btn.appendChild(labelEl);
    li.appendChild(btn);

    const capturedOpt = opt; // stable closure capture
    btn.addEventListener("click", () => {
      if (destroyed || submitted) return;
      selectedOption = capturedOpt;
      freeText = "";
      freeTextArea.value = "";
      syncOptionStyles();
      syncFreeTextVisibility();
      syncSubmitState();
    });

    optionBtns.push(btn);
    listEl.appendChild(li);
  }

  freeTextArea.addEventListener("input", () => {
    freeText = freeTextArea.value;
    syncSubmitState();
  });

  // Actions row
  const actionsEl = document.createElement("div");
  actionsEl.className = "pulse-cs-actions";
  panel.appendChild(actionsEl);

  const dismissBtn = document.createElement("button");
  dismissBtn.className = "pulse-cs-btn pulse-cs-btn--dismiss";
  dismissBtn.type = "button";
  dismissBtn.textContent = dismissLabel;
  actionsEl.appendChild(dismissBtn);

  const submitBtn = document.createElement("button");
  submitBtn.className = "pulse-cs-btn pulse-cs-btn--submit";
  submitBtn.type = "button";
  submitBtn.textContent = submitLabel;
  submitBtn.disabled = true;
  actionsEl.appendChild(submitBtn);

  // ── DOM sync helpers ───────────────────────────────────────────────────────

  function syncOptionStyles(): void {
    for (let i = 0; i < CANCELLATION_SURVEY_OPTIONS.length; i++) {
      const opt = CANCELLATION_SURVEY_OPTIONS[i]!;
      const btn = optionBtns[i]!;
      const sel = selectedOption === opt;
      btn.classList.toggle("pulse-cs-option--selected", sel);
      btn.setAttribute("aria-checked", String(sel));
    }
  }

  function syncFreeTextVisibility(): void {
    const show = selectedOption?.freeform === true;
    freeTextArea.style.display = show ? "block" : "none";
    if (show) freeTextArea.focus();
  }

  function syncSubmitState(): void {
    submitBtn.disabled = !canSubmit(selectedOption, freeText);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  function handleSubmit(): void {
    if (destroyed || submitted) return;
    if (!selectedOption || !canSubmit(selectedOption, freeText)) return;

    const reason = computeReason(selectedOption, freeText);
    // Guard: never emit an empty string (canSubmit already prevents this, belt-and-suspenders)
    if (!reason) return;

    submitted = true;
    emitFn(reason);
    teardown();
    onSubmit?.(reason);
  }

  function handleDismiss(): void {
    if (destroyed || submitted) return;
    teardown();
    onDismiss?.();
  }

  function teardown(): void {
    if (destroyed) return;
    destroyed = true;
    releaseStyles();
    removeGlobalListeners();
    if (isModal && backdropEl) {
      backdropEl.remove();
    } else {
      panel.remove();
    }
  }

  // ── Wire action listeners ──────────────────────────────────────────────────

  submitBtn.addEventListener("click", handleSubmit);
  dismissBtn.addEventListener("click", handleDismiss);
  closeBtn.addEventListener("click", handleDismiss);

  // ── Global listeners (Escape key, backdrop click) ──────────────────────────

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") handleDismiss();
  };

  function removeGlobalListeners(): void {
    document.removeEventListener("keydown", onKeyDown);
  }

  // ── Mount into DOM ─────────────────────────────────────────────────────────

  let backdropEl: HTMLDivElement | null = null;

  if (isModal) {
    backdropEl = document.createElement("div");
    backdropEl.className = "pulse-cs-backdrop";
    backdropEl.addEventListener("click", (e) => {
      if (e.target === backdropEl) handleDismiss();
    });
    backdropEl.appendChild(panel);
    document.body.appendChild(backdropEl);
  } else {
    container.appendChild(panel);
  }

  document.addEventListener("keydown", onKeyDown);

  // ── Public handle ──────────────────────────────────────────────────────────

  return {
    destroy(): void {
      if (destroyed) return;
      // destroy() from outside: treat as programmatic dismiss (no event emitted)
      teardown();
    },
  };
}

// ── Default emit — deferred cancelReason() call ───────────────────────────────
//
// We CANNOT do `import { cancelReason } from "./index.js"` at the top of this
// file because index.ts re-exports survey.ts, creating a circular parse-time
// execution order issue. The fix: call cancelReason lazily via a module-level
// variable that is populated on first use. By the time any user ever clicks
// "Submit", Pulse.init() has already run and the index.ts module has been
// fully evaluated, so the lazy lookup is always safe in practice.
//
// The _lazyEmit variable is populated once by _resolveDefaultEmit(). Tests
// always supply an explicit `emit` override and never hit this path.

let _lazyEmit: ((reason: string) => void) | null = null;

function defaultEmit(reason: string): void {
  if (_lazyEmit === null) {
    _lazyEmit = _resolveDefaultEmit();
  }
  if (_lazyEmit) {
    _lazyEmit(reason);
  }
  // If _lazyEmit is still null the developer called mountCancellationSurvey()
  // before Pulse.init() — silently drop; the SDK is not initialised.
}

/**
 * Attempt to resolve the cancelReason function from the already-evaluated
 * index module. This is called lazily (on first submit), never at import time.
 *
 * We expose a registration function (_registerCancelReason) that index.ts calls
 * when it loads, so this module never needs to import from index.ts.
 */
function _resolveDefaultEmit(): ((reason: string) => void) | null {
  return _registeredCancelReason;
}

let _registeredCancelReason: ((reason: string) => void) | null = null;

/**
 * Called by index.ts immediately after it defines the cancelReason function.
 * This breaks the circular import by inverting the dependency: survey.ts never
 * imports from index.ts; index.ts pushes its cancelReason reference here.
 *
 * Not exported in the public API surface (not re-exported from index.ts).
 */
export function _registerCancelReason(fn: (reason: string) => void): void {
  _registeredCancelReason = fn;
  // Also update _lazyEmit if it was already resolved to null
  _lazyEmit = fn;
}
