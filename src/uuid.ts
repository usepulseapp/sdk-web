// uuid.ts — zero-dependency UUID v4 generation.
// Prefers crypto.randomUUID() (available in all modern browsers + Node ≥14.17).
// Falls back to crypto.getRandomValues() for older/insecure contexts.
// Zero external dependencies.

/**
 * Generate a UUID v4 string.
 * Safe in SSR contexts — returns a UUID regardless of window availability.
 */
export function uuidv4(): string {
  // Modern browsers + Node ≥14.17
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as { randomUUID?: () => string }).randomUUID === "function"
  ) {
    return (crypto as { randomUUID: () => string }).randomUUID();
  }

  // Fallback: RFC-4122 v4 from getRandomValues
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // Set version bits (v4)
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    // Set variant bits (RFC 4122)
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return (
      hex.slice(0, 8) +
      "-" +
      hex.slice(8, 12) +
      "-" +
      hex.slice(12, 16) +
      "-" +
      hex.slice(16, 20) +
      "-" +
      hex.slice(20)
    );
  }

  // Last-resort fallback: Math.random-based (low entropy, never used in practice
  // since all modern runtimes have crypto.getRandomValues).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
