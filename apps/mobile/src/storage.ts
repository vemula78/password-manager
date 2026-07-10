// Vault persistence: the vault blob handed to us by @pw/core is ALREADY encrypted
// (plaintext header with KDF params/key envelopes + per-item ciphertexts), so a plain
// file in the app sandbox is the right store. Never AsyncStorage, never plaintext.
import { File, Paths } from "expo-file-system";
import type { StorageAdapter } from "@pw/core";

const VAULT_FILENAME = "vault.json";

function vaultFile(): File {
  return new File(Paths.document, VAULT_FILENAME);
}

export const fileStorage: StorageAdapter = {
  async save(serialized: string): Promise<void> {
    vaultFile().write(serialized);
  },
};

export function vaultExists(): boolean {
  return vaultFile().exists;
}

export function readVault(): string {
  return vaultFile().textSync();
}

export function deleteVault(): void {
  const f = vaultFile();
  if (f.exists) f.delete();
}

// ---- Device preferences (NOT secret — no vault data, no keys, no passwords) ----------

export interface DevicePrefs {
  /** null = user has not been asked yet; drives the one-time "enable biometrics?" offer. */
  biometricEnabled: boolean | null;
  /** Seconds the app may stay unlocked in the background before relocking. 0 = immediately. */
  backgroundGraceSeconds: number;
}

export const DEFAULT_PREFS: DevicePrefs = {
  biometricEnabled: null,
  backgroundGraceSeconds: 0,
};

const PREFS_FILENAME = "prefs.json";

export function readPrefs(): DevicePrefs {
  try {
    const f = new File(Paths.document, PREFS_FILENAME);
    if (!f.exists) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ...(JSON.parse(f.textSync()) as Partial<DevicePrefs>) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs: DevicePrefs): void {
  new File(Paths.document, PREFS_FILENAME).write(JSON.stringify(prefs));
}
