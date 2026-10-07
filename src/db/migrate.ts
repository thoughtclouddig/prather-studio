/**
 * Apply migrations, and decide whether failing to is fatal.
 *
 * ## Why this is not simply "migrate or die"
 *
 * It was, and it took the production site down.
 *
 * The reasoning for aborting the boot is sound for a FRESH database: an empty
 * Postgres that never got its schema will fail every query, and that reads as
 * an application bug rather than a database that was never set up. Refusing to
 * serve turns an hour of confused debugging into "deploy failed, here is why".
 *
 * But it is the wrong trade for a database that is already working. This one's
 * schema was partly applied outside Drizzle, so its journal is behind what the
 * tables actually contain, and a replay dies on an object that already exists.
 * Aborting then takes down a Studio that would have run perfectly — every page,
 * including all the ones that never touch the new column.
 *
 * So the question is not "did migrations succeed" but "can this database serve
 * at all":
 *
 *   · No schema at all  -> migrations are the only way it will ever work.
 *                          Failure is fatal.
 *   · Schema present     -> the app can serve. Failure is loud, and the pages
 *                          needing the new columns will error, but the rest of
 *                          the Studio stays up.
 *
 * Deleting the migration step entirely — which is what happened the first time
 * this bit — is the third option, and the worst: schema changes then never
 * reach production at all, silently, for ever.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./client";

/**
 * Postgres codes meaning "this object is already here".
 *
 * Tolerated only in the reconcile path below, never in a normal run: they are
 * precisely the errors a replay produces against a schema that was applied
 * outside Drizzle, and precisely the ones that are safe to skip because the
 * thing the statement wanted to create already exists.
 */
const ALREADY_THERE = new Set([
  "42P07", // duplicate_table
  "42710", // duplicate_object  (type, constraint)
  "42701", // duplicate_column
  "42P06", // duplicate_schema
  "42P16", // invalid_table_definition, from a repeated PK add
]);

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/**
 * Apply every unrecorded migration, skipping statements whose object already
 * exists, then stamp the journal so Drizzle is back in step.
 *
 * Drizzle's migrator decides what to run by comparing each journal entry's
 * `when` against the newest `created_at` it has recorded. Stamping that value
 * is therefore what "this is applied" means to it.
 */
async function reconcile(): Promise<{ applied: string[]; skipped: number }> {
  const journal = JSON.parse(
    await readFile("./drizzle/meta/_journal.json", "utf8"),
  ) as { entries: JournalEntry[] };

  const recorded = await sql<{ created_at: string }[]>`
    SELECT created_at FROM drizzle.__drizzle_migrations
    ORDER BY created_at DESC LIMIT 1
  `;
  const lastApplied = Number(recorded[0]?.created_at ?? 0);

  const applied: string[] = [];
  let skipped = 0;

  for (const entry of journal.entries) {
    if (entry.when <= lastApplied) continue;

    const file = await readFile(`./drizzle/${entry.tag}.sql`, "utf8");
    const statements = file
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.trim())
      .filter(Boolean);

    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
      } catch (error) {
        const code = (error as { code?: string }).code ?? "";
        if (!ALREADY_THERE.has(code)) throw error;
        skipped += 1;
      }
    }

    // Stamped per migration, not once at the end: a failure partway through
    // leaves the earlier ones correctly recorded instead of replaying them all
    // again on the next boot.
    await sql`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES (${entry.tag}, ${entry.when})
    `;
    applied.push(entry.tag);
  }

  return { applied, skipped };
}

/** Does this database already have the application's schema? */
async function hasSchema(): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'shows'
    ) AS exists
  `;
  return rows[0]?.exists ?? false;
}

function banner(lines: string[]): void {
  const rule = "=".repeat(72);
  console.error(`\n${rule}\n${lines.join("\n")}\n${rule}\n`);
}

async function main() {
  const established = await hasSchema();

  console.log(
    `[migrate] applying migrations from ./drizzle (database is ${
      established ? "already set up" : "EMPTY"
    })`,
  );

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("[migrate] done");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!established) {
      banner([
        "MIGRATIONS FAILED ON AN EMPTY DATABASE.",
        "",
        message,
        "",
        "Not starting: there is no schema here, so every query would fail and",
        "it would look like broken code rather than a database that was never",
        "set up.",
      ]);
      await sql.end();
      process.exit(1);
    }

    // The database works but its journal is behind what the tables contain —
    // a schema applied outside Drizzle. Apply what is genuinely missing,
    // skip what is already there, and put the journal back in step so the
    // next boot is an ordinary no-op.
    console.error(`[migrate] replay failed (${message}); reconciling`);

    try {
      const { applied, skipped } = await reconcile();
      console.log(
        `[migrate] reconciled: applied ${applied.length} migration(s)` +
          `${applied.length > 0 ? ` (${applied.join(", ")})` : ""}, ` +
          `skipped ${skipped} statement(s) whose object already existed`,
      );
    } catch (reconcileError) {
      const detail =
        reconcileError instanceof Error
          ? reconcileError.message
          : String(reconcileError);
      banner([
        "MIGRATIONS FAILED AND COULD NOT BE RECONCILED.",
        "",
        `replay:    ${message}`,
        `reconcile: ${detail}`,
        "",
        "Starting anyway, because the database already has a schema and most",
        "of the Studio will work. Pages needing the missing columns will",
        "error until this is resolved.",
      ]);
    }
  }

  await sql.end();
}

main().catch(async (error) => {
  console.error("[migrate] failed:", error);
  try {
    await sql.end();
  } catch {
    /* already closing */
  }
  process.exit(1);
});
