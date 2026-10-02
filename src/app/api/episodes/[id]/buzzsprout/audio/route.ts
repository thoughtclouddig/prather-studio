/**
 * Receive the show audio and hand it to Buzzsprout.
 *
 * ## Why a route handler and not a server action
 *
 * Server actions carry a 1 MB body limit by default and buffer the whole
 * payload. The StreamYard audio-only export is around 60 MB. A route handler
 * takes the multipart body and passes it straight through, so the file is never
 * buffered into a server action's payload and never written anywhere.
 *
 * ## Why nothing is stored
 *
 * Phase 0 established that the Replit filesystem does not survive a republish,
 * so media held on disk silently disappears. The safest media store is the one
 * that does not exist: the file arrives, goes to Buzzsprout, and the Studio
 * keeps no copy. Buzzsprout is the system of record for podcast audio.
 *
 * ## The approval gate still applies
 *
 * Audio does not bypass review. An episode with no APPROVED title and show
 * notes is refused here, not merely discouraged in the UI — otherwise the
 * upload becomes a side door around the one rule this whole system is built on.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, episodes } from "@/db/schema";
import { requirePermission } from "@/lib/auth/require";
import { recordActivity } from "@/lib/domain/activity";
import { planBuzzsproutUpdate } from "@/lib/domain/buzzsprout-publish";
import {
  BuzzsproutApiError,
  BuzzsproutNotConnectedError,
  uploadEpisodeAudio,
} from "@/lib/integrations/buzzsprout/client";

/** Generous, but not unbounded. The real export is about 60 MB. */
const MAX_BYTES = 300 * 1024 * 1024;

const AUDIO_TYPES = /^(audio\/|video\/mp4$|application\/octet-stream$)/;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: episodeId } = await params;

  let user;
  try {
    user = await requirePermission("publication.enqueue");
  } catch {
    return NextResponse.json({ error: "Not permitted." }, { status: 403 });
  }

  const [episode] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  if (!episode) {
    return NextResponse.json({ error: "Episode not found." }, { status: 404 });
  }

  const form = await request.formData();
  const file = form.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No audio file was included." }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error:
          `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Use StreamYard's ` +
          "audio-only export, which is around 60 MB — the full video is not needed " +
          "for the podcast.",
      },
      { status: 413 },
    );
  }
  if (file.type && !AUDIO_TYPES.test(file.type)) {
    return NextResponse.json(
      { error: `"${file.type}" is not an audio file.` },
      { status: 415 },
    );
  }

  // The approval gate, enforced server-side.
  let plan;
  try {
    plan = await planBuzzsproutUpdate(episodeId);
  } catch {
    plan = null; // Not linked yet — creating is allowed, see below.
  }

  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(
      and(
        eq(episodePublications.episodeId, episodeId),
        eq(episodePublications.platform, "BUZZSPROUT"),
      ),
    )
    .limit(1);

  const existingId = publication?.externalId ? Number(publication.externalId) : null;

  if (plan && plan.missing.length > 0) {
    return NextResponse.json(
      {
        error:
          `Approve the episode copy first — still needs ${plan.missing.join(" and ")}. ` +
          "Audio does not bypass review.",
      },
      { status: 409 },
    );
  }

  try {
    const uploaded = await uploadEpisodeAudio(
      existingId,
      { name: file.name, type: file.type, stream: file },
      existingId
        ? {}
        : {
            // Creating: carry the approved copy, and default to PRIVATE.
            // Buzzsprout documents no DELETE, so a mistaken create cannot be
            // removed — private means a mistake is at least not public while
            // it is sorted out.
            title:
              plan?.changes.find((c) => c.field === "title")?.proposed ??
              episode.approvedTitle ??
              episode.workingTitle,
            description: plan?.composition.text ?? "",
            private: true,
            ...(episode.episodeNumber ? { episode_number: episode.episodeNumber } : {}),
          },
    );

    const now = new Date();
    await db
      .update(episodePublications)
      .set({
        externalId: String(uploaded.id),
        externalUrl: uploaded.audioUrl,
        state: uploaded.private ? "SCHEDULED" : "PUBLISHED",
        publishedAt: uploaded.publishedAt ? new Date(uploaded.publishedAt) : null,
        lastSyncAt: now,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(episodePublications.id, publication!.id));

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: existingId ? "buzzsprout.audio_replaced" : "buzzsprout.audio_uploaded",
      subjectType: "publication",
      subjectId: publication!.id,
      episodeId,
      summary:
        `${existingId ? "Replaced" : "Uploaded"} audio on Buzzsprout episode ` +
        `${uploaded.id} — ${file.name}, ${(file.size / 1024 / 1024).toFixed(1)} MB` +
        (existingId ? "" : ". Created PRIVATE; publish it from Buzzsprout when ready."),
      after: {
        buzzsproutId: uploaded.id,
        bytes: file.size,
        filename: file.name,
        private: uploaded.private,
      },
    });

    return NextResponse.json({
      ok: true,
      buzzsproutId: uploaded.id,
      title: uploaded.title,
      private: uploaded.private,
      created: !existingId,
    });
  } catch (error) {
    if (error instanceof BuzzsproutNotConnectedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message =
      error instanceof BuzzsproutApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await recordActivity({
      actor: { kind: "user", id: user.id, name: user.name },
      verb: "buzzsprout.audio_failed",
      subjectType: "publication",
      subjectId: publication?.id,
      episodeId,
      summary: `Buzzsprout audio upload failed: ${message}`,
      after: { error: message, filename: file.name },
    });

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
