// session.ts — session lifecycle management.
//
// session_id: UUID per session, persisted in localStorage.
// Starts on init/app_open. Times out after sessionTimeoutMs of inactivity.
// On timeout: fires session_end for the old session, starts a new session_id,
// fires session_start.
// last-activity timestamp is persisted so timeout survives page reloads.

import {
  LS_SESSION_ID,
  LS_SESSION_LAST_ACTIVITY,
  DEFAULT_SESSION_TIMEOUT_MS,
} from "./constants.js";
import { lsGet, lsSet, lsRemove } from "./storage.js";
import { uuidv4 } from "./uuid.js";

export interface SessionState {
  sessionId: string;
  /** True when a new session was started (caller should fire session_start). */
  isNew: boolean;
  /** Set to the expired sessionId when the previous session timed out. */
  expiredSessionId?: string;
}

/**
 * Load or start a session, checking for timeout.
 * Returns the current session state and signals whether session_start / session_end
 * events should be fired by the caller.
 */
export function loadOrStartSession(
  sessionTimeoutMs: number = DEFAULT_SESSION_TIMEOUT_MS,
): SessionState {
  const storedId = lsGet(LS_SESSION_ID);
  const storedLastActivity = lsGet(LS_SESSION_LAST_ACTIVITY);

  const now = Date.now();

  if (storedId && storedLastActivity) {
    const lastActivity = parseInt(storedLastActivity, 10);
    const elapsed = now - lastActivity;
    if (elapsed < sessionTimeoutMs) {
      // Session is still active — refresh last-activity
      touchSession();
      return { sessionId: storedId, isNew: false };
    }
    // Session timed out — start a new one
    const expiredSessionId = storedId;
    const newId = mintSession(now);
    return { sessionId: newId, isNew: true, expiredSessionId };
  }

  // No stored session — mint a fresh one
  const newId = mintSession(now);
  return { sessionId: newId, isNew: true };
}

function mintSession(now: number): string {
  const id = uuidv4();
  lsSet(LS_SESSION_ID, id);
  lsSet(LS_SESSION_LAST_ACTIVITY, String(now));
  return id;
}

/**
 * Update the last-activity timestamp to now. Call on every event enqueue.
 */
export function touchSession(): void {
  lsSet(LS_SESSION_LAST_ACTIVITY, String(Date.now()));
}

/**
 * Start a completely new session (called by reset()). Returns the new session id.
 */
export function startNewSession(): string {
  return mintSession(Date.now());
}

/**
 * Clear session state from storage (called by reset() before starting a new session).
 */
export function clearSession(): void {
  lsRemove(LS_SESSION_ID);
  lsRemove(LS_SESSION_LAST_ACTIVITY);
}

/**
 * Get the currently stored session id without touching last-activity.
 * Returns undefined if no session is stored.
 */
export function currentSessionId(): string | undefined {
  const stored = lsGet(LS_SESSION_ID);
  return stored && stored.length > 0 ? stored : undefined;
}
