import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { SCHEDULE, resetScheduleState, runDueTasks } from "../worker/schedule";
import { resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
  resetScheduleState();
});

const countOf = async (kind: string) =>
  (await db.select().from(jobs).where(eq(jobs.kind, kind))).length;

describe("the in-worker schedule", () => {
  it("enqueues every task on the first run", async () => {
    const created = await runDueTasks(new Date("2026-10-05T21:19:00Z"));
    expect(created.sort()).toEqual(SCHEDULE.map((t) => t.kind).sort());
  });

  /**
   * The property a naive setInterval does not have: a worker that restarts
   * twice in a minute must not fire three polls.
   */
  it("does not double-enqueue within the same time bucket after a restart", async () => {
    const now = new Date("2026-10-05T21:19:30Z");
    await runDueTasks(now);

    resetScheduleState(); // simulates a worker restart
    const second = await runDueTasks(new Date("2026-10-05T21:19:45Z"));

    expect(second).not.toContain("rumble.poll_live");
    expect(await countOf("rumble.poll_live")).toBe(1);
  });

  it("enqueues the next poll once the minute rolls over", async () => {
    await runDueTasks(new Date("2026-10-05T21:19:00Z"));
    resetScheduleState();
    await runDueTasks(new Date("2026-10-05T21:20:00Z"));
    expect(await countOf("rumble.poll_live")).toBe(2);
  });

  /** Two workers racing the same bucket must produce one job, not two. */
  it("is safe when two workers fire the same bucket concurrently", async () => {
    const now = new Date("2026-10-05T21:19:00Z");
    resetScheduleState();
    const a = runDueTasks(now);
    resetScheduleState();
    const b = runDueTasks(now);
    await Promise.all([a, b]);
    expect(await countOf("rumble.poll_live")).toBe(1);
  });

  it("holds the hourly and six-hourly tasks to their own cadence", async () => {
    await runDueTasks(new Date("2026-10-05T21:00:00Z"));
    resetScheduleState();
    await runDueTasks(new Date("2026-10-05T21:30:00Z"));

    expect(await countOf("integration.health_check")).toBe(1);
    expect(await countOf("metrics.snapshot")).toBe(1);
    expect(await countOf("rumble.poll_live")).toBe(2);
  });

  it("buckets six-hourly snapshots to 00/06/12/18 UTC", async () => {
    await runDueTasks(new Date("2026-10-05T07:00:00Z"));
    resetScheduleState();
    await runDueTasks(new Date("2026-10-05T11:59:00Z"));
    expect(await countOf("metrics.snapshot")).toBe(1);

    resetScheduleState();
    await runDueTasks(new Date("2026-10-05T12:00:00Z"));
    expect(await countOf("metrics.snapshot")).toBe(2);
  });

  /** Every scheduled kind must have a handler, or it dead-letters forever. */
  it("every scheduled kind is a real handler", async () => {
    const { getHandler } = await import("@/lib/queue/handlers");
    for (const task of SCHEDULE) {
      expect(getHandler(task.kind), `no handler for ${task.kind}`).toBeTruthy();
    }
  });
});
