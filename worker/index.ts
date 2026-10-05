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
import { claim, defer, fail, JobDeferred, reclaimStale, succeed } from "../src/lib/queue/queue";
import { getHandler } from "../src/lib/queue/handlers";
import { runDueTasks } from "./schedule";
import {
  assertWorkerAllowed,
  beat,
  HEARTBEAT_INTERVAL_MS,
  identify,
  register,
} from "../src/lib/queue/worker-registry";

const IDENTITY = identify();
const WORKER_ID = IDENTITY.workerId;
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
      // A handler that says "not ready yet" is not a handler that failed.
      if (error instanceof JobDeferred) {
        await defer(job.id, error.runAfter, error.why);
        log("job.deferred", {
          jobId: job.id,
          kind: job.kind,
          until: error.runAfter.toISOString(),
          why: error.why,
        });
        continue;
      }
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
  log("worker.start", {
    pollMs: POLL_MS,
    batch: BATCH,
    environment: IDENTITY.environment,
    version: IDENTITY.version,
  });

  // Before touching a single job: is this worker allowed to run against this
  // database at all? Phase 2 had four workers competing, two of them stale.
  const verdict = await assertWorkerAllowed(IDENTITY);
  if (!verdict.allowed) {
    await register(IDENTITY, verdict.reason);
    log("worker.refused", { reason: verdict.reason });
    await sql.end();
    process.exit(2);
  }
  await register(IDENTITY);

  // A worker that died mid-job leaves rows stuck in RUNNING. Free them on boot.
  const reclaimed = await reclaimStale();
  if (reclaimed > 0) log("worker.reclaimed_stale", { count: reclaimed });

  let sinceReclaim = Date.now();
  let sinceBeat = 0;
  let claimedSinceBeat = 0;

  // Fire the schedule once on boot so a restart does not leave a gap until the
  // next interval comes round.
  const booted = await runDueTasks();
  if (booted.length > 0) log("schedule.enqueued", { kinds: booted, onBoot: true });

  while (running) {
    try {
      // Enqueue anything due BEFORE claiming, so work scheduled this tick is
      // available to this same tick rather than waiting for the next one.
      const due = await runDueTasks();
      if (due.length > 0) log("schedule.enqueued", { kinds: due });

      const processed = await tick();
      claimedSinceBeat += processed;
      if (Date.now() - sinceReclaim > 60_000) {
        await reclaimStale();
        sinceReclaim = Date.now();
      }
      // The heartbeat is what makes "is the worker running?" answerable from
      // the Studio rather than from someone SSHing into the VM.
      if (Date.now() - sinceBeat > HEARTBEAT_INTERVAL_MS) {
        await beat(WORKER_ID, claimedSinceBeat);
        claimedSinceBeat = 0;
        sinceBeat = Date.now();
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
