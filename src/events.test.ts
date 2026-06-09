// events.test.ts — coerceProperties unit tests.
// Verifies server-contract compliance: drops nested objects/arrays, non-finite
// numbers, oversized keys/values; enforces ≤50 key cap.

import { describe, it, expect } from "vitest";
import { coerceProperties } from "./events.js";
import { MAX_PROPERTY_KEYS, MAX_PROPERTY_KEY_LEN, MAX_PROPERTY_VALUE_LEN } from "./constants.js";

describe("coerceProperties — passthrough for valid values", () => {
  it("passes string values through unchanged", () => {
    const result = coerceProperties({ key: "value" }, false);
    expect(result).toEqual({ key: "value" });
  });

  it("passes number values through", () => {
    const result = coerceProperties({ price: 9.99, count: 0 }, false);
    expect(result).toEqual({ price: 9.99, count: 0 });
  });

  it("passes boolean values through", () => {
    const result = coerceProperties({ active: true, trial: false }, false);
    expect(result).toEqual({ active: true, trial: false });
  });

  it("passes null values through", () => {
    const result = coerceProperties({ tag: null }, false);
    expect(result).toEqual({ tag: null });
  });

  it("returns undefined for undefined input", () => {
    expect(coerceProperties(undefined, false)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    // null is treated the same as undefined by coerceProperties
    expect(coerceProperties(null as unknown as undefined, false)).toBeUndefined();
  });

  it("returns undefined for empty object", () => {
    // Zero keys → no output keys → returns undefined
    expect(coerceProperties({}, false)).toBeUndefined();
  });
});

describe("coerceProperties — drops nested objects/arrays", () => {
  it("drops a nested object value", () => {
    const result = coerceProperties({ nested: { inner: "value" } as unknown as string }, false);
    expect(result).toBeUndefined(); // only 'nested' was present and it was dropped
  });

  it("drops an array value", () => {
    const result = coerceProperties({ tags: ["a", "b"] as unknown as string }, false);
    expect(result).toBeUndefined();
  });

  it("keeps valid sibling keys when a nested object is dropped", () => {
    const result = coerceProperties(
      { good: "value", bad: { inner: "x" } as unknown as string },
      false,
    );
    expect(result).toEqual({ good: "value" });
  });

  it("drops undefined values", () => {
    const result = coerceProperties({ key: undefined as unknown as string }, false);
    expect(result).toBeUndefined();
  });

  it("returns undefined when input is an array (not a plain object)", () => {
    const result = coerceProperties(["a", "b"] as unknown as Record<string, unknown>, false);
    expect(result).toBeUndefined();
  });
});

describe("coerceProperties — drops non-finite numbers", () => {
  it("drops NaN", () => {
    const result = coerceProperties({ bad: NaN }, false);
    expect(result).toBeUndefined();
  });

  it("drops Infinity", () => {
    const result = coerceProperties({ bad: Infinity }, false);
    expect(result).toBeUndefined();
  });

  it("drops -Infinity", () => {
    const result = coerceProperties({ bad: -Infinity }, false);
    expect(result).toBeUndefined();
  });

  it("keeps valid finite number siblings when non-finite is dropped", () => {
    const result = coerceProperties({ price: 9.99, bad: NaN }, false);
    expect(result).toEqual({ price: 9.99 });
  });

  it("keeps 0 (edge case: finite zero)", () => {
    const result = coerceProperties({ zero: 0 }, false);
    expect(result).toEqual({ zero: 0 });
  });
});

describe("coerceProperties — string value truncation", () => {
  it(`passes a string value at exactly ${MAX_PROPERTY_VALUE_LEN} chars`, () => {
    const val = "x".repeat(MAX_PROPERTY_VALUE_LEN);
    const result = coerceProperties({ key: val }, false);
    expect(result?.["key"]).toHaveLength(MAX_PROPERTY_VALUE_LEN);
  });

  it(`truncates a string value that exceeds ${MAX_PROPERTY_VALUE_LEN} chars to exactly ${MAX_PROPERTY_VALUE_LEN}`, () => {
    const val = "x".repeat(MAX_PROPERTY_VALUE_LEN + 100);
    const result = coerceProperties({ key: val }, false);
    expect(result?.["key"]).toHaveLength(MAX_PROPERTY_VALUE_LEN);
  });

  it("truncation preserves the prefix of the value", () => {
    const prefix = "abc";
    const val = prefix + "x".repeat(MAX_PROPERTY_VALUE_LEN + 100);
    const result = coerceProperties({ key: val }, false);
    expect((result?.["key"] as string).startsWith(prefix)).toBe(true);
  });
});

describe("coerceProperties — key length enforcement", () => {
  it(`accepts a key at exactly ${MAX_PROPERTY_KEY_LEN} chars`, () => {
    const key = "k".repeat(MAX_PROPERTY_KEY_LEN);
    const result = coerceProperties({ [key]: "value" }, false);
    expect(result?.[key]).toBe("value");
  });

  it(`drops a key that exceeds ${MAX_PROPERTY_KEY_LEN} chars`, () => {
    const longKey = "k".repeat(MAX_PROPERTY_KEY_LEN + 1);
    const result = coerceProperties({ [longKey]: "value" }, false);
    expect(result).toBeUndefined(); // only key was dropped
  });

  it("keeps valid keys when an oversized key is dropped", () => {
    const longKey = "k".repeat(MAX_PROPERTY_KEY_LEN + 1);
    const result = coerceProperties({ valid: "ok", [longKey]: "dropped" }, false);
    expect(result).toEqual({ valid: "ok" });
  });
});

describe(`coerceProperties — key count cap (≤${MAX_PROPERTY_KEYS})`, () => {
  it(`passes ${MAX_PROPERTY_KEYS} keys exactly`, () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < MAX_PROPERTY_KEYS; i++) props[`key${i}`] = "v";
    const result = coerceProperties(props, false);
    expect(result).not.toBeUndefined();
    expect(Object.keys(result!)).toHaveLength(MAX_PROPERTY_KEYS);
  });

  it(`drops keys beyond ${MAX_PROPERTY_KEYS} (enforces iteration-order cap)`, () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < MAX_PROPERTY_KEYS + 10; i++) props[`key${i}`] = "v";
    const result = coerceProperties(props, false);
    expect(Object.keys(result!)).toHaveLength(MAX_PROPERTY_KEYS);
  });

  it("keeps the first keys in iteration order when cap is exceeded", () => {
    // Object.entries preserves insertion order
    const props: Record<string, string> = {};
    for (let i = 0; i < MAX_PROPERTY_KEYS + 1; i++) props[`key${i}`] = "v";
    const result = coerceProperties(props, false);
    // key50 (the 51st key) should be absent
    expect(result?.[`key${MAX_PROPERTY_KEYS}`]).toBeUndefined();
    // key49 (the 50th key) should be present
    expect(result?.[`key${MAX_PROPERTY_KEYS - 1}`]).toBe("v");
  });
});

describe("coerceProperties — combined: 50 keys + boundary values (server-schema passthrough)", () => {
  it("produces exactly 50 valid keys with max-length key and max-length string value", () => {
    const props: Record<string, string> = {};
    const maxKey = "k".repeat(MAX_PROPERTY_KEY_LEN);
    props[maxKey] = "x".repeat(MAX_PROPERTY_VALUE_LEN);
    for (let i = 0; i < MAX_PROPERTY_KEYS - 1; i++) props[`key${i}`] = "v";
    const result = coerceProperties(props, false);
    expect(Object.keys(result!)).toHaveLength(MAX_PROPERTY_KEYS);
    expect(result![maxKey]).toHaveLength(MAX_PROPERTY_VALUE_LEN);
  });
});
