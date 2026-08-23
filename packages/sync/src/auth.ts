// Server authentication credential. See SYNC-DESIGN.md §4.
//
// The server must be able to authenticate the account without ever holding anything that
// could decrypt the vault:
//
//   master password + salt --Argon2id--> KEK          (never leaves the device)
//   KEK --BLAKE2b "server-auth"-------->  authToken   (sent over TLS)
//   server stores Argon2id(authToken, server_salt)    (slow hash at rest)
//
// deriveSubkey is one-way, so a full server-database compromise yields a slow hash of a
// value that cannot reconstruct the KEK, let alone the Vault Key.
import { type KdfParams, deriveKek, deriveSubkey, toB64, wipe } from "@pw/core";

/** Domain separation context. Changing this string invalidates every account's credential. */
const AUTH_CONTEXT = "server-auth";

/**
 * Derive the server auth token from the master password. Runs Argon2id, so call it once at
 * unlock and keep the result in memory for the session — never persist it.
 */
export function deriveAuthToken(masterPassword: string, kdf: KdfParams): string {
  const kek = deriveKek(masterPassword, kdf);
  try {
    const token = deriveSubkey(kek, AUTH_CONTEXT);
    const b64 = toB64(token);
    wipe(token);
    return b64;
  } finally {
    wipe(kek);
  }
}

/**
 * Session credentials held in MEMORY ONLY, for as long as the vault is unlocked.
 *
 * Deliberately not persisted: the project forbids sensitive values in localStorage, and
 * nothing needs to survive a lock. Sync only runs while the vault is unlocked, and unlocking
 * already requires the master password — from which the auth token is re-derived. So there
 * is no refresh token to steal from disk on the web client.
 */
export interface SyncSession {
  accountId: string;
  accessToken: string;
  /** Epoch ms at which accessToken expires; re-login before this. */
  expiresAt: number;
  /** Kept in memory so the session can be renewed without re-prompting for the password. */
  authTokenB64: string;
}

export function isExpired(session: SyncSession, nowMs: number, skewMs = 30_000): boolean {
  return nowMs + skewMs >= session.expiresAt;
}
