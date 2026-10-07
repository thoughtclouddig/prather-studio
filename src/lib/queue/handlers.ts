/**
 * Job handlers.
 *
 * Phase 2 adds the asynchronous work that genuinely cannot happen inside a
 * request: caption retrieval (can take a minute), the content engine (can take
 * several), and the Rumble poll (runs on a schedule with nobody watching).
 *
 *   ping                    DEV ONLY test handler: succeeds, records a result
 *   fail-test               DEV ONLY test handler: always throws, to exercise
 *                           retry then dead-letter then manual retry
 *   simulate.publication    DEV ONLY simulation for platforms with no adapter.
 *                           Refused on a production worker: it writes PUBLISHED
 *                           without contacting anything, which is actively
 *                           misleading now that real adapters exist.
 *   youtube.fetch_captions  real: captions.list then captions.download
 *   episode.package         real: Claude, transcript to PROPOSED drafts
 *   rumble.poll_live        real: observe Rumble, advance episode state
 *   integration.health_check real: refresh tokens, update health
 *
 * Two Phase 2 actions are deliberately NOT jobs:
 *   · youtube.sync_recent  — the operator is waiting for the candidate list,
 *                            and it costs 2 quota units. Fetched inline.
 *   · youtube.update_metadata — the confirmation carries a fingerprint of the
 *                            exact remote state shown. Queuing it would put
 *                            time between "I confirm this diff" and the write,
 *                            which is the window we are trying to close.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodePublications,
  episodes,
  integrationCredentials,
  type Job,
  type Platform,
} from "@/db/schema";
import { recordActivity, workerActor } from "@/lib/domain/activity";
import { sendSubmissionNotice } from "@/lib/domain/submission-notice";
import { applyBroadcastEvidence } from "@/lib/domain/broadcast-apply";
import { decidePoll, readLiveDetails } from "@/lib/domain/broadcast-poll";
import { evaluateBroadcast } from "@/lib/domain/broadcast";
import { isAwaitingCaptions, nextCaptionCheck } from "@/lib/domain/captions-wait";
import { markDraftsStaleForTranscript } from "@/lib/domain/drafts";
import { capture } from "@/lib/domain/metrics";
import {
  observationsForEpisode,
  recordBroadcastObservation,
} from "@/lib/domain/observations";
import { PROMPT_VERSION } from "@/lib/content/package";
import { runPreShow } from "@/lib/content/pre-show";
import {
  BuzzsproutNotConnectedError,
  listEpisodes as listBuzzsproutEpisodes,
} from "@/lib/integrations/buzzsprout/client";
import { JobDeferred } from "./queue";
import { diagnosticsEnabled, isDiagnosticJob } from "@/lib/diagnostics";
import { fetchCaptionsForEpisode } from "@/lib/domain/transcripts";
import { packageEpisode } from "@/lib/content/package";
import { applyRumbleObservation } from "@/lib/domain/linkage";
import { observe, RumbleNotConnectedError } from "@/lib/integrations/rumble/observer";
import { getMyChannel, getVideo } from "@/lib/integrations/youtube/client";
import {
  markHealth,
  recordObservation,
} from "@/lib/integrations/credentials";

export type HandlerResult = Record<string, unknown> | void;
export type Handler = (job: Job, ctx: { workerId: string }) => Promise<HandlerResult>;

/** Platforms with no write API. A simulated publish must stop at the handoff. */
const MANUAL_PLATFORMS: ReadonlySet<Platform> = new Set<Platform>(["LOCALS"]);

const ping: Handler = async (job) => {
  const payload = job.payload as Record<string, unknown>;
  return {
    pong: true,
    note: payload["note"] ?? null,
    respondedAt: new Date().toISOString(),
  };
};

const failTest: Handler = async (job) => {
  throw new Error(
    `fail-test handler failed on purpose (attempt ${job.attempts} of ${job.maxAttempts}). ` +
      "This job exists to demonstrate retry and dead-lettering.",
  );
};

const simulatePublication: Handler = async (job, ctx) => {
  const publicationId = (job.payload as { publicationId?: string }).publicationId;
  if (!publicationId) {
    throw new Error("simulate.publication requires payload.publicationId");
  }

  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.id, publicationId))
    .limit(1);
  if (!publication) throw new Error(`Publication ${publicationId} not found`);

  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, publication.episodeId))
    .limit(1);

  const manual = MANUAL_PLATFORMS.has(publication.platform);
  const now = new Date();
  const slug = episode?.slug ?? "episode";
  const externalId = manual
    ? null
    : `sim_${publication.platform.toLowerCase()}_${slug}`;

  const [updated] = await db
    .update(episodePublications)
    .set({
      state: manual ? "AWAITING_MANUAL" : "PUBLISHED",
      externalId,
      externalUrl: manual
        ? null
        : `https://simulated.invalid/${publication.platform.toLowerCase()}/${slug}`,
      publishedAt: manual ? null : now,
      lastSyncAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(episodePublications.id, publicationId))
    .returning();

  await recordActivity({
    actor: workerActor(ctx.workerId),
    verb: "publication.simulated",
    subjectType: "publication",
    subjectId: publicationId,
    episodeId: publication.episodeId,
    summary: manual
      ? `SIMULATED — ${publication.platform} has no write API; marked awaiting manual publishing`
      : `SIMULATED — ${publication.platform} marked published (no platform was contacted)`,
    before: { state: publication.state },
    after: { state: updated?.state, simulated: true },
  });

  return { simulated: true, platform: publication.platform, state: updated?.state };
};

/* ------------------------------------------------------------- real work */

/**
 * Retrieve the transcript from the linked YouTube video.
 *
 * On success it chains straight into packaging, so a finished show walks
 * itself to the review queue without anyone pressing a second button.
 */
const fetchCaptions: Handler = async (job, ctx) => {
  const episodeId = job.episodeId;
  if (!episodeId) throw new Error("youtube.fetch_captions requires an episodeId");

  const actor = workerActor(ctx.workerId);

  let stored;
  try {
    stored = await fetchCaptionsForEpisode(episodeId, actor);
  } catch (error) {
    // "YouTube has not generated them yet" is the provider doing normal
    // asynchronous work, not a failure. Deferring keeps the attempt budget for
    // real errors and keeps the Jobs page free of red after every show.
    if (!isAwaitingCaptions(error)) throw error;

    const [episode] = await db
      .select()
      .from(episodes)
      .where(eq(episodes.id, episodeId))
      .limit(1);
    const endedAt = episode?.airedAt ?? job.createdAt;
    const decision = nextCaptionCheck(
      job.attempts,
      Date.now() - endedAt.getTime(),
    );

    if (decision.escalate) {
      await recordActivity({
        actor,
        verb: "transcript.delayed",
        subjectType: "episode",
        subjectId: episodeId,
        episodeId,
        summary: decision.reason,
      });
    }

    throw new JobDeferred(new Date(Date.now() + decision.delayMs), decision.reason);
  }

  // A new transcript can invalidate copy generated from an older one.
  const staleCount = await markDraftsStaleForTranscript(
    episodeId,
    stored.transcript.id,
    actor,
  );

  // Chain the next step. Nobody presses Generate.
  const { enqueue } = await import("./queue");
  const { created } = await enqueue({
    kind: "episode.package",
    // Keyed on the transcript AND the prompt version: the same transcript run
    // through the same prompt must never produce a second AI package, however
    // many times the worker restarts or a poll replays.
    idempotencyKey: `episode.package:${episodeId}:${stored.transcript.id}:${PROMPT_VERSION}`,
    episodeId,
    maxAttempts: 2,
    actor,
  });

  if (created) {
    await recordActivity({
      actor,
      verb: "package.scheduled",
      subjectType: "episode",
      subjectId: episodeId,
      episodeId,
      summary:
        `TRANSCRIPT READY — ${stored.segments.length} segments. ` +
        "Content engine queued automatically.",
    });
  }

  return {
    transcriptId: stored.transcript.id,
    segments: stored.segments.length,
    source: stored.transcript.source,
    durationSeconds: stored.transcript.durationSeconds,
    packageQueued: created,
    draftsMarkedStale: staleCount,
  };
};

/**
 * `episode.pre_show` — prepare the email from Jeff's submission.
 *
 * Runs before the broadcast, reading the intake rather than a transcript. It
 * deliberately does NOT move the episode's phase: the show has not happened,
 * and marking it REVIEW would make a prepared email look like a finished
 * episode on the dashboard.
 */
const preShowHandler: Handler = async (job) => {
  const episodeId = job.episodeId;
  if (!episodeId) throw new Error("episode.pre_show requires an episodeId");

  const draftsCreated = await runPreShow(episodeId);
  return { draftsCreated };
};

const packageEpisodeHandler: Handler = async (job, ctx) => {
  const episodeId = job.episodeId;
  if (!episodeId) throw new Error("episode.package requires an episodeId");

  const result = await packageEpisode(episodeId, workerActor(ctx.workerId));

  await db
    .update(episodes)
    .set({ phase: "REVIEW", updatedAt: new Date() })
    .where(eq(episodes.id, episodeId));

  return {
    draftsCreated: result.draftsCreated,
    clips: result.pkg.clip_candidates.length,
    chapters: result.pkg.chapters.length,
    model: result.model,
    promptVersion: result.promptVersion,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
};

/**
 * Poll YouTube for the broadcast lifecycle.
 *
 * The second, independent completion signal. Rumble gives a fast one and no
 * retrospective one; YouTube gives a retrospective one that is still there an
 * hour later. Between them, an episode can move forward even if Rumble was
 * unavailable, was never used for that show, or the worker was restarting at
 * the exact minute the stream ended.
 *
 * Cadence is decided per episode by `decidePoll` — see that module for the
 * table and the quota arithmetic. This handler re-enqueues itself at the
 * interval it chooses, so the polling stops on its own when there is nothing
 * left to learn rather than running forever on a cron.
 */
const pollYouTubeBroadcast: Handler = async (job, ctx) => {
  const episodeId = job.episodeId;
  if (!episodeId) throw new Error("youtube.poll_broadcast requires an episodeId");

  const actor = workerActor(ctx.workerId);
  const now = new Date();

  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) return { skipped: true, reason: "Episode no longer exists" };

  const observations = await observationsForEpisode(episodeId);
  const before = evaluateBroadcast(episode, observations, now);
  const decision = decidePoll(episode, before.state, now);

  if (!decision.shouldPoll) {
    if (decision.nextIntervalMs === null) {
      return { stopped: true, reason: decision.reason, state: before.state };
    }
    throw new JobDeferred(
      new Date(now.getTime() + decision.nextIntervalMs),
      decision.reason,
    );
  }

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

  const videoId = publication?.externalId;
  if (!videoId) {
    // Nothing to poll yet. Not an error: the operator may link the video after
    // the show. Come back rather than dying.
    throw new JobDeferred(
      new Date(now.getTime() + 10 * 60_000),
      "No YouTube video is linked to this episode yet; nothing to poll.",
    );
  }

  const video = await getVideo(videoId);
  if (!video) {
    throw new Error(`YouTube video ${videoId} is no longer reachable.`);
  }

  const reading = readLiveDetails(videoId, video.live, video.liveBroadcastContent);
  let recorded = false;

  if (reading) {
    const result = await recordBroadcastObservation({
      provider: "YOUTUBE",
      signal: reading.signal,
      externalId: videoId,
      observedAt: reading.at,
      episodeId,
      summary: reading.summary,
      detail: reading.detail,
      terminal: reading.terminal,
    });
    recorded = result.created;
  }

  const applied = await applyBroadcastEvidence(episodeId, actor, now);
  const next = decidePoll(episode, applied.evidence.state, now);

  if (next.nextIntervalMs !== null) {
    throw new JobDeferred(new Date(now.getTime() + next.nextIntervalMs), next.reason);
  }

  return {
    videoId,
    state: applied.evidence.state,
    recordedEvidence: recorded,
    captionsScheduled: applied.captionsScheduled,
    liveBroadcastContent: video.liveBroadcastContent,
  };
};

/**
 * Poll Rumble.
 *
 * Runs whether or not a show is on. A poll that finds nothing is the normal
 * case and must not be treated as a failure, or the Jobs page fills with red.
 */
const pollRumble: Handler = async (_job, ctx) => {
  let observation;
  try {
    observation = await observe();
  } catch (error) {
    if (error instanceof RumbleNotConnectedError) {
      // Not connected is a configuration state, not a job failure.
      return { skipped: true, reason: "Rumble is not connected" };
    }
    await markHealth(
      "RUMBLE",
      "ATTENTION",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  await recordObservation("RUMBLE", observation);
  const applied = await applyRumbleObservation(observation, workerActor(ctx.workerId));

  if (applied.needsAttention) {
    await recordActivity({
      actor: workerActor(ctx.workerId),
      verb: "rumble.needs_attention",
      subjectType: "integration",
      subjectId: "RUMBLE",
      summary: applied.needsAttention,
      after: { liveTitle: observation.liveNow?.title ?? null },
    });
  }

  return {
    live: !!observation.liveNow,
    liveTitle: observation.liveNow?.title ?? null,
    watchingNow: observation.liveNow?.watchingNow ?? null,
    followers: observation.followers,
    transition: applied.transition,
    needsAttention: applied.needsAttention,
  };
};

/**
 * Read recent Buzzsprout episodes.
 *
 * READ ONLY. It creates nothing and changes nothing — it records what is
 * actually on the podcast so the operator can see it and so matching has real
 * data to work against. Phase 3 reads Buzzsprout well before it writes to it.
 */
const syncBuzzsproutRecent: Handler = async () => {
  let episodesSeen;
  try {
    episodesSeen = await listBuzzsproutEpisodes(25);
  } catch (error) {
    if (error instanceof BuzzsproutNotConnectedError) {
      return { skipped: true, reason: "Buzzsprout is not connected" };
    }
    await markHealth(
      "BUZZSPROUT",
      "ATTENTION",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }

  await recordObservation("BUZZSPROUT", {
    episodeCount: episodesSeen.length,
    latest: episodesSeen[0]
      ? {
          id: episodesSeen[0].id,
          title: episodesSeen[0].title,
          publishedAt: episodesSeen[0].publishedAt,
          durationSeconds: episodesSeen[0].durationSeconds,
          totalPlays: episodesSeen[0].totalPlays,
        }
      : null,
  });

  return {
    episodes: episodesSeen.length,
    latestTitle: episodesSeen[0]?.title ?? null,
    latestPublishedAt: episodesSeen[0]?.publishedAt ?? null,
  };
};

/**
 * Capture the counters that providers do not keep.
 *
 * Rumble and Buzzsprout only, on purpose. YouTube Analytics backfills a daily
 * series on request, so snapshotting it here would build a second and worse
 * copy of a history the provider already has. Rumble and Buzzsprout expose
 * only "right now" — every unsnapshotted day is permanently lost, which is the
 * whole reason this job exists.
 *
 * A provider that is not connected is skipped, not failed. Half a record is
 * better than none, and a red job every day for an integration nobody has set
 * up yet is how the Jobs page stops being read.
 */
const snapshotMetrics: Handler = async () => {
  const capturedAt = new Date();
  const result: Record<string, unknown> = { capturedAt: capturedAt.toISOString() };

  // ---- Rumble: followers and subscribers, channel level ------------------
  try {
    const observation = await observe();
    const { created } = await capture({
      provider: "RUMBLE",
      subject: "CHANNEL",
      capturedAt,
      counters: {
        followers: observation.followers,
        followersTotal: observation.followersTotal,
        subscribers: observation.subscribers,
      },
    });
    result["rumble"] = {
      captured: created,
      followersTotal: observation.followersTotal,
    };
  } catch (error) {
    result["rumble"] =
      error instanceof RumbleNotConnectedError
        ? { skipped: "not connected" }
        : { error: error instanceof Error ? error.message : String(error) };
  }

  // ---- Buzzsprout: total_plays per episode -------------------------------
  try {
    const episodesSeen = await listBuzzsproutEpisodes(50);
    let captured = 0;
    let totalPlays = 0;

    for (const episode of episodesSeen) {
      totalPlays += episode.totalPlays ?? 0;
      const { created } = await capture({
        provider: "BUZZSPROUT",
        subject: "EPISODE",
        externalId: String(episode.id),
        capturedAt,
        counters: {
          totalPlays: episode.totalPlays,
          durationSeconds: episode.durationSeconds,
        },
      });
      if (created) captured++;
    }

    // Podcast-level total as well: an episode row can disappear from the feed,
    // and the series should survive that.
    await capture({
      provider: "BUZZSPROUT",
      subject: "PODCAST",
      capturedAt,
      counters: { episodeCount: episodesSeen.length, totalPlays },
    });

    result["buzzsprout"] = {
      episodes: episodesSeen.length,
      captured,
      totalPlays,
    };
  } catch (error) {
    result["buzzsprout"] =
      error instanceof BuzzsproutNotConnectedError
        ? { skipped: "not connected" }
        : { error: error instanceof Error ? error.message : String(error) };
  }

  return result;
};

/**
 * Prove each connection still works, and refresh tokens before they expire
 * rather than after — a broken connection should surface on the Integrations
 * page, not in the middle of a publish.
 */
const integrationHealthCheck: Handler = async () => {
  const rows = await db.select().from(integrationCredentials);
  const results: Record<string, string> = {};

  for (const row of rows) {
    try {
      if (row.provider === "YOUTUBE") {
        const channel = await getMyChannel(); // implicitly refreshes the token
        await db
          .update(integrationCredentials)
          .set({
            health: "CONNECTED",
            lastError: null,
            lastSuccessAt: new Date(),
            accountLabel: channel.title,
            accountExternalId: channel.id,
            lastObservation: {
              subscriberCount: channel.subscriberCount,
              videoCount: channel.videoCount,
            } as never,
            lastObservedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(integrationCredentials.provider, "YOUTUBE"));
        results["YOUTUBE"] = "CONNECTED";
      } else if (row.provider === "RUMBLE") {
        const observation = await observe();
        await recordObservation("RUMBLE", observation);
        results["RUMBLE"] = "CONNECTED";
      } else {
        results[row.provider] = "SKIPPED";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markHealth(row.provider, "ATTENTION", message);
      results[row.provider] = `ATTENTION: ${message.slice(0, 120)}`;
    }
  }

  return { checked: rows.length, results };
};

/**
 * Email the operator that Jeff has filed.
 *
 * Queued rather than sent inline: his form must not hang or fail because a
 * mail provider is slow, and he is the one person here who cannot be asked
 * to try again.
 */
const notifySubmission: Handler = async (job) => {
  const payload = job.payload as { episodeId?: string; resubmitted?: boolean };
  if (!payload.episodeId) throw new Error("notify.submission needs an episodeId.");
  const { to, id } = await sendSubmissionNotice(payload.episodeId, !!payload.resubmitted);
  return { to, messageId: id };
};

export const HANDLERS: Record<string, Handler> = {
  ping,
  "fail-test": failTest,
  "simulate.publication": simulatePublication,
  "youtube.fetch_captions": fetchCaptions,
  "episode.package": packageEpisodeHandler,
  "episode.pre_show": preShowHandler,
  "notify.submission": notifySubmission,
  "rumble.poll_live": pollRumble,
  "youtube.poll_broadcast": pollYouTubeBroadcast,
  "buzzsprout.sync_recent": syncBuzzsproutRecent,
  "metrics.snapshot": snapshotMetrics,
  "integration.health_check": integrationHealthCheck,
};

/**
 * Look up a handler, refusing development diagnostics on a production worker.
 *
 * Enforced here rather than only in the UI because a row already sitting in the
 * queue does not care what the UI showed. A `simulate.publication` that writes
 * PUBLISHED onto a publication row without contacting anything is the specific
 * thing that must not run once Buzzsprout is a real adapter.
 */
export function getHandler(kind: string): Handler | undefined {
  if (isDiagnosticJob(kind) && !diagnosticsEnabled()) return undefined;
  return HANDLERS[kind];
}
