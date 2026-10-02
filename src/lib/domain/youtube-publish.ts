/**
 * Updating the EXISTING YouTube video.
 *
 * This module never uploads. It reads the video we are already linked to,
 * shows exactly what would change, and applies the change only on an explicit
 * confirmation that matches what the operator was shown.
 *
 * Three safety properties, each enforced here rather than in the UI:
 *
 *  1. ONLY APPROVED CONTENT SHIPS. `buildApprovedMetadata` selects drafts with
 *     state = 'APPROVED'. A PROPOSED draft has no path to YouTube.
 *  2. READ-MODIFY-WRITE IS MANDATORY, not stylistic. videos.update deletes any
 *     property of a submitted part that the request omits, so sending a title
 *     and description alone would wipe the video's tags and category. We always
 *     send the full merged snippet.
 *  3. NO SILENT OVERWRITE. If the remote video changed since our last sync,
 *     the update is refused until the operator sees the newer remote state.
 */
import "server-only";
import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodeContentDrafts,
  episodePublications,
  episodes,
  type EpisodePublication,
  type User,
} from "@/db/schema";
import { authorize } from "@/lib/auth/authorize";
import { recordActivity } from "@/lib/domain/activity";
import { snapshotOf, type RemoteSnapshot } from "@/lib/domain/linkage";
import {
  getVideo,
  updateVideoSnippet,
  type YouTubeVideo,
} from "@/lib/integrations/youtube/client";

/** YouTube category 25 = News & Politics. Used only if the video has none. */
const DEFAULT_CATEGORY_ID = "25";

export interface ApprovedMetadata {
  title: string | null;
  descriptionBody: string | null;
  chapters: string | null;
  /** Description plus chapters, composed. This is what actually gets sent. */
  composedDescription: string | null;
  missing: string[];
}

/**
 * Compose what we would publish, from APPROVED drafts only.
 *
 * Chapters live in exactly one place, their own draft, and are composed into
 * the description here. There is no second manual copy to drift.
 */
export async function buildApprovedMetadata(episodeId: string): Promise<ApprovedMetadata> {
  const drafts = await db
    .select()
    .from(episodeContentDrafts)
    .where(
      and(
        eq(episodeContentDrafts.episodeId, episodeId),
        eq(episodeContentDrafts.state, "APPROVED"),
      ),
    )
    .orderBy(asc(episodeContentDrafts.sortOrder), asc(episodeContentDrafts.createdAt));

  const pick = (field: string, platform?: "YOUTUBE") =>
    drafts.find((d) => d.field === field && (platform ? d.platform === platform : true))
      ?.value ?? null;

  // A YouTube-specific title wins; the approved headline is the fallback.
  const title = pick("platform_title", "YOUTUBE") ?? pick("primary_headline");
  const descriptionBody = pick("platform_description", "YOUTUBE");
  const chapters = pick("chapters");

  const missing: string[] = [];
  if (!title) missing.push("an approved title");
  if (!descriptionBody) missing.push("an approved YouTube description");

  const composedDescription = descriptionBody
    ? chapters
      ? `${descriptionBody.trim()}\n\nCHAPTERS\n${chapters.trim()}`
      : descriptionBody.trim()
    : null;

  return { title, descriptionBody, chapters, composedDescription, missing };
}

export interface FieldChange {
  field: "title" | "description";
  current: string;
  proposed: string;
  changed: boolean;
}

export interface UpdatePlan {
  videoId: string;
  video: YouTubeVideo;
  changes: FieldChange[];
  hasChanges: boolean;
  /** Set when the remote video changed since our last recorded sync. */
  remoteDrift: {
    since: Date | null;
    fields: string[];
    previous: RemoteSnapshot;
  } | null;
  missing: string[];
  /**
   * Hash of the exact remote state the operator was shown. The apply step
   * requires it back, so a confirmation can never be applied to a video that
   * moved underneath it.
   */
  remoteFingerprint: string;
}

export function fingerprint(video: YouTubeVideo): string {
  return createHash("sha256")
    .update(`${video.id} ${video.title} ${video.description}`)
    .digest("hex")
    .slice(0, 32);
}

export async function planYouTubeUpdate(episodeId: string): Promise<UpdatePlan> {
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
  if (!videoId) throw new Error("This episode is not linked to a YouTube video.");

  const video = await getVideo(videoId);
  if (!video) throw new Error(`YouTube video ${videoId} is no longer reachable.`);

  const approved = await buildApprovedMetadata(episodeId);

  const changes: FieldChange[] = [
    {
      field: "title",
      current: video.title,
      proposed: approved.title ?? video.title,
      changed: !!approved.title && approved.title !== video.title,
    },
    {
      field: "description",
      current: video.description,
      proposed: approved.composedDescription ?? video.description,
      changed:
        !!approved.composedDescription &&
        approved.composedDescription !== video.description,
    },
  ];

  // Did someone edit the video outside the Studio since we last looked?
  const previous = publication.remoteSnapshot as RemoteSnapshot | null;
  const drifted: string[] = [];
  if (previous) {
    if (previous.title !== video.title) drifted.push("title");
    if (previous.description !== video.description) drifted.push("description");
  }

  return {
    videoId,
    video,
    changes,
    hasChanges: changes.some((c) => c.changed),
    remoteDrift:
      drifted.length > 0 && previous
        ? { since: publication.remoteSnapshotAt, fields: drifted, previous }
        : null,
    missing: approved.missing,
    remoteFingerprint: fingerprint(video),
  };
}

export class RemoteChangedError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `The YouTube video changed since you opened this diff (${fields.join(", ")}). ` +
        "Re-open the update so you can see the newer remote state before overwriting it.",
    );
    this.name = "RemoteChangedError";
  }
}

export class NothingApprovedError extends Error {
  constructor(missing: string[]) {
    super(`Nothing can be sent to YouTube yet. Still needs ${missing.join(" and ")}.`);
    this.name = "NothingApprovedError";
  }
}

/**
 * Apply the update.
 *
 * `confirmedFingerprint` must match the remote state right now. That single
 * check covers both races: someone editing in YouTube Studio while the diff is
 * open, and a stale browser tab replaying an old confirmation.
 */
export async function applyYouTubeUpdate(
  user: User,
  episodeId: string,
  confirmedFingerprint: string,
  opts: { acknowledgeDrift?: boolean } = {},
): Promise<{ publication: EpisodePublication; video: YouTubeVideo }> {
  authorize(user.role, "publication.enqueue");

  const plan = await planYouTubeUpdate(episodeId);
  if (plan.missing.length > 0) throw new NothingApprovedError(plan.missing);
  if (!plan.hasChanges) {
    throw new Error("YouTube already matches the approved metadata. Nothing to send.");
  }
  if (plan.remoteFingerprint !== confirmedFingerprint) {
    throw new RemoteChangedError(["title or description"]);
  }
  if (plan.remoteDrift && !opts.acknowledgeDrift) {
    throw new RemoteChangedError(plan.remoteDrift.fields);
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

  // Preserve what was there before we touched it. This is the audit record.
  const before = snapshotOf(plan.video);
  await recordActivity({
    actor: { kind: "user", id: user.id, name: user.name },
    verb: "youtube.metadata_snapshot",
    subjectType: "publication",
    subjectId: publication!.id,
    episodeId,
    summary: `Captured YouTube metadata for ${plan.videoId} before updating it`,
    before,
  });

  const titleChange = plan.changes.find((c) => c.field === "title")!;
  const descriptionChange = plan.changes.find((c) => c.field === "description")!;

  try {
    // FULL snippet. videos.update deletes anything omitted from the part.
    const updated = await updateVideoSnippet(plan.videoId, {
      title: titleChange.proposed,
      description: descriptionChange.proposed,
      categoryId: plan.video.categoryId ?? DEFAULT_CATEGORY_ID,
      tags: plan.video.tags,
      ...(plan.video.defaultLanguage
        ? { defaultLanguage: plan.video.defaultLanguage }
        : {}),
    });

    const now = new Date();
    const [saved] = await db
      .update(episodePublications)
      .set({
        state: "PUBLISHED",
        // What is live on YouTube lives in `remoteSnapshot`, not in duplicate
        // columns. One copy, so there is nothing to drift.
        lastSyncAt: now,
        remoteSnapshot: snapshotOf(updated) as never,
        remoteSnapshotAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(episodePublications.id, publication!.id))
      .returning();

    const changedFields = plan.changes
      .filter((c) => c.changed)
      .map((c) => c.field)
      .join(" and ");

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "youtube.metadata_updated",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary: `Updated YouTube video ${plan.videoId}: ${changedFields}`,
      before: { title: before.title, description: before.description },
      after: { title: updated.title, description: updated.description },
    });

    // Stamp when the broadcast actually happened, not when we updated it.
    // Marking an episode RELEASED without an airedAt left it looking like it
    // had never aired, which is how a past show kept qualifying as upcoming.
    const broadcastAt = plan.video.live?.actualStartTime
      ? new Date(plan.video.live.actualStartTime)
      : new Date(plan.video.publishedAt);

    await db
      .update(episodes)
      .set({ phase: "RELEASED", airedAt: broadcastAt, updatedAt: now })
      .where(eq(episodes.id, episodeId));

    return { publication: saved!, video: updated };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // A failed update must not lose the link we already had.
    await db
      .update(episodePublications)
      .set({
        state: "FAILED",
        errorMessage: message.slice(0, 1000),
        updatedAt: new Date(),
      })
      .where(eq(episodePublications.id, publication!.id));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "youtube.metadata_failed",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary: `YouTube update failed for ${plan.videoId}: ${message}`,
      after: { error: message },
    });
    throw error;
  }
}
