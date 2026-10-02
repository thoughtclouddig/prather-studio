#!/usr/bin/env node
/**
 * Enqueue one job and exit. This is the entrypoint for Replit Scheduled
 * Deployments: the schedule enqueues, the always-on worker executes. Keeping
 * the two separate means a slow job can never overlap its own schedule.
 *
 *   node scripts/enqueue-job.mjs rumble.poll_live
 */
import "dotenv/config";
import postgres from "postgres";

const kind = process.argv[2];
if (!kind) {
  console.error("usage: node scripts/enqueue-job.mjs <job-kind>");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  // Minute-resolution idempotency key: a re-fired schedule collapses instead of
  // stacking duplicate polls.
  const bucket = Math.floor(Date.now() / 60_000);
  const [row] = await sql`
    INSERT INTO jobs (kind, idempotency_key, max_attempts)
    VALUES (${kind}, ${`${kind}:${bucket}`}, 1)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      kind,
      enqueued: !!row,
      note: row ? "queued" : "already queued for this minute",
    }),
  );
} finally {
  await sql.end();
}
