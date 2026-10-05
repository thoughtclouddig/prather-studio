/**
 * Serve a stored episode image.
 *
 * The bytes live in Postgres, so they need a route to be viewable. Behind the
 * session: thumbnails are unreleased editorial material until the episode
 * ships, and an unguarded image URL is a link anyone can forward.
 *
 * Cached privately and immutably — the id addresses one row whose bytes never
 * change, since a replacement is a new row rather than an edit.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeImages } from "@/db/schema";
import { requireUser } from "@/lib/auth/require";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireUser();
  const { id } = await params;

  const [image] = await db
    .select()
    .from(episodeImages)
    .where(eq(episodeImages.id, id))
    .limit(1);

  if (!image) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(image.bytes), {
    headers: {
      "content-type": image.contentType,
      "content-length": String(image.byteSize),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
