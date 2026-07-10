# Project: Personal Password Manager

Open-source zero-knowledge password manager for Indian users. SPEC.md is binding
(security principles, templates, acceptance criteria); PLAN.md has the decided stack and
key hierarchy. V1 only — family sharing/passkeys/breach monitoring/sync are V2, do not implement.

## Hard rules
- All crypto through `packages/core` via libsodium. Never hand-roll primitives, never import
  libsodium in the apps directly.
- Nothing sensitive in localStorage, URLs, logs, or analytics (there are no analytics).
- The Argon2id regression vector in `packages/core/test/crypto.test.ts` is pinned — if it
  fails, a KDF parameter drifted; fix the drift, never re-pin without understanding why.
- libsodium-wrappers-sumo must be aliased to its CJS build in every bundler config —
  see NOTES/libsodium-esm-bug.md.

## Practical
- npm workspaces (no pnpm). Tests: `npm test` at root = core vitest suite.
- Commits: Praveen Vemula <vemula78@gmail.com> (already set in .git/config).
- Web deploy target: GitHub Pages (vite base "./"). Mobile: Expo, needs dev build (not
  Expo Go) because of react-native-libsodium.
- Google Drive OAuth client ID is user-supplied config (Praveen creates it in Google Cloud
  Console); code must degrade gracefully without it.
