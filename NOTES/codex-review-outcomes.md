# Independent Codex security review (10-Jul-2026) — what was fixed vs accepted

Codex (gpt-5.5, read-only) reviewed packages/core against SPEC. Eight findings; disposition:

**Fixed in core (with tests in test/hardening.test.ts):**
1. Recovery-key create/rotate and master-password change now require reauth *enforced by core*
   (`Reauth` param verified via verifyMasterPassword; recovery-unlock sessions exempt because
   that unlock is the stronger credential — it IS the forgot-password flow).
2. Backup payload AEAD AD now includes the package createdAt, and restore verifies the inner
   vault header exactly matches the package keyring → mix-and-match of old payloads with new
   keyrings (or stripped-recovery keyrings) fails integrity.
3. KDF params from stored files are bounds-checked (ops 1–10, mem 8MiB–1GiB, 16-byte salt)
   before Argon2id runs → no resource-exhaustion via tampered files.
4. Recovery-stripping detection: encrypted settings remember recoveryKeyId; on unlock, if the
   plaintext header's recovery data disappeared/changed, `getIntegrityWarnings()` is non-empty
   and shells must display it.

**Accepted residual risks (documented in SECURITY.md, not fixed):**
5. Header rollback by an attacker with (a) write access to local storage AND (b) an old copy of
   the vault AND (c) knowledge of an old master password. No trust anchor exists in a fully
   serverless design; mitigations (device keystore epoch counters) are platform work noted for V2.
6. Item titles appear in the audit log. The audit log is itself encrypted with the vault key and
   never leaves the device; the spec's own activity-history requirement implies item context.
   Titles stay (matching Bitwarden/1Password behaviour).

Lesson: shell-enforced-only reauth is a trap — put the check in core where every caller hits it.
