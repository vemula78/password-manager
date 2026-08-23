// Manual: exercises the real Postgres repository over real HTTP against a running
// `docker compose up` stack. Not part of `npm test` (no DB in CI) — pg-repo.ts is
// otherwise never executed by any suite. Run explicitly against a throwaway stack.
import { beforeAll, describe, expect, it } from "vitest";
import { type StorageAdapter, VaultStore, createBackup, initCrypto, restoreBackup } from "@pw/core";
import { SyncClient, deriveAuthToken, type SyncBase } from "@pw/sync";

const URL_ = process.env.LIVE_SERVER ?? "http://127.0.0.1:8787";
const PW = "correct horse battery staple 42";

beforeAll(async () => { await initCrypto(); });

function memStorage(): StorageAdapter & { data: string | null } {
  const s = { data: null as string | null, async save(x: string) { s.data = x; } };
  return s;
}
let clock = 1_770_000_000_000;
const tick = (ms = 1000) => { clock += ms; return new Date(clock).toISOString(); };

describe("live Postgres backend", () => {
  it("two devices sync through the real pg repository", async () => {
    const storageA = memStorage();
    const storeA = await VaultStore.create(PW, storageA, { now: tick, deviceId: "device-A" });
    const authToken = deriveAuthToken(PW, storeA.getHeader().kdf);

    const mk = (id: string, label: string) =>
      new SyncClient({ fetch, serverUrl: URL_, deviceId: id, deviceLabel: label, now: () => tick(0) });

    const cA = mk("device-A", "Mac Chrome");
    const accountId = await cA.register("Mac Chrome", authToken, storeA);
    expect(accountId).toMatch(/^[0-9a-f-]{36}$/);

    const backup = createBackup(storeA, tick());
    const { vaultSerialized } = restoreBackup(backup, { password: PW });
    const storeB = await VaultStore.open(vaultSerialized, { password: PW }, memStorage(), {
      now: tick, deviceId: "device-B",
    });
    const cB = mk("device-B", "iPhone Safari");
    await cB.login(accountId, authToken);

    let sA = { lastSyncRev: 0, highestSeenRev: 0 }, bA: SyncBase = {};
    let sB = { lastSyncRev: 0, highestSeenRev: 0 }, bB: SyncBase = {};

    await storeA.addItem({ type: "login", title: "Gmail", fields: { username: "p@x.in", password: "s3cret" } });
    let r = await cA.sync(storeA, sA, bA); sA = r.state; bA = r.base;

    r = await cB.sync(storeB, sB, bB); sB = r.state; bB = r.base;
    const got = storeB.listItems().find((i) => i.title === "Gmail");
    expect(got?.fields.password).toBe("s3cret");

    // B edits, A pulls it back — proves the round trip, not just one direction.
    await storeB.updateItem(got!.id, { fields: { ...got!.fields, password: "rotated" } });
    r = await cB.sync(storeB, sB, bB); sB = r.state; bB = r.base;
    r = await cA.sync(storeA, sA, bA); sA = r.state; bA = r.base;
    expect(storeA.listItems().find((i) => i.title === "Gmail")?.fields.password).toBe("rotated");

    // Deletion must not resurrect on the next pull.
    await storeA.deleteItem(got!.id);
    r = await cA.sync(storeA, sA, bA); sA = r.state; bA = r.base;
    r = await cB.sync(storeB, sB, bB); sB = r.state; bB = r.base;
    expect(storeB.listItems().some((i) => i.title === "Gmail")).toBe(false);
    r = await cB.sync(storeB, sB, bB); sB = r.state; bB = r.base;
    expect(storeB.listItems().some((i) => i.title === "Gmail")).toBe(false);
  }, 60_000);
});
