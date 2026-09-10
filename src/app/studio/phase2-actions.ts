"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission, requireUser } from "@/lib/auth/require";
import { createEpisode } from "@/lib/domain/create-episode";
import {
  candidatesForEpisode,
  linkYouTubeVideo,
  unlinkYouTubeVideo,
} from "@/lib/domain/linkage";
import { applyYouTubeUpdate } from "@/lib/domain/youtube-publish";
import { disconnect, saveCredential } from "@/lib/integrations/credentials";
import { testConnection } from "@/lib/integrations/rumble/observer";
import { listRecentVideos } from "@/lib/integrations/youtube/client";
import { enqueue } from "@/lib/queue/queue";
import { fromShowInputValue } from "@/lib/format";
import { extractVideoId } from "@/lib/integrations/youtube/video-id";
import { db } from "@/db/client";
import { episodes, type IntegrationProvider } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { ActionState } from "./actions";

async function guarded(
  fn: () => Promise<string | void>,
  paths: string[],
): Promise<ActionState> {
  try {
    const ok = await fn();
    for (const p of paths) revalidatePath(p, "page");
    return ok ? { ok } : {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const episodePaths = (id: string) => [
  "/studio",
  "/studio/episodes",
  `/studio/episodes/${id}`,
  `/studio/episodes/${id}/review`,
  "/studio/jobs",
];

/* ------------------------------------------------------------- episodes */

export async function createEpisodeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requirePermission("episode.create");

  const workingTitle = String(formData.get("workingTitle") ?? "").trim();
  const scheduledRaw = String(formData.get("scheduledAt") ?? "").trim();
  const numberRaw = String(formData.get("episodeNumber") ?? "").trim();
  const notes = String(formData.get("internalNotes") ?? "").trim();

  let episodeId: string;
  try {
    const episode = await createEpisode(user, {
      workingTitle,
      scheduledAt: fromShowInputValue(scheduledRaw),
      episodeNumber: numberRaw ? Number(numberRaw) : null,
      internalNotes: notes || null,
    });
    episodeId = episode.id;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  revalidatePath("/studio", "page");
  revalidatePath("/studio/episodes", "page");
  redirect(`/studio/episodes/${episodeId}`);
}

/* -------------------------------------------------------- YouTube link */

export async function linkYouTubeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const raw = String(formData.get("videoId") ?? "").trim();
  const via = String(formData.get("via") ?? "manual") as "manual" | "candidate";

  return guarded(async () => {
    const user = await requirePermission("publication.intent");
    const videoId = extractVideoId(raw);
    if (!videoId) {
      throw new Error(
        "That does not look like a YouTube video ID or URL. Expected an 11-character ID.",
      );
    }
    const { video } = await linkYouTubeVideo(user, episodeId, videoId, { via });
    return `Linked to "${video.title}".`;
  }, episodePaths(episodeId));
}

export async function unlinkYouTubeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.intent");
    await unlinkYouTubeVideo(user, episodeId);
    return "Unlinked from YouTube.";
  }, episodePaths(episodeId));
}

/** Live candidate lookup. Two quota units, and the operator is waiting. */
export async function loadCandidates(episodeId: string) {
  await requireUser();
  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) throw new Error("Episode not found");

  const videos = await listRecentVideos(25);
  return candidatesForEpisode(episode, videos);
}

/* ------------------------------------------------------------ pipeline */

export async function enqueueCaptionsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    await enqueue({
      kind: "youtube.fetch_captions",
      idempotencyKey: `youtube.fetch_captions:${episodeId}:${Date.now()}`,
      episodeId,
      maxAttempts: 3,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Queued caption retrieval. It will package the episode automatically if it succeeds.";
  }, episodePaths(episodeId));
}

export async function enqueuePackageAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    await enqueue({
      kind: "episode.package",
      idempotencyKey: `episode.package:${episodeId}:${Date.now()}`,
      episodeId,
      maxAttempts: 2,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Queued the content engine. Proposals will appear in Review.";
  }, episodePaths(episodeId));
}

/* -------------------------------------------------------- YouTube write */

/**
 * Apply the metadata update.
 *
 * Runs synchronously on purpose: the fingerprint the operator confirmed must
 * be checked against the remote state with no queue delay in between.
 */
export async function applyYouTubeUpdateAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const episodeId = String(formData.get("episodeId"));
  const fingerprint = String(formData.get("fingerprint") ?? "");
  const acknowledgeDrift = formData.get("acknowledgeDrift") === "on";

  return guarded(async () => {
    const user = await requirePermission("publication.enqueue");
    const { video } = await applyYouTubeUpdate(user, episodeId, fingerprint, {
      acknowledgeDrift,
    });
    // Read back from YouTube, so success means "verified", not "no error".
    return `YouTube updated and verified. Title now reads "${video.title}".`;
  }, episodePaths(episodeId));
}

/* -------------------------------------------------------- integrations */

export async function connectRumbleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const apiUrl = String(formData.get("apiUrl") ?? "").trim();
  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    if (!/^https:\/\/rumble\.com\//i.test(apiUrl)) {
      throw new Error(
        "Expected a URL from rumble.com/account/livestream-api starting with https://rumble.com/.",
      );
    }
    // Prove it works before storing it.
    const observation = await testConnection(apiUrl);
    await saveCredential({
      provider: "RUMBLE",
      kind: "URL_SECRET",
      payload: { apiUrl },
      accountLabel:
        observation.followersTotal !== null
          ? `${observation.followersTotal.toLocaleString()} followers`
          : "Live Stream API",
      actor: { kind: "user", id: user.id, name: user.name },
      connectedBy: user.id,
    });
    return observation.liveNow
      ? `Connected. Rumble is live right now: "${observation.liveNow.title}".`
      : "Connected. Rumble reports no stream live at the moment.";
  }, ["/studio/integrations", "/studio"]);
}

export async function disconnectIntegrationAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const provider = String(formData.get("provider")) as IntegrationProvider;
  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    await disconnect(user, provider);
    return `${provider} disconnected.`;
  }, ["/studio/integrations", "/studio"]);
}

export async function testIntegrationsAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("integration.configure");
    await enqueue({
      kind: "integration.health_check",
      idempotencyKey: `integration.health_check:${Date.now()}`,
      maxAttempts: 1,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Health check queued.";
  }, ["/studio/integrations", "/studio/jobs"]);
}

export async function pollRumbleNowAction(
  _prev: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  return guarded(async () => {
    const user = await requirePermission("job.retry");
    await enqueue({
      kind: "rumble.poll_live",
      idempotencyKey: `rumble.poll_live:${Date.now()}`,
      maxAttempts: 1,
      actor: { kind: "user", id: user.id, name: user.name },
    });
    return "Rumble poll queued.";
  }, ["/studio/integrations", "/studio/jobs", "/studio"]);
}
