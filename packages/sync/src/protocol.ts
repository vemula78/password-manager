// Wire protocol between a client device and the self-hosted sync server.
// See SYNC-DESIGN.md. The server treats every `ct` as opaque bytes: it performs no crypto
// on vault content and cannot decrypt anything here.
import type { Ciphertext, Tombstone, VaultHeader } from "@pw/core";

export const PROTOCOL_VERSION = 1;

/** Monotonic per-account revision, assigned by the server inside the push transaction. */
export type Rev = number;

export interface ItemEnvelope {
  id: string;
  ct: Ciphertext;
  /**
   * Server-assigned revision at which this ciphertext landed. Deliberately NO plaintext
   * updatedAt on the wire: the merge runs client-side on decrypted items, so exposing
   * per-item edit timestamps to the server would leak metadata for no benefit.
   */
  rev: Rev;
}

// ---- auth -------------------------------------------------------------------

/**
 * Unauthenticated: the client needs the KDF salt to derive the KEK before it can prove
 * anything. Returns a plausible dummy for unknown accounts so this cannot enumerate
 * accounts. Rate-limited server-side.
 */
export interface KdfInfoResponse {
  kdf: VaultHeader["kdf"];
}

export interface RegisterRequest {
  label: string;
  kdf: VaultHeader["kdf"];
  /** deriveSubkey(KEK, "server-auth"), base64. The server stores only a slow hash of it. */
  authTokenB64: string;
  header: VaultHeader;
  deviceId: string;
  deviceLabel: string;
}

export interface LoginRequest {
  accountId: string;
  authTokenB64: string;
  deviceId: string;
  deviceLabel: string;
}

export interface SessionResponse {
  accountId: string;
  accessToken: string;
  /** Seconds until accessToken expires. */
  expiresIn: number;
  refreshToken: string;
}

// ---- sync -------------------------------------------------------------------

export interface ChangesResponse {
  rev: Rev;
  /** Present only when the header changed since `since`. */
  header?: VaultHeader;
  headerRev: Rev;
  items: ItemEnvelope[];
  deletions: Tombstone[];
  settings?: Ciphertext;
}

export interface PushRequest {
  /** The rev this push is based on. Server rejects with 409 if it has moved on. */
  baseRev: Rev;
  items: { id: string; ct: Ciphertext }[];
  deletions: Tombstone[];
  settings?: Ciphertext;
}

export interface PushResponse {
  rev: Rev;
}

export interface HeaderPushRequest {
  /** Compare-and-set: header changes (password / recovery rotation) must never merge. */
  baseHeaderRev: Rev;
  header: VaultHeader;
  /** Present when the master password changed, so the auth credential rotates atomically. */
  newAuthTokenB64?: string;
  newKdf?: VaultHeader["kdf"];
}

export interface ErrorResponse {
  error: string;
  /** Set on 409 so the client knows to re-pull before retrying. */
  serverRev?: Rev;
}

export class SyncConflictError extends Error {
  constructor(readonly serverRev: Rev) {
    super("The server has newer changes; re-pull and merge before pushing.");
    this.name = "SyncConflictError";
  }
}

export class SyncAuthError extends Error {
  constructor(message = "Sync authentication failed.") {
    super(message);
    this.name = "SyncAuthError";
  }
}

export class RollbackDetectedError extends Error {
  constructor(readonly seenRev: Rev, readonly offeredRev: Rev) {
    super(
      `The sync server offered revision ${offeredRev} but this device has already seen ${seenRev}. ` +
        "The server may be withholding or rolling back changes. Refusing to apply.",
    );
    this.name = "RollbackDetectedError";
  }
}
