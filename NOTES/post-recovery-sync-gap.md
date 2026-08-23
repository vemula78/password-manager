# A device unlocked by recovery key cannot update the sync server

Found 23-Aug-2026 while wiring the remaining `pushHeader` call sites.

## The gap

Server auth is `deriveSubkey(KEK, "server-auth")` (SYNC-DESIGN.md §4), and the KEK comes
only from the master password. A recovery-key unlock derives the Vault Key by unwrapping
the recovery envelope; it never produces a KEK. So a device unlocked that way holds no
credential the server will accept.

The post-recovery flow then forces a new master password. That produces a *new* auth token,
but pushing it requires authenticating with the *old* one, which this device does not have
and cannot derive. The push is impossible, not merely unwired.

Result, if nothing is said: the vault's master password changes locally, the sync server
keeps the old header and the old verifier, the old password keeps working against the
server indefinitely, and every other device stays on the old header. The comment in
`VaultContext.unlockWithRecoveryKey` claimed the forced password change was sufficient to
restore sync. It is not.

## What is implemented today

Nothing that closes it — only that it is no longer silent. `PostRecoveryFlow` (web) and
`RecoverScreen` / `RestoreVaultView` (mobile) call `markSyncStaleAfterRecovery()`, which
records the condition in the sync config's `lastError` and shows a warning telling the user
the server was not updated and the account must be reset there.

The operator's manual recovery is: delete the account on the sync server (or set
`REGISTRATION_OPEN=true`), then connect the device again, which registers fresh and
re-uploads the vault. Nothing is lost — the vault is intact locally — but it is a
server-side action, not something the app can do.

## The real fix, not yet decided

Store a second verifier server-side, derived from the recovery key the same one-way way the
password verifier is:

    recovery key --> recovery KEK --BLAKE2b "server-auth-recovery"--> recoveryAuthToken
    server stores Argon2id(recoveryAuthToken)

Post-recovery, the client authenticates with that token and pushes the new header plus the
new password verifier atomically, exactly as `pushHeader` already does.

This preserves zero-knowledge (both verifiers are one-way subkeys; neither reconstructs a
KEK, let alone the Vault Key), but it is a design change and touches:

- SYNC-DESIGN.md §4 (binding — decide there first)
- a `002_*.sql` migration adding `recovery_auth_hash`
- account creation and every `createRecoveryKey` call site, which must now also rotate the
  server-side recovery verifier — and that push has the same atomicity requirement as a
  password change
- a login variant accepting a recovery credential, with its own rate limit; it is an
  unauthenticated Argon2 endpoint, so it widens the same surface `/login` already has
- accounts created before the migration, which have no recovery verifier and need a
  backfill on the next authenticated header push

Worth weighing against how rare the path is: it only matters for someone who has forgotten
their master password *and* uses sync. Doing nothing is defensible; doing it silently is
not, which is why the warning went in first.
