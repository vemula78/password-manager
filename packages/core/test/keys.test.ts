import { beforeAll, describe, expect, it } from "vitest";
import { initCrypto, toB64 } from "../src/crypto";
import {
  WrongCredentialError,
  createVaultHeader,
  formatRecoveryKey,
  hasRecovery,
  parseRecoveryKey,
  rewrapWithNewPassword,
  setupRecoveryKey,
  unlockWithPassword,
  unlockWithRecoveryKey,
  verifyMasterPassword,
} from "../src/keys";

beforeAll(async () => {
  await initCrypto();
});

const NOW = "2026-07-10T00:00:00.000Z";

describe("key hierarchy", () => {
  it("unlocks with the correct master password and rejects the wrong one", () => {
    const { header, keys } = createVaultHeader("my long passphrase", NOW);
    const unlocked = unlockWithPassword(header, "my long passphrase");
    expect(toB64(unlocked.vk)).toBe(toB64(keys.vk));
    expect(toB64(unlocked.bk)).toBe(toB64(keys.bk));
    expect(() => unlockWithPassword(header, "wrong")).toThrow(WrongCredentialError);
    expect(verifyMasterPassword(header, "my long passphrase")).toBe(true);
    expect(verifyMasterPassword(header, "wrong")).toBe(false);
  });

  it("VK and BK are distinct keys", () => {
    const { keys } = createVaultHeader("pw", NOW);
    expect(toB64(keys.vk)).not.toBe(toB64(keys.bk));
  });
});

describe("recovery key", () => {
  it("format/parse round-trips, tolerating dashes, case and confusables", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const formatted = formatRecoveryKey(bytes);
    expect(formatted.replace(/-/g, "")).toHaveLength(26);
    expect(toB64(parseRecoveryKey(formatted))).toBe(toB64(bytes));
    expect(toB64(parseRecoveryKey(formatted.toLowerCase().replace(/-/g, " ")))).toBe(toB64(bytes));
    // Crockford confusables: o→0, i/l→1
    const withConfusables = formatted.replace(/0/g, "O").replace(/1/g, "l");
    expect(toB64(parseRecoveryKey(withConfusables))).toBe(toB64(bytes));
  });

  it("recovers the vault keys after setup, and rejects a wrong key", () => {
    const { header, keys } = createVaultHeader("pw", NOW);
    expect(hasRecovery(header)).toBe(false);
    expect(() => unlockWithRecoveryKey(header, "AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA")).toThrow(
      WrongCredentialError,
    );

    const { header: h2, recoveryKey } = setupRecoveryKey(header, keys, NOW);
    expect(hasRecovery(h2)).toBe(true);
    const recovered = unlockWithRecoveryKey(h2, recoveryKey);
    expect(toB64(recovered.vk)).toBe(toB64(keys.vk));
    expect(toB64(recovered.bk)).toBe(toB64(keys.bk));
    expect(() => unlockWithRecoveryKey(h2, "AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA")).toThrow(
      WrongCredentialError,
    );
  });

  it("rotation invalidates the old recovery key", () => {
    const { header, keys } = createVaultHeader("pw", NOW);
    const { header: h2, recoveryKey: oldKey } = setupRecoveryKey(header, keys, NOW);
    const { header: h3, recoveryKey: newKey } = setupRecoveryKey(h2, keys, NOW);
    expect(newKey).not.toBe(oldKey);
    expect(() => unlockWithRecoveryKey(h3, oldKey)).toThrow(WrongCredentialError);
    expect(toB64(unlockWithRecoveryKey(h3, newKey).vk)).toBe(toB64(keys.vk));
  });
});

describe("master password rewrap (recovery flow)", () => {
  it("after recovery, a new password unlocks the same VK/BK; old password stops working", () => {
    const { header, keys } = createVaultHeader("forgotten-password", NOW);
    const { header: h2, recoveryKey } = setupRecoveryKey(header, keys, NOW);

    // User forgot the password: unlock via recovery key, then rewrap.
    const recovered = unlockWithRecoveryKey(h2, recoveryKey);
    const h3 = rewrapWithNewPassword(h2, recovered, "brand-new-password");

    const unlocked = unlockWithPassword(h3, "brand-new-password");
    expect(toB64(unlocked.vk)).toBe(toB64(keys.vk)); // items remain decryptable
    expect(() => unlockWithPassword(h3, "forgotten-password")).toThrow(WrongCredentialError);
    expect(h3.kdf.saltB64).not.toBe(h2.kdf.saltB64); // fresh salt
    // recovery key still works after a password change
    expect(toB64(unlockWithRecoveryKey(h3, recoveryKey).bk)).toBe(toB64(keys.bk));
  });
});
