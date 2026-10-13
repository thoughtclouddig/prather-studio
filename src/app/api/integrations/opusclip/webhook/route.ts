/**
 * OpusClip's callback.
 *
 * Public by necessity — OpusClip has to reach it — so the signature is the
 * only thing distinguishing a real callback from anyone who found the URL.
 *
 * The route does as little as possible: verify, record, enqueue. Fetching the
 * clips happens in a job, because an HTTP handler that calls another API is a
 * handler that times out, and OpusClip will retry a callback it thinks failed.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications } from "@/db/schema";
import { readCredential } from "@/lib/integrations/credentials";
import {
  parseWebhook,
  verifyWebhook,
} from "@/lib/integrations/opusclip/webhook";
import type { OpusCredentialPayload } from "@/lib/integrations/opusclip/client";
import { enqueue } from "@/lib/queue/queue";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Raw bytes, before any parsing: re-serialising changes key order and
  // whitespace, and the signature then never matches.
  const body = await request.text();

  const stored = await readCredential<OpusCredentialPayload>("OPUSCLIP");
  const secret = stored?.payload.signingSecret?.trim() ?? "";

  const result = verifyWebhook({
    body,
    signature: request.headers.get("x-opus-signature"),
    salt: request.headers.get("x-opus-salt"),
    timestamp: request.headers.get("x-opus-timestamp"),
    secret,
  });

  if (!result.ok) {
    // 401 and nothing else. A detailed rejection tells an attacker which part
    // of their forgery was wrong; the reason is for our logs.
    console.warn("[opusclip] rejected webhook:", result.reason);
    return new Response("unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const event = parseWebhook(payload);
  if (!event.projectId) {
    return new Response("ok", { status: 200 });
  }

  const [publication] = await db
    .select()
    .from(episodePublications)
    .where(eq(episodePublications.externalId, event.projectId))
    .limit(1);

  if (!publication) {
    // Not ours, or the project row was deleted. 200 so OpusClip stops
    // retrying something we will never be able to act on.
    console.warn("[opusclip] no episode for project", event.projectId);
    return new Response("ok", { status: 200 });
  }

  // The salt is unique per request, so keying the job on it makes a replayed
  // callback a no-op without needing a separate store of seen salts.
  const saltKey = createHash("sha256").update(result.salt).digest("hex").slice(0, 32);

  await enqueue({
    kind: "opusclip.collect",
    idempotencyKey: `opusclip.collect:${event.projectId}:${saltKey}`,
    episodeId: publication.episodeId,
    payload: { projectId: event.projectId, stage: event.stage, failed: event.failed },
    maxAttempts: 4,
  });

  return new Response("ok", { status: 200 });
}
