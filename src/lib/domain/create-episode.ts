/**
 * Creating an episode.
 *
 * Publication rows for every platform are created here, in the same
 * transaction. An operator should never have to remember to add them, and a
 * missing row would make the dashboard quietly under-report.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodePublications,
  episodes,
  shows,
  type Episode,
  type Platform,
  type PublicationIntent,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity, type Actor } from "@/lib/domain/activity";
import { POLL_LEAD_MS } from "@/lib/domain/broadcast-poll";

/**
 * Default intent per platform, from what each one can actually do today.
 * OpusClip and Locals start HELD because neither has a working adapter — an
 * intent of PUBLISH would promise something the system cannot deliver.
 */
export const DEFAULT_INTENTS: Record<Platform, PublicationIntent> = {
  RUMBLE: "PUBLISH",
  YOUTUBE: "PUBLISH",
  BUZZSPROUT: "PUBLISH",
  MAILCHIMP: "PUBLISH",
  WORDPRESS: "PUBLISH",
  WEBSITE: "PUBLISH",
  OPUSCLIP: "HOLD",
  LOCALS: "HOLD",
};

/** The platforms the brief asks for on creation, plus the two internal ones. */
export const CREATED_PLATFORMS: Platform[] = [
  "YOUTUBE",
  "RUMBLE",
  "BUZZSPROUT",
  "MAILCHIMP",
  "WORDPRESS",
  "LOCALS",
  "WEBSITE",
  "OPUSCLIP",
];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface CreateEpisodeInput {
  workingTitle: string;
  scheduledAt: Date | null;
  episodeNumber?: number | null;
  internalNotes?: string | null;
  showId?: string;
}

export async function createEpisode(
  user: User,
  input: CreateEpisodeInput,
): Promise<Episode> {
  authorize(user.role, "episode.create");
  return createEpisodeRecord(input, { kind: "user", id: user.id, name: user.name });
}

/**
 * Create an episode with no user to authorize against.
 *
 * The host's intake form has no session — Jeff is the host, not an operator,
 * and requiring him to hold a password for a four-field form is how a form
 * stops being used. So authorization is separated from creation rather than
 * inventing a user for him to act as, which would attribute his submission to
 * somebody who did not make it.
 *
 * Everything this creates is inert: a PLANNED or SCHEDULED episode and its
 * platform rows. Nothing contacts a provider, sends anything or publishes.
 */
export async function createEpisodeRecord(
  input: CreateEpisodeInput,
  actor: Actor = { kind: "system", label: "host intake" },
): Promise<Episode> {
  const workingTitle = input.workingTitle.trim();
  if (!workingTitle) throw new Error("An episode needs a working title.");

  const showId =
    input.showId ??
    (await db.select({ id: shows.id }).from(shows).limit(1))[0]?.id;
  if (!showId) throw new Error("No show is configured. Seed one first.");

  // Slugs are unique; disambiguate rather than failing on a repeated title.
  const base = slugify(workingTitle) || "episode";
  let slug = base;
  for (let attempt = 2; attempt < 50; attempt++) {
    const [taken] = await db
      .select({ id: episodes.id })
      .from(episodes)
      .where(eq(episodes.slug, slug))
      .limit(1);
    if (!taken) break;
    slug = `${base}-${attempt}`;
  }

  const episode = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(episodes)
      .values({
        showId,
        slug,
        workingTitle,
        episodeNumber: input.episodeNumber ?? null,
        scheduledAt: input.scheduledAt,
        internalNotes: input.internalNotes ?? null,
        phase: input.scheduledAt ? "SCHEDULED" : "PLANNED",
      })
      .returning();

    await tx.insert(episodePublications).values(
      CREATED_PLATFORMS.map((platform) => ({
        episodeId: created!.id,
        platform,
        intent: DEFAULT_INTENTS[platform],
        state:
          DEFAULT_INTENTS[platform] === "HOLD"
            ? ("NOT_STARTED" as const)
            : platform === "RUMBLE" && input.scheduledAt
              ? ("SCHEDULED" as const)
              : ("NOT_STARTED" as const),
        scheduledFor: platform === "RUMBLE" ? input.scheduledAt : null,
      })),
    );

    return created!;
  });

  // Start watching for the broadcast. The poller decides its own cadence and
  // sleeps until the slot is near, so scheduling it now costs nothing and
  // means nobody has to remember to start it on show day.
  if (input.scheduledAt) {
    const { enqueue } = await import("@/lib/queue/queue");
    await enqueue({
      kind: "youtube.poll_broadcast",
      idempotencyKey: `youtube.poll_broadcast:${episode.id}`,
      episodeId: episode.id,
      maxAttempts: 5,
      runAfter: new Date(input.scheduledAt.getTime() - POLL_LEAD_MS),
      actor,
    });
  }

  await recordActivity({
    actor,
    verb: "episode.created",
    subjectType: "episode",
    subjectId: episode.id,
    episodeId: episode.id,
    summary: `Created "${workingTitle}" with ${CREATED_PLATFORMS.length} platform rows`,
    after: {
      slug,
      scheduledAt: input.scheduledAt?.toISOString() ?? null,
      platforms: CREATED_PLATFORMS.length,
    },
  });

  return episode;
}
