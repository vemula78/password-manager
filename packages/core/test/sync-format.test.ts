// V2 vault-file behaviour that multi-device sync depends on: stable per-item ciphertext,
// deletion tombstones, and transparent v1 → v2 migration. See SYNC-DESIGN.md §3.
import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "../src/crypto";
import { TOMBSTONE_RETENTION_DAYS } from "../src/model";
import { StorageAdapter, VaultStore, parseVaultFile } from "../src/vault";

beforeAll(async () => {
  await initCrypto();
});

function memStorage(): StorageAdapter & { data: string | null } {
  const s = {
    data: null as string | null,
    async save(serialized: string) {
      s.data = serialized;
    },
  };
  return s;
}

let tick = 0;
const now = () => new Date(1770000000000 + tick++ * 1000).toISOString();
const PW = "correct horse battery staple 42";

async function vaultWithTwoItems() {
  const storage = memStorage();
  const store = await VaultStore.create(PW, storage, { now, deviceId: "device-A" });
  const a = await store.addItem({ type: "login", title: "Alpha", fields: { password: "aaa" } });
  const b = await store.addItem({ type: "login", title: "Beta", fields: { password: "bbb" } });
  return { storage, store, a, b };
}

const ctOf = (serialized: string, id: string) =>
  parseVaultFile(serialized).items.find((i) => i.id === id)!.ct.ctB64;

describe("per-item ciphertext stability (enables per-item sync)", () => {
  it("editing one item leaves the other item's ciphertext byte-identical", async () => {
    const { storage, store, a, b } = await vaultWithTwoItems();
    const beforeA = ctOf(storage.data!, a.id);
    const beforeB = ctOf(storage.data!, b.id);

    await store.updateItem(a.id, { fields: { password: "changed" } });

    expect(ctOf(storage.data!, a.id)).not.toBe(beforeA); // edited → fresh nonce, new ct
    expect(ctOf(storage.data!, b.id)).toBe(beforeB); // untouched → must not churn
  });

  it("a save that changes nothing does not churn any ciphertext", async () => {
    const { storage, store, a, b } = await vaultWithTwoItems();
    const before = storage.data!;
    await store.updateSettings({ autoLockMinutes: 9 });
    expect(ctOf(storage.data!, a.id)).toBe(ctOf(before, a.id));
    expect(ctOf(storage.data!, b.id)).toBe(ctOf(before, b.id));
  });

  it("reopening a vault keeps ciphertext stable (cache is seeded from the file)", async () => {
    const { storage, a } = await vaultWithTwoItems();
    const before = ctOf(storage.data!, a.id);
    const reopened = await VaultStore.open(storage.data!, { password: PW }, storage, {
      now,
      deviceId: "device-A",
    });
    await reopened.updateSettings({ autoLockMinutes: 3 }); // forces a persist
    expect(ctOf(storage.data!, a.id)).toBe(before);
  });

  it("getItemCiphertexts round-trips through decryptItem", async () => {
    const { store, a } = await vaultWithTwoItems();
    const env = store.getItemCiphertexts().find((e) => e.id === a.id)!;
    expect(store.decryptItem(a.id, env.ct).fields.password).toBe("aaa");
  });

  it("refuses a ciphertext transplanted onto a different item id", async () => {
    const { store, a, b } = await vaultWithTwoItems();
    const ctA = store.getItemCiphertexts().find((e) => e.id === a.id)!.ct;
    // Associated data binds ct to its item id, so this must fail authentication.
    expect(() => store.decryptItem(b.id, ctA)).toThrow();
  });
});

describe("deletion tombstones", () => {
  it("records a tombstone with the deleting device, not a silent drop", async () => {
    const { storage, store, a } = await vaultWithTwoItems();
    await store.deleteItem(a.id);

    const tombs = store.getDeletions();
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.id).toBe(a.id);
    expect(tombs[0]!.deviceId).toBe("device-A");
    expect(parseVaultFile(storage.data!).deletions).toHaveLength(1);
  });

  it("survives a lock/reopen cycle", async () => {
    const { storage, store, a } = await vaultWithTwoItems();
    await store.deleteItem(a.id);
    const reopened = await VaultStore.open(storage.data!, { password: PW }, storage, {
      now,
      deviceId: "device-A",
    });
    expect(reopened.getDeletions().map((d) => d.id)).toEqual([a.id]);
  });

  it("re-creating an item with the same id clears its tombstone", async () => {
    const { store, a } = await vaultWithTwoItems();
    await store.deleteItem(a.id);
    expect(store.getDeletions()).toHaveLength(1);
    // applyMerge is the resurrection path used by sync; addItem covers the local path.
    await store.applyMerge([...store.listItems(), { ...a, id: a.id }], [], [a.id]);
    expect(store.getItem(a.id)).toBeDefined();
  });

  it("garbage-collects tombstones older than the retention window on open", async () => {
    // Delete with a clock set well before the retention window, then reopen with the real
    // clock. Sealing means the tombstone cannot be hand-written into the file any more.
    const storage = memStorage();
    const ancient = () =>
      new Date(Date.now() - (TOMBSTONE_RETENTION_DAYS + 5) * 86_400_000).toISOString();
    const old = await VaultStore.create(PW, storage, { now: ancient, deviceId: "device-A" });
    const item = await old.addItem({ type: "login", title: "Gone", fields: {} });
    await old.deleteItem(item.id);
    expect(old.getDeletions()).toHaveLength(1);

    const reopened = await VaultStore.open(storage.data!, { password: PW }, storage, {
      now: () => new Date().toISOString(),
      deviceId: "device-A",
    });
    expect(reopened.getDeletions()).toHaveLength(0);
  });

  it("ignores a forged tombstone and warns instead of deleting anything", async () => {
    // A malicious server's core capability: inventing a deletion for an item it can see.
    const { storage, store, a } = await vaultWithTwoItems();
    const file = parseVaultFile(storage.data!);
    file.deletions = [{ id: a.id, ct: { nonceB64: "AAAA", ctB64: "BBBB" } }];

    const reopened = await VaultStore.open(JSON.stringify(file), { password: PW }, storage, {
      now,
      deviceId: "device-A",
    });
    expect(reopened.getDeletions()).toHaveLength(0);
    expect(reopened.getItem(a.id)).toBeDefined(); // the credential survives
    expect(reopened.getIntegrityWarnings().join(" ")).toMatch(/failed their integrity check/i);
  });

  it("rejects a valid tombstone transplanted onto a different item id", async () => {
    const { store, a, b } = await vaultWithTwoItems();
    await store.deleteItem(a.id);
    const sealed = store.getSealedDeletions()[0]!;
    expect(() => store.openSealedTombstone({ id: b.id, ct: sealed.ct })).toThrow();
  });
});

describe("v1 → v2 migration", () => {
  it("opens a pre-sync v1 file that has no fileVersion and no deletions", async () => {
    const { storage, a } = await vaultWithTwoItems();
    const file = parseVaultFile(storage.data!);
    delete file.fileVersion;
    delete file.deletions;
    const v1 = JSON.stringify(file);

    const store = await VaultStore.open(v1, { password: PW }, storage, { now, deviceId: "device-B" });
    expect(store.getDeletions()).toEqual([]);
    expect(store.getItem(a.id)!.fields.password).toBe("aaa");

    // and it is written back as v2
    await store.updateSettings({ autoLockMinutes: 7 });
    expect(parseVaultFile(storage.data!).fileVersion).toBe(2);
  });

  it("defaults deviceId to 'local' when no options are given (single-device vaults)", async () => {
    const storage = memStorage();
    const store = await VaultStore.create(PW, storage, now);
    expect(store.getDeviceId()).toBe("local");
  });
});

describe("accessors cannot corrupt the ciphertext cache", () => {
  // Regression for the independent review's "stale ciphertext" finding: a caller that
  // mutates a returned item must not be able to make serialize() emit stale ciphertext
  // while the in-memory value looks updated.
  it("mutating an item returned by getItem does not change vault state", async () => {
    const { storage, store, a } = await vaultWithTwoItems();
    const before = ctOf(storage.data!, a.id);

    const item = store.getItem(a.id)!;
    item.fields.password = "tampered";
    item.title = "tampered";

    expect(store.getItem(a.id)!.fields.password).toBe("aaa");
    await store.updateSettings({ autoLockMinutes: 4 }); // force a persist
    expect(ctOf(storage.data!, a.id)).toBe(before);
  });

  it("mutating an item returned by listItems does not change vault state", async () => {
    const { store, a } = await vaultWithTwoItems();
    const listed = store.listItems().find((i) => i.id === a.id)!;
    listed.fields.password = "tampered";
    expect(store.getItem(a.id)!.fields.password).toBe("aaa");
  });

  it("mutating the input passed to addItem does not change vault state", async () => {
    const { store } = await vaultWithTwoItems();
    const fields = { password: "original" };
    const created = await store.addItem({ type: "login", title: "Gamma", fields });
    fields.password = "tampered";
    expect(store.getItem(created.id)!.fields.password).toBe("original");
  });
});
