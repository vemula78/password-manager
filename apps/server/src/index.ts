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

  const app = await buildApp(repo, config);
  await app.listen({ port: PORT, host: "0.0.0.0" });
}

export async function buildApp(repo: import("./repo.js").SyncRepository, config: ServerConfig) {
  const app = Fastify({
    logger: true,
    // Vault content is ciphertext + small metadata; nothing legitimate approaches this.
    bodyLimit: 5 * 1024 * 1024,
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
