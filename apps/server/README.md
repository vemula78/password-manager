# @pw/server — self-hosted sync server

Dumb, authenticated, versioned ciphertext store. See `../../SYNC-DESIGN.md` for the binding
design (threat model, protocol, schema). This server never decrypts anything — every `ct`
field is opaque JSON to it.

## Endpoints

- `GET  /kdf?accountId=...` — unauthenticated, rate-limited. Returns the account's KDF
  params, or a deterministic dummy for unknown accounts.
- `POST /register` — creates an account, returns a session.
- `POST /login` — authenticates with `authTokenB64`, returns a session.
- `POST /refresh` — rotates the refresh token, returns a new session.
- `POST /devices/revoke` — deletes a device's refresh token.
- `GET  /vault/changes?since=<rev>` — bearer-authenticated pull.
- `POST /vault/changes` — bearer-authenticated push (optimistic concurrency on `baseRev`).
- `POST /vault/header` — bearer-authenticated header compare-and-set (master password /
  recovery rotation).

## Environment variables

| Variable        | Required | Notes                                                        |
|-----------------|----------|---------------------------------------------------------------|
| `PORT`          | no       | default `8787`                                                 |
| `DATABASE_URL`  | yes      | `postgres://user:pass@host:5432/dbname`                        |
| `SERVER_SECRET` | yes      | ≥32 random bytes; signs access tokens and the dummy-KDF HMAC. Rotating it logs out every device. Generate with `openssl rand -base64 48`. |

## Deploying on an Ubuntu VM behind nginx + TLS

1. Install Docker and Docker Compose on the VM.
2. Copy this `apps/server` directory to the VM (or clone the repo and `cd apps/server`).
3. Create `apps/server/.env`:
   ```
   POSTGRES_PASSWORD=<random>
   SERVER_SECRET=<output of: openssl rand -base64 48>
   ```
4. `docker compose up -d` (builds the server image from the repo root — run this from
   `apps/server` so the compose file's relative build context resolves, or pass
   `--build` with the repo root as context if you vendor a copy).
5. Confirm it's up: `curl http://127.0.0.1:8787/kdf?accountId=test` should return a JSON
   `{ "kdf": ... }` body — the server binds `127.0.0.1` only, not the public interface.
6. Point nginx at it, terminating TLS (Let's Encrypt via certbot):
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
8. `docker compose logs -f server` to confirm requests are being served. Logs contain
   account UUIDs and revision numbers only — never ciphertext or tokens.

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

Tests run against an in-memory repository and need no Postgres. `npx tsc --noEmit` type-checks
against the same strict config as `packages/core`.
