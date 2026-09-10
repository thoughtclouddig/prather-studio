/**
 * YouTube Data API v3 client.
 *
 * Holds a decrypted access token for the life of one call chain and refreshes
 * it proactively. Nothing here returns a token to a caller.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { integrationCredentials } from "@/db/schema";
import { encryptJson } from "@/lib/crypto/secretbox";
import {
  markHealth,
  readCredential,
  type YouTubeCredentialPayload,
} from "@/lib/integrations/credentials";
import { refreshAccessToken } from "./oauth";

const API = "https://www.googleapis.com/youtube/v3";

export class YouTubeApiError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, reason: string | undefined, message: string) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.reason = reason;
  }
}

/** Refresh when fewer than 5 minutes remain, rather than waiting for a 401. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface YouTubeSession {
  accessToken: string;
  scopes: string[];
}

/**
 * Get a usable access token, refreshing it if it is close to expiry. A failure
 * here marks the integration ATTENTION so it surfaces on the dashboard rather
 * than only failing the job that happened to notice.
 */
export async function authorize(): Promise<YouTubeSession> {
  const stored = await readCredential<YouTubeCredentialPayload>("YOUTUBE");
  if (!stored) throw new Error("YouTube is not connected.");

  const { record, payload } = stored;
  const expiringSoon =
    !record.expiresAt || record.expiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS;

  if (!expiringSoon) {
    return { accessToken: payload.accessToken, scopes: record.scopes ?? [] };
  }

  try {
    const refreshed = await refreshAccessToken(payload.refreshToken);
    const next: YouTubeCredentialPayload = {
      // Google omits refresh_token on a refresh — keep the one we hold.
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? payload.refreshToken,
      tokenType: refreshed.token_type,
    };
    await db
      .update(integrationCredentials)
      .set({
        encryptedPayload: encryptJson(next),
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000),
        health: "CONNECTED",
        lastError: null,
        lastSuccessAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(integrationCredentials.provider, "YOUTUBE"));

    return { accessToken: next.accessToken, scopes: record.scopes ?? [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markHealth("YOUTUBE", "ATTENTION", `Token refresh failed: ${message}`);
    throw new Error(
      `YouTube token refresh failed — the connection needs to be re-authorized. (${message})`,
    );
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const { accessToken } = await authorize();
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    let reason: string | undefined;
    let message = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      reason = parsed.error?.errors?.[0]?.reason;
      message = parsed.error?.message ?? message;
    } catch {
      /* body was not JSON; keep the raw text */
    }
    throw new YouTubeApiError(response.status, reason, message);
  }

  return (await response.json()) as T;
}

/* ------------------------------------------------------------------ types */

export interface YouTubeChannel {
  id: string;
  title: string;
  customUrl?: string;
  uploadsPlaylistId: string;
  subscriberCount?: string;
  videoCount?: string;
}

export interface YouTubeVideo {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnailUrl: string | null;
  durationIso: string | null;
  durationSeconds: number | null;
  privacyStatus: string | null;
  categoryId: string | null;
  tags: string[];
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  liveBroadcastContent: string | null;
  /** Present only on livestreams — this is how we learn the real lifecycle. */
  live: {
    scheduledStartTime?: string;
    actualStartTime?: string;
    actualEndTime?: string;
    concurrentViewers?: string;
  } | null;
}

export interface YouTubeCaptionTrack {
  id: string;
  language: string;
  name: string;
  /** "asr" = auto-generated; "standard" = uploaded by a human. */
  trackKind: string;
  status: string;
  isDraft: boolean;
  isAutoSynced: boolean;
  lastUpdated: string;
}

/* --------------------------------------------------------------- requests */

export async function getMyChannel(): Promise<YouTubeChannel> {
  const data = await call<{
    items?: Array<{
      id: string;
      snippet: { title: string; customUrl?: string };
      contentDetails: { relatedPlaylists: { uploads: string } };
      statistics?: { subscriberCount?: string; videoCount?: string };
    }>;
  }>("channels", {
    query: { part: "snippet,contentDetails,statistics", mine: "true" },
  });

  const channel = data.items?.[0];
  if (!channel) {
    throw new Error("The authorized Google account has no YouTube channel.");
  }
  return {
    id: channel.id,
    title: channel.snippet.title,
    customUrl: channel.snippet.customUrl,
    uploadsPlaylistId: channel.contentDetails.relatedPlaylists.uploads,
    subscriberCount: channel.statistics?.subscriberCount,
    videoCount: channel.statistics?.videoCount,
  };
}

/** ISO 8601 duration (PT1H2M3S) → seconds. */
export function parseIsoDuration(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, sec] = m;
  return (
    Number(d ?? 0) * 86400 +
    Number(h ?? 0) * 3600 +
    Number(min ?? 0) * 60 +
    Math.round(Number(sec ?? 0))
  );
}

/**
 * Recent uploads via the channel's uploads playlist (1 quota unit) rather than
 * search.list (100 units) — same data, a hundredth of the cost.
 */
export async function listRecentVideos(limit = 25): Promise<YouTubeVideo[]> {
  const channel = await getMyChannel();
  const playlist = await call<{
    items?: Array<{ contentDetails: { videoId: string } }>;
  }>("playlistItems", {
    query: {
      part: "contentDetails",
      playlistId: channel.uploadsPlaylistId,
      maxResults: String(Math.min(limit, 50)),
    },
  });

  const ids = (playlist.items ?? []).map((i) => i.contentDetails.videoId);
  if (ids.length === 0) return [];
  return getVideos(ids);
}

export async function getVideos(ids: string[]): Promise<YouTubeVideo[]> {
  if (ids.length === 0) return [];
  const data = await call<{
    items?: Array<{
      id: string;
      snippet: {
        title: string;
        description: string;
        publishedAt: string;
        categoryId?: string;
        tags?: string[];
        defaultLanguage?: string;
        defaultAudioLanguage?: string;
        liveBroadcastContent?: string;
        thumbnails?: Record<string, { url: string; width: number }>;
      };
      contentDetails?: { duration?: string };
      status?: { privacyStatus?: string };
      liveStreamingDetails?: {
        scheduledStartTime?: string;
        actualStartTime?: string;
        actualEndTime?: string;
        concurrentViewers?: string;
      };
    }>;
  }>("videos", {
    query: {
      part: "snippet,contentDetails,status,liveStreamingDetails",
      id: ids.join(","),
      maxResults: "50",
    },
  });

  return (data.items ?? []).map((v) => {
    const thumbs = v.snippet.thumbnails ?? {};
    const best = Object.values(thumbs).sort((a, b) => b.width - a.width)[0];
    const durationIso = v.contentDetails?.duration ?? null;
    return {
      id: v.id,
      title: v.snippet.title,
      description: v.snippet.description,
      publishedAt: v.snippet.publishedAt,
      thumbnailUrl: best?.url ?? null,
      durationIso,
      durationSeconds: parseIsoDuration(durationIso),
      privacyStatus: v.status?.privacyStatus ?? null,
      categoryId: v.snippet.categoryId ?? null,
      tags: v.snippet.tags ?? [],
      defaultLanguage: v.snippet.defaultLanguage ?? null,
      defaultAudioLanguage: v.snippet.defaultAudioLanguage ?? null,
      liveBroadcastContent: v.snippet.liveBroadcastContent ?? null,
      live: v.liveStreamingDetails
        ? {
            scheduledStartTime: v.liveStreamingDetails.scheduledStartTime,
            actualStartTime: v.liveStreamingDetails.actualStartTime,
            actualEndTime: v.liveStreamingDetails.actualEndTime,
            concurrentViewers: v.liveStreamingDetails.concurrentViewers,
          }
        : null,
    };
  });
}

export async function getVideo(id: string): Promise<YouTubeVideo | null> {
  const [video] = await getVideos([id]);
  return video ?? null;
}

export async function listCaptionTracks(videoId: string): Promise<YouTubeCaptionTrack[]> {
  const data = await call<{
    items?: Array<{
      id: string;
      snippet: {
        language: string;
        name: string;
        trackKind: string;
        status: string;
        isDraft: boolean;
        isAutoSynced: boolean;
        lastUpdated: string;
      };
    }>;
  }>("captions", { query: { part: "snippet", videoId } });

  return (data.items ?? []).map((c) => ({ id: c.id, ...c.snippet }));
}

/**
 * Download a caption track. Returns the raw body — this endpoint does NOT
 * return JSON, so it bypasses `call()`.
 *
 * 403 here is the well-known failure: it means the token lacks force-ssl, or
 * the account cannot edit the video. The message is preserved verbatim so the
 * operator sees exactly what Google said.
 */
export async function downloadCaptionTrack(
  captionId: string,
  format: "vtt" | "srt" | "ttml" = "vtt",
): Promise<string> {
  const { accessToken } = await authorize();
  const url = new URL(`${API}/captions/${captionId}`);
  url.searchParams.set("tfmt", format);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text();
    let reason: string | undefined;
    let message = body.slice(0, 500);
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      reason = parsed.error?.errors?.[0]?.reason;
      message = parsed.error?.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new YouTubeApiError(response.status, reason, message);
  }

  return response.text();
}

/**
 * Update an existing video's snippet.
 *
 * CRITICAL: videos.update deletes any property of a submitted part that is not
 * present in the request body. The caller must therefore pass the FULL snippet,
 * merged — never just the fields it wants to change. `updateVideoSnippet` takes
 * a complete snippet for exactly this reason.
 */
export interface VideoSnippetUpdate {
  title: string;
  description: string;
  categoryId: string;
  tags?: string[];
  defaultLanguage?: string;
}

export async function updateVideoSnippet(
  videoId: string,
  snippet: VideoSnippetUpdate,
): Promise<YouTubeVideo> {
  await call<unknown>("videos", {
    method: "PUT",
    query: { part: "snippet" },
    body: JSON.stringify({ id: videoId, snippet }),
  });
  const updated = await getVideo(videoId);
  if (!updated) throw new Error(`Video ${videoId} vanished immediately after update.`);
  return updated;
}

export async function setThumbnail(videoId: string, image: Buffer, mime: string) {
  const { accessToken } = await authorize();
  const url = new URL("https://www.googleapis.com/upload/youtube/v3/thumbnails/set");
  url.searchParams.set("videoId", videoId);

  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": mime },
    body: new Uint8Array(image),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new YouTubeApiError(response.status, undefined, body.slice(0, 400));
  }
}
