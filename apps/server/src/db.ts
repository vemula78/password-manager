// pg Pool + migration runner. Only imported by index.ts / pg-repo.ts — tests never touch
// this file, so `npx vitest run` stays green without a live Postgres.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

// Applied in order on every boot. Each file must be idempotent (IF NOT EXISTS etc.) — there
// is no migrations table; re-running them is the mechanism, not a hazard.
const MIGRATIONS = ["001_init.sql", "002_recovery_auth.sql"];

export async function runMigrations(pool: pg.Pool): Promise<void> {
  for (const name of MIGRATIONS) {
    const sql = readFileSync(join(__dirname, "..", "migrations", name), "utf8");
    await pool.query(sql);
  }
}
