import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto } from "../src/crypto";
import { WrongCredentialError } from "../src/keys";
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

describe("VaultStore", () => {
  it("creates a vault, adds a netbanking record, and reopens it with the password", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("a strong master passphrase", storage, now);
    await store.addItem({
      type: "netbanking",
      title: "SBI Savings",
      fields: {
        bankName: "State Bank of India",
        customerId: "12345678",
        loginPassword: "login-pw-1",
        transactionPassword: "txn-pw-1",
        mpin: "4821",
        accountNumber: "00000012345678901",
      },
      notes: "Primary salary account",
    });

    const reopened = await VaultStore.open(
      storage.data!,
      { password: "a strong master passphrase" },
      storage,
      now,
    );
    const items = reopened.listItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.fields.mpin).toBe("4821");
    expect(items[0]!.fields.transactionPassword).toBe("txn-pw-1");

    await expect(
      VaultStore.open(storage.data!, { password: "wrong" }, storage, now),
    ).rejects.toThrow(WrongCredentialError);
  });

  it("stores nothing sensitive in plaintext on disk", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    await store.addItem({
      type: "netbanking",
      title: "HDFC Netbanking",
      fields: { loginPassword: "SuperSecret!42", mpin: "9911", customerId: "CUST42" },
      notes: "note-marker-xyzzy",
    });
    const onDisk = storage.data!;
    for (const secret of ["SuperSecret!42", "9911", "CUST42", "HDFC", "note-marker-xyzzy"]) {
      expect(onDisk).not.toContain(secret);
    }
    // Only structural/header fields are visible
    const parsed = parseVaultFile(onDisk);
    expect(parsed.header.kdf.alg).toBe("argon2id13");
  });

  it("keeps item versions and password history on edit", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    const item = await store.addItem({
      type: "login",
      title: "Gmail",
      fields: { username: "praveen", password: "old-pass-1" },
    });
    await store.updateItem(item.id, { fields: { ...item.fields, password: "new-pass-2" } });
    const updated = store.getItem(item.id)!;
    expect(updated.fields.password).toBe("new-pass-2");
    expect(updated.passwordHistory[0]!.value).toBe("old-pass-1");
    expect(updated.versions).toHaveLength(1);
    expect(updated.versions[0]!.fields.password).toBe("old-pass-1");
  });

  it("search covers title/tags/non-sensitive fields but never sensitive values", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    await store.addItem({
      type: "netbanking",
      title: "ICICI",
      tags: ["bank"],
      fields: { bankName: "ICICI Bank", loginPassword: "findme-secret" },
    });
    expect(store.search("icici")).toHaveLength(1);
    expect(store.search("bank")).toHaveLength(1);
    expect(store.search("findme-secret")).toHaveLength(0);
  });

  it("archive hides from default list; restore brings it back; audit log records events", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    const item = await store.addItem({ type: "note", title: "Old note", fields: { body: "x" } });
    await store.setArchived(item.id, true);
    expect(store.listItems()).toHaveLength(0);
    expect(store.listItems({ includeArchived: true })).toHaveLength(1);
    await store.setArchived(item.id, false);
    expect(store.listItems()).toHaveLength(1);

    const types = store.getAudit().map((e) => e.type);
    expect(types).toContain("vault_created");
    expect(types).toContain("item_created");
    expect(types).toContain("item_archived");
    expect(types).toContain("item_restored");
    await store.clearAudit();
    expect(store.getAudit().map((e) => e.type)).toEqual(["history_cleared"]);
  });

  it("recovery key flow: create, unlock with it, rewrap to a new password", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("original-pw", storage, now);
    await store.addItem({ type: "login", title: "Item", fields: { password: "p" } });
    const recoveryKey = await store.createRecoveryKey({ masterPassword: "original-pw" });
    expect(recoveryKey.replace(/-/g, "")).toHaveLength(26);

    const viaRecovery = await VaultStore.open(
      storage.data!,
      { recoveryKey },
      storage,
      now,
    );
    expect(viaRecovery.listItems()).toHaveLength(1);
    await viaRecovery.changeMasterPassword("new-pw");

    const reopened = await VaultStore.open(storage.data!, { password: "new-pw" }, storage, now);
    expect(reopened.listItems()).toHaveLength(1);
    await expect(
      VaultStore.open(storage.data!, { password: "original-pw" }, storage, now),
    ).rejects.toThrow(WrongCredentialError);
  });

  it("rejects a tampered vault file (flipped ciphertext byte)", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    await store.addItem({ type: "login", title: "X", fields: { password: "p" } });
    const file = JSON.parse(storage.data!);
    const ct: string = file.items[0].ct.ctB64;
    file.items[0].ct.ctB64 = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(
      VaultStore.open(JSON.stringify(file), { password: "pw" }, storage, now),
    ).rejects.toThrow();
  });
});
