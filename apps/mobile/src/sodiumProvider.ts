// Sodium provider for React Native — the single place where the crypto backend is chosen.
// ALL crypto lives in @pw/core; this file only injects a libsodium instance into it.
//
// Decision: react-native-libsodium (JSI bindings to the real C libsodium; API-compatible
// with libsodium-wrappers). It requires a DEV BUILD (expo-dev-client / expo run:ios|android)
// — it does NOT work in Expo Go, because it ships native code.
//
// Its native surface is *almost* the libsodium-wrappers API. Verified against
// node_modules/react-native-libsodium/lib/typescript/lib.native.d.ts, the default export
// includes everything @pw/core calls EXCEPT:
//   - base64_variants  (named export only, not on the default export object)
//   - from_string      (missing on native — to_string exists)
//   - memzero          (missing on native)
// So we build a thin adapter object filling those three gaps rather than forking core.
import rnSodium, { base64_variants, ready } from "react-native-libsodium";
import { initCrypto, type Sodium } from "@pw/core";

/** UTF-8 encode without relying on TextEncoder (Hermes support varies by RN version). */
function utf8Encode(str: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
  const out: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return new Uint8Array(out);
}

/** Members of the sodium API that @pw/core actually calls (see packages/core/src/crypto.ts). */
const REQUIRED = [
  "crypto_pwhash",
  "crypto_pwhash_ALG_ARGON2ID13",
  "crypto_aead_xchacha20poly1305_ietf_encrypt",
  "crypto_aead_xchacha20poly1305_ietf_decrypt",
  "crypto_generichash",
  "randombytes_buf",
  "randombytes_uniform",
  "to_base64",
  "from_base64",
  "base64_variants",
  "from_string",
  "to_string",
  "memzero",
] as const;

let initialized = false;

/** Initialize @pw/core's crypto with react-native-libsodium. Idempotent. */
export async function initSodium(): Promise<void> {
  if (initialized) return;
  await ready;

  const adapter = {
    ...rnSodium,
    // Gaps in react-native-libsodium's native default export, filled here:
    base64_variants,
    from_string: (s: string) => utf8Encode(s),
    // Best-effort zeroing — JS cannot guarantee the GC leaves no copies, which matches
    // libsodium-wrappers' own memzero semantics for Uint8Arrays.
    memzero: (bytes: Uint8Array) => bytes.fill(0),
  };

  for (const key of REQUIRED) {
    if ((adapter as Record<string, unknown>)[key] === undefined) {
      throw new Error(`react-native-libsodium is missing '${key}' — cannot initialize crypto`);
    }
  }

  // The cast bridges a type gap only: react-native-libsodium is typed against
  // libsodium-wrappers (non-sumo) while core's Sodium type is the sumo surface.
  // The runtime check above proves every member core uses is present.
  await initCrypto(adapter as unknown as Sodium);
  initialized = true;
}
