// Repository interface: the only thing routes depend on. Two implementations —
// an in-memory one (tests, no live Postgres needed) and a pg one (production).
// The server never inspects the shape of `ct`/`header` — they are passed through as
// opaque JSON values (the `unknown` type reflects that; routes must not narrow it).
import type { Ciphertext, KdfParams, VaultHeader, Tombstone } from "@pw/core";

export interface AccountRow {
  id: string;
  label: string;
  kdfSalt: string; // base64
  kdf: KdfParams;
  authHash: string; // argon2id PHC string
  header: VaultHeader;
  headerRev: number;
  rev: number;
  createdAt: string;
}

export interface ItemRow {
  itemId: string;
  ct: Ciphertext;
  updatedAt: string;
  rev: number;
}

export interface DeletionRow extends Tombstone {
  rev: number;
}

export interface DeviceRow {
  accountId: string;
  deviceId: string;
  label: string;
  refreshHash: string | null;
  lastSeen: string;
}

export interface PushInput {
  items: { id: string; ct: Ciphertext }[];
  deletions: Tombstone[];
  settings?: Ciphertext;
}

export interface PushResult {
  rev: number;
}

/** Thrown by pushChanges when baseRev doesn't match the current server rev. */
export class RevConflictError extends Error {
  constructor(readonly serverRev: number) {
    super("baseRev does not match current server rev");
    this.name = "RevConflictError";
  }
}

/** Thrown by pushHeader when baseHeaderRev doesn't match the current header rev. */
export class HeaderConflictError extends Error {
  constructor(readonly serverHeaderRev: number) {
    super("baseHeaderRev does not match current header rev");
    this.name = "HeaderConflictError";
  }
}

export interface SyncRepository {
  createAccount(input: {
    id: string;
    label: string;
    kdfSalt: string;
    kdf: KdfParams;
    authHash: string;
    header: VaultHeader;
  }): Promise<void>;

  getAccount(accountId: string): Promise<AccountRow | undefined>;

  upsertDevice(accountId: string, deviceId: string, label: string): Promise<void>;
  getDevice(accountId: string, deviceId: string): Promise<DeviceRow | undefined>;
  setDeviceRefreshHash(accountId: string, deviceId: string, refreshHash: string | null): Promise<void>;
  deleteDevice(accountId: string, deviceId: string): Promise<void>;

  /** Everything changed strictly after `since`. */
  getChangesSince(
    accountId: string,
    since: number,
  ): Promise<{
    rev: number;
    headerRev: number;
    header?: VaultHeader;
    items: ItemRow[];
    deletions: DeletionRow[];
    settings?: Ciphertext;
  }>;

  /**
   * Single transaction: reject with RevConflictError if baseRev != current rev, else bump
   * rev and apply items + deletions atomically.
   */
  pushChanges(accountId: string, baseRev: number, input: PushInput): Promise<PushResult>;

  /**
   * Strict compare-and-set on headerRev. When newAuthHash is provided, the auth hash is
   * rotated in the SAME transaction as the header write — a master-password change must
   * never write one without the other.
   */
  pushHeader(
    accountId: string,
    baseHeaderRev: number,
    header: VaultHeader,
    newAuthHash?: string,
  ): Promise<{ headerRev: number }>;
}
