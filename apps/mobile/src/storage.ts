// Vault persistence: the vault blob handed to us by @pw/core is ALREADY encrypted
// (plaintext header with KDF params/key envelopes + per-item ciphertexts), so a plain
// file is the right store. Never AsyncStorage, never plaintext.
//
// On iOS the vault file lives in the App Group's shared container (not the app-private
// sandbox) so the credentials-provider AutoFill extension — a separate process — can read
// (and, for the audit log, rewrite) the same file. See targets/credentials-provider/ and
// NOTES/ios-autofill-setup.md. Android has no AutoFill-provider integration in this codebase,
// so it keeps the original app-private location.
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import type { StorageAdapter } from "@pw/core";
import SharedVaultStore from "../modules/shared-vault-store/src/SharedVaultStoreModule";

const VAULT_FILENAME = "vault.json";
// Must match app.json's expo.ios.entitlements["com.apple.security.application-groups"][0] and
// targets/credentials-provider/expo-target.config.js's app-groups entry exactly.
const APP_GROUP_ID = "group.org.pwmanager.vault";

/**
 * Thrown on iOS when the shared App Group container can't be resolved. On a correctly
 * configured build this should never happen — surfacing it loudly (rather than silently
 * falling back to the stale app-private vault copy) avoids a build misconfiguration looking
 * like a rollback to old data.
 */
export class VaultStorageUnavailableError extends Error {
  constructor() {
    super("Vault storage is misconfigured — reinstall the app.");
    this.name = "VaultStorageUnavailableError";
  }
}

function oldVaultFile(): File {
  return new File(Paths.document, VAULT_FILENAME);
}

// Resolved once and cached: the App Group container path is fixed for the lifetime of the
// process. expo-file-system (57.x) exposes it natively as `Paths.appleSharedContainers`, keyed
// by App Group id, already as a properly-formed Directory — no custom native module needed for
// this part (the shared-vault-store module handles only Keychain + identity-store sync, which
// have no existing Expo API).
let sharedDir: Directory | null | undefined;

function sharedContainerDir(): Directory | null {
  if (Platform.OS !== "ios") return null;
  if (sharedDir !== undefined) return sharedDir;
  try {
    sharedDir = Paths.appleSharedContainers[APP_GROUP_ID] ?? null;
  } catch {
    // Missing entitlement, or running in an environment (e.g. Expo Go) without the App Group
    // configured at all. Fall back to the app-private location rather than crash — AutoFill
    // simply won't see the vault in that case.
    sharedDir = null;
  }
  return sharedDir;
}

/**
 * Resolves the vault file. On iOS this MUST be the shared-container file — if the App Group
 * can't be resolved there, that means a misconfigured build (a correctly configured build
 * always has it), so this throws rather than silently falling back to the stale app-private
 * copy, which would look like a rollback to old data. Android has no App Group concept, so it
 * keeps using the app-private location unconditionally.
 */
function vaultFile(): File {
  if (Platform.OS !== "ios") return oldVaultFile();
  const dir = sharedContainerDir();
  if (!dir) throw new VaultStorageUnavailableError();
  return new File(dir, VAULT_FILENAME);
}

/**
 * One-time migration: if a vault exists at the OLD app-private location and nothing has been
 * written to the new shared-container location yet, copy it over. After verifying the copy by
 * reading it back and confirming it matches what was read from the old location, the old file
 * is deleted — leaving it in place indefinitely would be a permanent stale-fork risk (the two
 * copies silently diverging is exactly the rollback class of bug this migration exists to
 * avoid).
 */
function migrateVaultIfNeeded(): void {
  if (Platform.OS !== "ios") return;
  const dir = sharedContainerDir();
  if (!dir) return; // Shared container unavailable — vaultFile() will throw when actually used.
  const newFile = new File(dir, VAULT_FILENAME);
  if (newFile.exists) return;
  const old = oldVaultFile();
  if (!old.exists) return;
  const oldContents = old.textSync();
  newFile.write(oldContents);
  if (newFile.exists && newFile.textSync() === oldContents) {
    old.delete();
  }
}

export const fileStorage: StorageAdapter = {
  async save(serialized: string): Promise<void> {
    const f = vaultFile(); // throws VaultStorageUnavailableError on a misconfigured iOS build
    if (Platform.OS === "ios") {
      // Coordinated, atomic write via NSFileCoordinator (see SharedVaultStoreModule.swift) —
      // NOT a plain File.write(), so this is mutually exclusive at the OS level with the
      // credentials-provider extension's own coordinated reads/writes.
      await SharedVaultStore.writeVaultFileCoordinated(f.uri, serialized);
    } else {
      f.write(serialized);
    }
  },
};

export function vaultExists(): boolean {
  migrateVaultIfNeeded();
  return vaultFile().exists;
}

export function readVault(): string {
  migrateVaultIfNeeded();
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
