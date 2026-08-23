// Per-device sync identity + config, kept in chrome.storage.local (ordinary, non-sensitive
// storage — same store as the vault blob, never chrome.storage.sync, since a device id must
// NOT follow the user to another browser profile). Mirrors apps/web/src/lib/config.ts's sync
// slice and device.ts as closely as an MV3 shell allows.
const K_DEVICE_ID = "pwmext.deviceId";
const K_DEVICE_LABEL = "pwmext.deviceLabel";
const K_SYNC_CONFIG = "pwmext.syncConfig";

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
   * refuses to apply it and warns.
   */
  highestSeenRev: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: false,
  serverUrl: "",
  accountId: "",
  lastSyncRev: 0,
  highestSeenRev: 0,
  lastSyncAt: null,
  lastError: null,
};

/** Random, non-secret device id — stable for the life of this browser profile's install. */
function newDeviceId(): string {
  return crypto.randomUUID();
}

function guessDeviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Browser";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : "browser";
  return `${os} ${br} extension`;
}

/** Mint the device identity on first use and persist it, so it stays stable thereafter. */
export async function ensureDeviceIdentity(): Promise<{ deviceId: string; deviceLabel: string }> {
  const v = await chrome.storage.local.get([K_DEVICE_ID, K_DEVICE_LABEL]);
  let deviceId = typeof v[K_DEVICE_ID] === "string" ? (v[K_DEVICE_ID] as string) : "";
  let deviceLabel = typeof v[K_DEVICE_LABEL] === "string" ? (v[K_DEVICE_LABEL] as string) : "";
  if (!deviceId || !deviceLabel) {
    deviceId ||= newDeviceId();
    deviceLabel ||= guessDeviceLabel();
    await chrome.storage.local.set({ [K_DEVICE_ID]: deviceId, [K_DEVICE_LABEL]: deviceLabel });
  }
  return { deviceId, deviceLabel };
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const v = await chrome.storage.local.get(K_SYNC_CONFIG);
  return { ...DEFAULT_SYNC_CONFIG, ...(v[K_SYNC_CONFIG] as Partial<SyncConfig> | undefined) };
}

export async function saveSyncConfig(cfg: SyncConfig): Promise<void> {
  await chrome.storage.local.set({ [K_SYNC_CONFIG]: cfg });
}
