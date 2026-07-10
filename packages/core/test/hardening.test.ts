// Tests for the hardening added after the independent (Codex) security review:
// core-enforced reauth, KDF parameter bounds, backup mix-and-match binding,
// and recovery-stripping detection.
import { beforeAll, describe, expect, it } from "vitest";
import { createBackup, restoreBackup } from "../src/backup";
import { deriveKek, initCrypto } from "../src/crypto";
import { ReauthRequiredError, StorageAdapter, VaultStore } from "../src/vault";

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

let tick = 0;
const now = () => new Date(1770000000000 + tick++ * 1000).toISOString();

describe("core-enforced reauthentication", () => {
  it("recovery-key creation requires the master password, verified by core", async () => {
    const store = await VaultStore.create("pw-1", memStorage(), now);
    await expect(store.createRecoveryKey()).rejects.toThrow(ReauthRequiredError);
    await expect(store.createRecoveryKey({ masterPassword: "wrong" })).rejects.toThrow(
      ReauthRequiredError,
    );
    const key = await store.createRecoveryKey({ masterPassword: "pw-1" });
    expect(key).toBeTruthy();
  });

  it("master-password change requires reauth — except after a recovery-key unlock", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw-1", storage, now);
    const recoveryKey = await store.createRecoveryKey({ masterPassword: "pw-1" });

    await expect(store.changeMasterPassword("hijacked")).rejects.toThrow(ReauthRequiredError);
    await store.changeMasterPassword("pw-2", { masterPassword: "pw-1" });

    // Forgot-password flow: recovery unlock IS the stronger credential, no password needed.
    const viaRecovery = await VaultStore.open(storage.data!, { recoveryKey }, storage, now);
    await viaRecovery.changeMasterPassword("pw-3");
    const reopened = await VaultStore.open(storage.data!, { password: "pw-3" }, storage, now);
    expect(reopened).toBeTruthy();
  });
});

describe("KDF parameter bounds", () => {
  it("refuses out-of-range ops/mem from a tampered file", () => {
    const base = {
      alg: "argon2id13" as const,
      saltB64: "AAECAwQFBgcICQoLDA0ODw==",
    };
    expect(() =>
      deriveKek("pw", { ...base, opsLimit: 3, memLimitBytes: 8 * 1024 * 1024 * 1024 }),
    ).toThrow(/out-of-range/);
    expect(() => deriveKek("pw", { ...base, opsLimit: 0, memLimitBytes: 64 * 1024 * 1024 })).toThrow(
      /out-of-range/,
    );
    expect(() =>
      deriveKek("pw", { ...base, opsLimit: 3, memLimitBytes: 64 * 1024 * 1024, saltB64: "AAEC" }),
    ).toThrow(/salt/);
  });
});

describe("backup mix-and-match protection", () => {
  it("rejects a package pairing one backup's keyring with another's payload", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    await store.addItem({ type: "login", title: "old-state", fields: { password: "p1" } });
    const oldBackup = JSON.parse(createBackup(store, now()));

    await store.createRecoveryKey({ masterPassword: "pw" }); // header changes
    const newBackup = JSON.parse(createBackup(store, now()));

    // Attacker serves: current keyring + stale payload (same BK encrypted both).
    const frankenstein = JSON.stringify({ ...newBackup, payload: oldBackup.payload });
    expect(() => restoreBackup(frankenstein, { password: "pw" })).toThrow(/integrity/);

    // Keeping the old createdAt to satisfy the AD still fails the keyring-vs-header check.
    const frankenstein2 = JSON.stringify({
      ...newBackup,
      createdAt: oldBackup.createdAt,
      payload: oldBackup.payload,
    });
    expect(() => restoreBackup(frankenstein2, { password: "pw" })).toThrow(/integrity/);

    // Sanity: the untampered packages restore fine.
    expect(() => restoreBackup(JSON.stringify(newBackup), { password: "pw" })).not.toThrow();
    expect(() => restoreBackup(JSON.stringify(oldBackup), { password: "pw" })).not.toThrow();
  });
});

describe("recovery-stripping detection", () => {
  it("warns on unlock when recovery envelopes vanish from the header", async () => {
    const storage = memStorage();
    const store = await VaultStore.create("pw", storage, now);
    await store.createRecoveryKey({ masterPassword: "pw" });

    const file = JSON.parse(storage.data!);
    delete file.header.recovery;
    delete file.header.vkEnvelopes.recovery;
    delete file.header.bkEnvelopes.recovery;

    const reopened = await VaultStore.open(JSON.stringify(file), { password: "pw" }, storage, now);
    expect(reopened.getIntegrityWarnings().join(" ")).toMatch(/tampered|missing/i);

    // and an untouched vault produces no warnings
    const clean = await VaultStore.open(storage.data!, { password: "pw" }, storage, now);
    expect(clean.getIntegrityWarnings()).toEqual([]);
  });
});
