// Tiny NON-SENSITIVE config kept in localStorage: Drive OAuth client id, unlock backoff
// counters and UI prefs. Never anything from inside the vault.

export interface SyncConfig {
  enabled: boolean;
  /** Base URL of the self-hosted sync server, e.g. https://vault-sync.example.in */
  serverUrl: string;
  accountId: string;
  /** Last revision successfully merged into the local vault. */
  lastSyncRev: number;
  /**
   * Highest revision this device has EVER seen. A server that later offers a lower rev is
   * withholding or rolling back changes (SYNC-DESIGN.md §8 freeze attack) — the client
   * refuses to apply it and warns. Monotonic, never decreased.
   */
  highestSeenRev: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface AppConfig {
  driveClientId: string;
  /**
   * Stable per-device id for tombstone/conflict attribution. Generated once per browser
   * profile. Not a secret and deliberately NOT synced — each device must have its own.
   */
  deviceId: string;
  deviceLabel: string;
  sync: SyncConfig;
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

const DEFAULT_SYNC: SyncConfig = {
  enabled: false,
  serverUrl: "",
  accountId: "",
  lastSyncRev: 0,
  highestSeenRev: 0,
  lastSyncAt: null,
  lastError: null,
};

const DEFAULTS: AppConfig = {
  driveClientId: "",
  deviceId: "",
  deviceLabel: "",
  sync: structuredClone(DEFAULT_SYNC),
  unlock: { fails: 0, until: 0, pendingAuditCount: 0 },
};

/** Random, non-secret device id. crypto.randomUUID is available in every target browser. */
function newDeviceId(): string {
  return crypto.randomUUID();
}

/** Best-effort human label so conflict copies say where they came from. */
function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android"
    : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows"
    : /Linux/.test(ua) ? "Linux" : "Browser";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return `${os} ${br}`;
}

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const cfg: AppConfig = {
      ...structuredClone(DEFAULTS),
      ...parsed,
      sync: { ...DEFAULT_SYNC, ...(parsed.sync ?? {}) },
      unlock: { ...DEFAULTS.unlock, ...(parsed.unlock ?? {}) },
    };
    return ensureDeviceIdentity(cfg);
  } catch {
    return ensureDeviceIdentity(structuredClone(DEFAULTS));
  }
}

/** Mint the device identity on first use and persist it, so it stays stable thereafter. */
function ensureDeviceIdentity(cfg: AppConfig): AppConfig {
  if (cfg.deviceId && cfg.deviceLabel) return cfg;
  const next: AppConfig = {
    ...cfg,
    deviceId: cfg.deviceId || newDeviceId(),
    deviceLabel: cfg.deviceLabel || guessDeviceLabel(),
  };
  saveConfig(next);
  return next;
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
