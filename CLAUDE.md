# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Project: Personal Password Manager

Open-source zero-knowledge password manager for Indian users. SPEC.md is binding
(security principles, templates, acceptance criteria); PLAN.md has the decided stack, key
hierarchy, and milestone history; SYNC-DESIGN.md is binding for anything touching sync.

Scope: V1 plus **multi-device sync (M7, shipped 23-Aug-2026)**. Still out of scope and not
to be implemented: family/shared vaults, passkeys, breach monitoring, trusted-contact
recovery, desktop app.

## Hard rules

- All crypto through `packages/core` via libsodium. Never hand-roll primitives, never import
  libsodium in the apps directly. `packages/sync` is no exception — it does zero crypto of
  its own and calls into core for every seal/open.
- Nothing sensitive in localStorage, URLs, logs, or analytics (there are no analytics). The
  sync auth token counts as sensitive: it lives in memory and is cleared on lock.
- The Argon2id regression vector in `packages/core/test/crypto.test.ts` is pinned — if it
  fails, a KDF parameter drifted; fix the drift, never re-pin without understanding why.
- libsodium-wrappers-sumo must be aliased to its CJS build in every bundler **and vitest**
  config — see NOTES/libsodium-esm-bug.md. A new workspace that runs tests needs its own
  `vitest.config.ts` with that alias or every crypto test dies at import.
- Never act on data the vault key cannot authenticate. This is why tombstones are sealed
  (see below) and why a failed AEAD check aborts a sync cycle instead of skipping one item.

## Commands

```bash
npm install            # repo root, npm workspaces (no pnpm)
npm test               # all suites: core, sync, server, extension
npm run typecheck      # all six workspaces
```

Single test file or single test:

```bash
cd packages/core && npx vitest run test/vault.test.ts
cd packages/sync && npx vitest run -t "conflicted copy"
```

Running things:

```bash
npm run dev --workspace @pw/web      # PWA on http://localhost:5173
npm run dev --workspace @pw/server   # in-memory sync server on :8787, no Postgres needed
npm run build --workspace @pw/server # tsc -> dist/, what `npm start` runs in production
npm run build --workspace @pw/extension
cd apps/mobile && npx expo start     # needs a dev build, not Expo Go (react-native-libsodium)
```

## Architecture

**Layering.** `packages/core` owns all state and crypto; `packages/sync` is pure protocol and
merge logic over decrypted items; the four shells (`apps/web`, `apps/mobile`,
`apps/extension`, and the iOS AutoFill extension) are UI over those two. Shells inject their
own `StorageAdapter` and, on React Native, their own sodium via `setSodium`.

**Key hierarchy** (detail in PLAN.md). Master password →Argon2id→ KEK, never stored. A random
Vault Key encrypts every item; a random Backup Key encrypts backup packages. Both are stored
only as envelopes wrapped by the KEK and, if configured, by the Recovery Key. The consequence
that matters: **changing the master password rewraps envelopes only** — item ciphertexts are
untouched, which is why password change is cheap and why sync does not have to re-upload the
vault.

**The vault file** is one JSON document: a plaintext header (KDF params + envelopes, safe by
design), per-item ciphertexts, sealed tombstones, and an encrypted audit log and settings.
`VaultStore` is the only thing that may mutate it.

**Two invariants inside `VaultStore` that are easy to break:**

1. *Ciphertext cache.* `serialize()` reuses cached ciphertext for unmodified items, so editing
   one item leaves the others' bytes identical — this is what makes per-item sync possible.
   Any new mutator **must** call `markDirty(id)`, or it will silently persist stale ciphertext.
2. *Clone on read.* `getItem`/`listItems`/`addItem`/`getSettings` return deep clones precisely
   so a caller mutating a returned object cannot bypass (1). Do not "optimise" these back into
   returning live references.

**Reauthentication is enforced in core**, not the UI — `requireReauth` verifies the master
password inside `VaultStore` for recovery-key and password-change operations. A
recovery-key unlock counts as already reauthenticated, since it is the stronger credential.

**Sync** (SYNC-DESIGN.md is the authority):

- The server (`apps/server`) is a dumb, authenticated, versioned blob store. It performs no
  crypto on vault content and must never parse or inspect a `ct` field.
- Merging happens client-side on decrypted items, in `packages/sync/src/merge.ts` — a pure
  synchronous function with an injected clock. Keep it pure; that is where the tests live.
- **Concurrent edits must never lose data.** Last-writer-wins picks a winner, but the losing
  edit is always preserved as a "(conflicted copy)" item. A duplicate is an acceptable
  outcome; a lost credential is not.
- **Tombstones are sealed.** Deletion time and device are AEAD-encrypted under the Vault Key
  with the item id bound in as associated data. They were plaintext once and an independent
  review found that a hostile server could forge deletions and silently destroy every
  credential — see NOTES/sync-review-outcomes.md before touching them.
- **`rev` and `headerRev` are separate counters.** Item pulls use `since`, header changes use
  `sinceHeader`. Comparing one to the other makes header changes permanently invisible; this
  was a real bug.
- Server auth is `deriveSubkey(KEK, "server-auth")` — one-way, so the server holds nothing
  that can decrypt a vault. Derived at unlock, held in memory, never persisted.
- A master-password change must push the rotated header **and** the new auth verifier
  atomically, or the old password keeps working against the server.
- Audit log and settings are deliberately **device-local**, not synced.

## Practical

- Commits: Praveen Vemula <vemula78@gmail.com> (already set in .git/config).
- Deploy: web → GitHub Pages (vite base `"./"`). Sync server → self-hosted Linux VM,
  see apps/server/README.md. **Do not host the web app on the sync server** — a compromise
  there could serve JavaScript that steals the master password, which collapses every other
  guarantee. Cross-origin is the expected setup, hence the `ALLOWED_ORIGINS` allowlist.
- Google Drive OAuth client ID is user-supplied config (Praveen creates it in Google Cloud
  Console); code must degrade gracefully without it. Sync is likewise off by default.
- `apps/server` emits with `moduleResolution: "bundler"`, not NodeNext, because the workspace
  packages are source-only TypeScript. Its cross-package imports are all `import type`, so
  `dist/` has no runtime dependency on `@pw/core` or `@pw/sync`. Keep it that way.
- `NOTES/` holds one lesson per file — read the relevant one before re-litigating a decision,
  and add one when a non-obvious call gets made.
