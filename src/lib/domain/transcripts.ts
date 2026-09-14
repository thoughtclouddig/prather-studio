/**
 * Transcript retrieval and storage.
 *
 * The official path is YouTube's own caption track for a video we own. If it
 * fails, this module records the EXACT API response rather than working around
 * it — an undocumented workaround that silently half-works would be worse than
 * a clear failure, and the fallback decision (transcribe our own master) is an
 * architecture choice, not something to paper over.
 */
import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  episodePublications,
  episodeTranscripts,
  transcriptSegments,
  type EpisodeTranscript,
  type TranscriptSegment,
  type TranscriptSource,
} from "@/db/schema";
import { recordActivity, SYSTEM_ACTOR, type Actor } from "@/lib/domain/activity";
import {
  downloadCaptionTrack,
  listCaptionTracks,
  YouTubeApiError,
  type YouTubeCaptionTrack,
} from "@/lib/integrations/youtube/client";
import { parseTranscript } from "@/lib/transcripts/parse";
import { and } from "drizzle-orm";

export class CaptionRetrievalError extends Error {
  readonly status: number | undefined;
  readonly reason: string | undefined;
  readonly tracks: YouTubeCaptionTrack[];
  constructor(
    message: string,
    opts: { status?: number; reason?: string; tracks?: YouTubeCaptionTrack[] } = {},
  ) {
    super(message);
    this.name = "CaptionRetrievalError";
    this.status = opts.status;
    this.reason = opts.reason;
    this.tracks = opts.tracks ?? [];
  }
}

/**
 * Choose which caption track to download.
 *
 * Preferring a human-uploaded track over ASR is right in principle — same
 * timecodes, punctuated text — but only among tracks that actually work.
 *
 * The JP Intel channel turns out to carry a second `standard` track on every
 * livestream with `language: "und"` and `status: "failed"`. It downloads
 * successfully and returns a 37-byte VTT header with no cues. Preferring
 * "human over ASR" without checking status therefore picked the broken track
 * on every single episode and produced an empty transcript, with no error
 * anywhere to explain it. Status and language are filtered first for that
 * reason.
 */
export function chooseTrack(tracks: YouTubeCaptionTrack[]): YouTubeCaptionTrack | null {
  const usable = tracks.filter(
    (t) =>
      !t.isDraft &&
      // "serving" is the only status that means the track has content.
      t.status === "serving" &&
      // "und" is YouTube's undefined-language placeholder.
      t.language.toLowerCase() !== "und",
  );
  if (usable.length === 0) return null;

  const english = usable.filter((t) => t.language.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : usable;

  return (
    pool.find((t) => t.trackKind !== "asr") ?? pool.find((t) => t.trackKind === "asr") ?? null
  );
}

export interface StoredTranscript {
  transcript: EpisodeTranscript;
  segments: TranscriptSegment[];
}

export async function storeTranscript(input: {
  episodeId: string;
  source: TranscriptSource;
  provider: string;
  language: string;
  raw: string;
  sourceExternalId?: string | null;
  generatedAt?: Date | null;
  actor?: Actor;
}): Promise<StoredTranscript> {
  const parsed = parseTranscript(input.raw);
  if (parsed.segments.length === 0) {
    throw new CaptionRetrievalError(
      "The caption track downloaded but contained no readable cues.",
    );
  }

  const stored = await db.transaction(async (tx) => {
    const [transcript] = await tx
      .insert(episodeTranscripts)
      .values({
        episodeId: input.episodeId,
        source: input.source,
        provider: input.provider,
        language: input.language,
        rawText: input.raw,
        rawFormat: parsed.format,
        plainText: parsed.plainText,
        sourceExternalId: input.sourceExternalId ?? null,
        durationSeconds: parsed.durationSeconds,
        segmentCount: parsed.segments.length,
        generatedAt: input.generatedAt ?? new Date(),
      })
      .returning();

    await tx.insert(transcriptSegments).values(
      parsed.segments.map((segment, index) => ({
        transcriptId: transcript!.id,
        ordinal: index,
        startTime: Math.round(segment.startTime),
        endTime: Math.round(segment.endTime),
        speaker: segment.speaker ?? null,
        text: segment.text,
      })),
    );

    const segments = await tx
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.transcriptId, transcript!.id));

    return { transcript: transcript!, segments };
  });

  await recordActivity({
    actor: input.actor ?? SYSTEM_ACTOR,
    verb: "transcript.stored",
    subjectType: "transcript",
    subjectId: stored.transcript.id,
    episodeId: input.episodeId,
    summary: `Transcript stored — ${parsed.segments.length} segments, ${Math.round(parsed.durationSeconds / 60)} minutes, via ${input.provider}`,
    after: { source: input.source, segments: parsed.segments.length },
  });

  return stored;
}

/**
 * Fetch captions for an episode's linked YouTube video.
 *
 * A 403 here is the failure mode the Phase 0 audit flagged. We surface Google's
 * own message intact so the operator can tell "wrong scope" from "not the
 * owner" from "track not downloadable", rather than seeing a generic error.
 */
export async function fetchCaptionsForEpisode(
  episodeId: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<StoredTranscript> {
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
    throw new CaptionRetrievalError(
      "This episode is not linked to a YouTube video yet. Link it first.",
    );
  }

  let tracks: YouTubeCaptionTrack[];
  try {
    tracks = await listCaptionTracks(videoId);
  } catch (error) {
    const api = error instanceof YouTubeApiError ? error : null;
    throw new CaptionRetrievalError(
      `captions.list failed for ${videoId}: ${api?.message ?? String(error)}`,
      { status: api?.status, reason: api?.reason },
    );
  }

  if (tracks.length === 0) {
    throw new CaptionRetrievalError(
      `YouTube reports no caption tracks for ${videoId}. Auto-captions can take up to a few hours after a stream ends.`,
      { tracks },
    );
  }

  const track = chooseTrack(tracks);
  if (!track) {
    throw new CaptionRetrievalError(
      `Found ${tracks.length} caption track(s) for ${videoId} but all are drafts.`,
      { tracks },
    );
  }

  let raw: string;
  try {
    raw = await downloadCaptionTrack(track.id, "vtt");
  } catch (error) {
    const api = error instanceof YouTubeApiError ? error : null;
    // Record the exact response — this is the experiment's result, not noise.
    await recordActivity({
      actor,
      verb: "transcript.failed",
      subjectType: "transcript",
      episodeId,
      summary: `captions.download failed (${api?.status ?? "?"}${api?.reason ? ` ${api.reason}` : ""}) — ${api?.message ?? String(error)}`,
      after: {
        videoId,
        captionId: track.id,
        trackKind: track.trackKind,
        status: api?.status,
        reason: api?.reason,
        message: api?.message ?? String(error),
        tracks: tracks.map((t) => ({ kind: t.trackKind, lang: t.language, status: t.status })),
      },
    });
    throw new CaptionRetrievalError(
      `captions.download returned ${api?.status ?? "an error"}${api?.reason ? ` (${api.reason})` : ""}: ${api?.message ?? String(error)}`,
      { status: api?.status, reason: api?.reason, tracks },
    );
  }

  return storeTranscript({
    episodeId,
    source: track.trackKind === "asr" ? "YOUTUBE_ASR" : "YOUTUBE_MANUAL",
    provider: "youtube.captions.download",
    language: track.language,
    raw,
    sourceExternalId: track.id,
    generatedAt: track.lastUpdated ? new Date(track.lastUpdated) : null,
    actor,
  });
}

export async function latestTranscript(episodeId: string) {
  const [transcript] = await db
    .select()
    .from(episodeTranscripts)
    .where(eq(episodeTranscripts.episodeId, episodeId))
    .orderBy(desc(episodeTranscripts.createdAt))
    .limit(1);
  if (!transcript) return null;

  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.transcriptId, transcript.id))
    .orderBy(transcriptSegments.ordinal);

  return { transcript, segments };
}
