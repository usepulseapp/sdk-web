// events.ts — property coercion to match the server Zod schema exactly.
// The server rejects nested objects/arrays, non-finite numbers, oversized strings
// and keys, and more than 50 keys. We coerce/drop client-side so the wire payload
// always passes server validation. Each dropped value emits a debug warn.

import { MAX_PROPERTY_KEYS, MAX_PROPERTY_KEY_LEN, MAX_PROPERTY_VALUE_LEN } from "./constants.js";
import type { Props, PropValue } from "./types.js";

/**
 * Coerce a raw properties record into a wire-safe flat primitive map.
 * Rules (mirror server Zod schema):
 *   - Only string | finite number | boolean | null values survive.
 *   - Nested objects, arrays, undefined, functions, symbols → dropped (debug warn).
 *   - String values > 1024 chars → truncated to 1024 (warn).
 *   - Keys > 128 chars → key dropped (warn).
 *   - Keys > 50 → excess keys dropped in iteration order (warn).
 *   - NaN / Infinity / -Infinity → dropped (warn).
 */
export function coerceProperties(
  raw: Record<string, unknown> | undefined,
  debug: boolean,
): Props | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    if (debug) console.warn("[Pulse] properties must be a plain object; ignoring.");
    return undefined;
  }

  const out: Props = {};
  let keyCount = 0;

  for (const [key, val] of Object.entries(raw)) {
    if (keyCount >= MAX_PROPERTY_KEYS) {
      if (debug)
        console.warn(
          `[Pulse] properties exceeds ${MAX_PROPERTY_KEYS} keys; dropping "${key}" and remaining.`,
        );
      break;
    }

    if (key.length > MAX_PROPERTY_KEY_LEN) {
      if (debug)
        console.warn(
          `[Pulse] property key "${key.slice(0, 32)}…" exceeds ${MAX_PROPERTY_KEY_LEN} chars; dropping.`,
        );
      continue;
    }

    const coerced = coerceValue(key, val, debug);
    if (coerced === undefined) continue; // dropped

    out[key] = coerced;
    keyCount++;
  }

  return keyCount > 0 ? out : undefined;
}

function coerceValue(key: string, val: unknown, debug: boolean): PropValue | undefined {
  if (val === null) return null;
  if (typeof val === "boolean") return val;

  if (typeof val === "number") {
    if (!isFinite(val)) {
      if (debug) console.warn(`[Pulse] property "${key}" is non-finite (${val}); dropping.`);
      return undefined;
    }
    return val;
  }

  if (typeof val === "string") {
    if (val.length > MAX_PROPERTY_VALUE_LEN) {
      if (debug)
        console.warn(
          `[Pulse] property "${key}" string value truncated to ${MAX_PROPERTY_VALUE_LEN} chars.`,
        );
      return val.slice(0, MAX_PROPERTY_VALUE_LEN);
    }
    return val;
  }

  // object, array, undefined, function, symbol → drop
  if (debug)
    console.warn(
      `[Pulse] property "${key}" has unsupported type "${typeof val}" (nested objects/arrays not allowed); dropping.`,
    );
  return undefined;
}
