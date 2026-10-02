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

/**
 * Turn whatever was configured into an origin, or return "" if it cannot be.
 *
 * The "" case is load-bearing. A real deployment pasted the entire line from
 * the documentation into the Secrets value box:
 *
 *     APP_BASE_URL = https://abc.riker.replit.dev
 *
 * so `process.env.APP_BASE_URL` held the name, the spaces and the equals sign
 * too. The old version prepended https:// to it because it did not start with
 * a scheme, and the app spent an afternoon sending Google a redirect_uri of
 * `https://APP_BASE_URL = https://abc.../callback`. Google rejected it with
 * `invalid_request` and the generic "does not comply with OAuth 2.0 policy",
 * which pointed at the consent screen, the scopes and the test users — none of
 * which were wrong.
 *
 * So: strip an accidental `NAME =` prefix, then validate. Anything that is not
 * a parseable http(s) origin is discarded rather than passed on, and the caller
 * falls through to a source that works.
 */
function normalize(value: string): string {
  let v = value.trim();
  if (!v) return "";

  // "APP_BASE_URL = https://..." or "APP_BASE_URL=https://..."
  v = v.replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/i, "").trim();

  // Surrounding quotes, which .env files invite and shells leave behind.
  v = v.replace(/^["']|["']$/g, "").trim();

  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  v = v.replace(/\/+$/, "");

  // The real guard: if it does not parse as a URL with a host, it is not an
  // origin, and sending it anywhere is worse than falling back.
  try {
    const url = new URL(v);
    if (!url.hostname || url.hostname.includes(" ")) return "";
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export function appBaseUrl(): string {
  const explicit = normalize(process.env.APP_BASE_URL ?? "");
  if (explicit) return explicit;

  // Replit provides the host. Deriving it means a workspace works immediately
  // and cannot drift from the domain the platform actually serves.
  const replit = process.env.REPLIT_DOMAINS ?? process.env.REPLIT_DEV_DOMAIN;
  if (replit?.trim()) {
    const first = normalize(replit.split(",")[0] ?? "");
    if (first) return first;
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
