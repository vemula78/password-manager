// Tiny NON-SENSITIVE config kept in localStorage: Drive OAuth client id, unlock backoff
// counters and UI prefs. Never anything from inside the vault.

export interface AppConfig {
  driveClientId: string;
  unlock: {
    /** Consecutive failed unlock attempts. */
    fails: number;
    /** Epoch ms before which unlocking is blocked (exponential backoff after 5 fails). */
    until: number;
    /** Failed attempts not yet written to the (encrypted) audit log. */
    pendingAuditCount: number;
  };
}

const KEY = "pwm-config";

const DEFAULTS: AppConfig = {
  driveClientId: "",
  unlock: { fails: 0, until: 0, pendingAuditCount: 0 },
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      ...structuredClone(DEFAULTS),
      ...parsed,
      unlock: { ...DEFAULTS.unlock, ...(parsed.unlock ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(KEY, JSON.stringify(cfg));
}

/** Record a failed unlock; returns updated config. Backoff kicks in after 5 failures. */
export function recordFailedUnlock(cfg: AppConfig): AppConfig {
  const fails = cfg.unlock.fails + 1;
  let until = 0;
  if (fails >= 5) {
    const delaySec = Math.min(30 * 2 ** (fails - 5), 3600); // 30s, 60s, 120s … cap 1h
    until = Date.now() + delaySec * 1000;
  }
  const next: AppConfig = {
    ...cfg,
    unlock: { fails, until, pendingAuditCount: cfg.unlock.pendingAuditCount + 1 },
  };
  saveConfig(next);
  return next;
}

/** On successful unlock: clear backoff and the pending audit queue. */
export function resetUnlockFails(cfg: AppConfig): AppConfig {
  const next: AppConfig = { ...cfg, unlock: { fails: 0, until: 0, pendingAuditCount: 0 } };
  saveConfig(next);
  return next;
}
