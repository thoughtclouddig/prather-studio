import "dotenv/config";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";

async function main() {
  console.log("[migrate] applying migrations from ./drizzle");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("[migrate] done");
  await sql.end();
}

main().catch((error) => {
  console.error("[migrate] failed:", error);
  process.exit(1);
});
