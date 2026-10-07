/**
 * Episode reads and edits.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  activityEvents,
  episodeContentDrafts,
  episodeImages,
  episodePublications,
  episodeTranscripts,
  episodes,
  jobs,
  shows,
  type Episode,
  type EpisodePhase,
  type Readiness,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity, type Actor } from "./activity";
import { derivePackaging, type PackagingStatus } from "./vocabulary";

function actorFor(user: User) {
  return { kind: "user" as const, id: user.id, name: user.name };
}

export interface EpisodePatch {
  workingTitle?: string;
  scheduledAt?: Date | null;
  phase?: EpisodePhase;
  internalNotes?: string | null;
  showPrepState?: Readiness;
  artworkState?: Readiness;
}

export async function updateEpisode(
  user: User,
  episodeId: string,
  patch: EpisodePatch,
): Promise<Episode> {
  authorize(user.role, "episode.edit");

  const [current] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!current) throw new Error(`Episode ${episodeId} not found`);

  const changes: Partial<Episode> = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const key of [
    "workingTitle",
    "scheduledAt",
    "phase",
    "internalNotes",
    "showPrepState",
    "artworkState",
  ] as const) {
    if (patch[key] === undefined) continue;
    const next = patch[key];
    const prev = current[key];
    const same =
      prev instanceof Date && next instanceof Date
        ? prev.getTime() === next.getTime()
        : prev === next;
    if (same) continue;
    (changes as Record<string, unknown>)[key] = next;
    before[key] = prev instanceof Date ? prev.toISOString() : prev;
    after[key] = next instanceof Date ? next.toISOString() : next;
  }

  if (Object.keys(changes).length === 0) return current;

  const [updated] = await db
    .update(episodes)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(episodes.id, episodeId))
    .returning();

  await recordActivity({
    actor: actorFor(user),
    verb: "episode.updated",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary: `Updated ${Object.keys(changes).join(", ")}`,
    before,
    after,
  });
  return updated!;
}

/* ------------------------------------------------------------------ reads */

export type EpisodeRow = Episode & {
  showName: string;
  packaging: PackagingStatus;
  publications: Array<{
    id: string;
    platform: (typeof episodePublications.$inferSelect)["platform"];
    intent: (typeof episodePublications.$inferSelect)["intent"];
    state: (typeof episodePublications.$inferSelect)["state"];
    externalUrl: string | null;
  }>;
  failedPublications: number;
  deadJobs: number;
  proposedDrafts: number;
};

/** One query set, reused by the dashboard and the episodes list. */
export async function listEpisodes(): Promise<EpisodeRow[]> {
  const rows = await db
    .select({ episode: episodes, showName: shows.name })
    .from(episodes)
    .innerJoin(shows, eq(shows.id, episodes.showId))
    .orderBy(desc(sql`coalesce(${episodes.scheduledAt}, ${episodes.createdAt})`));

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.episode.id);

  const [pubs, drafts, deadJobRows] = await Promise.all([
    db
      .select()
      .from(episodePublications)
      .where(inArray(episodePublications.episodeId, ids)),
    db
      .select({
        id: episodeContentDrafts.id,
        episodeId: episodeContentDrafts.episodeId,
        state: episodeContentDrafts.state,
      })
      .from(episodeContentDrafts)
      .where(inArray(episodeContentDrafts.episodeId, ids)),
    db
      .select({ episodeId: jobs.episodeId, count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(and(eq(jobs.state, "DEAD"), isNotNull(jobs.episodeId)))
      .groupBy(jobs.episodeId),
  ]);

  const deadByEpisode = new Map(deadJobRows.map((r) => [r.episodeId!, r.count]));

  return rows.map(({ episode, showName }) => {
    const myPubs = pubs.filter((p) => p.episodeId === episode.id);
    // SUPERSEDED drafts are history, not part of the current packaging picture.
    const myDrafts = drafts.filter(
      (d) => d.episodeId === episode.id && d.state !== "SUPERSEDED",
    );
    return {
      ...episode,
      showName,
      packaging: derivePackaging(myDrafts),
      publications: myPubs.map((p) => ({
        id: p.id,
        platform: p.platform,
        intent: p.intent,
        state: p.state,
        externalUrl: p.externalUrl,
      })),
      failedPublications: myPubs.filter((p) => p.state === "FAILED").length,
      deadJobs: deadByEpisode.get(episode.id) ?? 0,
      proposedDrafts: myDrafts.filter((d) => d.state === "PROPOSED").length,
    };
  });
}

export function needsAttention(row: EpisodeRow): boolean {
  return row.failedPublications > 0 || row.deadJobs > 0;
}

export async function getEpisodeDetail(episodeId: string) {
  const [row] = await db
    .select({ episode: episodes, show: shows })
    .from(episodes)
    .innerJoin(shows, eq(shows.id, episodes.showId))
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!row) return null;

  const [publications, drafts, activity, episodeJobs] = await Promise.all([
    db
      .select()
      .from(episodePublications)
      .where(eq(episodePublications.episodeId, episodeId)),
    db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId))
      .orderBy(asc(episodeContentDrafts.sortOrder), asc(episodeContentDrafts.createdAt)),
    db
      .select()
      .from(activityEvents)
      .where(eq(activityEvents.episodeId, episodeId))
      .orderBy(desc(activityEvents.createdAt))
      .limit(60),
    db
      .select()
      .from(jobs)
      .where(eq(jobs.episodeId, episodeId))
      .orderBy(desc(jobs.createdAt))
      .limit(20),
  ]);

  const live = drafts.filter((d) => d.state !== "SUPERSEDED");
  return {
    episode: row.episode,
    show: row.show,
    publications,
    drafts,
    liveDrafts: live,
    packaging: derivePackaging(live),
    activity,
    jobs: episodeJobs,
  };
}

export type EpisodeDetail = NonNullable<Awaited<ReturnType<typeof getEpisodeDetail>>>;

/** Drafts still awaiting a decision, in review order. Powers Review mode. */
export async function getReviewQueue(episodeId: string) {
  return db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        ne(episodeContentDrafts.state, "SUPERSEDED"),
      ),
    )
    .orderBy(asc(episodeContentDrafts.sortOrder), asc(episodeContentDrafts.createdAt));
}

/**
 * What deleting an episode would destroy.
 *
 * Counted and shown before anything happens, because the cascade reaches a
 * long way — drafts, the transcript, publication links, artwork, job history —
 * and "delete this episode" does not look like it means "and the transcript it
 * took four hours to get".
 */
export interface DeletionImpact {
  drafts: number;
  transcripts: number;
  publications: number;
  images: number;
  jobs: number;
  /** Platforms this episode is live or scheduled on. Deleting loses the link. */
  liveOn: string[];
}

export async function deletionImpact(episodeId: string): Promise<DeletionImpact> {
  const [draftRows, transcriptRows, publicationRows, imageRows, jobRows] = await Promise.all([
    db.select({ id: episodeContentDrafts.id }).from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId)),
    db.select({ id: episodeTranscripts.id }).from(episodeTranscripts)
      .where(eq(episodeTranscripts.episodeId, episodeId)),
    db.select().from(episodePublications)
      .where(eq(episodePublications.episodeId, episodeId)),
    db.select({ id: episodeImages.id }).from(episodeImages)
      .where(eq(episodeImages.episodeId, episodeId)),
    db.select({ id: jobs.id }).from(jobs).where(eq(jobs.episodeId, episodeId)),
  ]);

  const LIVE = new Set(["LIVE", "PUBLISHED", "SCHEDULED"]);

  return {
    drafts: draftRows.length,
    transcripts: transcriptRows.length,
    publications: publicationRows.length,
    images: imageRows.length,
    jobs: jobRows.length,
    liveOn: publicationRows.filter((p) => LIVE.has(p.state)).map((p) => p.platform),
  };
}

export class EpisodeDeletionError extends Error {}

/**
 * Delete an episode and everything that cascades from it.
 *
 * Reserved for mistakes: a duplicate, a test, an episode created on the wrong
 * date. A real broadcast should be corrected, not removed — the archive is the
 * point of this system.
 *
 * The activity event is written BEFORE the delete and deliberately records
 * what was lost, because the row it points at is about to stop existing. It is
 * the only trace left afterwards.
 */
export async function deleteEpisode(
  episodeId: string,
  actor: Actor,
  opts: { force?: boolean } = {},
): Promise<{ title: string; impact: DeletionImpact }> {
  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (!episode) throw new EpisodeDeletionError("That episode no longer exists.");

  const impact = await deletionImpact(episodeId);

  // Live somewhere is the one case worth refusing by default: the publication
  // row is how the Studio knows this episode is that video, and losing it
  // leaves something published that nothing here can match again.
  if (impact.liveOn.length > 0 && !opts.force) {
    throw new EpisodeDeletionError(
      `This episode is published or scheduled on ${impact.liveOn.join(", ")}. ` +
        "Deleting it here does not remove it there — it only loses the link " +
        "between them. Unlink it first, or confirm you mean to delete anyway.",
    );
  }

  const title = episode.approvedTitle ?? episode.workingTitle;

  await recordActivity({
    actor,
    verb: "episode.deleted",
    subjectType: "episode",
    subjectId: episodeId,
    // Deliberately NOT episodeId: that column references a row about to go.
    summary:
      `Deleted the episode "${title}" — ${impact.drafts} drafts, ` +
      `${impact.transcripts} transcript(s), ${impact.publications} publication(s), ` +
      `${impact.images} image(s)`,
    before: {
      title,
      slug: episode.slug,
      scheduledAt: episode.scheduledAt?.toISOString() ?? null,
      impact,
    },
  });

  await db.delete(episodes).where(eq(episodes.id, episodeId));

  return { title, impact };
}
