import { beforeAll, describe, expect, it } from "vitest";
import {
  decrypt,
  deriveKek,
  encrypt,
  fromB64,
  initCrypto,
  newKdfParams,
  randomBytes,
  toB64,
  utf8,
  utf8decode,
} from "../src/crypto";

beforeAll(async () => {
  await initCrypto();
});

describe("AEAD round-trip (XChaCha20-Poly1305)", () => {
  it("encrypts and decrypts with associated data", () => {
    const key = randomBytes(32);
    const ct = encrypt(utf8("mpin=482913"), key, "item:abc");
    expect(utf8decode(decrypt(ct, key, "item:abc"))).toBe("mpin=482913");
  });

  it("uses a fresh nonce per encryption (same plaintext → different ciphertext)", () => {
    const key = randomBytes(32);
    const a = encrypt(utf8("same"), key, "x");
    const b = encrypt(utf8("same"), key, "x");
    expect(a.nonceB64).not.toBe(b.nonceB64);
    expect(a.ctB64).not.toBe(b.ctB64);
  });

  it("rejects tampered ciphertext", () => {
    const key = randomBytes(32);
    const ct = encrypt(utf8("secret"), key, "x");
    const bytes = fromB64(ct.ctB64);
    bytes[0]! ^= 0xff;
    expect(() => decrypt({ ...ct, ctB64: toB64(bytes) }, key, "x")).toThrow();
  });

  it("rejects ciphertext transplanted to a different context (AD mismatch)", () => {
    const key = randomBytes(32);
    const ct = encrypt(utf8("secret"), key, "item:A");
    expect(() => decrypt(ct, key, "item:B")).toThrow();
  });

  it("rejects the wrong key", () => {
    const ct = encrypt(utf8("secret"), randomBytes(32), "x");
    expect(() => decrypt(ct, randomBytes(32), "x")).toThrow();
  });
});

describe("Argon2id KDF", () => {
  it("is deterministic for the same password and salt", () => {
    const params = newKdfParams();
    const a = deriveKek("correct horse battery staple", params);
    const b = deriveKek("correct horse battery staple", params);
    expect(toB64(a)).toBe(toB64(b));
  });

  it("differs across salts and passwords", () => {
    const p1 = newKdfParams();
    const p2 = newKdfParams();
    expect(p1.saltB64).not.toBe(p2.saltB64); // unique random salt per user
    const a = deriveKek("pw", p1);
    const b = deriveKek("pw", p2);
    const c = deriveKek("pw2", p1);
    expect(toB64(a)).not.toBe(toB64(b));
    expect(toB64(a)).not.toBe(toB64(c));
  });

  it("matches the pinned regression vector (catches silent KDF changes)", () => {
    // Vector generated with libsodium crypto_pwhash Argon2id13, ops=3, mem=64MiB —
    // pinned so any accidental parameter or algorithm drift fails loudly.
    const key = deriveKek("test-vector-password", {
      alg: "argon2id13",
      opsLimit: 3,
      memLimitBytes: 64 * 1024 * 1024,
      saltB64: "AAECAwQFBgcICQoLDA0ODw==",
    });
    expect(toB64(key)).toBe("kUUdR90JKKM+XVkoR4SW5SB6rG+itYJ0uygyxyp5t8A=");
  });
});
