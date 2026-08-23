// Tiny NON-SENSITIVE sync config, mirroring apps/web/src/lib/config.ts. Stored as a plain
// JSON file in the app's private document directory (same pattern as storage.ts's
// prefs.json) — never in the vault, never anything from inside it.
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import { randomId } from "@pw/core";

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

export interface SyncIdentity {
  /**
   * Stable per-device id for tombstone/conflict attribution, passed into VaultStore as
   * VaultStoreOptions.deviceId. Not a secret and deliberately NOT synced — each device must
   * have its own.
   */
  deviceId: string;
  deviceLabel: string;
  sync: SyncConfig;
}

const FILENAME = "sync-config.json";

const DEFAULT_SYNC: SyncConfig = {
  enabled: false,
  serverUrl: "",
  accountId: "",
  lastSyncRev: 0,
  highestSeenRev: 0,
  lastSyncAt: null,
  lastError: null,
};

/** Best-effort human label so conflict copies say where they came from. */
function guessDeviceLabel(): string {
  const os = Platform.OS === "ios" ? "iPhone/iPad" : Platform.OS === "android" ? "Android" : Platform.OS;
  return `${os} app`;
}

function file(): File {
  return new File(Paths.document, FILENAME);
}

function readRaw(): Partial<SyncIdentity> {
  try {
    const f = file();
    if (!f.exists) return {};
    return JSON.parse(f.textSync()) as Partial<SyncIdentity>;
  } catch {
    return {};
  }
}

function writeRaw(cfg: SyncIdentity): void {
  file().write(JSON.stringify(cfg));
}

/** Mint the device identity on first use and persist it, so it stays stable thereafter. */
export function loadSyncConfig(): SyncIdentity {
  const parsed = readRaw();
  const cfg: SyncIdentity = {
    deviceId: parsed.deviceId || randomId(),
    deviceLabel: parsed.deviceLabel || guessDeviceLabel(),
    sync: { ...DEFAULT_SYNC, ...(parsed.sync ?? {}) },
  };
  if (!parsed.deviceId || !parsed.deviceLabel) writeRaw(cfg);
  return cfg;
}

export function saveSyncConfig(cfg: SyncIdentity): void {
  writeRaw(cfg);
}
