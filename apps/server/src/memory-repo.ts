// In-memory SyncRepository implementation, used by tests (no live Postgres required) and
// usable as a lightweight standalone mode. Mirrors the transactional semantics of the pg
// implementation exactly, including the atomic header+auth-hash rotation.
import type { KdfParams, VaultHeader } from "@pw/core";
import {
  AccountRow,
  DeletionRow,
  DeviceRow,
  HeaderConflictError,
  ItemRow,
  PushInput,
  PushResult,
  RevConflictError,
  SyncRepository,
} from "./repo.js";

interface InternalAccount extends AccountRow {
  items: Map<string, ItemRow>;
  deletions: Map<string, DeletionRow>;
}

export class InMemorySyncRepository implements SyncRepository {
  private accounts = new Map<string, InternalAccount>();
  private devices = new Map<string, DeviceRow>(); // key: accountId:deviceId

  private deviceKey(accountId: string, deviceId: string): string {
    return `${accountId}:${deviceId}`;
  }

  async createAccount(input: {
    id: string;
    label: string;
    kdfSalt: string;
    kdf: KdfParams;
    authHash: string;
    header: VaultHeader;
  }): Promise<void> {
    if (this.accounts.has(input.id)) throw new Error("account already exists");
    this.accounts.set(input.id, {
      id: input.id,
      label: input.label,
      kdfSalt: input.kdfSalt,
      kdf: input.kdf,
      authHash: input.authHash,
      header: input.header,
      headerRev: 0,
      rev: 0,
      createdAt: new Date().toISOString(),
      items: new Map(),
      deletions: new Map(),
    });
  }

  async hasAnyAccount(): Promise<boolean> {
    return this.accounts.size > 0;
  }

  async getAccount(accountId: string): Promise<AccountRow | undefined> {
    const a = this.accounts.get(accountId);
    if (!a) return undefined;
    const { items: _items, deletions: _deletions, ...row } = a;
    return { ...row };
  }

  async upsertDevice(accountId: string, deviceId: string, label: string): Promise<void> {
    const key = this.deviceKey(accountId, deviceId);
    const existing = this.devices.get(key);
    this.devices.set(key, {
      accountId,
      deviceId,
      label,
      refreshHash: existing?.refreshHash ?? null,
      lastSeen: new Date().toISOString(),
    });
  }

  async getDevice(accountId: string, deviceId: string): Promise<DeviceRow | undefined> {
    return this.devices.get(this.deviceKey(accountId, deviceId));
  }

  async setDeviceRefreshHash(
    accountId: string,
    deviceId: string,
    refreshHash: string | null,
  ): Promise<void> {
    const key = this.deviceKey(accountId, deviceId);
    const d = this.devices.get(key);
    if (!d) throw new Error("device not found");
    d.refreshHash = refreshHash;
  }

  async deleteDevice(accountId: string, deviceId: string): Promise<void> {
    this.devices.delete(this.deviceKey(accountId, deviceId));
  }

  async getChangesSince(accountId: string, since: number, sinceHeader: number) {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("account not found");
    const items = [...a.items.values()].filter((i) => i.rev > since);
    const deletions = [...a.deletions.values()].filter((d) => d.rev > since);
    return {
      rev: a.rev,
      headerRev: a.headerRev,
      // headerRev is a SEPARATE counter from the item revision `since` — compare like-for-like.
      header: a.headerRev > sinceHeader ? a.header : undefined,
      items,
      deletions,
    };
  }

  async pushChanges(accountId: string, baseRev: number, input: PushInput): Promise<PushResult> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("account not found");
    if (baseRev !== a.rev) throw new RevConflictError(a.rev);

    const nextRev = a.rev + 1;
    for (const item of input.items) {
      a.items.set(item.id, {
        itemId: item.id,
        ct: item.ct,
        updatedAt: new Date().toISOString(),
        rev: nextRev,
      });
      // A push that re-adds an item implicitly supersedes any tombstone for it.
      a.deletions.delete(item.id);
    }
    for (const del of input.deletions) {
      a.deletions.set(del.id, { ...del, rev: nextRev });
      a.items.delete(del.id);
    }
    a.rev = nextRev;
    return { rev: a.rev };
  }

  async pushHeader(
    accountId: string,
    baseHeaderRev: number,
    header: VaultHeader,
    newAuthHash?: string,
  ): Promise<{ headerRev: number }> {
    const a = this.accounts.get(accountId);
    if (!a) throw new Error("account not found");
    if (baseHeaderRev !== a.headerRev) throw new HeaderConflictError(a.headerRev);

    // Atomic in the sense that both fields update together or neither does — there is no
    // await between them, so no other request can observe a half-applied state.
    a.header = header;
    a.headerRev = a.headerRev + 1;
    if (newAuthHash !== undefined) {
      a.authHash = newAuthHash;
    }
    return { headerRev: a.headerRev };
  }
}
