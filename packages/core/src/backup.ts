// Encrypted backup package. The payload is the full serialized vault encrypted under the
// Backup Key (BK). The package header carries the vault's KDF params and BK envelopes so
// the backup opens with EITHER the master password OR the recovery key — and with nothing
// else. Used identically for Google Drive uploads and local encrypted export.
import { Ciphertext, decrypt, encryptJson, utf8decode } from "./crypto";
import {
  UnlockedKeys,
  VaultHeader,
  unlockWithPassword,
  unlockWithRecoveryKey,
} from "./keys";
import { parseVaultFile } from "./vault";

export const BACKUP_MAGIC = "pwm-backup";
const AD_PAYLOAD = "backup:payload:v1";

export interface BackupPackage {
  format: typeof BACKUP_MAGIC;
  version: 1;
  createdAt: string;
  /** Copy of the vault header — everything needed to recover BK, nothing secret. */
  keyring: Pick<VaultHeader, "kdf" | "vkEnvelopes" | "bkEnvelopes" | "recovery" | "version" | "createdAt">;
  payload: Ciphertext;
}

export function createBackup(store: {
  serialize(): string;
  getHeader(): VaultHeader;
  getBackupKey(): Uint8Array;
}, now: string): string {
  const header = store.getHeader();
  const pkg: BackupPackage = {
    format: BACKUP_MAGIC,
    version: 1,
    createdAt: now,
    keyring: {
      version: header.version,
      createdAt: header.createdAt,
      kdf: header.kdf,
      vkEnvelopes: header.vkEnvelopes,
      bkEnvelopes: header.bkEnvelopes,
      ...(header.recovery ? { recovery: header.recovery } : {}),
    },
    payload: encryptJson(store.serialize(), store.getBackupKey(), AD_PAYLOAD),
  };
  return JSON.stringify(pkg);
}

export function parseBackup(text: string): BackupPackage {
  let pkg: BackupPackage;
  try {
    pkg = JSON.parse(text) as BackupPackage;
  } catch {
    throw new Error("Not a valid backup file (corrupt JSON).");
  }
  if (pkg?.format !== BACKUP_MAGIC || pkg.version !== 1)
    throw new Error("Not a valid backup file (unknown format or version).");
  if (!pkg.keyring?.kdf || !pkg.keyring?.bkEnvelopes?.kek || !pkg.payload?.ctB64)
    throw new Error("Backup file is incomplete or damaged.");
  return pkg;
}

/**
 * Decrypt a backup with the master password or recovery key. Returns the serialized vault
 * (validated), ready to hand to VaultStore.open with the same credential. Any tampering
 * fails AEAD authentication and surfaces as a clear error.
 */
export function restoreBackup(
  text: string,
  credential: { password: string } | { recoveryKey: string },
): { vaultSerialized: string; createdAt: string } {
  const pkg = parseBackup(text);
  const headerLike = pkg.keyring as VaultHeader;
  let keys: UnlockedKeys;
  keys =
    "password" in credential
      ? unlockWithPassword(headerLike, credential.password)
      : unlockWithRecoveryKey(headerLike, credential.recoveryKey);
  let vaultSerialized: string;
  try {
    vaultSerialized = JSON.parse(
      utf8decode(decrypt(pkg.payload, keys.bk, AD_PAYLOAD)),
    ) as string;
  } catch {
    throw new Error("Backup failed integrity check — it may be corrupted or tampered with.");
  }
  parseVaultFile(vaultSerialized); // integrity: payload must be a well-formed vault
  return { vaultSerialized, createdAt: pkg.createdAt };
}

/** Neutral file name — reveals nothing about the user. */
export function backupFileName(now: Date | string): string {
  const d = typeof now === "string" ? new Date(now) : now;
  const p = (n: number) => String(n).padStart(2, "0");
  return `vault-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.pwmbackup`;
}
