/**
 * Advancing an episode from provider evidence.
 *
 * Exactly one path from "a provider told us something" to "the episode moved".
 * Both the Rumble poll and the YouTube poll call this; neither mutates an
 * episode itself. One path means one place where the rules live, and one place
 * that writes the explanation.
 *
 * What it will do:
 *   · move an episode to LIVE when a provider observed it live
 *   · move it to PRODUCING when completion is observed or defensibly inferred
 *   · stamp `airedAt` from a PROVIDER-REPORTED start, never from the clock
 *   · schedule caption retrieval once, automatically
 *
 * What it will never do:
 *   · move an episode on elapsed time alone
 *   · invent an `airedAt` when no provider reported a start
 *   · approve anything
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, episodes, type Episode } from "@/db/schema";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "@/lib/domain/activity";
import { evaluateBroadcast, type BroadcastEvidence } from "./broadcast";
import { observationsForEpisode } from "./observations";

export interface ApplyResult {
  evidence: BroadcastEvidence;
  /** The phase change made, if any. */
  phaseChange: { from: string; to: string } | null;
  /** True when this call scheduled caption retrieval. */
  captionsScheduled: boolean;
  attention: string | null;
}

/**
 * Delay before the first caption check.
 *
 * YouTube has to transcode the recording before ASR can run, so asking the
 * instant a stream ends is guaranteed to come back empty and burn 50 quota
 * units doing it. See `captions-wait.ts` for the full schedule.
 */
export const FIRST_CAPTION_CHECK_MS = 20 * 60_000;

export async function applyBroadcastEvidence(
  episodeId: string,
  actor: Actor = SYSTEM_ACTOR,
  now = new Date(),
): Promise<ApplyResult> {
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) throw new Error(`Episode ${episodeId} not found`);

  const observations = await observationsForEpisode(episodeId);
  const evidence = evaluateBroadcast(episode, observations, now);

  let phaseChange: ApplyResult["phaseChange"] = null;
  let captionsScheduled = false;

  if (evidence.state === "LIVE" && episode.phase !== "LIVE") {
    phaseChange = { from: episode.phase, to: "LIVE" };
    await db
      .update(episodes)
      .set({ phase: "LIVE", updatedAt: now })
      .where(eq(episodes.id, episodeId));

    await recordActivity({
      actor,
      verb: "broadcast.observed_live",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary: evidence.reason,
      before: { phase: episode.phase },
      after: { phase: "LIVE", basis: basisOf(evidence) },
    });
  }

  if (evidence.readyForPostShow && !isPostBroadcast(episode)) {
    phaseChange = { from: episode.phase, to: "PRODUCING" };

    // `airedAt` records when the broadcast STARTED, and only when a provider
    // said so. An inferred ending gives us no start time of its own, so we use
    // the observed live start. If nothing reported a start, the column stays
    // null rather than acquiring a plausible-looking lie.
    const airedAt = evidence.startedAt ?? episode.airedAt;

    await db
      .update(episodes)
      .set({ phase: "PRODUCING", airedAt, updatedAt: now })
      .where(eq(episodes.id, episodeId));

    await recordActivity({
      actor,
      verb: "broadcast.completed",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary: evidence.reason,
      before: { phase: episode.phase, airedAt: episode.airedAt?.toISOString() ?? null },
      after: {
        phase: "PRODUCING",
        airedAt: airedAt?.toISOString() ?? null,
        endedAt: evidence.endedAt?.toISOString() ?? null,
        basis: basisOf(evidence),
      },
    });

    captionsScheduled = await scheduleCaptionRetrieval(episodeId, evidence, actor, now);
  }

  return { evidence, phaseChange, captionsScheduled, attention: evidence.attention };
}

/**
 * Queue caption retrieval — the step nobody should have to press.
 *
 * The idempotency key is the episode id alone, so however many providers
 * report the same completion and however many times the worker restarts, one
 * caption job exists per episode.
 */
async function scheduleCaptionRetrieval(
  episodeId: string,
  evidence: BroadcastEvidence,
  actor: Actor,
  now: Date,
): Promise<boolean> {
  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "YOUTUBE"),
      ),
    )
    .limit(1);

  if (!publication?.externalId) {
    await recordActivity({
      actor,
      verb: "transcript.blocked",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary:
        "Show is complete, but no YouTube video is linked yet, so captions cannot be " +
        "retrieved. Link the video and retrieval will start.",
    });
    return false;
  }

  const { enqueue } = await import("@/lib/queue/queue");
  const { created } = await enqueue({
    kind: "youtube.fetch_captions",
    idempotencyKey: `youtube.fetch_captions:${episodeId}`,
    episodeId,
    // Attempts are only spent by genuine errors; waiting for YouTube defers
    // instead, so this is a real error budget rather than a patience budget.
    maxAttempts: 4,
    runAfter: new Date(
      (evidence.endedAt ?? now).getTime() + FIRST_CAPTION_CHECK_MS,
    ),
    actor,
  });

  if (created) {
    await recordActivity({
      actor,
      verb: "transcript.scheduled",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary:
        "CAPTION RETRIEVAL SCHEDULED — first check in 20 minutes. YouTube needs to " +
        "transcode the recording before automatic captions can be generated.",
      after: { videoId: publication.externalId },
    });
  }
  return created;
}

function isPostBroadcast(episode: Episode): boolean {
  return (
    episode.phase === "CAPTURING" ||
    episode.phase === "PRODUCING" ||
    episode.phase === "REVIEW" ||
    episode.phase === "RELEASED" ||
    episode.phase === "ARCHIVED"
  );
}

function basisOf(evidence: BroadcastEvidence) {
  return evidence.basis.map((o) => ({
    provider: o.provider,
    signal: o.signal,
    observedAt: o.observedAt.toISOString(),
    summary: o.summary,
  }));
}
