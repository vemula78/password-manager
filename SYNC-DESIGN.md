# V2 — Multi-device encrypted sync (design)

Status: **design only, not implemented.** Approved scope decision by Praveen, 23-Aug-2026.
Binding constraints: SPEC.md § Admin-Free Personal Mode ("If cloud sync is implemented, the
server only stores encrypted data") and SPEC.md:46 ("All vault content must be encrypted
before leaving the user device").

Target deployment: self-hosted Node + Postgres on a Linux VM (Azure or on-prem), TLS
terminated by nginx. Single-user-per-account; no admin, no support access, no password reset.

---

## 1. What the server is, and is not

The server is a **dumb, authenticated, versioned blob store for ciphertext**. It performs no
crypto on vault content, holds no key material, and can never decrypt anything.

It stores, per account:

- the vault **header** (KDF params + key envelopes — already safe in plaintext by design)
- one row per item, holding that item's **existing** `Ciphertext` unchanged
- tombstones for deleted items
- an encrypted settings blob and encrypted audit shards
- a monotonically increasing revision number

It never stores: master password, KEK, VK, BK, recovery key, item titles, URLs, or any
metadata derived from item contents. Row count and update timestamps *are* visible to the
server — see § 8.

## 2. Why per-item sync, not whole-blob

Whole-blob sync (upload `VaultStore.serialize()`) is far simpler and is what the Drive backup
already does. It is rejected for sync because two devices editing different items offline
produce a guaranteed **lost update**: the second push overwrites the first device's item
entirely, with no way to detect or recover it. That violates the project's "never silently
drop" discipline in the one place where the dropped thing is a credential.

Per-item sync is viable here because the crypto already supports it: `vault.ts` encrypts each
item independently under VK with associated data `item:{id}`. A single item's ciphertext is
decryptable on its own. No crypto redesign is needed.

## 3. Blockers in the current code

Three changes are required in `packages/core` before any server exists.

### 3.1 Ciphertext churn on save (must fix)

`VaultStore.serialize()` re-encrypts **every** item on **every** mutation, with a fresh nonce
each time. Editing one item changes all ciphertexts, so the client cannot tell the server
which items actually changed — every sync would push the whole vault, defeating per-item sync.

Fix: cache each item's ciphertext alongside the item and re-encrypt only on mutation. Track a
dirty set. `serialize()` emits cached ciphertext for clean items. This is a pure optimisation
of existing behaviour — the file format does not change — and is independently worth doing:
it also removes an O(n) encrypt on every keystroke-triggered save.

### 3.2 Deletes have no tombstone (must fix)

`deleteItem()` removes the item from the map. With sync, device A deletes an item, device B
still has it, B pushes, the item **resurrects**. Silent resurrection of a credential the user
deliberately destroyed is a security bug, not a nuisance.

Fix: add `deletions` to `VaultFile`. Deletion is a tombstone write. Tombstones are retained
180 days (long enough for any realistic offline device), then garbage-collected by the client
that observes them as expired.

**Tombstones must be authenticated** (revised 23-Aug-2026 after the independent review found
this as a critical hole). The first implementation stored them as plaintext
`{ id, deletedAt, deviceId }`. That let a compromised server invent a tombstone for every
item id it could see and make every client silently destroy the credential — the exact
failure this whole design is built to prevent, arriving through the one structure that had no
integrity protection.

They are now sealed: `{ id, ct }`, where `ct` is an XChaCha20-Poly1305 ciphertext of
`{ deletedAt, deviceId }` under the Vault Key, with `tombstone:{id}` as associated data. The
id stays in the clear because the server needs it to key the row and already sees it on the
item. A forged tombstone has no valid tag; a real tombstone moved onto a different item id
fails the associated-data check. Either way the client ignores it and raises an integrity
warning instead of deleting. Sealing also removes deletion timestamps and device attribution
from the server, which §1 promised and the plaintext form quietly broke.

### 3.3 File format version bump

`VaultFile.format`/`header.version` is pinned at `1` and `parseVaultFile` rejects anything
else. Sync fields (`rev`, `deletions`, per-item `updatedAt` exposed outside the ciphertext)
require **version 2**, with a one-way migration on first open: v1 → v2 adds empty
`deletions`, `rev: 0`, and a freshly generated `deviceId`. Existing local vaults and existing
`.pwmbackup` files must keep opening. Backups stay v1-compatible on restore.

## 4. Server authentication

The server must authenticate the account without ever holding anything that can decrypt the
vault, and without the master password leaving the device.

```
master password + salt ──Argon2id──> KEK            (never leaves the device)
KEK ──BLAKE2b, context "server-auth"──> authToken   (sent to server over TLS)
server stores Argon2id(authToken, server_salt)      (slow hash at rest)
```

`deriveSubkey(kek, "server-auth")` already exists in `crypto.ts` and is one-way, so a server
compromise yields a slow hash of a value that cannot reconstruct the KEK. The server-side
Argon2id is a second barrier against an offline attack on a leaked database.

Consequences to handle explicitly:

- **Account identity is not the password.** The account is keyed by a random `accountId`
  issued at signup, plus a user-chosen label. The KDF salt must be fetchable *before*
  authentication (it is needed to derive the KEK), so `GET /kdf?accountId=…` is unauthenticated
  and rate-limited. This is standard and leaks only that an account exists — mitigate by
  returning a plausible dummy salt for unknown accounts.
- **Changing the master password rotates authToken.** `changeMasterPassword` must, in one
  transaction, push the rewrapped header *and* the new auth hash, or the account is locked
  out. Item ciphertexts are untouched (VK is unchanged) — this is why the existing key
  hierarchy makes password change cheap.
- **Recovery-key unlock does not yield a KEK**, so it cannot produce an authToken. A device
  recovering via recovery key must set a new master password before it can sync. That is
  already the forced flow in the web and mobile shells.
- Session tokens are short-lived bearer tokens (30 min) plus a rotating refresh token bound to
  the device record. Revoking a device deletes its refresh token server-side.

## 5. Sync protocol

Monotonic revision counter per account, assigned by the server. Clients store `lastSyncRev`.

```
GET  /vault/changes?since=<rev>   → { rev, headerRev, header?, items:[{id, ct, rev}],
                                      deletions:[…], settings? }
POST /vault/changes               → { baseRev, items:[…], deletions:[…], settings? }
                                    409 if baseRev != server rev  → client re-pulls, merges, retries
POST /vault/header                → strict compare-and-set on header rev (password/recovery change)
```

Pull-merge-push, optimistic concurrency. The header endpoint is separate and strictly
serialised because a header conflict (two devices changing the master password) has no sane
merge and must fail loudly.

### Conflict resolution

Per **item**, not per vault. On merge, for an item changed both locally and remotely:

1. If the decrypted contents are byte-identical → no conflict, take either.
2. Otherwise **last-writer-wins by `updatedAt`, and the loser is preserved** as a new item,
   title suffixed `(conflicted copy — <device>, <date>)`, tagged `conflict`, and an audit event
   is logged on both devices.

Preserving the loser rather than discarding it is the whole point. A password manager that
silently drops the losing edit can destroy the only copy of a credential. The user resolves
the duplicate manually; the UI surfaces a conflict banner until they do.

Deletion beats edit if `deletedAt > updatedAt`; otherwise the edit resurrects the item and the
tombstone is dropped (an explicit edit after a delete is a deliberate act).

Clock skew across devices makes `updatedAt` imperfect. Accepted, because the loser is never
destroyed — the cost of a wrong LWW call is a spurious duplicate, not data loss.

### Audit log and settings

- **Audit**: **not synced** (revised 23-Aug-2026 during implementation). The design originally
  called for per-device append-only shards merged on read. That is sound but buys little: the
  audit log is a record of what happened *on this device*, and a merged cross-device log is a
  reporting nicety, not a security control. Each device keeps its own local log. Revisit if
  cross-device forensics is ever wanted; the shard design above still applies.
- **Settings**: **not synced** (revised 23-Aug-2026 during the review fixes). LWW settings
  sync turned out to need core API that does not exist — `VaultStore` exposes only plaintext
  settings, the Vault Key is private, and `VaultSettings` has no `updatedAt` to compare — and
  encrypting them in `packages/sync` would breach the "all crypto through core" rule. Rather
  than leave a settings blob half-wired in the protocol, it was removed. This is also
  defensible on its own terms: auto-lock and clipboard-clear timings reasonably differ between
  a phone and a desktop. Revisit only with the core additions listed in
  NOTES/sync-review-outcomes.md.

### Metadata minimisation on the wire (revised 23-Aug-2026)

The protocol carries **no plaintext `updatedAt` per item**, contrary to the first draft of §5.
The merge runs client-side on decrypted items, so the server never needs item timestamps —
sending them would have leaked a per-item edit history for no functional benefit. The server
orders purely by its own `rev`. Row count and *aggregate* write timing remain visible (§8).

## 6. Data model (Postgres)

```sql
accounts(id uuid pk, label text, kdf_salt bytea, auth_hash text,
         header jsonb, header_rev bigint, rev bigint, created_at timestamptz)
items(account_id uuid, item_id text, ct jsonb, updated_at timestamptz, rev bigint,
      primary key (account_id, item_id))
deletions(account_id uuid, item_id text, deleted_at timestamptz, rev bigint,
          primary key (account_id, item_id))
devices(account_id uuid, device_id text, label text, refresh_hash text,
        last_seen timestamptz, primary key (account_id, device_id))
audit_shards(account_id uuid, device_id text, ct jsonb, rev bigint,
             primary key (account_id, device_id))
settings(account_id uuid pk, ct jsonb, rev bigint)
```

`ct` columns hold the existing `Ciphertext` JSON shape verbatim — the server treats them as
opaque. `rev` is bumped from a per-account sequence inside the push transaction.

Postgres is a reasonable choice but not a load-bearing one at this scale (one user, a few
hundred items). It is chosen for transactional integrity on the push path and because
operating it on a Linux VM is well-trodden — not for query power.

## 7. Repo layout

```
packages/core      + sync-aware VaultFile v2, tombstones, ciphertext cache  (§3)
packages/sync      NEW — client: protocol types, merge/conflict engine, pure & unit-tested
apps/server        NEW — Fastify + Postgres, ~400 lines, no crypto beyond auth hashing
apps/web|mobile|extension   consume packages/sync; offline-first, IndexedDB stays the cache
```

The merge engine lives in `packages/sync` as **pure functions over decrypted items**, so it is
testable without a server or a database. That is where the risk is, so that is where the tests
go: concurrent edit, edit-vs-delete both orders, offline device rejoining after 30 days,
clock-skew inversion, conflicted-copy generation, tombstone expiry.

## 8. Threat model — what this does and does not protect

**A fully compromised server cannot** read any credential, learn item titles or URLs, or
authenticate as the user against anything but itself.

**A compromised server can:**

- **Withhold or roll back updates** (freeze attack) — serve a stale `rev` so a device never
  sees a password change. Mitigation: the client stores the highest `rev` it has ever seen and
  refuses to accept a lower one, surfacing a warning. This detects rollback but cannot prevent
  a server that simply stops responding.

  The review sharpened this: the guard only catches a *lower* revision. A server can also
  return an equal-or-higher rev with items silently missing, which looks like a healthy sync.
  Because tombstones are now authenticated, a previously-synced item that disappears with no
  valid tombstone is detectable, and the client refuses to treat it as a deletion. That is a
  detection mitigation, not a completeness proof — a full fix needs a vault-key-authenticated
  manifest with a revision hash chain, which is not implemented. Treat sync completeness as
  best-effort against a hostile server.

- **Test master-password guesses offline**, given a database compromise. The server holds the
  KDF salt and an Argon2id verifier of the auth token, so an attacker can derive a candidate
  KEK and check it. The domain separation is sound and the KEK is not algebraically
  recoverable, but a guessable master password is still guessable. This is inherent to any
  password-derived credential; the defence is passphrase entropy, not protocol design.
- **Learn metadata**: number of items, size of each ciphertext, edit frequency and timing,
  device count, IP addresses. Item *count* and *edit patterns* are genuinely revealing. Padding
  ciphertexts to size buckets is deferred; the leak is documented rather than fixed.
- **Serve tampered client code** if it also hosts the web app. This is the real risk of putting
  the PWA and the sync server on the same VM: a server compromise becomes a full vault
  compromise, because it can ship JavaScript that exfiltrates the master password. Hosting the
  web app separately (GitHub Pages) from the sync server reduces this. The browser extension
  and mobile app are not exposed to it, since their code is installed rather than served.
- **Delete everything.** Server-side backups are the user's responsibility; the existing local
  and Drive backup paths remain the recovery mechanism and must keep working.

Denial of service and availability are not solved: if the VM is down, devices fall back to
their local cache, which stays fully functional read-write and syncs on reconnect.

## 9. Explicitly out of scope

Family/shared vaults, per-device key envelopes, trusted-contact recovery, passkeys, and
server-side breach monitoring remain V2+ items beyond this design. Per-device envelopes are
*not* needed for sync — every device derives the same KEK from the master password — and are
only required once vault access must be revocable per device without a password change.

## 10. Build order

1. `packages/core` v2 file format: ciphertext cache, tombstones, migration + tests (§3).
2. `packages/sync` merge engine, pure functions, full conflict test matrix (§5). No I/O.
3. `apps/server` Fastify + Postgres, auth (§4), changes endpoints (§5), Docker Compose.
4. Web client integration behind a "Sync" settings pane, off by default.
5. Mobile + extension integration.
6. Fresh-context security review of the whole surface before it holds a real credential,
   matching the M4 process.

Each step ends green before the next begins; steps 1 and 2 have no server dependency and
carry most of the correctness risk.
