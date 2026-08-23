# Independent Codex security review of M7 sync (23-Aug-2026) — dispositions

Codex reviewed `packages/core`, `packages/sync`, `apps/server` and the web integration
against SPEC.md and SYNC-DESIGN.md. Full report: [codex-sync-review.md](codex-sync-review.md).
Ten findings. This file records what was done about each, so a future reader does not have to
re-litigate them.

## Fixed in packages/core

**1. Critical — a compromised server could forge deletions.** Tombstones were plaintext
`{id, deletedAt, deviceId}` with no authentication, so a hostile server could return one per
item id and make every client silently destroy the credential. This was the worst possible
bug in this codebase: silent, remote, and aimed squarely at the data the app exists to
protect. Tombstones are now sealed — `{id, ct}`, with `{deletedAt, deviceId}` AEAD-encrypted
under the Vault Key and `tombstone:{id}` as associated data. Forged tombstones fail
authentication, delete nothing, and raise an integrity warning; a real tombstone moved onto a
different item id fails the associated-data check. This also fixed finding 8 (plaintext
deletion history on the server, contrary to SPEC.md:513).

Worth noting *why* it existed: every other structure in the vault was authenticated, and
tombstones were added late, as bookkeeping rather than as data. The lesson is that anything
the merge acts on is security-relevant, whether or not it contains a secret.

**4. High — public accessors leaked mutable internal state.** `getItem`, `listItems`,
`addItem` and `getSettings` returned live objects, so a caller mutating one bypassed
`markDirty()`; `serialize()` would then emit stale ciphertext while the UI showed the new
value, and the edit would vanish on the next persist or sync. All four now return deep
clones, and caller-supplied nested input is cloned on the way in. Three regression tests.

## Accepted, documented rather than fixed

**9. Medium — a leaked server database permits offline master-password guessing.** Inherent
to any password-derived credential: the server necessarily holds the KDF salt and a verifier,
so guesses can be tested. Argon2id (64 MiB, ops 3) client-side plus a server-side Argon2id
hash makes this expensive, not impossible. The defence is passphrase entropy. Recorded in
SECURITY.md under "Multi-device sync"; no code change would remove it.

**5. High (partially) — the rollback guard cannot prove completeness.** `highestSeenRev`
catches a *lower* revision, but a hostile server can return an equal-or-higher revision with
items missing and look healthy. Because tombstones are now authenticated, a previously-synced
item that disappears with no valid tombstone is detectable and refused — that mitigation is
implemented. A full fix needs a vault-key-authenticated manifest with a revision hash chain,
which is not built. SECURITY.md and SYNC-DESIGN.md §8 both say plainly that completeness
against a hostile server is best-effort.

The review also noted the guard's anchor lives in `localStorage`, where an XSS or local
attacker can reset it. That is the same class as the already-accepted local-rollback risk in
codex-review-outcomes.md item 5, and the same answer applies: an attacker with that level of
local access can keylog the master password anyway.

## Fixed in packages/sync and apps/server

See the commits following the review. Findings 2 (password change never rotated the server
header or auth verifier), 3 (header revision compared against the item revision, so header
changes were invisible), 6 (a failed item authentication still advanced the revision,
permanently losing that credential on that device), 7 (unauthenticated device revocation),
9 (no rate limiting on /register, /login, /refresh) and 10 (settings advertised in the
protocol but never synced).

## What the review confirmed as sound

The auth-token construction and its domain separation; no master password or token in URLs,
`localStorage`, or `sessionStorage`; no nonce reuse in the item-encryption paths; parameterized
SQL; transactional compare-and-set on push; and server logs carrying account ids and revision
numbers but no ciphertext, tokens, or headers.
