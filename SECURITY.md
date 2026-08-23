# Security model and known limitations

Architecture, key hierarchy, and algorithm choices: see [PLAN.md](PLAN.md) and
[README.md](README.md). This file records what an attacker can and cannot do, and the
residual risks we accept knowingly in V1.

## What the design guarantees

- **Zero knowledge**: the vault and every backup are encrypted on-device
  (XChaCha20-Poly1305, keys derived via Argon2id or randomly generated). Google Drive only
  ever stores ciphertext with a meaningless file name. Multi-device sync is **optional and
  off by default**; when it is on, the self-hosted sync server is a blob store that holds
  ciphertext and nothing else — see "Multi-device sync" below.
- **Tamper evidence**: every ciphertext is authenticated and bound to its context (item id,
  backup timestamp), so swapped, spliced, or bit-flipped data fails to decrypt rather than
  decrypting to something wrong. Backup packages additionally verify that their key envelope
  block matches the encrypted contents.
- **Recovery without escrow**: the recovery key wraps the same vault/backup keys; nobody —
  including this app's authors — can decrypt a vault without the master password or that key.
- **Core-enforced reauthentication**: creating/rotating the recovery key and changing the
  master password require re-proving the master password inside the crypto core, not just in
  the UI.
- **Tampered-file resilience**: KDF parameters from stored files are bounds-checked (no
  resource-exhaustion), and silent removal of recovery envelopes is detected and reported at
  unlock ("recovery stripping").

## Multi-device sync (optional, off by default)

Sync is not required to use this app. With it off, nothing described here applies and the
vault never leaves the device except through backups you take deliberately.

With it on, you run your own server (see `apps/server`). What it holds and what it can do:

- **It stores ciphertext only**: per-item ciphertexts, the vault header (KDF parameters and
  wrapped key envelopes, all safe in the clear by design), an encrypted settings blob, and
  sealed tombstones. It has no key material and cannot decrypt any of it.
- **Your master password never reaches it.** Sync authenticates with a one-way value derived
  from the KEK (`BLAKE2b(KEK, "server-auth")`), which the server stores only as an Argon2id
  hash. The password is used at unlock to derive that token and is not retained; the token
  lives in memory and is cleared on lock.
- **Forged deletions are rejected.** Tombstones are authenticated under the Vault Key with the
  item id bound in, so a hostile server cannot fabricate a deletion to destroy a credential,
  nor move a real one onto a different item. A failed check surfaces a warning and deletes
  nothing.
- **Concurrent edits never lose data.** When two devices edit the same item, the losing edit
  is preserved as a "conflicted copy" item rather than overwritten. You may get a duplicate;
  you will not lose a password.

What a fully compromised sync server can still do:

1. **Withhold changes.** It can stop responding, or return a plausible response with items
   missing. A previously-synced item vanishing without a valid tombstone is detected and
   refused, but this is best-effort: there is no authenticated manifest proving a response is
   complete. A device can be kept stale by a server that is hostile rather than merely down.
2. **Learn metadata.** Item count, individual ciphertext sizes, edit frequency and timing,
   device count, and IP addresses. Item *count* and *edit patterns* are genuinely revealing
   even though the contents are not. Padding to size buckets is not implemented.
3. **Test master-password guesses offline**, if its database leaks. It holds your KDF salt and
   an Argon2id verifier, so guesses can be checked. Argon2id (64 MiB, ops 3) plus the
   server-side hash makes this expensive, not impossible. Use a long passphrase.
4. **Serve tampered client code — but only if you let it.** Host the web app somewhere other
   than the sync server. If one host serves both, compromising it means serving JavaScript
   that steals the master password outright, and every guarantee above collapses. The mobile
   app and the browser extension are not exposed to this, since their code is installed
   rather than fetched.

The server offers no account recovery. Losing the master password and the recovery key means
the data is gone, from the server too.

## Accepted residual risks (V1)

1. **Local rollback with an old password.** An attacker who (a) can overwrite the vault file
   on your device, (b) kept an old copy of it, and (c) knows an old master password, can
   restore the old header and unlock with the old password. A serverless design has no
   external trust anchor to pin file freshness. Mitigation: change the master password only
   if the old one is actually compromised — and treat device compromise as game over anyway
   (an attacker at that level can also keylog the current password). Device-keystore epoch
   pinning is planned platform work for V2.
2. **Old backups are restorable by design.** Backup retention deliberately keeps history; a
   Drive attacker can offer you an older (authentic) backup. The restore screen always shows
   the backup's creation date — check it.
3. **Item titles in the encrypted activity history.** The audit log records item titles for
   usability. It is encrypted with the vault key, never leaves the device, and can be cleared
   in Settings.
4. **Unlock rate-limiting is local deterrence, not a cryptographic control.** The failed-unlock
   backoff lives in browser storage and an attacker with the device can clear it — or skip the
   app entirely and brute-force the vault file offline. The real defence against password
   guessing is Argon2id (64 MiB, ops 3) plus a long passphrase; the backoff exists to slow
   casual/shoulder-surf attempts on your own device.
5. **Memory hygiene is best-effort in JavaScript.** Keys are zeroed after use (libsodium
   `memzero`), but JS runtimes may have copied buffers or strings the app cannot scrub. This
   is inherent to every JS password manager.

## Reporting

This is an open-source personal project. Report vulnerabilities via GitHub issues (for
non-sensitive reports) or the contact in the repository profile.
