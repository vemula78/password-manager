# @pw/server — self-hosted sync server

Dumb, authenticated, versioned ciphertext store. See `../../SYNC-DESIGN.md` for the binding
design (threat model, protocol, schema). This server never decrypts anything — every `ct`
field is opaque JSON to it, **including deletion tombstones**: a tombstone is `{ id, ct }`
where `ct` is an AEAD ciphertext (sealed under the vault key) hiding the deletion time and
originating device. The server stores and returns `ct` verbatim and never parses it.

## Endpoints

- `GET  /kdf?accountId=...` — unauthenticated, rate-limited (30/min/IP). Returns the
  account's KDF params, or a deterministic dummy for unknown accounts.
- `POST /register` — creates an account, returns a session. Rate-limited (5/10min/IP).
  Closed by default once one account exists — see `REGISTRATION_OPEN` below.
- `POST /login` — authenticates with `authTokenB64`, returns a session. Rate-limited
  (10/min/IP).
- `POST /login/recovery` — authenticates with `recoveryAuthTokenB64`, the verifier derived
  from the printed recovery key (SYNC-DESIGN.md §4). This is the only way a device that
  unlocked via recovery key can reach the server: it has no KEK and so no password token.
  Shares the `/login` rate-limit bucket. An account with no recovery verifier registered
  answers exactly like a wrong key — same 401, same dummy Argon2 verify — and is never
  treated as "no verifier set, so allow in".
- `POST /refresh` — rotates the refresh token, returns a new session. Rate-limited
  (20/min/IP).
- `POST /devices/revoke` — **bearer-authenticated.** Deletes the caller's own device's
  refresh token; the account is taken from the access token, never from the request body,
  so a device can only ever revoke a device on its own account. Body is `{ deviceId }`.
- `GET  /vault/changes?since=<rev>&sinceHeader=<headerRev>` — bearer-authenticated pull.
  `since` and `sinceHeader` are separate counters — the header is returned iff
  `headerRev > sinceHeader`, never compared against the item `since`. A missing
  `sinceHeader` defaults to `0` for compatibility with older clients.
- `POST /vault/changes` — bearer-authenticated push (optimistic concurrency on `baseRev`).
  `deletions` are sealed tombstones (`{ id, ct }`).
- `POST /vault/header` — bearer-authenticated header compare-and-set (master password /
  recovery rotation). `newAuthTokenB64` and `newRecoveryAuthTokenB64` each rotate their
  verifier in the SAME transaction as the header write, so a credential can never fall out
  of step with the envelopes it unwraps.

Argon2id hashing (register/login) is additionally capped at 4 concurrent operations
process-wide, so a burst of requests queues rather than exhausting memory.

## Environment variables

| Variable            | Required | Notes                                                        |
|---------------------|----------|---------------------------------------------------------------|
| `PORT`              | no       | default `8787`                                                 |
| `DATABASE_URL`      | yes      | `postgres://user:pass@host:5432/dbname`                        |
| `SERVER_SECRET`     | yes      | ≥32 random bytes; signs access tokens and the dummy-KDF HMAC. Rotating it logs out every device. Generate with `openssl rand -base64 48`. |
| `ALLOWED_ORIGINS`   | no       | comma-separated exact-origin allowlist for browser CORS (e.g. `https://app.example.org`). Empty = no cross-origin browser access at all (same-origin only); there is no wildcard option, by design — see SYNC-DESIGN.md §8. |
| `REGISTRATION_OPEN` | no       | `true` to allow creating another account after the first already exists. This is a personal single-user server, so the default (`false`/unset) closes registration the moment one account exists — unbounded account creation has no legitimate use here. |

## Building and running

```
npm run build   # tsc -p tsconfig.build.json -> dist/
npm start       # node dist/index.js — needs DATABASE_URL and SERVER_SECRET
```

`npm run dev` builds and runs `dist/dev.js`: an in-memory server (no Postgres, nothing
persisted, registration always open) for trying sync across two browser profiles locally.
Never point a real vault at it.

## Deploying: web app on GitHub Pages, sync server on an Azure Linux VM

This is the recommended split. The two halves are deliberately on different origins:
GitHub Pages serves the JavaScript, this VM serves only ciphertext. A compromise of the
VM must not be able to ship tampered JavaScript that steals the master password
(SYNC-DESIGN.md §8), which is exactly what co-hosting them would allow.

**Nothing secret goes in the GitHub repo.** GitHub holds source code and serves the built
PWA. Vault ciphertext lives only in this server's Postgres volume and on your devices.

### 1. Web app (GitHub Pages)

Already wired: `.github/workflows/deploy-web.yml` builds `apps/web` and publishes to
Pages on every push to `main`. Enable it once in the repo's *Settings → Pages → Source →
GitHub Actions*. The result is served at `https://<user>.github.io/<repo>/`; the origin —
the part the server allowlists — is `https://<user>.github.io`, with no path.

(`deploy-cloudflare-pages.yml` targets the same app. Keep whichever you actually use and
delete the other, so a push does not publish two divergent copies.)

### 2. Azure VM

Create an Ubuntu 22.04/24.04 VM (B1s/B2s is ample; this is a low-traffic personal
service). In its Network Security Group open **only** TCP 22, 80 and 443 — never 8787,
which is bound to loopback and reached only through nginx. Point a DNS A record, e.g.
`sync.example.org`, at the VM's public IP.

### 3. Server

1. Install Docker and the Compose plugin.
2. Clone the repo on the VM and `cd apps/server`.
3. Create `apps/server/.env`:
   ```
   POSTGRES_PASSWORD=<random>
   SERVER_SECRET=<output of: openssl rand -base64 48>
   ALLOWED_ORIGINS=https://<user>.github.io
   REGISTRATION_OPEN=true
   ```
   `ALLOWED_ORIGINS` must be the exact scheme+host of the Pages site, no trailing slash
   and no path — get it wrong and every browser request fails CORS preflight. Set
   `REGISTRATION_OPEN=true` only until your first account exists, then remove the line and
   `docker compose up -d` again.
4. `docker compose up -d` from `apps/server`. The compose file sets the build context to
   the repo root because the image needs `packages/core` and `packages/sync`.
5. Confirm it is up: `curl "http://127.0.0.1:8787/kdf?accountId=test"` returns a JSON
   `kdf` body. It is not reachable from outside the VM at this point, by design.
6. nginx + TLS in front of it:
   ```nginx
   server {
       listen 443 ssl http2;
       server_name sync.example.org;

       ssl_certificate     /etc/letsencrypt/live/sync.example.org/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/sync.example.org/privkey.pem;

       client_max_body_size 6m; # match the server's bodyLimit with headroom

       location / {
           proxy_pass http://127.0.0.1:8787;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```
7. `sudo certbot --nginx -d sync.example.org` to obtain and auto-renew the certificate.
   TLS is not optional: the bearer token is a live credential on every request.
8. `docker compose logs -f server` to watch requests. Logs contain account UUIDs and
   revision numbers only — never ciphertext or tokens.

### 4. Connect a device

Open the Pages URL, unlock the vault, then *Settings → Sync*: server URL
`https://sync.example.org`, create the account on the first device, and connect the rest
with the same master password and the account ID the first device shows.

### Backups

This server holds no plaintext, but losing the Postgres volume still means losing every
device's only copy of anything pushed since its last local snapshot. Back up the `pgdata`
volume (e.g. nightly `pg_dump` to a separate host) — this is the operator's responsibility;
the design explicitly does not solve availability (SYNC-DESIGN.md §8).

## Local development

```
npm install --workspace @pw/server --workspace @pw/core --workspace @pw/sync   # from repo root
npx vitest run                                                                  # from apps/server
```

Tests run against an in-memory repository and need no Postgres — which means `pg-repo.ts`
is never executed by the default suite. To exercise the real Postgres path, bring up the
compose stack (see above) and run the manual test against it:

```
LIVE_SERVER=http://127.0.0.1:8787 npx vitest run test/live-pg.manual.test.ts
```

It registers an account and syncs two devices through real HTTP and real Postgres. It
writes to whatever database it points at, so use a throwaway stack, never your live one.
Without `LIVE_SERVER` set, `*.manual.test.ts` is excluded. `npx tsc --noEmit` type-checks
against the same strict config as `packages/core`.
