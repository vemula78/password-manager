// Fastify bootstrap. Config from env: PORT, DATABASE_URL, SERVER_SECRET.
import Fastify from "fastify";
import { createPool, runMigrations } from "./db.js";
import { PgSyncRepository } from "./pg-repo.js";
import type { ServerConfig } from "./auth.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerSyncRoutes } from "./routes/sync.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;
// SERVER_SECRET signs bearer tokens and derives dummy KDF params. Must be stable across
// restarts (a rotated secret invalidates every live session) and never logged.
const SERVER_SECRET = process.env.SERVER_SECRET;
// Browser clients are cross-origin whenever the PWA is not served from this same host —
// which is the RECOMMENDED deployment (SYNC-DESIGN.md §8: a server that also serves the app
// can ship tampered JavaScript). So CORS is required, and must be a strict allowlist:
// a wildcard would let any website in the user's browser talk to their sync server.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// A crude in-process token bucket is enough here: GET /kdf is the only unauthenticated
// route and the deployment target is a single small VM, not a fleet behind a shared cache.
const KDF_RATE_LIMIT_WINDOW_MS = 60_000;
const KDF_RATE_LIMIT_MAX = 30;

async function main(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }
  if (!SERVER_SECRET || SERVER_SECRET.length < 32) {
    throw new Error("SERVER_SECRET is required and must be at least 32 characters");
  }

  const pool = createPool(DATABASE_URL);
  await runMigrations(pool);
  const repo = new PgSyncRepository(pool);
  const config: ServerConfig = { serverSecret: Buffer.from(SERVER_SECRET, "utf8") };

  const app = await buildApp(repo, config, { allowedOrigins: ALLOWED_ORIGINS });
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

export interface BuildOptions {
  /** Exact origins allowed to call this server from a browser. Empty = same-origin only. */
  allowedOrigins?: string[];
  logger?: boolean;
}

export async function buildApp(
  repo: import("./repo.js").SyncRepository,
  config: ServerConfig,
  opts: BuildOptions = {},
) {
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);
  const app = Fastify({
    logger: opts.logger ?? true,
    // Vault content is ciphertext + small metadata; nothing legitimate approaches this.
    bodyLimit: 5 * 1024 * 1024,
  });

  // Strict-allowlist CORS, hand-rolled rather than pulling in @fastify/cors for ~20 lines.
  // The origin is echoed back ONLY on an exact allowlist match — never reflected blindly,
  // and never "*", which would expose the sync API to every site the user visits.
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Headers", "authorization,content-type");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      reply.header("Access-Control-Max-Age", "600");
    }
    if (req.method === "OPTIONS") {
      // Preflight: 204 whether or not the origin matched. An unmatched origin simply gets no
      // Allow-Origin header, and the browser blocks the real request.
      reply.code(204).send();
      return reply;
    }
  });

  const kdfHits = new Map<string, { count: number; windowStart: number }>();
  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url.startsWith("/kdf")) {
      const ip = req.ip;
      const now = Date.now();
      const entry = kdfHits.get(ip);
      if (!entry || now - entry.windowStart > KDF_RATE_LIMIT_WINDOW_MS) {
        kdfHits.set(ip, { count: 1, windowStart: now });
      } else {
        entry.count += 1;
        if (entry.count > KDF_RATE_LIMIT_MAX) {
          reply.code(429).send({ error: "rate limited" });
          return reply;
        }
      }
    }
  });

  registerAuthRoutes(app, { repo, config });
  registerSyncRoutes(app, { repo, config });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Deliberately no ciphertext/token fields ever flow into thrown errors in this codebase,
    // so logging the error object here cannot leak secrets.
    console.error("server failed to start", err);
    process.exit(1);
  });
}
