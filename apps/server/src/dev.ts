// Local development server: real routes, in-memory storage, nothing persisted.
// For trying sync across two browser profiles without standing up Postgres.
// NEVER use this for anything real — the whole vault disappears when the process exits.
import { buildApp } from "./index.js";
import { InMemorySyncRepository } from "./memory-repo.js";

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = await buildApp(
  new InMemorySyncRepository(),
  { serverSecret: Buffer.from("dev-only-insecure-secret-not-for-real-use!!") },
  { allowedOrigins: ORIGINS },
);
await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`dev sync server (in-memory) on http://127.0.0.1:${PORT}, CORS: ${ORIGINS.join(", ")}`);
