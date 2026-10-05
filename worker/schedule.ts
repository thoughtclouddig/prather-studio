/**
 * Recurring work, scheduled inside the worker.
 *
 * ## Why not the platform's scheduler
 *
 * The plan was Replit Scheduled Deployments. That pane does not exist in the
 * current Replit UI, and depending on a hosting provider's console for the one
 * thing that makes this system autonomous is fragile anyway: it lives outside
 * the repository, it is not reviewed, it cannot be tested, and nobody can tell
 * from the code whether it is configured.
 *
 * The worker already runs continuously — that is the entire reason Phase 1
 * chose a Reserved VM over Autoscale, which recycles instances between
 * requests. So the schedule lives here, deploys with the application, and is
 * visible to anyone reading it.
 *
 * ## The schedule only ENQUEUES
 *
 * It never executes the work. A tick writes a job and returns; the normal queue
 * loop picks it up. So a slow poll can never overlap its own schedule, and a
 * long job cannot block the ticker.
 *
 * ## Time buckets rather than timers
 *
 * Each job's idempotency key carries the time bucket it belongs to:
 *
 *     rumble.poll_live:2026-10-05T21:19
 *
 * Which gives three properties for free, none of which a naive `setInterval`
 * has:
 *
 *  · **Restart-safe.** A worker that restarts twice in a minute does not fire
 *    three polls — the second and third collide with the first bucket and are
 *    dropped by `onConflictDoNothing`.
 *  · **Multi-worker-safe.** Two workers racing the same bucket produce one job,
 *    not two. The queue's unique index settles it, with no lock to take.
 *  · **Self-describing.** The key says exactly which minute a poll was for,
 *    which makes a gap in the record obvious rather than invisible.
 */
import { enqueue } from "@/lib/queue/queue";

export interface ScheduledTask {
  kind: string;
  /** How often it should run. */
  everyMs: number;
  /** Bucket granularity for the idempotency key. */
  bucket: (now: Date) => string;
  maxAttempts: number;
  why: string;
}

const minute = (d: Date) => d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
const hour = (d: Date) => d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
const sixHour = (d: Date) =>
  `${d.toISOString().slice(0, 10)}T${String(Math.floor(d.getUTCHours() / 6) * 6).padStart(2, "0")}`;

export const SCHEDULE: ScheduledTask[] = [
  {
    kind: "rumble.poll_live",
    everyMs: 60_000,
    bucket: minute,
    maxAttempts: 2,
    why:
      "Rumble emits no 'finished' event. The end of a show is inferred from a " +
      "previously-live stream disappearing, so the boundary is only ever as " +
      "precise as the poll interval.",
  },
  {
    kind: "integration.health_check",
    everyMs: 3_600_000,
    bucket: hour,
    maxAttempts: 2,
    why:
      "Surfaces an expiring YouTube token before a show rather than after. " +
      "Testing-mode refresh tokens expire in seven days.",
  },
  {
    kind: "metrics.snapshot",
    everyMs: 21_600_000,
    bucket: sixHour,
    maxAttempts: 2,
    why:
      "Rumble followers and Buzzsprout plays are point-in-time counters that " +
      "nobody keeps history for. A window missed is growth data that cannot " +
      "be recovered afterwards.",
  },
];

/** Jobs that are only worth enqueueing when they can actually do something. */
const lastRun = new Map<string, number>();

/**
 * Enqueue whatever is due. Returns the kinds actually created.
 *
 * Safe to call as often as the main loop likes — the `everyMs` check avoids
 * pointless database writes, and the bucket key makes a duplicate harmless
 * even when that check is wrong after a restart.
 */
export async function runDueTasks(now = new Date()): Promise<string[]> {
  const created: string[] = [];

  for (const task of SCHEDULE) {
    const previous = lastRun.get(task.kind) ?? 0;
    if (now.getTime() - previous < task.everyMs) continue;

    try {
      const result = await enqueue({
        kind: task.kind,
        idempotencyKey: `${task.kind}:${task.bucket(now)}`,
        maxAttempts: task.maxAttempts,
      });
      lastRun.set(task.kind, now.getTime());
      if (result.created) created.push(task.kind);
    } catch {
      // A scheduling failure must never take the worker down. The next tick
      // tries again; the bucket key means nothing is double-enqueued if the
      // write actually landed before the error.
      lastRun.set(task.kind, now.getTime());
    }
  }

  return created;
}

/** Test seam: forget what has run, so a suite can drive the clock itself. */
export function resetScheduleState(): void {
  lastRun.clear();
}
