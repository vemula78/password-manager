// POST /register, GET /kdf, POST /login, POST /refresh, POST /devices/:id/revoke
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type {
  KdfInfoResponse,
  LoginRequest,
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
    const { label, kdf, authTokenB64, header, deviceId, deviceLabel } = req.body ?? {};
    if (!label || !kdf || !authTokenB64 || !header || !deviceId || !deviceLabel) {
      return reply.code(400).send({ error: "missing required fields" });
    }
    const accountId = randomUUID();
    const authHash = await hashAuthToken(authTokenB64);
    await repo.createAccount({
      id: accountId,
      label,
      kdfSalt: kdf.saltB64,
      kdf,
      authHash,
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

  // Revoking a device deletes its refresh token server-side (SYNC-DESIGN.md §4).
  app.post<{ Body: { accountId: string; deviceId: string } }>(
    "/devices/revoke",
    async (req, reply) => {
      const { accountId, deviceId } = req.body ?? {};
      if (!accountId || !deviceId) {
        return reply.code(400).send({ error: "missing required fields" });
      }
      await repo.setDeviceRefreshHash(accountId, deviceId, null);
      return reply.code(204).send();
    },
  );
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
