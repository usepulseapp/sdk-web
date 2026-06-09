// index.test.ts — public API surface smoke tests.
// Locks the exported functional API so a teardown method (destroy) cannot
// silently fall out of the published entrypoint again.

import { describe, it, expect } from "vitest";
import * as Pulse from "./index.js";

describe("public API surface", () => {
  it("exports the full documented functional API", () => {
    for (const name of [
      "init",
      "identify",
      "reset",
      "track",
      "screenView",
      "paywallImpression",
      "paywallDismiss",
      "cancelReason",
      "flush",
      "disable",
      "enable",
      "isEnabled",
      "destroy",
    ]) {
      expect(typeof (Pulse as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("destroy() is a no-op (does not throw) when no client has been initialised", () => {
    expect(() => Pulse.destroy()).not.toThrow();
  });
});
