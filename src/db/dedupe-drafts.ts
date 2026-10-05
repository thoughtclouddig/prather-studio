/**
 * Retire duplicate content drafts left by two packaging runs.
 *
 * ## What happened
 *
 * The manual RUN CONTENT ENGINE button built its idempotency key with
 * `Date.now()`, so it could never match the key the transcript chain uses. Both
 * paths ran on the same episode and nothing retired the first generation — so
 * every field exists twice, and an operator approved across both sets.
 *
 * That cause is fixed. This clears the wreckage it left, which the fix cannot
 * do on its own because the rows already exist.
 *
 *   npm run fix:dedupe-drafts            # report only, changes nothing
 *   npm run fix:dedupe-drafts -- --apply
 *
 * ## Which one survives
 *
 * Per (episode, field, platform), in order:
 *
 *  1. **An APPROVED draft wins.** It is the one a human decided on, and a
 *     script does not overrule that.
 *  2. If several are approved — the state this is cleaning up — the NEWEST
 *     wins, because it came from the later run and matches whatever was
 *     reviewed most recently.
 *  3. Otherwise the newest.
 *
 * Losers become SUPERSEDED. Nothing is deleted; superseded drafts stay as
 * history, so a wrong call here is recoverable by looking at the episode's
 * drafts rather than by restoring a backup.
 */
import "dotenv/config";
import { asc, eq, ne } from "drizzle-orm";
import { db, sql } from "./client";
import { episodeContentDrafts } from "./schema";

const APPLY = process.argv.includes("--apply");

async function main() {
  const drafts = await db
    .select()
    .from(episodeContentDrafts)
    .where(ne(episodeContentDrafts.state, "SUPERSEDED"))
    .orderBy(asc(episodeContentDrafts.createdAt));

  // Group by what a reviewer would consider "the same slot".
  const groups = new Map<string, typeof drafts>();
  for (const draft of drafts) {
    const key = `${draft.episodeId}|${draft.field}|${draft.platform ?? "-"}`;
    const list = groups.get(key) ?? [];
    list.push(draft);
    groups.set(key, list);
  }

  const losers: typeof drafts = [];
  let duplicatedSlots = 0;

  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    duplicatedSlots++;

    const approved = list.filter((d) => d.state === "APPROVED");
    const pool = approved.length > 0 ? approved : list;
    // Newest last, because the query ordered by createdAt ascending.
    const keep = pool[pool.length - 1]!;

    const [, field, platform] = key.split("|");
    console.log(
      `  ${field}${platform !== "-" ? ` (${platform})` : ""}: ` +
        `${list.length} live, keeping ${keep.state} from ${keep.createdAt.toISOString()}`,
    );

    for (const draft of list) {
      if (draft.id !== keep.id) losers.push(draft);
    }
  }

  console.log("");
  console.log(`  live drafts     : ${drafts.length}`);
  console.log(`  duplicated slots: ${duplicatedSlots}`);
  console.log(`  to retire       : ${losers.length}`);

  if (losers.length === 0) {
    console.log("\n  Nothing to do.\n");
    await sql.end();
    return;
  }

  if (!APPLY) {
    console.log("\n  Report only. Re-run with --apply to retire them.\n");
    await sql.end();
    return;
  }

  for (const draft of losers) {
    await db
      .update(episodeContentDrafts)
      .set({ state: "SUPERSEDED" })
      .where(eq(episodeContentDrafts.id, draft.id));
  }

  console.log(`\n  Retired ${losers.length} duplicate draft(s). None deleted.\n`);
  await sql.end();
}

main().catch(async (error) => {
  console.error("[dedupe-drafts] failed:", error instanceof Error ? error.message : error);
  try {
    await sql.end();
  } catch {
    /* already closed */
  }
  process.exit(1);
});
