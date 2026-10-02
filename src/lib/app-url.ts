/**
 * Where this app is reachable from the outside.
 *
 * Used to build the YouTube OAuth redirect URI, which has to match an entry in
 * Google Console *exactly* — scheme, host, path, no trailing slash. A mismatch
 * fails at Google before the request ever reaches us, so there is nothing in
 * our logs to explain it. That makes this one of the easiest things in the
 * whole deployment to get silently wrong, and the reason it is derived rather
 * than simply read.
 *
 * Resolution order:
 *
 *  1. `APP_BASE_URL` — explicit wins, always. A custom domain or a proxy in
 *     front of the app can only be expressed this way.
 *  2. `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` — Replit sets these itself, so a
 *     workspace needs no configuration at all. `REPLIT_DOMAINS` is a
 *     comma-separated list; the first entry is the canonical one.
 *  3. `http://localhost:3000` — local development.
 *
 * Trailing slashes are stripped and a bare host is given https, because both
 * mistakes produce the same unexplainable Google error.
 */

function normalize(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function appBaseUrl(): string {
  const explicit = process.env.APP_BASE_URL;
  if (explicit?.trim()) return normalize(explicit);

  // Replit provides the host. Deriving it means a workspace works immediately
  // and cannot drift from the domain the platform actually serves.
  const replit = process.env.REPLIT_DOMAINS ?? process.env.REPLIT_DEV_DOMAIN;
  if (replit?.trim()) {
    const first = replit.split(",")[0];
    if (first?.trim()) return normalize(first);
  }

  return "http://localhost:3000";
}

/** The OAuth redirect URI. Must match Google Console exactly. */
export function youtubeRedirectUri(): string {
  return (
    process.env.YOUTUBE_REDIRECT_URI?.trim() ||
    `${appBaseUrl()}/api/integrations/youtube/callback`
  );
}
