// Exponential-backoff math for failed unlock attempts — the exact formula used by
// apps/web/src/lib/config.ts (recordFailedUnlock), reused here so the extension enforces
// the same client-side rate limit. Kept pure/dependency-free for unit testing; the extension
// wraps this with chrome.storage.local persistence in lib/extConfig.ts.

export interface UnlockBackoffState {
  /** Consecutive failed unlock attempts. */
  fails: number;
  /** Epoch ms before which unlocking is blocked. 0 = not blocked. */
  until: number;
}

export const INITIAL_BACKOFF: UnlockBackoffState = { fails: 0, until: 0 };

/** Backoff kicks in after 5 consecutive failures: 30s, 60s, 120s, … capped at 1 hour. */
export function nextBackoffState(state: UnlockBackoffState, nowMs: number): UnlockBackoffState {
  const fails = state.fails + 1;
  let until = 0;
  if (fails >= 5) {
    const delaySec = Math.min(30 * 2 ** (fails - 5), 3600);
    until = nowMs + delaySec * 1000;
  }
  return { fails, until };
}

export function resetBackoff(): UnlockBackoffState {
  return { ...INITIAL_BACKOFF };
}

/** Milliseconds remaining before unlock is allowed again (0 if not blocked). */
export function blockedForMs(state: UnlockBackoffState, nowMs: number): number {
  return Math.max(0, state.until - nowMs);
}
