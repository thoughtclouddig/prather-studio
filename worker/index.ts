/**
 * The Prather Point Studio worker.
 *
 * A single long-lived process that polls the `jobs` table and runs handlers.
 * It exists because asynchronous production work — transcripts, uploads,
 * analytics refreshes — cannot safely run inside an HTTP request handler on a
 * platform that recycles instances between requests.
 *
 * Run it on a Replit Reserved VM (always on). See DEPLOYMENT.md.
 */
import "dotenv/config";
import { sql } from "../src/db/client";
import { claim, fail, reclaimStale, succeed } from "../src/lib/queue/queue";
import { getHandler } from "../src/lib/queue/handlers";

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const BATCH = Number(process.env.WORKER_BATCH ?? 5);

let running = true;

function log(message: string, extra?: unknown) {
  const line = { ts: new Date().toISOString(), worker: WORKER_ID, message, ...(extra ?? {}) };
  console.log(JSON.stringify(line));
}

async function tick(): Promise<number> {
  const claimed = await claim(WORKER_ID, BATCH);
  for (const job of claimed) {
    const handler = getHandler(job.kind);
    if (!handler) {
      await fail(job.id, `No handler registered for job kind "${job.kind}"`);
      log("job.no_handler", { jobId: job.id, kind: job.kind });
      continue;
    }
    try {
      const result = await handler(job, { workerId: WORKER_ID });
      await succeed(job.id, (result ?? undefined) as Record<string, unknown> | undefined);
      log("job.succeeded", { jobId: job.id, kind: job.kind, attempt: job.attempts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updated = await fail(job.id, message);
      log(updated.state === "DEAD" ? "job.dead" : "job.failed", {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        error: message,
      });
    }
  }
  return claimed.length;
}

async function main() {
  log("worker.start", { pollMs: POLL_MS, batch: BATCH });

  // A worker that died mid-job leaves rows stuck in RUNNING. Free them on boot.
  const reclaimed = await reclaimStale();
  if (reclaimed > 0) log("worker.reclaimed_stale", { count: reclaimed });

  let sinceReclaim = Date.now();
  while (running) {
    try {
      const processed = await tick();
      if (Date.now() - sinceReclaim > 60_000) {
        await reclaimStale();
        sinceReclaim = Date.now();
      }
      // Only idle when there was nothing to do — otherwise drain the backlog.
      if (processed === 0) await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (error) {
      log("worker.tick_error", {
        error: error instanceof Error ? error.message : String(error),
      });
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  await sql.end();
  log("worker.stopped");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("worker.shutdown_requested", { signal });
    running = false;
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

main().catch((error) => {
  log("worker.fatal", { error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
});
