# PLAN — Personal Password Manager V1

Spec: [SPEC.md](SPEC.md). V1 scope = SPEC § "Recommended First Release". Family sharing,
trusted-contact recovery, passkeys, breach monitoring, desktop, and multi-device sync are
**out of scope** but the key hierarchy below leaves room for them.

## Stack (decided 10-Jul-2026 with Praveen)

- **Shared core**: TypeScript library (`packages/core`) — all crypto, vault model, templates,
  password generator/health, backup format, recovery. Crypto via **libsodium**
  (`libsodium-wrappers-sumo` on web/Node; same API surface via `react-native-libsodium` on
  mobile — the core takes an injected sodium instance so the code is identical).
- **Web**: Vite + React + TypeScript static PWA, encrypted vault in IndexedDB, deployable to
  GitHub Pages. No backend at all.
- **Mobile**: Expo (React Native) app consuming the same core; expo-local-authentication for
  biometrics, expo-secure-store for the wrapped-key cache, screenshot protection on sensitive
  screens.
- **Google Drive backup**: full module in core (`drive.ts`) using Drive REST v3 with an OAuth
  client ID from config (Praveen creates the Google Cloud OAuth client later); local encrypted
  export/import works today. Drive logic tested against a mocked fetch.

## Key hierarchy (fixed — V2 slots in without migration)

```
master password + per-user random salt ──Argon2id──> KEK (never stored)
random 256-bit Vault Key (VK)  ── encrypts every item (XChaCha20-Poly1305, fresh 24-byte nonce per item)
VK is wrapped into KeyEnvelopes:
  • envelope[kek]      — VK wrapped by KEK                      (normal unlock)
  • envelope[recovery] — VK wrapped by key from Recovery Key    (recovery unlock)
  • (V2: envelope[family], envelope[trusted-contact], per-device envelopes)
Backup Key (BK): random 256-bit, wraps backup packages; BK itself stored as
  envelopes wrapped by KEK and by the Recovery Key — so a backup is restorable
  with either the master password or the recovery key, per spec.
Recovery Key: 26-char Crockford base32 (128-bit) shown once, printable in the
  emergency kit; HKDF → wrapping key.
```

## Repo layout

```
packages/core     shared crypto/vault/backup/recovery library + vitest tests
apps/web          React PWA
apps/mobile       Expo app
NOTES/            one lesson per file
SPEC.md  PLAN.md
```

## Milestones

1. **M1 — Core library** (inline, no shortcuts): crypto primitives, key hierarchy, vault store,
   Indian templates, generator, health analysis, backup format, recovery key + rewrap,
   emergency kit content. Tests: round-trip, Argon2id vectors, tamper detection, backup
   encrypt/restore, recovery rewrap. ✅ gate: all tests pass.
2. **M2 — Web app**: unlock/onboarding (with recovery kit), dashboard, item CRUD on all V1
   templates, sensitive-field reveal with reauth, generator, health screen, backup/restore UI
   (local + Drive), settings, clipboard auto-clear, emergency kit print view. ✅ gate:
   acceptance-criteria walk-through in the browser preview.
3. **M3 — Mobile app**: same features via shared core + biometric unlock, app-lock on
   background, screenshot protection, secure reveal. ✅ gate: Expo app boots and core flows
   work (simulator/Expo Go; device signing is Praveen's step).
4. **M4 — Verification**: fresh-context subagent audits against SPEC § Acceptance Criteria +
   Security Principles; fix findings; final commit. ✅ done 10-Jul-2026 (all testable criteria
   passed; two Codex security reviews folded in — see NOTES/).
5. **M5 — Basic browser extension** (added 10-Jul-2026, Praveen delegated the call): MV3
   Chrome/Edge/Firefox, own encrypted vault copy imported from a `.pwmbackup` + master
   password (reuses core `restoreBackup`; no live sync — that's V2). Popup search/copy/fill,
   save-current-site, generator, domain/HTTP/lookalike warnings, hard refusal to fill
   transaction passwords/MPIN/TPIN/UPI PIN/CVV (copy/reveal only, behind reauth). Background
   worker holds the unlocked store in memory; worker death = lock.

Each milestone ends with a commit (author Praveen Vemula <vemula78@gmail.com>).
