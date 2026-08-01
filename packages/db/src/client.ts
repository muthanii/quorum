import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

let singleton: Db | null = null;

/**
 * Lazy singleton database handle. DATABASE_URL is read at call time, not
 * import time, so apps can import the schema (types, tables) without a
 * database configured — only actually touching the DB requires the env var.
 */
export function getDb(): Db {
  if (singleton === null) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set. @quorum/db needs a Postgres connection string " +
          "(see .env.example) before getDb() can open a connection.",
      );
    }
    // prepare: false keeps us compatible with transaction-mode poolers
    // (Neon pooled endpoints, pgbouncer), which reject prepared statements.
    const client = postgres(url, { prepare: false });
    singleton = drizzle(client, { schema });
  }
  return singleton;
}
