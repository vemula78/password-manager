-- Schema per SYNC-DESIGN.md §6. Server never inspects `ct`/`header` contents beyond
-- treating them as opaque JSON blobs.

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY,
  label text NOT NULL,
  kdf_salt bytea NOT NULL,
  auth_hash text NOT NULL,
  header jsonb NOT NULL,
  header_rev bigint NOT NULL DEFAULT 0,
  rev bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS items (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  ct jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  rev bigint NOT NULL,
  PRIMARY KEY (account_id, item_id)
);

CREATE TABLE IF NOT EXISTS deletions (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  deleted_at timestamptz NOT NULL,
  rev bigint NOT NULL,
  PRIMARY KEY (account_id, item_id)
);

CREATE TABLE IF NOT EXISTS devices (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  label text NOT NULL,
  refresh_hash text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_id)
);

CREATE TABLE IF NOT EXISTS audit_shards (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  ct jsonb NOT NULL,
  rev bigint NOT NULL,
  PRIMARY KEY (account_id, device_id)
);

CREATE TABLE IF NOT EXISTS settings (
  account_id uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  ct jsonb NOT NULL,
  rev bigint NOT NULL DEFAULT 0
);
