/**
 * Worker identity, heartbeat, and the stale-worker guard.
 *
 * The problem this solves is real and already happened: Phase 2 found FOUR
 * worker processes competing for the same jobs, two of them started before
 * `ANTHROPIC_API_KEY` existed. They won packaging jobs and failed them. Nothing
 * in the system could tell that some of the workers were stale, because a
 * worker's only identity was a pid.
 *
 * Once the worker is responsible for processing a real show automatically —
 * fetching captions, spending Anthropic tokens, writing drafts — a forgotten
 * laptop worker pointed at the production database stops being an annoyance.
 *
 * The guard is deliberately small:
 *
 *   A worker declares which environment it believes it is connected to.
 *   The database says which environment it actually is.
 *   A mismatch refuses the claim and records why.
 *
 * That is enough to stop the actual failure mode. It is NOT a lease, a fencing
 * token, or a consensus protocol — this application runs one worker for a show
 * twice a week, and distributed-systems machinery here would be more likely to
 * cause an outage than prevent one.
 *
 * The complementary protection is that every job is idempotent by
 * construction, so even a worker that slips through cannot double-publish.
 */
import "server-only";
import { hostname } from "node:os";
import { eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { settings, workerHeartbeats, type WorkerHeartbeat } from "@/db/schema";

/** A worker is considered alive if it beat within this window. */
export const HEARTBEAT_STALE_MS = 90_000;

/** How often the worker should call `beat`. Comfortably inside the window. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface WorkerIdentity {
  workerId: string;
  environment: string;
  version: string | null;
  hostname: string;
  pid: number;
}

/**
 * Who this process is.
 *
 * `APP_ENV` is the declaration. It is separate from `NODE_ENV` on purpose: a
 * developer running `npm run worker` against a copy of production data has
 * NODE_ENV=development and means it, whereas someone who exported the
 * production `DATABASE_URL` into a local shell has made a mistake that
 * NODE_ENV cannot see.
 */
export function identify(): WorkerIdentity {
  const host = process.env["HOSTNAME"] ?? hostname();
  return {
    workerId: process.env["WORKER_ID"] ?? `${host}-${process.pid}`,
    environment: process.env["APP_ENV"] ?? process.env["NODE_ENV"] ?? "development",
    version:
      process.env["REPLIT_DEPLOYMENT_ID"] ??
      process.env["GIT_COMMIT"] ??
      process.env["SOURCE_VERSION"] ??
      null,
    hostname: host,
    pid: process.pid,
  };
}

/**
 * Which environment this database belongs to.
 *
 * Stored in the single-row settings table rather than read from the connected
 * process's own environment — the whole point is to compare the worker's belief
 * against something the worker did not supply.
 */
export async function databaseEnvironment(): Promise<string | null> {
  const [row] = await db
    .select({ env: settings.appEnvironment })
    .from(settings)
    .where(eq(settings.id, "global"))
    .limit(1);
  return row?.env ?? null;
}

export class WorkerRejectedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "WorkerRejectedError";
  }
}

/**
 * May this worker claim jobs against this database?
 *
 * An unclaimed database (no environment recorded) accepts anyone and adopts the
 * first worker's declaration. That keeps a fresh development database and a
 * first deploy frictionless; the guard engages as soon as there is something to
 * protect.
 */
export async function assertWorkerAllowed(
  identity: WorkerIdentity,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const dbEnv = await databaseEnvironment();

  if (!dbEnv) {
    await db
      .insert(settings)
      .values({ id: "global", appEnvironment: identity.environment })
      .onConflictDoUpdate({
        target: settings.id,
        set: { appEnvironment: identity.environment, updatedAt: new Date() },
      });
    return { allowed: true };
  }

  if (dbEnv !== identity.environment) {
    return {
      allowed: false,
      reason:
        `This database belongs to "${dbEnv}" but the worker declares APP_ENV="${identity.environment}". ` +
        "Refusing to claim jobs. If this worker is meant to run here, set APP_ENV to match; " +
        "if it is a leftover process pointed at the wrong DATABASE_URL, stop it.",
    };
  }

  return { allowed: true };
}

/** Announce this worker, or update its row if it is already known. */
export async function register(
  identity: WorkerIdentity,
  rejectedReason: string | null = null,
): Promise<WorkerHeartbeat> {
  const now = new Date();
  const [row] = await db
    .insert(workerHeartbeats)
    .values({
      workerId: identity.workerId,
      environment: identity.environment,
      version: identity.version,
      hostname: identity.hostname,
      pid: identity.pid,
      startedAt: now,
      lastBeatAt: now,
      rejectedReason,
    })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        environment: identity.environment,
        version: identity.version,
        pid: identity.pid,
        startedAt: now,
        lastBeatAt: now,
        jobsClaimed: 0,
        rejectedReason,
      },
    })
    .returning();
  return row!;
}

/** Record that this worker is still alive, and how much it has done. */
export async function beat(workerId: string, claimedDelta = 0): Promise<void> {
  await db
    .update(workerHeartbeats)
    .set({
      lastBeatAt: new Date(),
      jobsClaimed: sql`${workerHeartbeats.jobsClaimed} + ${claimedDelta}`,
    })
    .where(eq(workerHeartbeats.workerId, workerId));
}

export interface WorkerStatus extends WorkerHeartbeat {
  alive: boolean;
  secondsSinceBeat: number;
}

/** Every worker that has ever registered, newest heartbeat first. */
export async function listWorkers(now = new Date()): Promise<WorkerStatus[]> {
  const rows = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(sql`${workerHeartbeats.lastBeatAt} desc`);

  return rows.map((row) => {
    const since = now.getTime() - row.lastBeatAt.getTime();
    return {
      ...row,
      alive: since <= HEARTBEAT_STALE_MS && !row.rejectedReason,
      secondsSinceBeat: Math.max(0, Math.round(since / 1000)),
    };
  });
}

/** Are any workers alive right now? The dashboard needs a truthful answer. */
export async function anyWorkerAlive(now = new Date()): Promise<boolean> {
  const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.lastBeatAt, cutoff));
  return (row?.n ?? 0) > 0;
}

/**
 * Judge a set of workers without touching the database.
 *
 * Split out so the rules are testable: "more than one live worker" and "a live
 * worker on an unexpected version" are both conditions an operator should see,
 * and neither should require standing up Postgres to verify.
 */
export function assessWorkers(
  workers: WorkerStatus[],
  expectedVersion: string | null,
): { concerns: string[] } {
  const concerns: string[] = [];
  const live = workers.filter((w) => w.alive);

  if (live.length > 1) {
    concerns.push(
      `${live.length} workers are alive (${live.map((w) => w.workerId).join(", ")}). ` +
        "This deployment expects exactly one; competing workers is how Phase 2 " +
        "lost packaging jobs to a process with no API key.",
    );
  }

  if (expectedVersion) {
    const wrong = live.filter((w) => w.version && w.version !== expectedVersion);
    for (const w of wrong) {
      concerns.push(
        `Worker ${w.workerId} is running version ${w.version}, but this deployment is ${expectedVersion}.`,
      );
    }
  }

  for (const w of workers.filter((w) => w.rejectedReason)) {
    concerns.push(`Worker ${w.workerId} was refused: ${w.rejectedReason}`);
  }

  return { concerns };
}
