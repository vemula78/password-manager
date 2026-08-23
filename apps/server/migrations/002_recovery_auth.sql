-- Recovery-derived server verifier (SYNC-DESIGN.md §4).
--
-- Nullable on purpose: the recovery key's bytes exist only at creation time and cannot be
-- recovered from the header, so accounts created before this migration have no verifier
-- until the user rotates their recovery key. A NULL here means "recovery sign-in is not
-- available for this account", never "any credential is accepted".
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_auth_hash text;
