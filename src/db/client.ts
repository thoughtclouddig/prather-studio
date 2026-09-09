/**
 * Postgres connection. Shared by the web app, the worker and the test suite, so
 * it must not depend on Next.js internals.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set. See .env.example.");
}

// Next dev reloads modules on every edit; without caching we exhaust Postgres
// connections within a few saves.
const globalForDb = globalThis as unknown as {
  __pratherSql?: ReturnType<typeof postgres>;
};

export const sql =
  globalForDb.__pratherSql ??
  postgres(connectionString, {
    max: process.env.DB_POOL_MAX ? Number(process.env.DB_POOL_MAX) : 10,
    idle_timeout: 20,
    // Replit's managed Postgres and Neon both require TLS; a local socket does
    // not. `prefer` covers both without a second env var.
    ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
      ? false
      : "prefer",
  });

if (process.env.NODE_ENV !== "production") globalForDb.__pratherSql = sql;

export const db = drizzle(sql, { schema });
export type Db = typeof db;
export { schema };
