// survey.test.ts — tests for the cancellation-survey UI component.
//
// Covers:
//   (a) Each of the 5 presets emits its exact code.
//   (b) "Other" + freeform text emits the typed text VERBATIM — NOT the literal "other".
//       This locks the #80 server alignment: normalizeSurveyReason(text) → {code:"other",freeText:text}.
//   (c) Render / dismiss / submit behaviour: all 6 options rendered; dismiss-without-answer
//       emits nothing; submit emits exactly once then dismisses.
//
// All tests inject a fake `emit` spy — no network calls, no Pulse.init() required.
// DOM assertions use jsdom (environment: "jsdom" in vitest.config.ts).
//
// a later phase PR-E.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mountCancellationSurvey,
  CANCELLATION_SURVEY_OPTIONS,
  computeReason,
  canSubmit,
} from "./survey.js";
import type { CancellationSurveyOption } from "./survey.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fresh container div and append it to document.body. */
function makeContainer(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

/** Click the option button whose label matches the given text. */
function clickOption(container: HTMLElement, labelText: string): void {
  const buttons = container.querySelectorAll<HTMLButtonElement>("button.pulse-cs-option");
  for (const btn of buttons) {
    if (btn.textContent?.trim().includes(labelText)) {
      btn.click();
      return;
    }
  }
  throw new Error(`Option button with label "${labelText}" not found`);
}

/** Click the submit button. */
function clickSubmit(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>("button.pulse-cs-btn--submit");
  if (!btn) throw new Error("Submit button not found");
  btn.click();
}

/** Click the dismiss button. */
function clickDismiss(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>("button.pulse-cs-btn--dismiss");
  if (!btn) throw new Error("Dismiss button not found");
  btn.click();
}

/** Set textarea value and fire an input event (simulates user typing). */
function typeIntoTextarea(container: HTMLElement, text: string): void {
  const ta = container.querySelector<HTMLTextAreaElement>("textarea.pulse-cs-freetext");
  if (!ta) throw new Error("Freetext textarea not found");
  ta.value = text;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  // Each test starts with a clean body (no leftover panels / style tags)
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  vi.restoreAllMocks();
});

// ── (a) Preset options emit their exact codes ────────────────────────────────

describe("(a) preset options — exact emit codes", () => {
  const PRESETS: Array<{ label: string; expectedCode: string }> = [
    { label: "Too expensive", expectedCode: "too_expensive" },
    { label: "Not using it", expectedCode: "unused" },
    { label: "Missing a feature", expectedCode: "missing_features" },
    { label: "Found an alternative", expectedCode: "switched_service" },
    { label: "Too hard to use", expectedCode: "too_complex" },
  ];

  for (const { label, expectedCode } of PRESETS) {
    it(`"${label}" emits "${expectedCode}"`, () => {
      const emitted: string[] = [];
      const container = makeContainer();

      mountCancellationSurvey({
        container,
        emit: (r) => emitted.push(r),
      });

      clickOption(container, label);
      clickSubmit(container);

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBe(expectedCode);
    });
  }
});

// ── (b) "Other" emits typed text verbatim — never the literal "other" ────────
//
// This is the critical server-alignment test (locked against #80).
// normalizeSurveyReason("other") → {code:"other", freeText:null}  ← WRONG: text lost.
// normalizeSurveyReason("my typed text") → {code:"other", freeText:"my typed text"} ← CORRECT.

describe('(b) "Other" option — emits typed text verbatim', () => {
  it('emits the typed text, not the literal string "other"', () => {
    const emitted: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    clickOption(container, "Other");
    typeIntoTextarea(container, "the app keeps crashing");
    clickSubmit(container);

    expect(emitted).toHaveLength(1);
    // The emitted value must equal the typed text exactly
    expect(emitted[0]).toBe("the app keeps crashing");
    // And must NOT be the sentinel "other" that would silently drop the free text
    expect(emitted[0]).not.toBe("other");
  });

  it("trims leading/trailing whitespace from typed text", () => {
    const emitted: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    clickOption(container, "Other");
    typeIntoTextarea(container, "  too buggy  ");
    clickSubmit(container);

    expect(emitted[0]).toBe("too buggy");
    expect(emitted[0]).not.toBe("other");
  });

  it("does not allow submit when Other is selected but text is empty", () => {
    const emitted: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    clickOption(container, "Other");
    // Do NOT type anything
    clickSubmit(container); // should be blocked (button is disabled)

    expect(emitted).toHaveLength(0);
  });

  it("does not allow submit when Other is selected but text is only whitespace", () => {
    const emitted: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    clickOption(container, "Other");
    typeIntoTextarea(container, "   ");
    clickSubmit(container); // should be blocked

    expect(emitted).toHaveLength(0);
  });
});

// ── (c) Render / dismiss / submit behaviour ───────────────────────────────────

describe("(c) render and dismiss/submit behaviour", () => {
  it("renders all 6 options", () => {
    const container = makeContainer();
    mountCancellationSurvey({ container, emit: () => {} });

    const optionBtns = container.querySelectorAll("button.pulse-cs-option");
    expect(optionBtns).toHaveLength(6);

    // Verify all expected labels are present
    const labels = Array.from(optionBtns).map((b) => b.textContent?.trim() ?? "");
    expect(labels.some((l) => l.includes("Too expensive"))).toBe(true);
    expect(labels.some((l) => l.includes("Not using it"))).toBe(true);
    expect(labels.some((l) => l.includes("Missing a feature"))).toBe(true);
    expect(labels.some((l) => l.includes("Found an alternative"))).toBe(true);
    expect(labels.some((l) => l.includes("Too hard to use"))).toBe(true);
    expect(labels.some((l) => l.includes("Other"))).toBe(true);
  });

  it("dismiss-without-answer emits nothing and calls onDismiss", () => {
    const emitted: string[] = [];
    const dismissCalls: number[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
      onDismiss: () => dismissCalls.push(1),
    });

    clickDismiss(container);

    expect(emitted).toHaveLength(0);
    expect(dismissCalls).toHaveLength(1);
  });

  it("dismiss removes the panel from the DOM", () => {
    const container = makeContainer();
    mountCancellationSurvey({ container, emit: () => {} });

    expect(container.querySelector(".pulse-cs-panel")).toBeTruthy();
    clickDismiss(container);
    expect(container.querySelector(".pulse-cs-panel")).toBeNull();
  });

  it("submit emits exactly once then removes the panel from DOM", () => {
    const emitted: string[] = [];
    const submitReasons: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
      onSubmit: (r) => submitReasons.push(r),
    });

    clickOption(container, "Too expensive");
    clickSubmit(container);

    // Emitted exactly once
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe("too_expensive");

    // onSubmit called with same reason
    expect(submitReasons).toHaveLength(1);
    expect(submitReasons[0]).toBe("too_expensive");

    // Panel is gone
    expect(container.querySelector(".pulse-cs-panel")).toBeNull();
  });

  it("double-click submit does not emit twice", () => {
    const emitted: string[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    clickOption(container, "Not using it");

    // Grab the button reference BEFORE the first click tears down the panel,
    // then click it twice on the same element to exercise the submitted-guard.
    const btn = container.querySelector<HTMLButtonElement>("button.pulse-cs-btn--submit");
    expect(btn).toBeTruthy();
    btn!.click(); // first submit — emits once and tears down
    btn!.click(); // second click on same node — destroyed guard must block it

    expect(emitted).toHaveLength(1);
  });

  it("destroy() removes panel without emitting", () => {
    const emitted: string[] = [];
    const container = makeContainer();

    const handle = mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
    });

    expect(container.querySelector(".pulse-cs-panel")).toBeTruthy();
    handle.destroy();
    expect(container.querySelector(".pulse-cs-panel")).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it("Escape key dismisses without emitting (inline variant)", () => {
    const emitted: string[] = [];
    const dismissCalls: number[] = [];
    const container = makeContainer();

    mountCancellationSurvey({
      container,
      emit: (r) => emitted.push(r),
      onDismiss: () => dismissCalls.push(1),
    });

    const escEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    document.dispatchEvent(escEvent);

    expect(emitted).toHaveLength(0);
    expect(dismissCalls).toHaveLength(1);
    expect(container.querySelector(".pulse-cs-panel")).toBeNull();
  });

  it("modal variant: mounts backdrop in document.body", () => {
    // No container — should mount as modal
    mountCancellationSurvey({ emit: () => {} });

    expect(document.body.querySelector(".pulse-cs-backdrop")).toBeTruthy();
    expect(document.body.querySelector(".pulse-cs-panel")).toBeTruthy();

    // Cleanup
    document.body.innerHTML = "";
  });

  it("modal variant: backdrop click dismisses without emitting", () => {
    const emitted: string[] = [];
    const dismissCalls: number[] = [];

    mountCancellationSurvey({
      emit: (r) => emitted.push(r),
      onDismiss: () => dismissCalls.push(1),
    });

    const backdrop = document.body.querySelector<HTMLElement>(".pulse-cs-backdrop");
    expect(backdrop).toBeTruthy();

    // Simulate clicking the backdrop itself (not the panel inside it)
    backdrop!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(emitted).toHaveLength(0);
    expect(dismissCalls).toHaveLength(1);
    expect(document.body.querySelector(".pulse-cs-backdrop")).toBeNull();
  });

  it("SSR guard: returns a no-op handle when window is undefined", () => {
    const origWindow = globalThis.window;
    // @ts-expect-error — intentional SSR simulation
    globalThis.window = undefined;

    const handle = mountCancellationSurvey({ emit: () => {} });
    expect(typeof handle.destroy).toBe("function");
    expect(() => handle.destroy()).not.toThrow();

    globalThis.window = origWindow;
  });
});

// ── Pure logic unit tests — computeReason / canSubmit ─────────────────────────

describe("computeReason — pure logic", () => {
  const presetOpt: CancellationSurveyOption = {
    label: "Too expensive",
    value: "too_expensive",
    freeform: false,
  };
  const freeformOpt: CancellationSurveyOption = { label: "Other", value: "other", freeform: true };

  it("returns option.value for preset options", () => {
    expect(computeReason(presetOpt, "")).toBe("too_expensive");
  });

  it("returns trimmed freeText for freeform options", () => {
    expect(computeReason(freeformOpt, " my reason ")).toBe("my reason");
  });

  it('freeform result is never the literal string "other"', () => {
    // This is the critical invariant: the typed text is what gets sent, NOT "other"
    const result = computeReason(freeformOpt, "the app kept crashing");
    expect(result).not.toBe("other");
    expect(result).toBe("the app kept crashing");
  });
});

describe("canSubmit — pure logic", () => {
  const presetOpt: CancellationSurveyOption = {
    label: "Not using it",
    value: "unused",
    freeform: false,
  };
  const freeformOpt: CancellationSurveyOption = { label: "Other", value: "other", freeform: true };

  it("returns false when no option selected", () => {
    expect(canSubmit(null, "")).toBe(false);
    expect(canSubmit(null, "some text")).toBe(false);
  });

  it("returns true for a preset option regardless of freeText", () => {
    expect(canSubmit(presetOpt, "")).toBe(true);
    expect(canSubmit(presetOpt, "ignored")).toBe(true);
  });

  it("returns false for freeform option with empty text", () => {
    expect(canSubmit(freeformOpt, "")).toBe(false);
    expect(canSubmit(freeformOpt, "   ")).toBe(false);
  });

  it("returns true for freeform option with non-empty trimmed text", () => {
    expect(canSubmit(freeformOpt, "my reason")).toBe(true);
    expect(canSubmit(freeformOpt, "  ok  ")).toBe(true);
  });
});

// ── CANCELLATION_SURVEY_OPTIONS data contract ──────────────────────────────────

describe("CANCELLATION_SURVEY_OPTIONS — locked data contract", () => {
  it("has exactly 6 options", () => {
    expect(CANCELLATION_SURVEY_OPTIONS).toHaveLength(6);
  });

  it("options are in the correct order", () => {
    const values = CANCELLATION_SURVEY_OPTIONS.map((o) => o.value);
    expect(values).toEqual([
      "too_expensive",
      "unused",
      "missing_features",
      "switched_service",
      "too_complex",
      "other",
    ]);
  });

  it("only the last option (Other) is freeform", () => {
    const freeformOpts = CANCELLATION_SURVEY_OPTIONS.filter((o) => o.freeform);
    expect(freeformOpts).toHaveLength(1);
    expect(freeformOpts[0]!.value).toBe("other");
  });

  it("does not include involuntary/system codes", () => {
    const values = CANCELLATION_SURVEY_OPTIONS.map((o) => o.value);
    expect(values).not.toContain("billing_error");
    expect(values).not.toContain("price_increase_declined");
    expect(values).not.toContain("product_unavailable");
    expect(values).not.toContain("unknown");
    expect(values).not.toContain("low_quality");
    expect(values).not.toContain("customer_service");
  });
});

// ── Theming — CSS custom properties applied to panel root ─────────────────────

describe("theming — CSS custom properties", () => {
  it("applies accent theme value as --pulse-cs-accent on the panel", () => {
    const container = makeContainer();
    mountCancellationSurvey({
      container,
      emit: () => {},
      theme: { accent: "#ff0000" },
    });

    const panel = container.querySelector<HTMLElement>(".pulse-cs-panel");
    expect(panel).toBeTruthy();
    expect(panel!.style.getPropertyValue("--pulse-cs-accent")).toBe("#ff0000");
  });

  it("applies all supported theme keys", () => {
    const container = makeContainer();
    mountCancellationSurvey({
      container,
      emit: () => {},
      theme: {
        accent: "#aa0000",
        text: "#111111",
        muted: "#888888",
        bg: "#ffffff",
        border: "#dddddd",
        font: "Georgia, serif",
        radius: "4px",
        gap: "12px",
      },
    });

    const panel = container.querySelector<HTMLElement>(".pulse-cs-panel");
    expect(panel!.style.getPropertyValue("--pulse-cs-accent")).toBe("#aa0000");
    expect(panel!.style.getPropertyValue("--pulse-cs-text")).toBe("#111111");
    expect(panel!.style.getPropertyValue("--pulse-cs-muted")).toBe("#888888");
    expect(panel!.style.getPropertyValue("--pulse-cs-bg")).toBe("#ffffff");
    expect(panel!.style.getPropertyValue("--pulse-cs-border")).toBe("#dddddd");
    expect(panel!.style.getPropertyValue("--pulse-cs-font")).toBe("Georgia, serif");
    expect(panel!.style.getPropertyValue("--pulse-cs-radius")).toBe("4px");
    expect(panel!.style.getPropertyValue("--pulse-cs-gap")).toBe("12px");
  });
});

// ── Text overrides ─────────────────────────────────────────────────────────────

describe("text overrides", () => {
  it("renders custom title text", () => {
    const container = makeContainer();
    mountCancellationSurvey({
      container,
      emit: () => {},
      texts: { title: "Why did you leave?" },
    });

    const title = container.querySelector(".pulse-cs-title");
    expect(title?.textContent).toBe("Why did you leave?");
  });

  it("renders custom submit and dismiss button labels", () => {
    const container = makeContainer();
    mountCancellationSurvey({
      container,
      emit: () => {},
      texts: { submitLabel: "Send feedback", dismissLabel: "No thanks" },
    });

    const submitBtn = container.querySelector<HTMLButtonElement>(".pulse-cs-btn--submit");
    const dismissBtn = container.querySelector<HTMLButtonElement>(".pulse-cs-btn--dismiss");
    expect(submitBtn?.textContent).toBe("Send feedback");
    expect(dismissBtn?.textContent).toBe("No thanks");
  });
});
