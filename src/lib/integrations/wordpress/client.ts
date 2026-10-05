/**
 * WordPress REST API client.
 *
 * ## Why an Application Password and not a plugin
 *
 * `GET https://jeffreyprather.com/wp-json/` advertises:
 *
 *     "authentication": { "application-passwords": { … } }
 *
 * Application Passwords are native to WordPress since 5.6. They authenticate
 * over HTTP Basic, are revocable on their own, and are NOT the account's login
 * password — so a leak costs one credential rather than the site. No JWT
 * plugin, no OAuth plugin, nothing new installed on a site already carrying
 * Elementor, Jetpack, WooCommerce, Yoast and a WP Engine cache plugin.
 *
 * ## What this writes, and what it refuses to
 *
 * Posts are created as **drafts**. The Studio never publishes to the public
 * site on its own — the same rule as every other platform, and the one that
 * matters most here because jeffreyprather.com is the public face.
 *
 * ## The host is part of the credential
 *
 * The site URL is stored with the username and password rather than taken from
 * configuration, because a credential that works against one host is worthless
 * and dangerous against another. Pointing a stored password at a different site
 * is how you end up authenticating somewhere you did not mean to.
 */
import "server-only";
import { readCredential } from "@/lib/integrations/credentials";

export interface WordPressCredentialPayload {
  /** Origin only, no trailing slash, e.g. https://jeffreyprather.com */
  siteUrl: string;
  username: string;
  /** The Application Password. Spaces are significant to WordPress; keep them. */
  applicationPassword: string;
}

export class WordPressApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "WordPressApiError";
  }
}

export class WordPressNotConnectedError extends Error {
  constructor() {
    super("WordPress is not connected. Add the Application Password in Integrations.");
    this.name = "WordPressNotConnectedError";
  }
}

export interface WordPressIdentity {
  id: number;
  name: string;
  slug: string;
  /** Capabilities matter: a user who cannot publish cannot create a draft. */
  canEditPosts: boolean;
  canUploadFiles: boolean;
  siteName: string | null;
}

function authHeader(c: WordPressCredentialPayload): string {
  // WordPress prints Application Passwords in groups separated by spaces. Those
  // spaces are part of the secret in the UI but WordPress accepts them either
  // way; stripping them avoids a copy-paste that includes a trailing space.
  const password = c.applicationPassword.trim();
  return `Basic ${Buffer.from(`${c.username.trim()}:${password}`).toString("base64")}`;
}

async function credential(): Promise<WordPressCredentialPayload> {
  const stored = await readCredential<WordPressCredentialPayload>("WORDPRESS");
  if (!stored) throw new WordPressNotConnectedError();
  return stored.payload;
}

async function call<T>(
  path: string,
  c: WordPressCredentialPayload,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const res = await fetch(`${c.siteUrl}/wp-json${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: authHeader(c),
      accept: "application/json",
      ...(init.body && !init.headers ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    ...(init.body
      ? { body: init.headers ? (init.body as BodyInit) : JSON.stringify(init.body) }
      : {}),
    cache: "no-store",
  });

  const text = await res.text();
  if (!res.ok) {
    // WordPress returns a JSON error with a `code` worth surfacing: the
    // difference between a wrong password and a user without permission is
    // the difference between retyping and changing a role.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { code?: string; message?: string };
      if (parsed.message) detail = parsed.message;
      if (parsed.code === "incorrect_password" || res.status === 401) {
        throw new WordPressApiError(
          res.status,
          detail,
          "WordPress rejected the username or Application Password.",
        );
      }
      if (res.status === 403) {
        throw new WordPressApiError(
          res.status,
          detail,
          `That WordPress user is not permitted to do this: ${detail}`,
        );
      }
    } catch (error) {
      if (error instanceof WordPressApiError) throw error;
    }
    throw new WordPressApiError(res.status, detail, `WordPress returned ${res.status}.`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Verify a credential and report what it can actually do.
 *
 * Checks capabilities rather than just authentication, because a credential
 * that signs in but cannot upload media would fail later, at the moment an
 * episode is being published, which is the worst time to discover it.
 */
export async function verifyCredentials(
  c: WordPressCredentialPayload,
): Promise<WordPressIdentity> {
  const me = await call<{
    id: number;
    name: string;
    slug: string;
    capabilities?: Record<string, boolean>;
  }>("/wp/v2/users/me?context=edit", c);

  const caps = me.capabilities ?? {};

  // The site name is public and unauthenticated; a failure here is cosmetic.
  let siteName: string | null = null;
  try {
    const root = await fetch(`${c.siteUrl}/wp-json/`, { cache: "no-store" });
    if (root.ok) siteName = ((await root.json()) as { name?: string }).name ?? null;
  } catch {
    /* cosmetic only */
  }

  return {
    id: me.id,
    name: me.name,
    slug: me.slug,
    canEditPosts: caps["edit_posts"] === true,
    canUploadFiles: caps["upload_files"] === true,
    siteName,
  };
}

/** Normalise whatever was typed into an origin. */
export function normalizeSiteUrl(raw: string): string {
  let v = raw.trim().replace(/^[A-Z_][A-Z0-9_]*\s*=\s*/i, "");
  if (!v) return "";
  if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
  try {
    const url = new URL(v);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

export interface WordPressPost {
  id: number;
  link: string;
  status: string;
  title: string;
}

/**
 * Create a post. Always a draft.
 *
 * `status` is not a parameter on purpose. The public site is the one place
 * where an accidental publish is immediately visible to the audience, so the
 * decision to publish stays in WordPress with a human.
 */
export async function createDraftPost(fields: {
  title: string;
  content: string;
  excerpt?: string;
  featuredMediaId?: number;
  slug?: string;
}): Promise<WordPressPost> {
  const c = await credential();
  const data = await call<Record<string, unknown>>("/wp/v2/posts", c, {
    method: "POST",
    body: {
      title: fields.title,
      content: fields.content,
      status: "draft",
      ...(fields.excerpt ? { excerpt: fields.excerpt } : {}),
      ...(fields.featuredMediaId ? { featured_media: fields.featuredMediaId } : {}),
      ...(fields.slug ? { slug: fields.slug } : {}),
    },
  });
  return {
    id: Number(data["id"]),
    link: String(data["link"] ?? ""),
    status: String(data["status"] ?? ""),
    title: String((data["title"] as { raw?: string })?.raw ?? fields.title),
  };
}

/** Upload an image and return its media id, for use as a featured image. */
export async function uploadMedia(
  file: Blob,
  filename: string,
  contentType: string,
): Promise<{ id: number; sourceUrl: string }> {
  const c = await credential();
  const data = await call<Record<string, unknown>>("/wp/v2/media", c, {
    method: "POST",
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename}"`,
    },
    body: file,
  });
  return { id: Number(data["id"]), sourceUrl: String(data["source_url"] ?? "") };
}
