/**
 * Receive a thumbnail the operator produced in their ChatGPT thread.
 *
 * A route handler rather than a server action: server actions cap bodies at
 * 1 MB and buffer the payload, and a 1920x1080 PNG routinely exceeds that.
 *
 * Unlike the Buzzsprout audio — which is forwarded and never kept — these ARE
 * stored. The reasons differ: audio has a system of record at Buzzsprout, while
 * a thumbnail has to be sent to three different places (YouTube, the podcast,
 * WordPress) at three different moments, and re-requesting it from the operator
 * each time would be absurd. Phase 0 sanctioned Postgres for exactly this.
 *
 * The file is checked and re-encoded before it is stored:
 *
 *  · The 16:9 is fitted to exactly 1920x1080 and encoded as the smallest clean
 *    JPEG. YouTube rejects anything over 2 MB, and a PNG from the generator
 *    routinely exceeds it — so an unprocessed upload would be accepted here and
 *    rejected later, at the moment it mattered.
 *  · The square is fitted to 1024x1024.
 *
 * Attempts SUPERSEDE rather than replace. "Re-run the graphic if it doesn't
 * look right" was a stated requirement, and an operator who prefers the
 * previous one needs it to still exist.
 */
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeImages, episodes, type EpisodeImageKind } from "@/db/schema";
import { requirePermission } from "@/lib/auth/require";
import { recordActivity } from "@/lib/domain/activity";
import { describe, fitMaster, fitSquare } from "@/lib/images/fit";

const MAX_UPLOAD = 40 * 1024 * 1024;
const ACCEPTED = /^image\/(png|jpeg|webp)$/;

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
  const kind = String(form.get("kind") ?? "") as EpisodeImageKind;
  const file = form.get("image");

  if (kind !== "THUMBNAIL_16_9" && kind !== "THUMBNAIL_1_1" && kind !== "GUEST_PHOTO") {
    return NextResponse.json({ error: `Unknown image kind "${kind}".` }, { status: 400 });
  }
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "No image was included." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD) {
    return NextResponse.json(
      { error: `That file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is 40 MB.` },
      { status: 413 },
    );
  }
  if (file.type && !ACCEPTED.test(file.type)) {
    return NextResponse.json(
      { error: `"${file.type}" is not a PNG, JPEG or WebP.` },
      { status: 415 },
    );
  }

  const incoming = Buffer.from(await file.arrayBuffer());

  let stored: { bytes: Buffer; contentType: string; width: number; height: number };
  try {
    if (kind === "THUMBNAIL_16_9") {
      const fitted = await fitMaster(incoming);
      stored = fitted;
    } else if (kind === "THUMBNAIL_1_1") {
      const fitted = await fitSquare(incoming);
      stored = fitted;
    } else {
      // A guest photo is a reference, not a deliverable — keep it as supplied.
      const meta = await describe(incoming);
      stored = {
        bytes: incoming,
        contentType: file.type || "image/png",
        width: meta.width,
        height: meta.height,
      };
    }
  } catch {
    return NextResponse.json(
      { error: "That file could not be read as an image." },
      { status: 422 },
    );
  }

  // Retire the previous attempt of this kind. Nothing is deleted.
  const retired = await db
    .update(episodeImages)
    .set({ state: "SUPERSEDED" })
    .where(
      and(
        eq(episodeImages.episodeId, episodeId),
        eq(episodeImages.kind, kind),
        eq(episodeImages.state, "ACCEPTED"),
      ),
    )
    .returning({ id: episodeImages.id });

  const [saved] = await db
    .insert(episodeImages)
    .values({
      episodeId,
      kind,
      state: "ACCEPTED",
      contentType: stored.contentType,
      bytes: stored.bytes,
      byteSize: stored.bytes.length,
      width: stored.width,
      height: stored.height,
      model: "operator-upload",
      createdBy: user.id,
    })
    .returning({ id: episodeImages.id });

  await recordActivity({
    actor: { kind: "user", id: user.id, name: user.name },
    verb: "episode.image_uploaded",
    subjectType: "episode",
    subjectId: episodeId,
    episodeId,
    summary:
      `Uploaded ${kind === "GUEST_PHOTO" ? "a guest photo" : kind.replace("THUMBNAIL_", "")} ` +
      `(${stored.width}x${stored.height}, ${Math.round(stored.bytes.length / 1024)} KB)` +
      (retired.length > 0 ? " — replaced the previous one" : ""),
    after: {
      kind,
      width: stored.width,
      height: stored.height,
      bytes: stored.bytes.length,
      originalName: file.name,
    },
  });

  return NextResponse.json({
    ok: true,
    id: saved!.id,
    kind,
    width: stored.width,
    height: stored.height,
    bytes: stored.bytes.length,
    replaced: retired.length,
  });
}
