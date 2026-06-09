// storage.ts — thin localStorage wrapper with SSR guard.
// The SDK ships inside Next.js apps that SSR pages; localStorage is unavailable
// during SSR. Every access is gated on isBrowser().

/**
 * True when running in a browser context with localStorage available.
 * False in SSR (Node.js), Web Workers without localStorage, etc.
 */
export function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/**
 * Read a value from localStorage. Returns null when unavailable or missing.
 * Never throws — storage errors are swallowed so a broken localStorage doesn't
 * crash the host app.
 */
export function lsGet(key: string): string | null {
  if (!isBrowser()) return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write a value to localStorage. Returns true on success, false on failure
 * (e.g. storage quota exceeded or private-browsing restrictions).
 */
export function lsSet(key: string, value: string): boolean {
  if (!isBrowser()) return false;
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a key from localStorage. Safe to call even when unavailable.
 */
export function lsRemove(key: string): void {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // swallow
  }
}
