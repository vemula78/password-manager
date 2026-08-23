# Independent security review — M7 encrypted sync

Scope: binding documents plus `packages/core`, `packages/sync`, `apps/server`, and the named web integration. This review was read-only except for this report. The two accepted risks in `NOTES/codex-review-outcomes.md` are not repeated.

## Critical — server can forge credential deletions

**Confidence:** high  
**Location:** `packages/sync/src/merge.ts:154-161,200-206`; `packages/sync/src/client.ts:241-251`; `apps/server/src/routes/sync.ts:56-60`

Tombstones are plaintext `{ id, deletedAt, deviceId }`, with no AEAD or vault-key authentication. A compromised server can see every opaque item ID, return a synthetic tombstone for each with a future `deletedAt`, and claim a non-decreasing revision. The merge accepts it, removes the local item, persists it, and pushes the deletion back. This is silent destructive credential loss.

Encrypt/authenticate tombstones under the vault key (or validate a client-held MAC/signature over each one) before merge. Keep deletion timestamps inside the authenticated envelope; do not let server-controlled timestamps decide delete-vs-edit.

## High — web password changes never rotate the sync header or auth verifier

**Confidence:** high  
**Location:** `apps/web/src/screens/Settings.tsx:309-323`; `apps/web/src/components/PostRecoveryFlow.tsx:25-31`; `packages/sync/src/client.ts:1-284`; `apps/server/src/routes/sync.ts:90-119`

The server implements `POST /vault/header`, but SyncClient has no header-push method and no web caller uses it. The UI persists only its local header. After changing a password or recovering, the server retains the old header and old auth-token hash; other devices never learn the header, a future unlock derives an unrecognized token, and the old password keeps being valid to the server.

Make header/password rotation an awaited CAS sync transaction: derive the new token, atomically push header plus new verifier, and only then commit the local session change. Surface and safely retry any 409/network failure.

## High — header revision is compared to the wrong revision domain

**Confidence:** high  
**Location:** `apps/server/src/pg-repo.ts:139-145,213-248`; `apps/server/src/memory-repo.ts:99-105`

`header_rev` is separate from account `rev`, and header pushes do not increment `rev`; yet the server sends a header only when `header_rev > since`, where `since` is the account/item revision. After ten item pushes (`rev=10`), a header change (`header_rev=1`) is never returned to a device pulling from 10. This remains broken even if the web client starts calling the header endpoint.

Use one account-wide revision for every replicated mutation, including header changes, or store/submit `lastHeaderRev` separately and compare only like-for-like counters.

## High — ciphertext cache can serialize stale state after public-object mutation

**Confidence:** high  
**Location:** `packages/core/src/vault.ts:136-139,208-214,265-272,274-300,217-230`

`getItem()`, `listItems()`, and `addItem()` expose mutable objects from the internal map. A caller can mutate an item or nested `fields` without invoking a mutator, so `markDirty()` never runs. Serialization and sync then emit the old cached ciphertext while in-memory/UI reads expose the new value; a later persist or merge silently loses it.

Return deep clones or immutable views from public accessors, clone on insertion, and funnel every mutation through cache-invalidating methods. Add regression tests for each accessor.

## High — rollback guard cannot detect an incomplete but high-revision response

**Confidence:** high  
**Location:** `packages/sync/src/client.ts:204-212,227-282`; `apps/web/src/lib/sync.ts:62-78`; `apps/web/src/lib/config.ts:76-107`

The guard rejects only `changes.rev < highestSeenRev`. A malicious server can return an equal/higher revision with an incomplete items/deletions delta. There is no authenticated history, manifest, or snapshot digest to prove completeness, and the client then advances both revision values. A fresh/restored device can permanently miss credentials while reporting successful sync. This is worse than the documented unavoidable no-response freeze attack because the server appears healthy. Further, the supposed trust anchor is ordinary `localStorage`, so an XSS or local browser-profile attacker can simply reset it; it is not an independently trustworthy monotonic store. This extends the prior accepted *local header rollback* risk to the M7 revision guard, rather than re-reporting that accepted finding.

Commit to a vault-key-authenticated manifest/history (for example a canonical manifest MAC and revision hash chain) and persist the last verified head with the vault. Do not advance state without a complete verified transition; until then describe this as best-effort only.

## High — failed item authentication still consumes the revision

**Confidence:** high  
**Location:** `packages/sync/src/client.ts:227-238,251-282`

On item AEAD failure the client warns and ignores that item, but still persists the merge and advances `lastSyncRev`. A server can corrupt a newly created remote item once; the recipient consumes its revision without the item, and a later valid copy is not returned by `since`. The credential is permanently absent on that device.

Abort the entire cycle before `applyMerge`, base save, or revision advancement when any item, tombstone, settings blob, or manifest cannot authenticate/parse. Retry from the prior revision.

## Medium — device revocation has no authentication or authorization

**Confidence:** high  
**Location:** `apps/server/src/routes/auth.ts:105-115`

`POST /devices/revoke` accepts arbitrary account and device IDs without a bearer token. Anyone knowing those values can clear that device’s refresh hash, repeatedly forcing re-login after the current access token expires.

Require a bearer token, derive account ID from it, restrict revocation to that account, and add unauthenticated/cross-account rejection tests.

## Medium — plaintext tombstones violate encrypted-data-only and expose deletion history

**Confidence:** high  
**Location:** `packages/core/src/model.ts:141-145`; `packages/sync/src/protocol.ts:65-75`; `apps/server/migrations/001_init.sql:24-30`

The server stores raw item IDs, exact deletion times, and device correlation data in `deletions`. This violates `SPEC.md:513` (“server only stores encrypted data”) and exposes item-level deletion history beyond aggregate write timing.

Use opaque client-derived lookup identifiers only if needed for routing; retain the real ID, timestamp, and device attribution solely inside authenticated encrypted tombstones.

## Medium — a database compromise permits offline master-password guessing

**Confidence:** high  
**Location:** `apps/server/migrations/001_init.sql:4-12`; `packages/sync/src/auth.ts:21-30`; `apps/server/src/auth.ts:17-31`

The server holds KDF parameters/salt, header envelopes, and an Argon2id verifier of `deriveSubkey(KEK, "server-auth")`. It cannot algebraically invert these and the domain separation is sound, but it can test master-password guesses offline: derive a candidate KEK/token and verify it (or test an envelope). Therefore KEK recovery remains possible for a guessable human password; the extra Argon2 verifier adds cost but is not an absolute barrier.

Document this conventional password-derived-key risk accurately, strongly promote high-entropy passphrases, and retain/increase memory-hard verifier costs as deployment permits.

## Medium — login and registration are not rate-limited

**Confidence:** high  
**Location:** `apps/server/src/index.ts:83-99`; `apps/server/src/routes/auth.ts:44-87`; `apps/server/src/auth.ts:17-31`

Only `/kdf` is rate-limited. Unauthenticated `/register` performs Argon2 hashing and `/login` performs Argon2 verification for existing and unknown accounts. Attackers can exhaust CPU/memory and create unbounded accounts; this also makes online guessing needlessly cheap.

Rate-limit `/register`, `/login`, and `/refresh` per IP/account, cap concurrent Argon2 work, document reverse-proxy limits, and consider bootstrap-only registration for a personal server.

## Low — settings are advertised in the protocol but never synced

**Confidence:** high  
**Location:** `packages/sync/src/protocol.ts:67,75`; `packages/sync/src/client.ts:241-282`; `packages/core/src/vault.ts:455-457`

The protocol/repository carry an encrypted settings blob, but SyncClient neither decrypts/applies pulled settings nor uploads one. This contradicts the designed LWW settings behavior and can mislead users about replication of safety preferences such as auto-lock or clipboard-clear duration.

Implement explicit encrypted settings pull/push with a dirty marker, or remove it from sync and document settings as device-local.

## Checked and found sound

- The web path does not put the master password or derived auth token in URLs, `localStorage`, or `sessionStorage`; the token is in-memory and cleared on lock.
- Controlled item mutation paths invalidate the cache. Fresh encryption uses libsodium XChaCha20-Poly1305 with a new random 24-byte nonce; I found no nonce reuse in those paths. Associated data binds ciphertext to `item:{id}`.
- `server-auth` uses the core’s consistently prefixed BLAKE2b subkey construction and is distinct from recovery contexts. A stored verifier alone does not directly reveal KEK/VK/BK.
- Sync data routes require signed, expiring bearer tokens; Postgres queries are parameterized; `pushChanges` uses a transaction and row lock for its CAS. Header/auth writes are atomic when the endpoint is actually invoked.
- Server sync logs include account ID and revision, not ciphertext, headers, passwords, or tokens. A live compromised server can observe a submitted auth token and replay it only to this blob store, not derive vault keys.
