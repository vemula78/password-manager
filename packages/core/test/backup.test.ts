import { beforeAll, describe, expect, it } from "vitest";
import { backupFileName, createBackup, restoreBackup } from "../src/backup";
import { initCrypto } from "../src/crypto";
import { StorageAdapter, VaultStore } from "../src/vault";

beforeAll(async () => {
  await initCrypto();
});

function memStorage(): StorageAdapter & { data: string | null } {
  const s = {
    data: null as string | null,
    async save(d: string) {
      s.data = d;
    },
  };
  return s;
}

const now = () => "2026-07-10T12:00:00.000Z";

async function vaultWithData() {
  const storage = memStorage();
  const store = await VaultStore.create("master-pw", storage, now);
  await store.addItem({
    type: "netbanking",
    title: "SBI",
    fields: { loginPassword: "bank-secret-1", mpin: "1234" },
  });
  const recoveryKey = await store.createRecoveryKey({ masterPassword: "master-pw" });
  return { store, storage, recoveryKey };
}

describe("encrypted backup", () => {
  it("round-trips: create → restore with master password → open vault", async () => {
    const { store, recoveryKey } = await vaultWithData();
    const pkg = createBackup(store, now());

    const { vaultSerialized } = restoreBackup(pkg, { password: "master-pw" });
    const restored = await VaultStore.open(vaultSerialized, { password: "master-pw" }, memStorage(), now);
    expect(restored.listItems()[0]!.fields.loginPassword).toBe("bank-secret-1");

    // and the same backup also opens with the recovery key
    const viaRk = restoreBackup(pkg, { recoveryKey });
    const restored2 = await VaultStore.open(viaRk.vaultSerialized, { recoveryKey }, memStorage(), now);
    expect(restored2.listItems()[0]!.fields.mpin).toBe("1234");
  });

  it("is unreadable without the master password or recovery key", async () => {
    const { store } = await vaultWithData();
    const pkg = createBackup(store, now());
    expect(() => restoreBackup(pkg, { password: "wrong" })).toThrow();
    expect(() => restoreBackup(pkg, { recoveryKey: "AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA" })).toThrow();
    // no plaintext leaks into the package itself
    expect(pkg).not.toContain("bank-secret-1");
    expect(pkg).not.toContain("SBI");
  });

  it("detects tampering before restoring", async () => {
    const { store } = await vaultWithData();
    const pkg = JSON.parse(createBackup(store, now()));
    const chars = (pkg.payload.ctB64 as string).split("");
    chars[10] = chars[10] === "A" ? "B" : "A";
    pkg.payload.ctB64 = chars.join("");
    expect(() => restoreBackup(JSON.stringify(pkg), { password: "master-pw" })).toThrow(
      /integrity|corrupt/i,
    );
  });

  it("rejects garbage files with a clear error", () => {
    expect(() => restoreBackup("not json", { password: "x" })).toThrow(/Not a valid backup/);
    expect(() => restoreBackup('{"format":"other"}', { password: "x" })).toThrow(
      /Not a valid backup/,
    );
  });

  it("backup file names carry no user data", () => {
    const name = backupFileName(new Date("2026-07-10T09:30:00"));
    expect(name).toBe("vault-backup-20260710-093000.pwmbackup");
  });
});
