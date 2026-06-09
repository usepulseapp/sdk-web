// identity.ts — distinct_id and external_user_id lifecycle.
//
// distinct_id:
//   UUID v4 minted at first init, persisted in localStorage, reused across
//   sessions. Rotated (new UUID) on reset(). Never changes on identify().
//
// external_user_id:
//   Set by identify(externalUserId). Persisted in localStorage. Cleared on
//   reset(). Attached to every buffered event as external_user_id. Opaque
//   token — the SDK never inspects its contents.

import { LS_DISTINCT_ID, LS_EXTERNAL_USER_ID } from "./constants.js";
import { lsGet, lsSet, lsRemove } from "./storage.js";
import { uuidv4 } from "./uuid.js";

/**
 * Load or mint the persistent distinct_id.
 * Mints a new UUID if none is stored (first init after install or after reset).
 */
export function loadOrMintDistinctId(): string {
  const stored = lsGet(LS_DISTINCT_ID);
  if (stored && stored.length > 0) return stored;
  const id = uuidv4();
  lsSet(LS_DISTINCT_ID, id);
  return id;
}

/**
 * Rotate distinct_id — called by reset(). Mints a fresh UUID and persists it.
 */
export function rotateDistinctId(): string {
  const id = uuidv4();
  lsSet(LS_DISTINCT_ID, id);
  return id;
}

/**
 * Load the stored external_user_id, or undefined if none.
 */
export function loadExternalUserId(): string | undefined {
  const stored = lsGet(LS_EXTERNAL_USER_ID);
  return stored && stored.length > 0 ? stored : undefined;
}

/**
 * Persist an external_user_id. Silently ignores empty strings (server requires
 * external_user_id to be min 1 char when present).
 */
export function saveExternalUserId(id: string): void {
  if (id.length === 0) return; // guard: server schema is .min(1)
  lsSet(LS_EXTERNAL_USER_ID, id);
}

/**
 * Clear the stored external_user_id. Called by reset().
 */
export function clearExternalUserId(): void {
  lsRemove(LS_EXTERNAL_USER_ID);
}
