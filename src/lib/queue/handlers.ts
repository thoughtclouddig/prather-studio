/**
 * Job handlers.
 *
 * Phase 1 has no provider handlers — nothing here contacts an external service.
 *
 *   ping                  test handler: succeeds and records a result
 *   fail-test             test handler: always throws, to exercise
 *                         retry → dead-letter → manual retry
 *   simulate.publication  simulation handler backing the Studio's
 *                         "SIMULATE QUEUE" action. It moves a publication row
 *                         through its states and writes an obviously fake
 *                         external URL. No platform is contacted.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, episodes, type Job, type Platform } from "@/db/schema";
import { recordActivity, workerActor } from "@/lib/domain/activity";

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
  if (!publicationId) throw new Error("simulate.publication requires payload.publicationId");

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
  const externalId = manual ? null : `sim_${publication.platform.toLowerCase()}_${slug}`;

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

export const HANDLERS: Record<string, Handler> = {
  ping,
  "fail-test": failTest,
  "simulate.publication": simulatePublication,
};

export function getHandler(kind: string): Handler | undefined {
  return HANDLERS[kind];
}
