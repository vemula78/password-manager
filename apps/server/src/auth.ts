// Auth primitives: argon2id hashing of the client-supplied authToken, HMAC-signed bearer
// access tokens, and deterministic dummy KDF params for account enumeration resistance.
// No vault crypto happens here — this file never sees a master password or a KEK.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as argon2 from "@node-rs/argon2";
import type { KdfParams } from "@pw/core";

const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;

export interface ServerConfig {
  /** HMAC key for access tokens and the dummy-KDF derivation. Never logged. */
  serverSecret: Buffer;
}

// ---- authToken hashing (argon2id, salt embedded in the PHC-format output string) --------

export async function hashAuthToken(authTokenB64: string): Promise<string> {
  return argon2.hash(authTokenB64, {
    algorithm: 2, // argon2id
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyAuthToken(hash: string, authTokenB64: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, authTokenB64);
  } catch {
    return false;
  }
}

// ---- bearer access tokens: HMAC-signed, stateless, short-lived --------------------------

export interface AccessTokenPayload {
  accountId: string;
  deviceId: string;
  exp: number; // unix seconds
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function issueAccessToken(cfg: ServerConfig, accountId: string, deviceId: string): {
  token: string;
  expiresIn: number;
} {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS;
  const payload: AccessTokenPayload = { accountId, deviceId, exp };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(createHmac("sha256", cfg.serverSecret).update(body).digest());
  return { token: `${body}.${sig}`, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Returns the payload if the token is well-formed, signed correctly, and unexpired. */
export function verifyAccessToken(cfg: ServerConfig, token: string): AccessTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, sig] = parts as [string, string];
  const expectedSig = b64url(createHmac("sha256", cfg.serverSecret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
  let payload: AccessTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return undefined;
  }
  return payload;
}

// ---- refresh tokens: random opaque value, stored only as a hash, rotated on use ---------

export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  // SHA-256 is sufficient here: refresh tokens are already 256 bits of CSPRNG entropy, so
  // this hash defends against DB-dump replay, not against brute force of a weak secret —
  // the slow argon2id hash is reserved for the human-derived authToken.
  return createHash("sha256").update(token).digest("hex");
}

export function verifyRefreshToken(hash: string, token: string): boolean {
  const a = Buffer.from(hashRefreshToken(token), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- dummy KDF for unknown accounts (GET /kdf enumeration resistance) -------------------

const DUMMY_OPSLIMIT = 3;
const DUMMY_MEMLIMIT = 64 * 1024 * 1024;

/**
 * Deterministic but unforgeable-without-the-server-secret dummy salt, so repeated queries
 * for the same unknown accountId return the same plausible KDF params (a real account's
 * salt also never changes), and an attacker cannot use response variability to tell real
 * accounts apart from fake ones by re-querying.
 */
export function dummyKdfParams(cfg: ServerConfig, accountId: string): KdfParams {
  const saltBytes = createHmac("sha256", cfg.serverSecret)
    .update(`kdf-salt:${accountId}`)
    .digest()
    .subarray(0, 16);
  return {
    alg: "argon2id13",
    opsLimit: DUMMY_OPSLIMIT,
    memLimitBytes: DUMMY_MEMLIMIT,
    saltB64: saltBytes.toString("base64"),
  };
}
