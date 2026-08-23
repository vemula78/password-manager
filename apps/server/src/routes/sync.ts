// GET /vault/changes, POST /vault/changes, POST /vault/header — all bearer-authenticated.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  ChangesResponse,
  ErrorResponse,
  HeaderPushRequest,
  PushRequest,
  PushResponse,
} from "@pw/sync";
import { hashAuthToken, verifyAccessToken, type ServerConfig } from "../auth.js";
import { HeaderConflictError, RevConflictError, type SyncRepository } from "../repo.js";

export interface SyncRouteDeps {
  repo: SyncRepository;
  config: ServerConfig;
}

interface Authed {
  accountId: string;
  deviceId: string;
}

function requireAuth(config: ServerConfig, req: FastifyRequest, reply: FastifyReply): Authed | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing bearer token" } satisfies ErrorResponse);
    return undefined;
  }
  const token = header.slice("Bearer ".length);
  const payload = verifyAccessToken(config, token);
  if (!payload) {
    reply.code(401).send({ error: "invalid or expired access token" } satisfies ErrorResponse);
    return undefined;
  }
  return { accountId: payload.accountId, deviceId: payload.deviceId };
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRouteDeps): void {
  const { repo, config } = deps;

  app.get<{ Querystring: { since?: string } }>("/vault/changes", async (req, reply) => {
    const authed = requireAuth(config, req, reply);
    if (!authed) return;

    const since = req.query.since !== undefined ? Number(req.query.since) : 0;
    if (!Number.isInteger(since) || since < 0) {
      return reply.code(400).send({ error: "invalid since" } satisfies ErrorResponse);
    }

    const changes = await repo.getChangesSince(authed.accountId, since);
    const body: ChangesResponse = {
      rev: changes.rev,
      header: changes.header,
      headerRev: changes.headerRev,
      items: changes.items.map((i) => ({ id: i.itemId, ct: i.ct, rev: i.rev })),
      deletions: changes.deletions.map((d) => ({
        id: d.id,
        deletedAt: d.deletedAt,
        deviceId: d.deviceId,
      })),
      settings: changes.settings,
    };
    req.log.info({ accountId: authed.accountId, rev: changes.rev }, "vault changes served");
    return reply.send(body);
  });

  app.post<{ Body: PushRequest }>("/vault/changes", async (req, reply) => {
    const authed = requireAuth(config, req, reply);
    if (!authed) return;

    const { baseRev, items, deletions, settings } = req.body ?? {};
    if (baseRev === undefined || !Array.isArray(items) || !Array.isArray(deletions)) {
      return reply.code(400).send({ error: "malformed push request" } satisfies ErrorResponse);
    }

    try {
      const result = await repo.pushChanges(authed.accountId, baseRev, { items, deletions, settings });
      req.log.info({ accountId: authed.accountId, rev: result.rev }, "vault push applied");
      return reply.send({ rev: result.rev } satisfies PushResponse);
    } catch (err) {
      if (err instanceof RevConflictError) {
        return reply
          .code(409)
          .send({ error: "rev conflict", serverRev: err.serverRev } satisfies ErrorResponse);
      }
      throw err;
    }
  });

  app.post<{ Body: HeaderPushRequest }>("/vault/header", async (req, reply) => {
    const authed = requireAuth(config, req, reply);
    if (!authed) return;

    const { baseHeaderRev, header, newAuthTokenB64 } = req.body ?? {};
    if (baseHeaderRev === undefined || !header) {
      return reply.code(400).send({ error: "malformed header push request" } satisfies ErrorResponse);
    }

    try {
      // Rotate the stored auth hash IN THE SAME TRANSACTION as the header write — see
      // repo.pushHeader. Getting this decoupled is the sharpest edge in this server: a
      // header write without the matching hash rotation locks the account out.
      const newAuthHash = newAuthTokenB64 !== undefined ? await hashAuthToken(newAuthTokenB64) : undefined;
      const result = await repo.pushHeader(authed.accountId, baseHeaderRev, header, newAuthHash);
      req.log.info(
        { accountId: authed.accountId, headerRev: result.headerRev },
        "vault header pushed",
      );
      return reply.send({ rev: result.headerRev } satisfies PushResponse);
    } catch (err) {
      if (err instanceof HeaderConflictError) {
        return reply.code(409).send({
          error: "header rev conflict",
          serverRev: err.serverHeaderRev,
        } satisfies ErrorResponse);
      }
      throw err;
    }
  });
}
