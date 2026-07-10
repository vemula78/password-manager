// Key hierarchy (see PLAN.md): master password —Argon2id→ KEK; random Vault Key (VK)
// encrypts items; random Backup Key (BK) encrypts backup packages. VK and BK are stored
// only as KeyEnvelopes wrapped by the KEK and (optionally) by the Recovery Key.
// V2 additions (family key, trusted-contact, per-device) are just more envelopes.
import {
  Ciphertext,
  KdfParams,
  KEY_BYTES,
  decrypt,
  deriveKek,
  deriveSubkey,
  encrypt,
  fromB64,
  newKdfParams,
  randomBytes,
  toB64,
  wipe,
} from "./crypto";

export interface VaultHeader {
  version: 1;
  kdf: KdfParams;
  /** Vault Key wrapped by KEK, and by the recovery wrapping key if recovery is set up. */
  vkEnvelopes: { kek: Ciphertext; recovery?: Ciphertext };
  /** Backup Key envelopes — so backups open with master password OR recovery key. */
  bkEnvelopes: { kek: Ciphertext; recovery?: Ciphertext };
  recovery?: { keyId: string; createdAt: string };
  createdAt: string;
}

export interface UnlockedKeys {
  vk: Uint8Array;
  bk: Uint8Array;
}

const AD_VK_KEK = "envelope:vk:kek";
const AD_VK_REC = "envelope:vk:recovery";
const AD_BK_KEK = "envelope:bk:kek";
const AD_BK_REC = "envelope:bk:recovery";

export class WrongCredentialError extends Error {
  constructor(kind: "password" | "recovery-key") {
    super(
      kind === "password"
        ? "Incorrect master password."
        : "Incorrect recovery key, or recovery was not set up for this vault.",
    );
    this.name = "WrongCredentialError";
  }
}

export function createVaultHeader(
  masterPassword: string,
  now: string,
): { header: VaultHeader; keys: UnlockedKeys } {
  const kdf = newKdfParams();
  const kek = deriveKek(masterPassword, kdf);
  const vk = randomBytes(KEY_BYTES);
  const bk = randomBytes(KEY_BYTES);
  const header: VaultHeader = {
    version: 1,
    kdf,
    vkEnvelopes: { kek: encrypt(vk, kek, AD_VK_KEK) },
    bkEnvelopes: { kek: encrypt(bk, kek, AD_BK_KEK) },
    createdAt: now,
  };
  wipe(kek);
  return { header, keys: { vk, bk } };
}

export function unlockWithPassword(header: VaultHeader, masterPassword: string): UnlockedKeys {
  const kek = deriveKek(masterPassword, header.kdf);
  try {
    const vk = decrypt(header.vkEnvelopes.kek, kek, AD_VK_KEK);
    const bk = decrypt(header.bkEnvelopes.kek, kek, AD_BK_KEK);
    return { vk, bk };
  } catch {
    throw new WrongCredentialError("password");
  } finally {
    wipe(kek);
  }
}

/** Reauthentication check for sensitive-field reveal / recovery changes. */
export function verifyMasterPassword(header: VaultHeader, masterPassword: string): boolean {
  try {
    const keys = unlockWithPassword(header, masterPassword);
    wipe(keys.vk);
    wipe(keys.bk);
    return true;
  } catch {
    return false;
  }
}

// ---- Recovery key ----------------------------------------------------------
// 128-bit random key, shown once as 26 Crockford-base32 characters grouped for
// print (ABCDE-FGHJK-…). Expanded to a 256-bit wrapping key via BLAKE2b.

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function formatRecoveryKey(bytes: Uint8Array): string {
  // 16 bytes = 128 bits → 26 base32 chars (last char carries 3 bits of padding zeros)
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(acc << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join("-");
}

export function parseRecoveryKey(text: string): Uint8Array {
  const clean = text
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1"); // Crockford confusable mapping
  if (clean.length !== 26) throw new WrongCredentialError("recovery-key");
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) throw new WrongCredentialError("recovery-key");
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out.slice(0, 16));
}

function recoveryWrappingKey(recoveryBytes: Uint8Array): Uint8Array {
  return deriveSubkey(recoveryBytes, "recovery-wrap");
}

/**
 * Create (or rotate) the recovery key. Requires unlocked keys — so a lost recovery key is
 * replaceable only while the user can still unlock the vault, per spec. Returns the new
 * header and the one-time-display recovery key string.
 */
export function setupRecoveryKey(
  header: VaultHeader,
  keys: UnlockedKeys,
  now: string,
): { header: VaultHeader; recoveryKey: string } {
  const recBytes = randomBytes(16);
  const wrap = recoveryWrappingKey(recBytes);
  const newHeader: VaultHeader = {
    ...header,
    vkEnvelopes: { ...header.vkEnvelopes, recovery: encrypt(keys.vk, wrap, AD_VK_REC) },
    bkEnvelopes: { ...header.bkEnvelopes, recovery: encrypt(keys.bk, wrap, AD_BK_REC) },
    recovery: { keyId: toB64(deriveSubkey(recBytes, "recovery-id").slice(0, 6)), createdAt: now },
  };
  const recoveryKey = formatRecoveryKey(recBytes);
  wipe(wrap);
  wipe(recBytes);
  return { header: newHeader, recoveryKey };
}

export function unlockWithRecoveryKey(header: VaultHeader, recoveryKeyText: string): UnlockedKeys {
  if (!header.vkEnvelopes.recovery || !header.bkEnvelopes.recovery)
    throw new WrongCredentialError("recovery-key");
  const recBytes = parseRecoveryKey(recoveryKeyText);
  const wrap = recoveryWrappingKey(recBytes);
  wipe(recBytes);
  try {
    const vk = decrypt(header.vkEnvelopes.recovery, wrap, AD_VK_REC);
    const bk = decrypt(header.bkEnvelopes.recovery, wrap, AD_BK_REC);
    return { vk, bk };
  } catch {
    throw new WrongCredentialError("recovery-key");
  } finally {
    wipe(wrap);
  }
}

/**
 * Set a new master password (used after recovery-key unlock, or a normal password change).
 * Fresh salt, fresh KEK; VK/BK are re-wrapped, so all item ciphertexts stay untouched.
 */
export function rewrapWithNewPassword(
  header: VaultHeader,
  keys: UnlockedKeys,
  newPassword: string,
): VaultHeader {
  const kdf = newKdfParams();
  const kek = deriveKek(newPassword, kdf);
  const newHeader: VaultHeader = {
    ...header,
    kdf,
    vkEnvelopes: { ...header.vkEnvelopes, kek: encrypt(keys.vk, kek, AD_VK_KEK) },
    bkEnvelopes: { ...header.bkEnvelopes, kek: encrypt(keys.bk, kek, AD_BK_KEK) },
  };
  wipe(kek);
  return newHeader;
}

export function hasRecovery(header: VaultHeader): boolean {
  return !!header.recovery && !!header.vkEnvelopes.recovery;
}

export { fromB64, toB64 };
