/**
 * Episode reads and edits.
 */
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  activityEvents,
  episodeContentDrafts,
  episodePublications,
  episodes,
  jobs,
  shows,
  type Episode,
  type EpisodePhase,
  type Readiness,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity } from "./activity";
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
