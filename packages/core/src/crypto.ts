// Crypto primitives. Everything here goes through libsodium — no hand-rolled primitives.
// The sodium instance is injected so web/Node (libsodium-wrappers-sumo) and React Native
// (react-native-libsodium) share this exact code.
import type sodiumType from "libsodium-wrappers-sumo";

export type Sodium = typeof sodiumType;

let sodium: Sodium | null = null;

export function setSodium(s: Sodium): void {
  sodium = s;
}

/** Default provider for web/Node. Mobile calls setSodium(react-native-libsodium) instead. */
export async function initCrypto(provided?: Sodium): Promise<void> {
  if (provided) {
    sodium = provided;
    return;
  }
  const mod = await import("libsodium-wrappers-sumo");
  const s = (mod.default ?? mod) as Sodium;
  await s.ready;
  sodium = s;
}

function so(): Sodium {
  if (!sodium) throw new Error("Crypto not initialized: call initCrypto() first");
  return sodium;
}

export const KEY_BYTES = 32;
export const SALT_BYTES = 16; // crypto_pwhash_SALTBYTES
export const NONCE_BYTES = 24; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES

/** Argon2id parameters, stored alongside the vault so they can be tuned later. */
export interface KdfParams {
  alg: "argon2id13";
  opsLimit: number;
  memLimitBytes: number;
  saltB64: string;
}

// MODERATE ops with 64 MiB memory: strong enough for a personal vault, fast enough on phones.
export const DEFAULT_OPSLIMIT = 3;
export const DEFAULT_MEMLIMIT = 64 * 1024 * 1024;

export function randomBytes(n: number): Uint8Array {
  return so().randombytes_buf(n);
}

/** Uniform random integer in [0, upperBound) via rejection sampling (CSPRNG). */
export function randomUniform(upperBound: number): number {
  return so().randombytes_uniform(upperBound);
}

export function toB64(bytes: Uint8Array): string {
  return so().to_base64(bytes, so().base64_variants.ORIGINAL);
}

export function fromB64(b64: string): Uint8Array {
  return so().from_base64(b64, so().base64_variants.ORIGINAL);
}

export function newKdfParams(): KdfParams {
  return {
    alg: "argon2id13",
    opsLimit: DEFAULT_OPSLIMIT,
    memLimitBytes: DEFAULT_MEMLIMIT,
    saltB64: toB64(randomBytes(SALT_BYTES)),
  };
}

/** Derive the KEK from the master password with Argon2id. Never persisted. */
export function deriveKek(masterPassword: string, params: KdfParams): Uint8Array {
  const s = so();
  if (params.alg !== "argon2id13") throw new Error(`Unsupported KDF: ${params.alg}`);
  return s.crypto_pwhash(
    KEY_BYTES,
    masterPassword,
    fromB64(params.saltB64),
    params.opsLimit,
    params.memLimitBytes,
    s.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export interface Ciphertext {
  nonceB64: string;
  ctB64: string; // ciphertext + Poly1305 tag
}

/**
 * XChaCha20-Poly1305 AEAD. `ad` (associated data) binds the ciphertext to its context —
 * e.g. the item id — so a swapped/transplanted ciphertext fails authentication.
 */
export function encrypt(plaintext: Uint8Array, key: Uint8Array, ad: string): Ciphertext {
  const s = so();
  const nonce = randomBytes(NONCE_BYTES); // fresh random nonce per encryption, per spec
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key);
  return { nonceB64: toB64(nonce), ctB64: toB64(ct) };
}

export function decrypt(c: Ciphertext, key: Uint8Array, ad: string): Uint8Array {
  const s = so();
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    fromB64(c.ctB64),
    ad,
    fromB64(c.nonceB64),
    key,
  );
}

export function encryptJson(value: unknown, key: Uint8Array, ad: string): Ciphertext {
  return encrypt(so().from_string(JSON.stringify(value)), key, ad);
}

export function decryptJson<T>(c: Ciphertext, key: Uint8Array, ad: string): T {
  return JSON.parse(so().to_string(decrypt(c, key, ad))) as T;
}

/** BLAKE2b with a domain-separation prefix, used to expand the recovery key into a wrapping key. */
export function deriveSubkey(material: Uint8Array, context: string): Uint8Array {
  const s = so();
  return s.crypto_generichash(KEY_BYTES, material, s.from_string(`pwmgr-v1:${context}`));
}

/** Best-effort zeroing of key material after use. */
export function wipe(bytes: Uint8Array): void {
  so().memzero(bytes);
}

export function randomId(): string {
  return toB64(randomBytes(12)).replace(/[+/=]/g, (m) => ({ "+": "-", "/": "_", "=": "" })[m]!);
}

export function utf8(s: string): Uint8Array {
  return so().from_string(s);
}

export function utf8decode(b: Uint8Array): string {
  return so().to_string(b);
}
