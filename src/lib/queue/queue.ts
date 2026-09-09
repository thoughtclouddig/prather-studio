/**
 * Postgres-backed job queue.
 *
 * Claiming uses `FOR UPDATE SKIP LOCKED`, so several workers can poll the same
 * table without coordination and without ever handing the same row to two of
 * them. There is no Redis and no external broker: at two shows a week, a table
 * and an index are the right amount of machinery.
 *
 * State meanings:
 *   PENDING    queued, waiting for `run_after`
 *   RUNNING    claimed by a worker
 *   SUCCEEDED  terminal, succeeded
 *   FAILED     an attempt failed and a retry is scheduled (attempts < max)
 *   DEAD       out of attempts; a human must retry it
 */
import { and, eq, inArray, sql as raw } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { jobs, type Job } from "@/db/schema";
import { recordActivity, type Actor, SYSTEM_ACTOR } from "@/lib/domain/activity";

/** First retry after ~3s, then ~6s, ~12s … plus jitter. */
export const BACKOFF_BASE_MS = 3_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

export function backoffMs(attempts: number, base = BACKOFF_BASE_MS): number {
  const exponential = Math.min(base * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  const jitter = Math.random() * exponential * 0.2;
  return Math.round(exponential + jitter);
}

export interface EnqueueOptions {
  kind: string;
  /** UNIQUE across the table. Re-enqueueing the same key is a no-op. */
  idempotencyKey: string;
  episodeId?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
  actor?: Actor;
}

export interface EnqueueResult {
  job: Job;
  created: boolean;
}

/**
 * Enqueue a job. If a job with the same idempotency key already exists, returns
 * the existing row with `created: false`. The uniqueness guarantee lives in the
 * database, not in this function — concurrent callers cannot both win.
 */
export async function enqueue(options: EnqueueOptions): Promise<EnqueueResult> {
  const inserted = await db
    .insert(jobs)
    .values({
      kind: options.kind,
      idempotencyKey: options.idempotencyKey,
      episodeId: options.episodeId ?? null,
      payload: (options.payload ?? {}) as never,
      maxAttempts: options.maxAttempts ?? 3,
      runAfter: options.runAfter ?? new Date(),
    })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();

  const created = inserted[0];
  if (created) {
    await recordActivity({
      actor: options.actor ?? SYSTEM_ACTOR,
      verb: "job.enqueued",
      subjectType: "job",
      subjectId: created.id,
      episodeId: created.episodeId,
      summary: `Queued job ${created.kind}`,
      after: { kind: created.kind, state: created.state },
    });
    return { job: created, created: true };
  }

  const existing = await db
    .select()
    .from(jobs)
    .where(eq(jobs.idempotencyKey, options.idempotencyKey))
    .limit(1);
  return { job: existing[0]!, created: false };
}

/**
 * Atomically claim up to `limit` runnable jobs.
 *
 * PENDING and FAILED are both runnable — FAILED simply means "a retry is
 * scheduled", so the same query picks up first attempts and retries.
 */
export async function claim(workerId: string, limit = 1): Promise<Job[]> {
  const rows = await sql<Job[]>`
    WITH claimed AS (
      SELECT id
        FROM jobs
       WHERE state IN ('PENDING', 'FAILED')
         AND run_after <= now()
       ORDER BY run_after ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT ${limit}
    )
    UPDATE jobs j
       SET state      = 'RUNNING',
           attempts   = j.attempts + 1,
           claimed_at = now(),
           claimed_by = ${workerId},
           started_at = COALESCE(j.started_at, now()),
           updated_at = now()
      FROM claimed c
     WHERE j.id = c.id
 RETURNING j.id, j.kind, j.episode_id AS "episodeId", j.payload,
           j.idempotency_key AS "idempotencyKey", j.state, j.attempts,
           j.max_attempts AS "maxAttempts", j.run_after AS "runAfter",
           j.claimed_at AS "claimedAt", j.claimed_by AS "claimedBy",
           j.last_error AS "lastError", j.result,
           j.started_at AS "startedAt", j.finished_at AS "finishedAt",
           j.created_at AS "createdAt", j.updated_at AS "updatedAt"
  `;
  return rows as unknown as Job[];
}

export async function succeed(
  jobId: string,
  result?: Record<string, unknown>,
): Promise<Job> {
  const [updated] = await db
    .update(jobs)
    .set({
      state: "SUCCEEDED",
      result: (result ?? null) as never,
      lastError: null,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId))
    .returning();

  await recordActivity({
    actor: SYSTEM_ACTOR,
    verb: "job.succeeded",
    subjectType: "job",
    subjectId: jobId,
    episodeId: updated?.episodeId,
    summary: `Job ${updated?.kind} succeeded`,
    after: { state: "SUCCEEDED", attempts: updated?.attempts },
  });
  return updated!;
}

/**
 * Record a failed attempt. Schedules a retry if attempts remain, otherwise
 * marks the job DEAD so it surfaces to an operator instead of disappearing.
 */
export async function fail(
  jobId: string,
  error: string,
  opts: { backoffBase?: number } = {},
): Promise<Job> {
  const [current] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!current) throw new Error(`Job ${jobId} not found`);

  const exhausted = current.attempts >= current.maxAttempts;
  const [updated] = await db
    .update(jobs)
    .set({
      state: exhausted ? "DEAD" : "FAILED",
      lastError: error.slice(0, 4000),
      runAfter: exhausted
        ? current.runAfter
        : new Date(Date.now() + backoffMs(current.attempts, opts.backoffBase)),
      finishedAt: exhausted ? new Date() : null,
      claimedAt: null,
      claimedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, jobId))
    .returning();

  await recordActivity({
    actor: SYSTEM_ACTOR,
    verb: exhausted ? "job.dead" : "job.failed",
    subjectType: "job",
    subjectId: jobId,
    episodeId: updated?.episodeId,
    summary: exhausted
      ? `Job ${updated?.kind} exhausted ${updated?.maxAttempts} attempts and was dead-lettered`
      : `Job ${updated?.kind} attempt ${updated?.attempts} failed; retry scheduled`,
    after: { state: updated?.state, attempts: updated?.attempts, error },
  });
  return updated!;
}

/**
 * Operator-initiated retry of a FAILED or DEAD job. Attempts reset to zero so
 * the job gets a genuinely fresh run; `lastError` is kept until the next
 * attempt overwrites it, so the Jobs page can still say why it died.
 */
export async function retry(jobId: string, actor: Actor = SYSTEM_ACTOR): Promise<Job> {
  const [updated] = await db
    .update(jobs)
    .set({
      state: "PENDING",
      attempts: 0,
      runAfter: new Date(),
      claimedAt: null,
      claimedBy: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(jobs.id, jobId), inArray(jobs.state, ["FAILED", "DEAD"])))
    .returning();

  if (!updated) {
    throw new Error("Only FAILED or DEAD jobs can be retried.");
  }

  await recordActivity({
    actor,
    verb: "job.retried",
    subjectType: "job",
    subjectId: jobId,
    episodeId: updated.episodeId,
    summary: `Job ${updated.kind} manually retried`,
    after: { state: "PENDING", attempts: 0 },
  });
  return updated;
}

/** Requeue jobs a worker claimed and then died holding. */
export async function reclaimStale(olderThanMs = 5 * 60_000): Promise<number> {
  const result = await db
    .update(jobs)
    .set({ state: "PENDING", claimedAt: null, claimedBy: null, updatedAt: new Date() })
    .where(
      and(
        eq(jobs.state, "RUNNING"),
        raw`${jobs.claimedAt} < now() - ${`${Math.round(olderThanMs / 1000)} seconds`}::interval`,
      ),
    )
    .returning({ id: jobs.id });
  return result.length;
}
