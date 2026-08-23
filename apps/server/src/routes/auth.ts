// POST /register, GET /kdf, POST /login, POST /refresh, POST /devices/:id/revoke
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  KdfInfoResponse,
  LoginRequest,
  RecoveryLoginRequest,
  RegisterRequest,
  SessionResponse,
} from "@pw/sync";
import {
  dummyKdfParams,
  generateRefreshToken,
  hashAuthToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAuthToken,
  verifyRefreshToken,
  type ServerConfig,
} from "../auth.js";
import type { SyncRepository } from "../repo.js";
import { requireAuth } from "./sync.js";

export interface AuthRouteDeps {
  repo: SyncRepository;
  config: ServerConfig;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { repo, config } = deps;

  // Unauthenticated by design (SYNC-DESIGN.md §4) — the client needs the salt before it can
  // derive a KEK. Returns a deterministic dummy for unknown accounts so this cannot be used
  // to enumerate real accounts.
  app.get<{ Querystring: { accountId?: string } }>("/kdf", async (req, reply) => {
    const accountId = req.query.accountId;
    if (!accountId) {
      return reply.code(400).send({ error: "accountId is required" });
    }
    const account = await repo.getAccount(accountId);
    const kdf = account ? account.kdf : dummyKdfParams(config, accountId);
    const body: KdfInfoResponse = { kdf };
    return reply.send(body);
  });

  app.post<{ Body: RegisterRequest }>("/register", async (req, reply) => {
    // This is a personal single-user server: unbounded account creation has no legitimate
    // use, so registration closes itself after the first account unless the operator
    // explicitly opts back in via REGISTRATION_OPEN=true (e.g. to add a second account).
    if (!config.registrationOpen && (await repo.hasAnyAccount())) {
      return reply.code(403).send({ error: "registration is closed" });
    }

    const { label, kdf, authTokenB64, recoveryAuthTokenB64, header, deviceId, deviceLabel } =
      req.body ?? {};
    if (!label || !kdf || !authTokenB64 || !header || !deviceId || !deviceLabel) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    const accountId = randomUUID();
    const authHash = await hashAuthToken(authTokenB64);
    // Optional: only a client that just created the recovery key holds its bytes. Absent
    // means recovery sign-in stays unavailable until the key is rotated.
    const recoveryAuthHash = recoveryAuthTokenB64
      ? await hashAuthToken(recoveryAuthTokenB64)
      : null;
    await repo.createAccount({
      id: accountId,
      label,
      kdfSalt: kdf.saltB64,
      kdf,
      authHash,
      recoveryAuthHash,
      header,
    });
    await repo.upsertDevice(accountId, deviceId, deviceLabel);

    const session = await issueSession(repo, config, accountId, deviceId);
    return reply.code(201).send(session);
  });

  app.post<{ Body: LoginRequest }>("/login", async (req, reply) => {
    const { accountId, authTokenB64, deviceId, deviceLabel } = req.body ?? {};
    if (!accountId || !authTokenB64 || !deviceId || !deviceLabel) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    const account = await repo.getAccount(accountId);
    if (!account) {
      // Constant-time-ish: still do a hash verify against a dummy to avoid an obvious
      // timing gap between "no such account" and "wrong token".
      await verifyAuthToken(
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        authTokenB64,
      ).catch(() => false);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const ok = await verifyAuthToken(account.authHash, authTokenB64);
    if (!ok) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    await repo.upsertDevice(accountId, deviceId, deviceLabel);
    const session = await issueSession(repo, config, accountId, deviceId);
    return reply.send(session);
  });

  /**
   * Sign in with the recovery-derived verifier (SYNC-DESIGN.md §4). This exists so a device
   * that unlocked with a recovery key — and therefore has no KEK and no password token — can
   * still push its rewrapped header. Without it such a device is locked out of the server
   * permanently, and the old master password keeps working against it forever.
   *
   * Rate-limited together with /login (shared prefix bucket in index.ts).
   */
  app.post<{ Body: RecoveryLoginRequest }>("/login/recovery", async (req, reply) => {
    const { accountId, recoveryAuthTokenB64, deviceId, deviceLabel } = req.body ?? {};
    if (!accountId || !recoveryAuthTokenB64 || !deviceId || !deviceLabel) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    const account = await repo.getAccount(accountId);
    // A null recoveryAuthHash means this account never registered a recovery verifier. It
    // must behave exactly like a wrong credential — same dummy verify, same 401, same timing
    // — so it cannot be probed, and must NEVER be read as "no verifier set, so allow in".
    if (!account || !account.recoveryAuthHash) {
      await verifyAuthToken(
        "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        recoveryAuthTokenB64,
      ).catch(() => false);
      return reply.code(401).send({ error: "invalid credentials" });
    }
    const ok = await verifyAuthToken(account.recoveryAuthHash, recoveryAuthTokenB64);
    if (!ok) {
      return reply.code(401).send({ error: "invalid credentials" });
    }
    await repo.upsertDevice(accountId, deviceId, deviceLabel);
    const session = await issueSession(repo, config, accountId, deviceId);
    return reply.send(session);
  });

  app.post<{ Body: { accountId: string; deviceId: string; refreshToken: string } }>(
    "/refresh",
    async (req, reply) => {
      const { accountId, deviceId, refreshToken } = req.body ?? {};
      if (!accountId || !deviceId || !refreshToken) {
        return reply.code(400).send({ error: "missing required fields" });
      }
      const device = await repo.getDevice(accountId, deviceId);
      if (!device || !device.refreshHash || !verifyRefreshToken(device.refreshHash, refreshToken)) {
        return reply.code(401).send({ error: "invalid refresh token" });
      }
      const session = await issueSession(repo, config, accountId, deviceId);
      return reply.send(session);
    },
  );

  // Revoking a device deletes its refresh token server-side (SYNC-DESIGN.md §4). Bearer-
  // authenticated: the account is derived from the caller's own access token, never from the
  // request body, so a device can only ever revoke a device belonging to its own account.
  // Any accountId formerly accepted in the body is ignored.
  app.post<{ Body: { deviceId: string } }>("/devices/revoke", async (req, reply) => {
    const authed = requireAuth(config, req, reply);
    if (!authed) return;

    const { deviceId } = req.body ?? {};
    if (!deviceId) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    // (accountId, deviceId) is a composite key, so a foreign deviceId simply does not exist
    // under this account — there is no code path that can reach another account's device.
    const device = await repo.getDevice(authed.accountId, deviceId);
    if (!device) {
      return reply.code(404).send({ error: "device not found" });
    }
    await repo.setDeviceRefreshHash(authed.accountId, deviceId, null);
    return reply.code(204).send();
  });
}

async function issueSession(
  repo: SyncRepository,
  config: ServerConfig,
  accountId: string,
  deviceId: string,
): Promise<SessionResponse> {
  const { token, expiresIn } = issueAccessToken(config, accountId, deviceId);
  const refreshToken = generateRefreshToken();
  await repo.setDeviceRefreshHash(accountId, deviceId, hashRefreshToken(refreshToken));
  return { accountId, accessToken: token, expiresIn, refreshToken };
}
