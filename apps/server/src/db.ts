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

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await pool.query(sql);
}
