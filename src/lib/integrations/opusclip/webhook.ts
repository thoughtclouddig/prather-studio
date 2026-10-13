/**
 * Verifying an OpusClip webhook.
 *
 * This endpoint is public — it has to be, for OpusClip to reach it — so the
 * signature is the only thing standing between a real callback and anyone who
 * knows the URL. Everything below is their documented scheme, implemented
 * literally:
 *
 *     signature = HMAC-SHA256(secretKey, body + salt)
 *
 * with `X-Opus-Signature`, `X-Opus-Salt` and `X-Opus-Timestamp`.
 *
 * Three details that are easy to get wrong and silently fatal:
 *
 *  · The body must be the RAW bytes as received. Parsing and re-serialising
 *    changes key order and whitespace, and the signature then never matches —
 *    which looks like a wrong secret rather than a mistake in the handler.
 *  · The comparison is constant-time. A `===` on a signature leaks, through
 *    timing, how much of a guess was correct.
 *  · A valid signature is not enough on its own. A captured request can be
 *    replayed for ever, so the timestamp must be fresh and the salt must not
 *    have been seen before.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a webhook may be and still be acted on. */
export const MAX_AGE_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true; salt: string }
  | { ok: false; reason: string };

export interface VerifyInput {
  /** The raw request body, exactly as received. */
  body: string;
  signature: string | null;
  salt: string | null;
  timestamp: string | null;
  secret: string;
  /** Injected so tests are not clock-dependent. */
  now?: Date;
  /** Returns true when this salt has been used before. */
  seenSalt?: (salt: string) => boolean;
}

export function verifyWebhook(input: VerifyInput): VerifyResult {
  const { body, signature, salt, timestamp, secret } = input;

  if (!signature || !salt || !timestamp) {
    return { ok: false, reason: "Missing signature, salt or timestamp header." };
  }
  if (!secret) {
    return { ok: false, reason: "No signing secret is configured for OpusClip." };
  }

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) {
    return { ok: false, reason: "Timestamp header is not a number." };
  }

  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const age = Math.abs(now - sent);
  if (age > MAX_AGE_SECONDS) {
    return {
      ok: false,
      reason: `Timestamp is ${age}s away from now; refusing anything older than ${MAX_AGE_SECONDS}s.`,
    };
  }

  const expected = createHmac("sha256", secret).update(body + salt).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.trim().toLowerCase(), "utf8");
  // timingSafeEqual throws on a length mismatch, which is itself a signal, so
  // the length is checked first and both paths return the same answer.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "Signature does not match." };
  }

  // Last, because a replay check is only meaningful once the request is known
  // to be genuine — otherwise anyone could exhaust the store with junk salts.
  if (input.seenSalt?.(salt)) {
    return { ok: false, reason: "This salt has been used before; refusing a replay." };
  }

  return { ok: true, salt };
}

export interface OpusWebhookEvent {
  projectId: string | null;
  stage: string | null;
  failed: boolean;
}

/**
 * Read what the callback is telling us.
 *
 * Their webhook payload is not documented beyond "a project", so this reads
 * defensively from the shapes the project representation uses and reports
 * nothing it cannot find, rather than assuming a field exists.
 */
export function parseWebhook(raw: unknown): OpusWebhookEvent {
  const body = (raw ?? {}) as Record<string, unknown>;
  const project = (body["project"] ?? body["data"] ?? body) as Record<string, unknown>;

  const projectId =
    (typeof project["projectId"] === "string" && project["projectId"]) ||
    (typeof project["id"] === "string" && project["id"]) ||
    null;

  const stage = typeof project["stage"] === "string" ? project["stage"] : null;

  return {
    projectId,
    stage,
    failed: stage === "STALLED" || typeof project["error"] === "string",
  };
}
