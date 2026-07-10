# Shell-level review findings (10-Jul-2026) — patterns to keep applying

From the Codex web-shell review + fresh-context acceptance audit. Both shells repeated the
same two mistakes, so treat these as standing patterns for any future shell (extension, desktop):

1. **Edit forms must not hydrate decrypted sensitive values.** A "hidden" `<input
   type=password>` (or RN `secureTextEntry`) with the real value in it is only visually hidden —
   XSS/extensions/DOM inspection (web) or a person holding the unlocked phone (mobile) read it
   without the reauth gate. Pattern: replace-only editing — "Saved — hidden / Replace →
   empty input; un-replaced fields keep the stored value on save".

2. **Every unlock-equivalent path needs the same treatment as the unlock screen.** Restoring a
   backup IS an unlock: it must respect the failed-attempt backoff, and a recovery-key restore
   must force a new master password exactly like the recovery-key unlock flow. Grep for every
   call site of `VaultStore.open` / `restoreBackup` when adding a new entry point.

Also: scope reauth caches narrowly (per item, not vault-wide), and the acceptance audit is the
place that catches missing spec warning strings — keep the grep list in the audit prompt.
