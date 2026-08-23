// Wire protocol between a client device and the self-hosted sync server.
// See SYNC-DESIGN.md. The server treats every `ct` as opaque bytes: it performs no crypto
// on vault content and cannot decrypt anything here.
import type { Ciphertext, SealedTombstone, VaultHeader } from "@pw/core";

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

/**
 * `GET /vault/changes?since=<rev>&sinceHeader=<headerRev>`.
 *
 * `since` and `sinceHeader` are DIFFERENT counters (review §3): the account/item revision is
 * bumped by item pushes, the header revision only by header pushes. Comparing one against the
 * other means a header rotation is never delivered to a device that has pushed items since.
 * The client therefore tracks both and submits both; the server compares like for like.
 */
export interface ChangesResponse {
  rev: Rev;
  /** Present only when `headerRev > sinceHeader`. */
  header?: VaultHeader;
  headerRev: Rev;
  items: ItemEnvelope[];
  /**
   * SEALED tombstones (review §1). A plaintext tombstone is a deletion instruction the
   * client cannot authenticate, so a malicious server could forge one per item id and make
   * every device destroy the credential. Only the id is in the clear; the deletion time and
   * originating device are AEAD-encrypted under the Vault Key with `tombstone:{id}` bound in
   * as associated data, so a forged or transplanted tombstone fails to open.
   */
  deletions: SealedTombstone[];
}

export interface PushRequest {
  /** The rev this push is based on. Server rejects with 409 if it has moved on. */
  baseRev: Rev;
  items: { id: string; ct: Ciphertext }[];
  deletions: SealedTombstone[];
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

/**
 * Something the server sent could not be authenticated or parsed. This ABORTS the whole sync
 * cycle (review §6): the previous behaviour — warn, skip the bad item, commit everything else
 * and advance `lastSyncRev` — meant a server could corrupt one newly-created item once and
 * that credential would be permanently absent on this device, because a later pull from the
 * advanced revision would never mention it again. Nothing is applied, no revision moves, and
 * the next sync retries from exactly the same revision.
 */
export interface IntegrityFailure {
  kind: "item" | "tombstone";
  id: string;
  reason: string;
}

export class SyncIntegrityError extends Error {
  constructor(readonly failures: IntegrityFailure[]) {
    super(
      `The sync server returned ${failures.length} object(s) that failed their integrity check ` +
        `(${failures.map((f) => `${f.kind} ${f.id.slice(0, 8)}\u2026`).join(", ")}). ` +
        "This means corrupted or TAMPERED data \u2014 possibly a forged deletion. " +
        "Nothing was applied and no local data was changed or removed.",
    );
    this.name = "SyncIntegrityError";
  }
}

/** 409 on POST /vault/header: another device rotated the password first. Never merge headers. */
export class SyncHeaderConflictError extends Error {
  constructor(readonly serverHeaderRev: Rev) {
    super(
      `The sync server's vault header is at revision ${serverHeaderRev}; this device tried to ` +
        "overwrite an older one. The master password may have been changed on another device. " +
        "Sync, unlock with the current password, and retry \u2014 the server was NOT updated.",
    );
    this.name = "SyncHeaderConflictError";
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
