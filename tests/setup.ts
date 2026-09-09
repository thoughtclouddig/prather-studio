import { beforeAll } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "@/db/client";

// The schema is applied once per test file; migrations are idempotent.
beforeAll(async () => {
  await migrate(db, { migrationsFolder: "./drizzle" });
});
