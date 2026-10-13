/**
 * Running OpusClip against an episode, and collecting what comes back.
 */
import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeClips, episodePublications, episodes } from "@/db/schema";
import { appBaseUrl } from "@/lib/app-url";
import { recordActivity, type Actor } from "@/lib/domain/activity";
import { createClipProject, listClips } from "@/lib/integrations/opusclip/client";
import { normalizeRumbleVideoUrl } from "@/lib/integrations/rumble/video-url";

export class OpusRunError extends Error {}

/**
 * The URL OpusClip should clip from.
 *
 * YouTube first: it is the canonical recording, OpusClip lists YOUTUBE as a
 * native source platform, and a Rumble embed URL is a player page rather than
 * a video file. Rumble is the fallback only when a page URL is stored —
 * never an embed URL, which would send OpusClip somewhere it cannot download
 * from.
 */
export async function sourceUrlFor(episodeId: string): Promise<string> {
  const rows = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.episodeId, episodeId));

  const youtubeId = rows.find((r) => r.platform === "YOUTUBE")?.externalId;
  if (youtubeId) return `https://www.youtube.com/watch?v=${youtubeId}`;

  const rumble = normalizeRumbleVideoUrl(
    rows.find((r) => r.platform === "RUMBLE")?.externalUrl,
  );
  if (rumble?.kind === "page") return rumble.url;

  throw new OpusRunError(
    rumble?.kind === "embed"
      ? "Only a Rumble embed URL is stored, which is a player rather than a " +
        "downloadable video. Link the YouTube video, or store the Rumble page URL."
      : "No video is linked to this episode yet. Match it to YouTube first.",
  );
}

/** Start a clipping run and record the project against the episode. */
export async function startClipRun(
  episodeId: string,
  actor: Actor,
): Promise<{ projectId: string; sourceUrl: string }> {
  const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (!episode) throw new OpusRunError("Episode not found.");

  const sourceUrl = await sourceUrlFor(episodeId);

  const project = await createClipProject({
    videoUrl: sourceUrl,
    webhookUrl: `${appBaseUrl()}/api/integrations/opusclip/webhook`,
    // Fewer, better clips is this project's rule, and it applies to length
    // too: 30-90s is what the platforms actually reward.
    clipDurations: [[30, 90]],
  });

  await db
    .insert(episodePublications)
    .values({
      episodeId,
      platform: "OPUSCLIP",
      state: "PROCESSING",
      externalId: project.projectId,
    })
    .onConflictDoUpdate({
      target: [episodePublications.episodeId, episodePublications.platform],
      set: {
        state: "PROCESSING",
        externalId: project.projectId,
        updatedAt: new Date(),
      },
    });

  await recordActivity({
    actor,
    verb: "episode.clips_requested",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary: `Sent the recording to OpusClip`,
    after: { projectId: project.projectId, sourceUrl, stage: project.stage },
  });

  return { projectId: project.projectId, sourceUrl };
}

/**
 * Collect the finished clips.
 *
 * Upserted on OpusClip's clip id, so a callback arriving twice — which their
 * retry behaviour makes likely — updates rather than duplicates.
 */
export async function collectClips(
  projectId: string,
  opts: { failed?: boolean } = {},
): Promise<{ stored: number }> {
  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.platform, "OPUSCLIP"),
        eq(episodePublications.externalId, projectId),
      ),
    )
    .limit(1);

  if (!publication) throw new OpusRunError(`No episode holds OpusClip project ${projectId}.`);

  if (opts.failed) {
    await db
      .update(episodePublications)
      .set({ state: "FAILED", updatedAt: new Date() })
      .where(eq(episodePublications.id, publication.id));
    throw new OpusRunError("OpusClip reported the run stalled or failed.");
  }

  const clips = await listClips(projectId);

  for (const clip of clips) {
    await db
      .insert(episodeClips)
      .values({
        episodeId: publication.episodeId,
        externalId: clip.id,
        projectId,
        title: clip.title,
        description: clip.description,
        transcriptText: clip.text,
        hashtags: clip.hashtags,
        keywords: clip.keywords,
        durationSeconds: clip.durationSeconds,
        previewUrl: clip.previewUrl,
        downloadUrl: clip.downloadUrl,
      })
      .onConflictDoUpdate({
        target: episodeClips.externalId,
        set: {
          title: clip.title,
          description: clip.description,
          previewUrl: clip.previewUrl,
          downloadUrl: clip.downloadUrl,
          updatedAt: new Date(),
        },
      });
  }

  await db
    .update(episodePublications)
    .set({ state: clips.length > 0 ? "PUBLISHED" : "PROCESSING", updatedAt: new Date() })
    .where(eq(episodePublications.id, publication.id));

  await recordActivity({
    actor: { kind: "system", label: "OpusClip" },
    verb: "episode.clips_collected",
    subjectType: "episode",
    subjectId: publication.episodeId,
    episodeId: publication.episodeId,
    summary: `Collected ${clips.length} clip${clips.length === 1 ? "" : "s"} from OpusClip`,
    after: { projectId, clips: clips.length },
  });

  return { stored: clips.length };
}
