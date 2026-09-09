import "dotenv/config";
import { sql } from "./client";

async function main() {
  await sql`TRUNCATE TABLE
    activity_events, jobs, episode_content_drafts, episode_publications,
    episodes, sponsors, shows, sessions, users, settings
    RESTART IDENTITY CASCADE`;
  console.log("[reset] all tables truncated");
  await sql.end();
}

main().catch((e) => {
  console.error("[reset] failed:", e);
  process.exit(1);
});
