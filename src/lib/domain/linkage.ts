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
}

/**
 * Apply one Rumble observation to the episode schedule.
 *
 * Matching is by air-time proximity first (the show has a fixed slot), title
 * second. An ambiguous or absent match produces a Needs Attention item — the
 * system never guesses which episode a live stream belongs to.
 *
 * End-of-stream is inferred: Rumble empties `livestreams` when a broadcast
 * finishes, so a Rumble publication left in LIVE with nothing live now is what
 * "the show ended" looks like.
 */
export async function applyRumbleObservation(
  observation: RumbleObservation,
  actor: Actor = SYSTEM_ACTOR,
): Promise<RumbleApplyResult> {
  const live = observation.liveNow;

  if (!live) {
    const ended = await closeFinishedRumbleStreams(actor);
    return { matchedEpisodeId: ended, needsAttention: null, transition: ended ? "ENDED" : null };
  }

  // Already tracking this stream? Just refresh it.
  const [tracked] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.platform, "RUMBLE"),
        eq(episodePublications.externalId, String(live.id)),
      ),
    )
    .limit(1);

  if (tracked) {
    await db
      .update(episodePublications)
      .set({ state: "LIVE", lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(episodePublications.id, tracked.id));
    return { matchedEpisodeId: tracked.episodeId, needsAttention: null, transition: null };
  }

  // New stream — find the episode it belongs to.
  const window = 6 * 3_600_000;
  const now = Date.now();
  const nearby = await db
    .select()
    .from(episodes)
    .where(
      and(
        isNull(episodes.airedAt),
        gte(episodes.scheduledAt, new Date(now - window)),
        lte(episodes.scheduledAt, new Date(now + window)),
      ),
    )
    .orderBy(desc(episodes.scheduledAt));

  if (nearby.length === 0) {
    return {
      matchedEpisodeId: null,
      needsAttention: `Rumble is live ("${live.title}") but no scheduled episode is within 6 hours. Create or reschedule the episode, then link it.`,
      transition: null,
    };
  }
  if (nearby.length > 1) {
    return {
      matchedEpisodeId: null,
      needsAttention: `Rumble is live ("${live.title}") and ${nearby.length} episodes are scheduled nearby. Confirm which one this is.`,
      transition: null,
    };
  }

  const episode = nearby[0]!;
  const [publication] = await db
    .update(episodePublications)
    .set({
      externalId: String(live.id),
      externalUrl: `https://rumble.com/embed/${live.id}/`,
      state: "LIVE",
      lastSyncAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(episodePublications.episodeId, episode.id),
        eq(episodePublications.platform, "RUMBLE"),
      ),
    )
    .returning();

  await db
    .update(episodes)
    .set({ phase: "LIVE", updatedAt: new Date() })
    .where(eq(episodes.id, episode.id));

  await recordActivity({
    actor,
    verb: "rumble.observed_live",
    subjectType: "publication",
    subjectId: publication?.id,
    episodeId: episode.id,
    // The wording matters: the Studio did not publish this.
    summary: `OBSERVED — Rumble reports "${live.title}" is live. The Studio did not publish this; it is watching.`,
    after: { rumbleId: String(live.id), watchingNow: live.watchingNow, observed: true },
  });

  return { matchedEpisodeId: episode.id, needsAttention: null, transition: "LIVE" };
}

/** A stream we had marked LIVE that Rumble no longer reports has finished. */
async function closeFinishedRumbleStreams(actor: Actor): Promise<string | null> {
  const stale = await db
    .select()
    .from(episodePublications)
    .where(
      and(eq(episodePublications.platform, "RUMBLE"), eq(episodePublications.state, "LIVE")),
    );
  if (stale.length === 0) return null;

  const now = new Date();
  for (const publication of stale) {
    await db
      .update(episodePublications)
      .set({ state: "PUBLISHED", publishedAt: now, lastSyncAt: now, updatedAt: now })
      .where(eq(episodePublications.id, publication.id));

    await db
      .update(episodes)
      .set({ phase: "PRODUCING", airedAt: now, updatedAt: now })
      .where(and(eq(episodes.id, publication.episodeId), isNull(episodes.airedAt)));

    await recordActivity({
      actor,
      verb: "rumble.observed_ended",
      subjectType: "publication",
      subjectId: publication.id,
      episodeId: publication.episodeId,
      summary:
        "OBSERVED — Rumble stopped reporting this stream as live, so the show has ended. " +
        "Episode moved to PRODUCING.",
      before: { state: "LIVE" },
      after: { state: "PUBLISHED", observed: true },
    });
  }
  return stale[0]!.episodeId;
}
