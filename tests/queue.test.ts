import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import {
  backoffMs,
  claim,
  enqueue,
  enqueueOrRerun,
  fail,
  retry,
  succeed,
} from "@/lib/queue/queue";
import { resetDb } from "./helpers";

beforeEach(resetDb);

describe("job queue", () => {
  it("enqueues a job in PENDING", async () => {
    const { job, created } = await enqueue({ kind: "ping", idempotencyKey: "k1" });
    expect(created).toBe(true);
    expect(job.state).toBe("PENDING");
    expect(job.attempts).toBe(0);
  });

  /**
   * Idempotency is enforced by a UNIQUE constraint, not by calling code. This
   * is the guard against double-publishing the same episode to the same place.
   */
  it("collapses duplicate idempotency keys to one job", async () => {
    const first = await enqueue({ kind: "ping", idempotencyKey: "same-key" });
    const second = await enqueue({ kind: "ping", idempotencyKey: "same-key" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);

    const all = await db.select().from(jobs);
    expect(all).toHaveLength(1);
  });

  it("claim() marks RUNNING and increments attempts", async () => {
    await enqueue({ kind: "ping", idempotencyKey: "c1" });
    const [claimed] = await claim("worker-a", 5);

    expect(claimed?.state).toBe("RUNNING");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimedBy).toBe("worker-a");
  });

  it("never hands the same job to two workers", async () => {
    await enqueue({ kind: "ping", idempotencyKey: "c2" });

    const [a, b] = await Promise.all([claim("worker-a", 5), claim("worker-b", 5)]);
    const ids = [...a, ...b].map((j) => j.id);

    expect(ids).toHaveLength(1);
  });

  it("does not claim jobs whose run_after is in the future", async () => {
    await enqueue({
      kind: "ping",
      idempotencyKey: "later",
      runAfter: new Date(Date.now() + 60_000),
    });
    expect(await claim("worker-a", 5)).toHaveLength(0);
  });

  it("succeed() stores the result and clears the error", async () => {
    await enqueue({ kind: "ping", idempotencyKey: "s1" });
    const [claimed] = await claim("worker-a");
    const done = await succeed(claimed!.id, { pong: true });

    expect(done.state).toBe("SUCCEEDED");
    expect(done.result).toEqual({ pong: true });
    expect(done.finishedAt).not.toBeNull();
  });

  it("fail() schedules a retry while attempts remain", async () => {
    await enqueue({ kind: "fail-test", idempotencyKey: "f1", maxAttempts: 3 });
    const [claimed] = await claim("worker-a");
    const failed = await fail(claimed!.id, "boom", { backoffBase: 50 });

    expect(failed.state).toBe("FAILED");
    expect(failed.attempts).toBe(1);
    expect(failed.lastError).toBe("boom");
    expect(failed.finishedAt).toBeNull();
    expect(failed.runAfter.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("dead-letters after max attempts", async () => {
    await enqueue({ kind: "fail-test", idempotencyKey: "f2", maxAttempts: 3 });

    for (let i = 0; i < 3; i++) {
      const [claimed] = await claim("worker-a");
      expect(claimed, `attempt ${i + 1} should have been claimable`).toBeDefined();
      await fail(claimed!.id, `boom ${i + 1}`, { backoffBase: 1 });
      await new Promise((r) => setTimeout(r, 30));
    }

    const [final] = await db.select().from(jobs).where(eq(jobs.kind, "fail-test"));
    expect(final?.state).toBe("DEAD");
    expect(final?.attempts).toBe(3);
    expect(final?.finishedAt).not.toBeNull();

    // A dead job must stay dead until a human intervenes.
    expect(await claim("worker-a", 5)).toHaveLength(0);
  });

  it("manual retry resurrects a DEAD job with fresh attempts", async () => {
    await enqueue({ kind: "fail-test", idempotencyKey: "f3", maxAttempts: 1 });
    const [claimed] = await claim("worker-a");
    const dead = await fail(claimed!.id, "boom");
    expect(dead.state).toBe("DEAD");

    const revived = await retry(dead.id, { kind: "system", label: "test" });
    expect(revived.state).toBe("PENDING");
    expect(revived.attempts).toBe(0);
    expect(revived.finishedAt).toBeNull();

    // …and it is genuinely runnable again.
    expect(await claim("worker-a", 5)).toHaveLength(1);
  });

  it("refuses to retry a job that is not FAILED or DEAD", async () => {
    const { job } = await enqueue({ kind: "ping", idempotencyKey: "r1" });
    await expect(retry(job.id)).rejects.toThrow(/FAILED or DEAD/);
  });

  it("backoff grows and stays bounded", async () => {
    expect(backoffMs(1, 1000)).toBeGreaterThanOrEqual(1000);
    expect(backoffMs(3, 1000)).toBeGreaterThan(backoffMs(1, 1000));
    expect(backoffMs(50, 1000)).toBeLessThanOrEqual(5 * 60_000 * 1.2 + 1);
  });
});

/**
 * A deterministic idempotency key is a one-shot. Once it exists, `enqueue`
 * does nothing forever — which is correct for deduplication and wrong for a
 * button an operator presses to re-run something. The content engine button
 * reported "Queued" either way, so a finished job produced a green message,
 * no drafts, and nothing on screen explaining the gap.
 */
describe("re-running the job behind a deterministic key", () => {
  it("queues normally the first time", async () => {
    const run = await enqueueOrRerun({ kind: "ping", idempotencyKey: "r1" });
    expect(run.outcome).toBe("queued");
  });

  it("re-runs a SUCCEEDED job instead of silently doing nothing", async () => {
    const { job } = await enqueue({ kind: "ping", idempotencyKey: "r2" });
    await claim("w", 5);
    await succeed(job.id, {});

    const run = await enqueueOrRerun({ kind: "ping", idempotencyKey: "r2" });
    expect(run.outcome).toBe("rerun");
    if (run.outcome === "rerun") expect(run.previousState).toBe("SUCCEEDED");

    const [after] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(after?.state).toBe("PENDING");
    expect(after?.attempts).toBe(0);

    // Re-run, not duplicated — two of every draft is the bug this key exists
    // to prevent, and the fix must not reintroduce it.
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("surfaces the previous error when the job had failed", async () => {
    const { job } = await enqueue({ kind: "ping", idempotencyKey: "r3", maxAttempts: 1 });
    await claim("w", 5);
    await fail(job.id, "Anthropic refused the request");

    const run = await enqueueOrRerun({ kind: "ping", idempotencyKey: "r3" });
    expect(run.outcome).toBe("rerun");
    if (run.outcome === "rerun") {
      expect(run.previousError).toContain("Anthropic refused the request");
    }
  });

  it("leaves a job that is still PENDING alone", async () => {
    await enqueue({ kind: "ping", idempotencyKey: "r4" });
    const run = await enqueueOrRerun({ kind: "ping", idempotencyKey: "r4" });
    expect(run.outcome).toBe("already-running");
  });

  it("leaves a RUNNING job alone rather than resetting work in flight", async () => {
    await enqueue({ kind: "ping", idempotencyKey: "r5" });
    await claim("w", 5);
    const run = await enqueueOrRerun({ kind: "ping", idempotencyKey: "r5" });
    expect(run.outcome).toBe("already-running");
  });
});
