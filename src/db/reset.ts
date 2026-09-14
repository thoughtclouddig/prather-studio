import "dotenv/config";
import { sql } from "./client";
import { DestructiveOperationRefused, requireDestructiveAllowed } from "./guard";

async function main() {
  await requireDestructiveAllowed("db:reset:dev");

  await sql`TRUNCATE TABLE
    activity_events, jobs, episode_content_drafts, episode_publications,
    episodes, sponsors, shows, sessions, users, settings,
    broadcast_observations, standing_blocks, worker_heartbeats,
    integration_credentials, episode_transcripts, transcript_segments
    RESTART IDENTITY CASCADE`;
  console.log("[reset] all tables truncated");
  await sql.end();
}

main().catch((e) => {
  if (e instanceof DestructiveOperationRefused) {
    console.error(`\n${e.message}`);
    process.exit(2);
  }
  console.error("[reset] failed:", e);
  process.exit(1);
});
