/**
 * Capturing growth that providers do not keep.
 *
 * ## Why this is narrow on purpose
 *
 * Measured, not assumed (see `docs/PHASE-3-INVESTIGATION.md` §5):
 *
 *   · YouTube Analytics returns a daily series retroactively. Three months came
 *     back on the first request. Snapshotting it here would build a second,
 *     worse copy of a series the provider already keeps — and would start it
 *     today, when the real one goes back years.
 *   · Rumble reports the follower count right now. Buzzsprout reports
 *     `total_plays` right now. Neither can be asked about last Tuesday.
 *
 * So this captures Rumble and Buzzsprout and deliberately skips YouTube. The
 * urgency is one-directional: a missed YouTube day is recoverable, a missed
 * Rumble day is gone permanently.
 *
 * ## What it stores
 *
 * Raw counters, as reported. Never a rate, a delta or a growth percentage —
 * those are a READING of the data, and readings get corrected. Deltas are
 * computed at read time by `growthBetween`, so improving the calculation is a
 * code change rather than a migration plus a backfill of numbers that can no
 * longer be verified.
 */
import "server-only";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db/client";
import {
  metricSnapshots,
  type IntegrationProvider,
  type MetricSnapshot,
  type MetricSubject,
} from "@/db/schema";

/** Counters are plain numbers keyed by the provider's own name for them. */
export type Counters = Record<string, number | null>;

export interface CaptureInput {
  provider: IntegrationProvider;
  subject: MetricSubject;
  externalId?: string | null;
  episodeId?: string | null;
  counters: Counters;
  capturedAt?: Date;
}

/** `YYYY-MM-DD` in UTC. One capture per subject per day. */
export function snapshotDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function snapshotKey(
  provider: string,
  subject: string,
  externalId: string | null,
  at: Date,
): string {
  return `${provider}:${subject}:${externalId ?? "-"}:${snapshotDay(at)}`;
}

/**
 * Record one capture. A second capture on the same day is a no-op.
 *
 * Deliberately first-write-wins rather than last: a job that runs twice because
 * a worker restarted should not move the day's number, and an operator
 * triggering a manual refresh should not rewrite history.
 */
export async function capture(
  input: CaptureInput,
): Promise<{ snapshot: MetricSnapshot; created: boolean }> {
  const capturedAt = input.capturedAt ?? new Date();
  const dedupeKey = snapshotKey(
    input.provider,
    input.subject,
    input.externalId ?? null,
    capturedAt,
  );

  const [inserted] = await db
    .insert(metricSnapshots)
    .values({
      provider: input.provider,
      subject: input.subject,
      externalId: input.externalId ?? null,
      episodeId: input.episodeId ?? null,
      capturedAt,
      counters: input.counters as never,
      dedupeKey,
    })
    .onConflictDoNothing({ target: metricSnapshots.dedupeKey })
    .returning();

  if (inserted) return { snapshot: inserted, created: true };

  const [existing] = await db
    .select()
    .from(metricSnapshots)
    .where(eq(metricSnapshots.dedupeKey, dedupeKey))
    .limit(1);
  return { snapshot: existing!, created: false };
}

/* ------------------------------------------------------------ reading */

export interface Growth {
  metric: string;
  first: number;
  last: number;
  delta: number;
  /** Null when the starting value is zero — percentage growth from nothing is
   *  not a large number, it is undefined, and rendering it as ∞% is a lie. */
  percent: number | null;
  /** Days actually covered by the data, NOT the requested window. */
  spanDays: number;
  /** How many captures the reading rests on. Shown so a two-point "trend"
   *  cannot be mistaken for an established one. */
  samples: number;
}

/**
 * Change between the earliest and latest capture in a set.
 *
 * Pure, so the arithmetic is testable without a database — and so the honesty
 * rules (undefined percentages, stated sample counts) are testable too.
 */
export function growthBetween(
  snapshots: Array<{ capturedAt: Date; counters: Counters }>,
  metric: string,
): Growth | null {
  const points = snapshots
    .filter((s) => typeof s.counters[metric] === "number")
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());

  if (points.length === 0) return null;

  const firstPoint = points[0]!;
  const lastPoint = points[points.length - 1]!;
  const first = firstPoint.counters[metric] as number;
  const last = lastPoint.counters[metric] as number;
  const spanMs = lastPoint.capturedAt.getTime() - firstPoint.capturedAt.getTime();

  return {
    metric,
    first,
    last,
    delta: last - first,
    percent: first === 0 ? null : ((last - first) / first) * 100,
    spanDays: Math.round(spanMs / 86_400_000),
    samples: points.length,
  };
}

/**
 * Is this reading strong enough to act on?
 *
 * Stated rather than implied. At two shows a week the channel produces 8-9
 * episodes a month, and a difference measured across two captures a day apart
 * is noise wearing a percentage sign. The Studio reports growth with its own
 * confidence attached so nobody has to remember to ask.
 */
export function readingConfidence(growth: Growth): {
  level: "none" | "weak" | "usable";
  note: string;
} {
  if (growth.samples < 2) {
    return {
      level: "none",
      note: "A single capture. There is no change to report yet, only a value.",
    };
  }
  if (growth.spanDays < 14 || growth.samples < 7) {
    return {
      level: "weak",
      note:
        `${growth.samples} captures over ${growth.spanDays} day(s). Too short to ` +
        "separate a trend from an ordinary week; read it as a value, not a direction.",
    };
  }
  return {
    level: "usable",
    note: `${growth.samples} captures over ${growth.spanDays} days.`,
  };
}

export async function snapshotsSince(
  provider: IntegrationProvider,
  subject: MetricSubject,
  since: Date,
): Promise<MetricSnapshot[]> {
  return db
    .select()
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.provider, provider),
        eq(metricSnapshots.subject, subject),
        gte(metricSnapshots.capturedAt, since),
      ),
    )
    .orderBy(asc(metricSnapshots.capturedAt));
}

export async function latestSnapshot(
  provider: IntegrationProvider,
  subject: MetricSubject,
): Promise<MetricSnapshot | null> {
  const [row] = await db
    .select()
    .from(metricSnapshots)
    .where(
      and(
        eq(metricSnapshots.provider, provider),
        eq(metricSnapshots.subject, subject),
      ),
    )
    .orderBy(desc(metricSnapshots.capturedAt))
    .limit(1);
  return row ?? null;
}
