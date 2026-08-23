// Postgres implementation of SyncRepository. Not exercised by the test suite (no live DB
// in CI) — kept structurally identical to memory-repo.ts so route logic behaves the same
// against either. `ct`/`header` values pass through as jsonb verbatim; never parsed here.
import type pg from "pg";
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

export class PgSyncRepository implements SyncRepository {
  constructor(private pool: pg.Pool) {}

  async createAccount(input: {
    id: string;
    label: string;
    kdfSalt: string;
    kdf: KdfParams;
    authHash: string;
    header: VaultHeader;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO accounts (id, label, kdf_salt, auth_hash, header, header_rev, rev)
       VALUES ($1, $2, $3, $4, $5, 0, 0)`,
      [input.id, input.label, Buffer.from(input.kdfSalt, "base64"), input.authHash, input.header],
    );
  }

  async hasAnyAccount(): Promise<boolean> {
    const res = await this.pool.query(`SELECT 1 FROM accounts LIMIT 1`);
    return res.rows.length > 0;
  }

  async getAccount(accountId: string): Promise<AccountRow | undefined> {
    const res = await this.pool.query(
      `SELECT id, label, kdf_salt, auth_hash, header, header_rev, rev, created_at
       FROM accounts WHERE id = $1`,
      [accountId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    const header: VaultHeader = row.header;
    return {
      id: row.id,
      label: row.label,
      kdfSalt: (row.kdf_salt as Buffer).toString("base64"),
      kdf: header.kdf,
      authHash: row.auth_hash,
      header,
      headerRev: Number(row.header_rev),
      rev: Number(row.rev),
      createdAt: row.created_at.toISOString(),
    };
  }

  async upsertDevice(accountId: string, deviceId: string, label: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO devices (account_id, device_id, label, last_seen)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (account_id, device_id)
       DO UPDATE SET label = EXCLUDED.label, last_seen = now()`,
      [accountId, deviceId, label],
    );
  }

  async getDevice(accountId: string, deviceId: string): Promise<DeviceRow | undefined> {
    const res = await this.pool.query(
      `SELECT account_id, device_id, label, refresh_hash, last_seen
       FROM devices WHERE account_id = $1 AND device_id = $2`,
      [accountId, deviceId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return {
      accountId: row.account_id,
      deviceId: row.device_id,
      label: row.label,
      refreshHash: row.refresh_hash,
      lastSeen: row.last_seen.toISOString(),
    };
  }

  async setDeviceRefreshHash(
    accountId: string,
    deviceId: string,
    refreshHash: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE devices SET refresh_hash = $3 WHERE account_id = $1 AND device_id = $2`,
      [accountId, deviceId, refreshHash],
    );
  }

  async deleteDevice(accountId: string, deviceId: string): Promise<void> {
    await this.pool.query(`DELETE FROM devices WHERE account_id = $1 AND device_id = $2`, [
      accountId,
      deviceId,
    ]);
  }

  async getChangesSince(accountId: string, since: number, sinceHeader: number) {
    const client = await this.pool.connect();
    try {
      const acctRes = await client.query(
        `SELECT rev, header_rev, header FROM accounts WHERE id = $1`,
        [accountId],
      );
      const acct = acctRes.rows[0];
      if (!acct) throw new Error("account not found");

      const itemsRes = await client.query(
        `SELECT item_id, ct, updated_at, rev FROM items WHERE account_id = $1 AND rev > $2`,
        [accountId, since],
      );
      const delRes = await client.query(
        `SELECT item_id, ct, rev FROM deletions WHERE account_id = $1 AND rev > $2`,
        [accountId, since],
      );

      const items: ItemRow[] = itemsRes.rows.map((r) => ({
        itemId: r.item_id,
        ct: r.ct,
        updatedAt: r.updated_at.toISOString(),
        rev: Number(r.rev),
      }));
      // ct is opaque: a sealed tombstone under the vault key. Never inspected server-side.
      const deletions: DeletionRow[] = delRes.rows.map((r) => ({
        id: r.item_id,
        ct: r.ct,
        rev: Number(r.rev),
      }));

      return {
        rev: Number(acct.rev),
        headerRev: Number(acct.header_rev),
        // headerRev is a SEPARATE counter from the item revision `since` — compare like-for-like.
        header: Number(acct.header_rev) > sinceHeader ? (acct.header as VaultHeader) : undefined,
        items,
        deletions,
      };
    } finally {
      client.release();
    }
  }

  async pushChanges(accountId: string, baseRev: number, input: PushInput): Promise<PushResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `SELECT rev FROM accounts WHERE id = $1 FOR UPDATE`,
        [accountId],
      );
      const row = res.rows[0];
      if (!row) throw new Error("account not found");
      const currentRev = Number(row.rev);
      if (currentRev !== baseRev) {
        await client.query("ROLLBACK");
        throw new RevConflictError(currentRev);
      }

      const nextRev = currentRev + 1;
      for (const item of input.items) {
        await client.query(
          `INSERT INTO items (account_id, item_id, ct, updated_at, rev)
           VALUES ($1, $2, $3, now(), $4)
           ON CONFLICT (account_id, item_id)
           DO UPDATE SET ct = EXCLUDED.ct, updated_at = now(), rev = EXCLUDED.rev`,
          [accountId, item.id, item.ct, nextRev],
        );
        await client.query(`DELETE FROM deletions WHERE account_id = $1 AND item_id = $2`, [
          accountId,
          item.id,
        ]);
      }
      for (const del of input.deletions) {
        await client.query(
          `INSERT INTO deletions (account_id, item_id, ct, rev)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (account_id, item_id)
           DO UPDATE SET ct = EXCLUDED.ct, rev = EXCLUDED.rev`,
          [accountId, del.id, del.ct, nextRev],
        );
        await client.query(`DELETE FROM items WHERE account_id = $1 AND item_id = $2`, [
          accountId,
          del.id,
        ]);
      }
      await client.query(`UPDATE accounts SET rev = $2 WHERE id = $1`, [accountId, nextRev]);
      await client.query("COMMIT");
      return { rev: nextRev };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async pushHeader(
    accountId: string,
    baseHeaderRev: number,
    header: VaultHeader,
    newAuthHash?: string,
  ): Promise<{ headerRev: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `SELECT header_rev FROM accounts WHERE id = $1 FOR UPDATE`,
        [accountId],
      );
      const row = res.rows[0];
      if (!row) throw new Error("account not found");
      const currentHeaderRev = Number(row.header_rev);
      if (currentHeaderRev !== baseHeaderRev) {
        await client.query("ROLLBACK");
        throw new HeaderConflictError(currentHeaderRev);
      }
      const nextHeaderRev = currentHeaderRev + 1;
      // Header write and auth-hash rotation happen in the same statement/transaction so a
      // master-password change can never leave the account locked out.
      if (newAuthHash !== undefined) {
        await client.query(
          `UPDATE accounts SET header = $2, header_rev = $3, auth_hash = $4 WHERE id = $1`,
          [accountId, header, nextHeaderRev, newAuthHash],
        );
      } else {
        await client.query(
          `UPDATE accounts SET header = $2, header_rev = $3 WHERE id = $1`,
          [accountId, header, nextHeaderRev],
        );
      }
      await client.query("COMMIT");
      return { headerRev: nextHeaderRev };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}
