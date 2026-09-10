/**
 * Job handlers.
 *
 * Phase 2 adds the asynchronous work that genuinely cannot happen inside a
 * request: caption retrieval (can take a minute), the content engine (can take
 * several), and the Rumble poll (runs on a schedule with nobody watching).
 *
 *   ping                    test handler: succeeds and records a result
 *   fail-test               test handler: always throws, to exercise
 *                           retry then dead-letter then manual retry
 *   simulate.publication    simulation for platforms with no adapter yet
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
import { fetchCaptionsForEpisode } from "@/lib/domain/transcripts";
import { packageEpisode } from "@/lib/content/package";
import { applyRumbleObservation } from "@/lib/domain/linkage";
import { observe, RumbleNotConnectedError } from "@/lib/integrations/rumble/observer";
import { getMyChannel } from "@/lib/integrations/youtube/client";
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

  const stored = await fetchCaptionsForEpisode(episodeId, workerActor(ctx.workerId));

  // Chain the next step. `enqueue` is imported lazily to keep the handler
  // module free of a cycle with the queue.
  const { enqueue } = await import("./queue");
  await enqueue({
    kind: "episode.package",
    idempotencyKey: `episode.package:${episodeId}:${stored.transcript.id}`,
    episodeId,
    maxAttempts: 2,
  });

  return {
    transcriptId: stored.transcript.id,
    segments: stored.segments.length,
    source: stored.transcript.source,
    durationSeconds: stored.transcript.durationSeconds,
  };
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

  // When Rumble reports the stream is over, go looking for the captions.
  if (applied.transition === "ENDED" && applied.matchedEpisodeId) {
    const [publication] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, applied.matchedEpisodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      )
      .limit(1);

    if (publication?.externalId) {
      const { enqueue } = await import("./queue");
      await enqueue({
        kind: "youtube.fetch_captions",
        idempotencyKey: `youtube.fetch_captions:${applied.matchedEpisodeId}`,
        episodeId: applied.matchedEpisodeId,
        maxAttempts: 5,
        // Auto-captions take a while to appear after a stream ends.
        runAfter: new Date(Date.now() + 20 * 60_000),
      });
    }
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

export const HANDLERS: Record<string, Handler> = {
  ping,
  "fail-test": failTest,
  "simulate.publication": simulatePublication,
  "youtube.fetch_captions": fetchCaptions,
  "episode.package": packageEpisodeHandler,
  "rumble.poll_live": pollRumble,
  "integration.health_check": integrationHealthCheck,
};

export function getHandler(kind: string): Handler | undefined {
  return HANDLERS[kind];
}
