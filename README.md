# Personal Password Manager (V1)

Open-source, zero-knowledge, offline-first password manager for Indian users — netbanking,
UPI, cards, demat, and government-ID credentials for individuals and families. No server:
the vault is encrypted on-device and backed up (encrypted) to the user's own Google Drive.

Full specification: [SPEC.md](SPEC.md) · Build plan and key hierarchy: [PLAN.md](PLAN.md)

## Layout

| Path | What |
|---|---|
| `packages/core` | Shared TypeScript library: all crypto (libsodium — Argon2id, XChaCha20-Poly1305), key hierarchy, vault store, Indian credential templates, password generator/health, encrypted backup format, Google Drive client, emergency kit |
| `apps/web` | React + Vite PWA (offline-capable, deployable to GitHub Pages) |
| `apps/mobile` | Expo (React Native) app — biometric unlock, app-lock on background, screenshot protection |

## Security model (short version)

- Master password → **Argon2id** (per-user random salt, ops=3, mem=64 MiB) → KEK, never stored.
- Random 256-bit **Vault Key** encrypts every item with **XChaCha20-Poly1305** and a fresh
  24-byte random nonce; the item id is bound as associated data, so ciphertexts can't be
  swapped between items undetected.
- A separate random 256-bit **Backup Key** encrypts backup packages. Both keys are stored only
  wrapped ("key envelopes") by the KEK and, if configured, by the **Recovery Key**
  (26-character Crockford-base32, shown once, printable in the emergency kit).
- Backups therefore open with the master password **or** the recovery key — and nothing else.
  Lose both and the vault is unrecoverable by design; the provider (nobody) can decrypt it.

## Run

```bash
npm install                      # from repo root (npm workspaces)
npm test                         # core test suite (37 tests)
npm run dev --workspace @pw/web  # web app on http://localhost:5173
cd apps/mobile && npx expo start # mobile (needs a dev build for native libsodium)
```

Google Drive backup needs a (free) OAuth client ID from Google Cloud Console
(type "Web application", scope `drive.file`); paste it in the web app's Backup screen.
Everything else works with no accounts and no network.
