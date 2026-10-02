/**
 * Recording and reading broadcast observations.
 *
 * Writes are transition-only and idempotent. Two properties matter:
 *
 *  · A poll that finds the same state as last time writes NOTHING. A show is
 *    polled every minute for hours; if every poll wrote a row, the evidence
 *    that matters would be buried under thousands that do not.
 *  · A poll that re-reports a transition we already recorded collides on
 *    `dedupe_key` and is dropped. That is what makes a worker restart safe:
 *    it may legitimately re-observe everything it can still see.
 */
import "server-only";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  broadcastObservations,
  type BroadcastObservation,
  type BroadcastSignal,
  type IntegrationProvider,
} from "@/db/schema";
import { observationKey, terminalObservationKey } from "./broadcast";

export interface RecordObservationInput {
  provider: IntegrationProvider;
  signal: BroadcastSignal;
  externalId: string | null;
  /** When the provider says it happened. Falls back to now at the call site. */
  observedAt: Date;
  summary: string;
  detail?: Record<string, unknown>;
  episodeId?: string | null;
  /**
   * True for a fact with one true time however often it is seen — a
   * completion. Keyed without the observation minute so repeated polls of a
   * finished broadcast cannot accumulate rows.
   */
  terminal?: boolean;
}

/**
 * Write an observation unless we already have it.
 *
 * Returns the row and whether it was new, because the caller usually wants to
 * act only on genuinely new evidence (enqueue caption retrieval once, not on
 * every poll that still sees the stream is over).
 */
export async function recordBroadcastObservation(
  input: RecordObservationInput,
): Promise<{ observation: BroadcastObservation; created: boolean }> {
  const dedupeKey =
    input.terminal && input.externalId
      ? terminalObservationKey(input.provider, input.signal, input.externalId)
      : observationKey(
          input.provider,
          input.signal,
          input.externalId,
          input.observedAt,
        );

  const [inserted] = await db
    .insert(broadcastObservations)
    .values({
      episodeId: input.episodeId ?? null,
      provider: input.provider,
      signal: input.signal,
      externalId: input.externalId,
      observedAt: input.observedAt,
      summary: input.summary,
      detail: (input.detail ?? null) as never,
      dedupeKey,
    })
    .onConflictDoNothing({ target: broadcastObservations.dedupeKey })
    .returning();

  if (inserted) return { observation: inserted, created: true };

  const [existing] = await db
    .select()
    .from(broadcastObservations)
    .where(eq(broadcastObservations.dedupeKey, dedupeKey))
    .limit(1);
  return { observation: existing!, created: false };
}

/**
 * The most recent signal we recorded for a provider/stream pair.
 *
 * This is what makes transition-only writing possible across restarts: the
 * worker asks the database what it last believed rather than remembering.
 */
export async function lastSignalFor(
  provider: IntegrationProvider,
  externalId: string | null,
): Promise<BroadcastObservation | null> {
  const [row] = await db
    .select()
    .from(broadcastObservations)
    .where(
      and(
        eq(broadcastObservations.provider, provider),
        externalId
          ? eq(broadcastObservations.externalId, externalId)
          : isNull(broadcastObservations.externalId),
      ),
    )
    .orderBy(desc(broadcastObservations.observedAt))
    .limit(1);
  return row ?? null;
}

/** Every observation attached to an episode, newest first. */
export async function observationsForEpisode(
  episodeId: string,
): Promise<BroadcastObservation[]> {
  return db
    .select()
    .from(broadcastObservations)
    .where(eq(broadcastObservations.episodeId, episodeId))
    .orderBy(desc(broadcastObservations.observedAt));
}

/** Observations for several episodes at once, grouped. For the dashboard. */
export async function observationsForEpisodes(
  episodeIds: string[],
): Promise<Map<string, BroadcastObservation[]>> {
  const grouped = new Map<string, BroadcastObservation[]>();
  if (episodeIds.length === 0) return grouped;

  const rows = await db
    .select()
    .from(broadcastObservations)
    .where(inArray(broadcastObservations.episodeId, episodeIds))
    .orderBy(desc(broadcastObservations.observedAt));

  for (const row of rows) {
    if (!row.episodeId) continue;
    const list = grouped.get(row.episodeId) ?? [];
    list.push(row);
    grouped.set(row.episodeId, list);
  }
  return grouped;
}

/**
 * Unmatched observations from the recent past.
 *
 * An observation can arrive before anyone links it to an episode — Rumble
 * reports a live stream we cannot confidently attribute. Those must not be
 * lost; they are re-examined when an episode appears, and surfaced to the
 * operator if they stay unattributed.
 */
export async function unmatchedObservations(
  since: Date,
): Promise<BroadcastObservation[]> {
  return db
    .select()
    .from(broadcastObservations)
    .where(
      and(
        isNull(broadcastObservations.episodeId),
        gte(broadcastObservations.observedAt, since),
        or(
          eq(broadcastObservations.signal, "LIVE"),
          eq(broadcastObservations.signal, "COMPLETED"),
        ),
      ),
    )
    .orderBy(desc(broadcastObservations.observedAt));
}

/**
 * Attach previously-unmatched observations to an episode.
 *
 * Used when a link is confirmed after the fact — the evidence was already
 * collected, it just did not have a home yet.
 */
export async function attachObservations(
  ids: string[],
  episodeId: string,
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(broadcastObservations)
    .set({ episodeId })
    .where(
      and(
        inArray(broadcastObservations.id, ids),
        isNull(broadcastObservations.episodeId),
      ),
    )
    .returning({ id: broadcastObservations.id });
  return rows.length;
}

/** How many observations exist, by signal. Used by the Integrations page. */
export async function observationCounts(): Promise<
  { provider: IntegrationProvider; signal: BroadcastSignal; count: number }[]
> {
  return db
    .select({
      provider: broadcastObservations.provider,
      signal: broadcastObservations.signal,
      count: sql<number>`count(*)::int`,
    })
    .from(broadcastObservations)
    .groupBy(broadcastObservations.provider, broadcastObservations.signal);
}
