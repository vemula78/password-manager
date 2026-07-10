# Security model and known limitations

Architecture, key hierarchy, and algorithm choices: see [PLAN.md](PLAN.md) and
[README.md](README.md). This file records what an attacker can and cannot do, and the
residual risks we accept knowingly in V1.

## What the design guarantees

- **Zero knowledge**: there is no server. The vault and every backup are encrypted on-device
  (XChaCha20-Poly1305, keys derived via Argon2id or randomly generated). Google only ever
  stores ciphertext with a meaningless file name.
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
