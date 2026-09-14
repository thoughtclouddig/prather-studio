/**
 * Linking a canonical Episode to what already exists on a platform.
 *
 * Both paths here are deliberately human-gated. Rumble state is OBSERVED and
 * an ambiguous observation becomes an operator task rather than a guess;
 * YouTube linkage requires an explicit confirmation of a specific video ID.
 */
import "server-only";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodePublications,
  episodes,
  type Episode,
  type EpisodePublication,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "@/lib/domain/activity";
import { getVideo, type YouTubeVideo } from "@/lib/integrations/youtube/client";
import { rankCandidates } from "@/lib/integrations/youtube/matching";
import type { RumbleObservation } from "@/lib/integrations/rumble/observer";
import { applyBroadcastEvidence } from "./broadcast-apply";
import { lastSignalFor, recordBroadcastObservation } from "./observations";
import { MAX_PROXIMITY_MS, matchRumbleStream } from "./rumble-match";

const actorFor = (user: User): Actor => ({ kind: "user", id: user.id, name: user.name });

async function publicationFor(
  episodeId: string,
  platform: "YOUTUBE" | "RUMBLE",
): Promise<EpisodePublication | undefined> {
  const [row] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, platform),
      ),
    )
    .limit(1);
  return row;
}

/* ------------------------------------------------------------- YouTube */

export class AlreadyLinkedError extends Error {
  constructor(public readonly existingId: string) {
    super(
      `This episode is already linked to YouTube video ${existingId}. ` +
        "Unlink it first if you need to point at a different video.",
    );
    this.name = "AlreadyLinkedError";
  }
}

/**
 * Confirm a YouTube video as this episode's canonical publication.
 *
 * Refuses to silently replace an existing link — re-pointing an episode at a
 * different video is a decision, not a correction, and it must be made
 * deliberately via `unlinkYouTubeVideo`.
 */
export async function linkYouTubeVideo(
  user: User,
  episodeId: string,
  videoId: string,
  opts: { via: "candidate" | "manual" } = { via: "manual" },
): Promise<{ publication: EpisodePublication; video: YouTubeVideo }> {
  authorize(user.role, "publication.intent");

  const existing = await publicationFor(episodeId, "YOUTUBE");
  if (existing?.externalId && existing.externalId !== videoId) {
    throw new AlreadyLinkedError(existing.externalId);
  }

  const video = await getVideo(videoId);
  if (!video) {
    throw new Error(
      `YouTube has no video ${videoId} visible to the connected channel. Check the ID.`,
    );
  }

  // A video already claimed by a different episode is almost always a mistake.
  const [claimedBy] = await db
    .select({ id: episodePublications.episodeId })
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.platform, "YOUTUBE"),
        eq(episodePublications.externalId, videoId),
      ),
    )
    .limit(1);
  if (claimedBy && claimedBy.id !== episodeId) {
    throw new Error(
      `YouTube video ${videoId} is already linked to a different episode. ` +
        "Unlink it there first.",
    );
  }

  const now = new Date();
  const snapshot = snapshotOf(video);

  const [publication] = await db
    .update(episodePublications)
    .set({
      externalId: video.id,
      externalUrl: `https://www.youtube.com/watch?v=${video.id}`,
      state: "PUBLISHED",
      publishedAt: new Date(video.live?.actualStartTime ?? video.publishedAt),
      lastSyncAt: now,
      remoteSnapshot: snapshot as never,
      remoteSnapshotAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "YOUTUBE"),
      ),
    )
    .returning();

  await recordActivity({
    actor: actorFor(user),
    verb: "youtube.linked",
    subjectType: "publication",
    subjectId: publication?.id,
    episodeId,
    summary: `Linked to YouTube video ${video.id} — "${video.title}" (${opts.via === "manual" ? "entered by hand" : "confirmed from candidates"})`,
    after: { videoId: video.id, title: video.title, via: opts.via },
  });

  return { publication: publication!, video };
}

export async function unlinkYouTubeVideo(user: User, episodeId: string): Promise<void> {
  authorize(user.role, "publication.intent");
  const existing = await publicationFor(episodeId, "YOUTUBE");
  if (!existing?.externalId) throw new Error("This episode is not linked to YouTube.");

  await db
    .update(episodePublications)
    .set({
      externalId: null,
      externalUrl: null,
      state: "NOT_STARTED",
      publishedAt: null,
      remoteSnapshot: null,
      remoteSnapshotAt: null,
      updatedAt: new Date(),
    })
    .where(eq(episodePublications.id, existing.id));

  await recordActivity({
    actor: actorFor(user),
    verb: "youtube.unlinked",
    subjectType: "publication",
    subjectId: existing.id,
    episodeId,
    summary: `Unlinked from YouTube video ${existing.externalId}`,
    before: { videoId: existing.externalId },
  });
}

export interface RemoteSnapshot {
  title: string;
  description: string;
  categoryId: string | null;
  tags: string[];
  privacyStatus: string | null;
  capturedAt: string;
}

export function snapshotOf(video: YouTubeVideo): RemoteSnapshot {
  return {
    title: video.title,
    description: video.description,
    categoryId: video.categoryId,
    tags: video.tags,
    privacyStatus: video.privacyStatus,
    capturedAt: new Date().toISOString(),
  };
}

/** Rank recent uploads against an episode. Presentation only — attaches nothing. */
export async function candidatesForEpisode(episode: Episode, videos: YouTubeVideo[]) {
  return rankCandidates(
    {
      workingTitle: episode.workingTitle,
      approvedTitle: episode.approvedTitle,
      scheduledAt: episode.scheduledAt,
      airedAt: episode.airedAt,
    },
    videos,
  );
}

/* -------------------------------------------------------------- Rumble */

export interface RumbleApplyResult {
  matchedEpisodeId: string | null;
  needsAttention: string | null;
  transition: string | null;
  /** True when this poll recorded evidence that was not already on file. */
  recordedEvidence: boolean;
}

/**
 * Apply one Rumble poll.
 *
 * Rumble is an OBSERVER. Nothing here publishes, and the Activity wording says
 * so — "RUMBLE STREAM OBSERVED", never "PUBLISHED TO RUMBLE".
 *
 * The poll's job is to turn what Rumble says into durable evidence. It does not
 * decide what the evidence means: that is `evaluateBroadcast`, applied through
 * `applyBroadcastEvidence`, so Rumble and YouTube reach the episode by the
 * same road.
 *
 * Writes are transition-only. Rumble is polled every minute for hours; a row
 * per poll would bury the two rows that matter under several hundred that do
 * not.
 */
export async function applyRumbleObservation(
  observation: RumbleObservation,
  actor: Actor = SYSTEM_ACTOR,
  now = new Date(),
): Promise<RumbleApplyResult> {
  const live = observation.liveNow;

  if (!live) {
    return closeFinishedRumbleStreams(actor, now);
  }

  const streamId = String(live.id);
  const startedAt = live.createdOn ? new Date(live.createdOn) : now;

  // Have we already recorded this stream as live? If so there is nothing new.
  const previous = await lastSignalFor("RUMBLE", streamId);
  const alreadyLive = previous?.signal === "LIVE";

  const tracked = await trackedRumblePublication(streamId);
  const episodeId =
    tracked?.episodeId ?? (await matchRumbleToEpisode(live, startedAt, actor, now));

  const { created } = await recordBroadcastObservation({
    provider: "RUMBLE",
    signal: "LIVE",
    externalId: streamId,
    observedAt: startedAt,
    episodeId,
    terminal: true, // one "this stream went live at T" fact, however often polled
    summary: `Rumble reports livestream "${live.title}" is active`,
    detail: {
      streamId,
      title: live.title,
      watchingNow: live.watchingNow,
      startedAt: startedAt.toISOString(),
    },
  });

  if (!episodeId) {
    return {
      matchedEpisodeId: null,
      needsAttention: await pendingAmbiguity(live.title, startedAt, now),
      transition: null,
      recordedEvidence: created,
    };
  }

  if (tracked) {
    await db
      .update(episodePublications)
      .set({ state: "LIVE", lastSyncAt: now, updatedAt: now })
      .where(eq(episodePublications.id, tracked.id));
  } else {
    await db
      .update(episodePublications)
      .set({
        externalId: streamId,
        externalUrl: `https://rumble.com/embed/${streamId}/`,
        state: "LIVE",
        lastSyncAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "RUMBLE"),
        ),
      );
  }

  if (created && !alreadyLive) {
    await recordActivity({
      actor,
      verb: "rumble.observed_live",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      // The wording matters: the Studio did not publish this.
      summary:
        `RUMBLE STREAM OBSERVED — Rumble reports "${live.title}" is live. ` +
        "The Studio did not publish this; it is watching.",
      after: { rumbleId: streamId, watchingNow: live.watchingNow, observed: true },
    });
  }

  const applied = await applyBroadcastEvidence(episodeId, actor, now);

  return {
    matchedEpisodeId: episodeId,
    needsAttention: applied.attention,
    transition: applied.phaseChange ? applied.phaseChange.to : null,
    recordedEvidence: created,
  };
}

/**
 * Rumble no longer lists a stream we were watching.
 *
 * This is the ONLY end signal Rumble provides — there is no completion event
 * and no VOD listing to check against. So the evidence is recorded honestly as
 * an inference, and `evaluateBroadcast` decides what it is worth. YouTube's
 * `actualEndTime`, when it arrives, supersedes it with a real time.
 */
async function closeFinishedRumbleStreams(
  actor: Actor,
  now: Date,
): Promise<RumbleApplyResult> {
  const stale = await db
    .select()
    .from(episodePublications)
    .where(
      and(eq(episodePublications.platform, "RUMBLE"), eq(episodePublications.state, "LIVE")),
    );
  if (stale.length === 0) {
    return {
      matchedEpisodeId: null,
      needsAttention: null,
      transition: null,
      recordedEvidence: false,
    };
  }

  let recorded = false;
  let lastEpisodeId: string | null = null;
  let attention: string | null = null;
  let transition: string | null = null;

  for (const publication of stale) {
    const streamId = publication.externalId;
    const { created } = await recordBroadcastObservation({
      provider: "RUMBLE",
      signal: "OFFLINE",
      externalId: streamId,
      observedAt: now,
      episodeId: publication.episodeId,
      summary:
        "Rumble stopped listing this stream after previously reporting it live",
      detail: { streamId, inferred: true },
    });
    recorded ||= created;

    await db
      .update(episodePublications)
      .set({ state: "PUBLISHED", publishedAt: now, lastSyncAt: now, updatedAt: now })
      .where(eq(episodePublications.id, publication.id));

    if (created) {
      await recordActivity({
        actor,
        verb: "rumble.observed_ended",
        subjectType: "episode",
        subjectId: publication.episodeId,
        episodeId: publication.episodeId,
        summary:
          "SHOW COMPLETION INFERRED — Rumble stopped reporting this stream as live " +
          "after previously observing it. Rumble emits no completion event, so the " +
          "end is inferred from the stream disappearing.",
        before: { state: "LIVE" },
        after: { state: "PUBLISHED", observed: true, inferred: true },
      });
    }

    const applied = await applyBroadcastEvidence(publication.episodeId, actor, now);
    lastEpisodeId = publication.episodeId;
    attention ??= applied.attention;
    transition ??= applied.phaseChange ? applied.phaseChange.to : null;
  }

  return {
    matchedEpisodeId: lastEpisodeId,
    needsAttention: attention,
    transition: transition ?? "ENDED",
    recordedEvidence: recorded,
  };
}

async function trackedRumblePublication(streamId: string) {
  const [row] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.platform, "RUMBLE"),
        eq(episodePublications.externalId, streamId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Find the episode a live stream belongs to.
 *
 * Candidates are episodes scheduled within 6 hours either side — NOT "episodes
 * with no airedAt". That distinction is the one commit cb1e8a1 was about:
 * `airedAt` is only ever written by an observer, so using its absence as a
 * filter silently excludes nothing and includes everything ancient.
 */
async function matchRumbleToEpisode(
  live: { id: string | number; title: string },
  startedAt: Date,
  actor: Actor,
  now: Date,
): Promise<string | null> {
  // The SQL window spans the whole live interval plus the tolerance on each
  // side, so a stream created well before it went live is still considered.
  const from = new Date(
    Math.min(startedAt.getTime(), now.getTime()) - MAX_PROXIMITY_MS,
  );
  const to = new Date(Math.max(startedAt.getTime(), now.getTime()) + MAX_PROXIMITY_MS);
  const nearby = await db
    .select()
    .from(episodes)
    .where(and(gte(episodes.scheduledAt, from), lte(episodes.scheduledAt, to)))
    .orderBy(desc(episodes.scheduledAt));

  const result = matchRumbleStream(nearby, {
    title: live.title,
    startedAt,
    observedAt: now,
  });

  if (!result.matched) {
    await recordActivity({
      actor,
      verb: "rumble.needs_attention",
      subjectType: "integration",
      subjectId: "RUMBLE",
      summary: result.ambiguous ?? "Rumble stream could not be matched to an episode.",
      after: {
        streamTitle: live.title,
        candidates: result.candidates.map((c) => ({
          episodeId: c.episode.id,
          title: c.episode.workingTitle,
          confidence: Number(c.confidence.toFixed(2)),
          reasons: c.reasons,
        })),
      },
    });
    return null;
  }

  await recordActivity({
    actor,
    verb: "rumble.matched",
    subjectType: "episode",
    subjectId: result.matched.episode.id,
    episodeId: result.matched.episode.id,
    summary:
      `RUMBLE STREAM OBSERVED — matched to this episode. ` +
      result.matched.reasons.join("; ") + ".",
    after: {
      confidence: Number(result.matched.confidence.toFixed(2)),
      streamTitle: live.title,
      observedAt: now.toISOString(),
    },
  });
  return result.matched.episode.id;
}

/** The message shown while a stream is live but unattributed. */
async function pendingAmbiguity(
  title: string,
  startedAt: Date,
  now: Date,
): Promise<string> {
  const from = new Date(
    Math.min(startedAt.getTime(), now.getTime()) - MAX_PROXIMITY_MS,
  );
  const to = new Date(Math.max(startedAt.getTime(), now.getTime()) + MAX_PROXIMITY_MS);
  const nearby = await db
    .select()
    .from(episodes)
    .where(and(gte(episodes.scheduledAt, from), lte(episodes.scheduledAt, to)));
  return (
    matchRumbleStream(nearby, { title, startedAt, observedAt: now }).ambiguous ?? ""
  );
}
