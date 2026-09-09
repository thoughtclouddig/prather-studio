/**
 * Publication intent and simulated dispatch.
 *
 * `intent` records a human decision; `state` records what happened. Setting
 * intent never touches state except for the one honest case: choosing SKIP is
 * itself the outcome.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodePublications,
  type EpisodePublication,
  type PublicationIntent,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { enqueue } from "@/lib/queue/queue";
import { recordActivity } from "./activity";
import { PLATFORM_LABEL } from "./vocabulary";

function actorFor(user: User) {
  return { kind: "user" as const, id: user.id, name: user.name };
}

export async function setPublicationIntent(
  user: User,
  publicationId: string,
  intent: PublicationIntent,
): Promise<EpisodePublication> {
  authorize(user.role, "publication.intent");

  const [current] = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.id, publicationId))
    .limit(1);
  if (!current) throw new Error(`Publication ${publicationId} not found`);

  // SKIP is a decision with an outcome — record it as such rather than leaving
  // the row looking like unfinished work. Moving off SKIP returns it to the
  // queue of things still to do.
  let nextState = current.state;
  if (intent === "SKIP") {
    nextState = "SKIPPED";
  } else if (current.state === "SKIPPED") {
    nextState = "NOT_STARTED";
  }

  const [updated] = await db
    .update(episodePublications)
    .set({ intent, state: nextState, updatedAt: new Date() })
    .where(eq(episodePublications.id, publicationId))
    .returning();

  await recordActivity({
    actor: actorFor(user),
    verb: "publication.intent_changed",
    subjectType: "publication",
    subjectId: publicationId,
    episodeId: current.episodeId,
    summary: `${PLATFORM_LABEL[current.platform]} intent set to ${intent}`,
    before: { intent: current.intent, state: current.state },
    after: { intent, state: nextState },
  });
  return updated!;
}

/**
 * SIMULATE QUEUE.
 *
 * Enqueues a `simulate.publication` job. No provider is contacted and none
 * exists yet — this proves the enqueue → worker → state-change path end to end
 * so the real adapters have something to plug into in Phase 2.
 */
export async function enqueueSimulatedPublish(
  user: User,
  publicationId: string,
): Promise<{ jobId: string; created: boolean }> {
  authorize(user.role, "publication.enqueue");

  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.id, publicationId))
    .limit(1);
  if (!publication) throw new Error(`Publication ${publicationId} not found`);
  if (publication.intent !== "PUBLISH") {
    throw new Error(
      `Cannot queue ${PLATFORM_LABEL[publication.platform]} while intent is ${publication.intent}.`,
    );
  }

  await db
    .update(episodePublications)
    .set({ state: "QUEUED", errorMessage: null, updatedAt: new Date() })
    .where(eq(episodePublications.id, publicationId));

  // Keyed on the attempt, not just the publication, so an operator can re-queue
  // after a failure while concurrent double-clicks still collapse to one job.
  const { job, created } = await enqueue({
    kind: "simulate.publication",
    idempotencyKey: `simulate.publication:${publicationId}:${Date.now()}`,
    episodeId: publication.episodeId,
    payload: { publicationId },
    maxAttempts: 3,
    actor: actorFor(user),
  });

  await recordActivity({
    actor: actorFor(user),
    verb: "publication.queued",
    subjectType: "publication",
    subjectId: publicationId,
    episodeId: publication.episodeId,
    summary: `Queued a SIMULATED publish for ${PLATFORM_LABEL[publication.platform]}`,
    before: { state: publication.state },
    after: { state: "QUEUED", jobId: job.id, simulated: true },
  });

  return { jobId: job.id, created };
}
