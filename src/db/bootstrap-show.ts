/**
 * Create the show and its global settings row. Production-safe.
 *
 * ## Why this is separate from `db:seed`
 *
 * An episode cannot exist without a show, so a freshly migrated database
 * cannot do anything at all until this row exists — "No show is configured"
 * is the wall you hit after bootstrapping an owner and nothing else.
 *
 * The only thing that created it was `db:seed`, which deletes every table and
 * writes demo episodes, drafts and dead jobs. Right for judging the workflow
 * on a laptop; wrong on the real podcast's database.
 *
 * So this writes exactly two rows — the show, and the global settings it
 * depends on — and touches nothing else. Like `bootstrap:owner` it is
 * idempotent: re-running updates the existing show rather than creating a
 * second one, because two shows with the same slug would silently split the
 * episode list.
 *
 *   npm run bootstrap:show
 *
 * Everything here is editable afterwards in Settings. These are starting
 * values, not configuration locked into code.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, sql } from "./client";
import { settings, shows } from "./schema";

/** Tue and Thu, 0 = Sunday. Drives the next-expected-slot calculation. */
const CADENCE_DAYS = [2, 4];

async function main() {
  const slug = process.env.SHOW_SLUG ?? "the-prather-point";

  const values = {
    slug,
    name: process.env.SHOW_NAME ?? "The Prather Point",
    tagline: "Freedom Is Taken",
    defaultStartTime: process.env.SHOW_START_TIME ?? "14:00",
    timezone: process.env.SHOW_TIMEZONE ?? "America/New_York",
    cadenceNote: "Live Tuesdays & Thursdays, 2:00 PM ET",
    cadenceDays: CADENCE_DAYS,
    credentialLine: "Jeffrey Prather · MAJ, US Army (Ret.) · ex-DIA / DEA",
    briefLabel: "Intelligence Brief",
    titlePrefix: "TPP",
  };

  const [existing] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(eq(shows.slug, slug))
    .limit(1);

  const [show] = existing
    ? await db
        .update(shows)
        .set(values)
        .where(eq(shows.id, existing.id))
        .returning({ id: shows.id, name: shows.name })
    : await db.insert(shows).values(values).returning({ id: shows.id, name: shows.name });

  // The settings row is a singleton keyed "global". Composition reads it for
  // the standing CTA blocks, so an absent row breaks description assembly.
  const [settingsRow] = await db
    .select({ id: settings.id })
    .from(settings)
    .where(eq(settings.id, "global"))
    .limit(1);

  if (!settingsRow) {
    await db.insert(settings).values({
      id: "global",
      patreonUrl: "https://www.patreon.com/JeffreyPrather",
      localsUrl: "https://jeffreyprather.locals.com",
      supportUrl: "https://jeffreyprather.com/support/",
      fromName: "Jeff Prather",
    });
  }

  console.log("");
  console.log(`  SHOW ${existing ? "updated" : "created"} : ${show!.name}`);
  console.log(`  id            : ${show!.id}`);
  console.log(`  cadence       : Tue & Thu, ${values.defaultStartTime} ${values.timezone}`);
  console.log(`  settings      : ${settingsRow ? "already present" : "created"}`);
  console.log("");
  console.log("  Editable in Settings. Create the first episode from the Dashboard.");
  console.log("");

  await sql.end();
}

main().catch(async (error) => {
  console.error("[bootstrap-show] failed:", error instanceof Error ? error.message : error);
  try {
    await sql.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
