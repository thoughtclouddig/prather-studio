/**
 * Composing and creating the episode post on jeffreyprather.com.
 *
 * ## What goes in it
 *
 * The Rumble player, the approved editorial copy, the chapters, and the links
 * out. The 1:1 thumbnail becomes the featured image — that was the operator's
 * stated choice, and it is the right one: the square survives the theme's
 * cropping at every size the archive renders it.
 *
 * ## Why the embed comes from oEmbed
 *
 * Rumble's page slug and its embed id are DIFFERENT strings. The Oct 1 episode
 * lives at `/v7g8rbk-iraq-israeli-false-flag-war….html` but its player is
 * `/embed/v7e2ee2/`. Building an iframe from the page URL — the obvious
 * shortcut — produces a dead embed that looks fine in the editor and plays
 * nothing on the page. So the embed HTML is fetched from Rumble's oEmbed
 * endpoint and used verbatim.
 *
 * ## Why the post is always a draft
 *
 * The public site is the one surface where a mistake is immediately visible to
 * the audience. `createDraftPost` takes no status parameter at all — it cannot
 * publish, by construction rather than by default.
 */
import "server-only";

const OEMBED = "https://rumble.com/api/Media/oembed.json";

export interface RumbleEmbed {
  html: string;
  title: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
}

export class RumbleEmbedError extends Error {}

/**
 * Resolve a Rumble page URL to its player embed.
 *
 * Also returns the duration, which is the cheapest guard against the wrong link
 * being pasted: a Prather Point broadcast runs 70-90 minutes, and a two-minute
 * clip pasted by accident is caught before it reaches a post.
 */
export async function resolveRumbleEmbed(pageUrl: string): Promise<RumbleEmbed> {
  const clean = pageUrl.trim().split("?")[0] ?? "";
  if (!/^https?:\/\/(www\.)?rumble\.com\//i.test(clean)) {
    throw new RumbleEmbedError("That is not a rumble.com video URL.");
  }

  const res = await fetch(`${OEMBED}?url=${encodeURIComponent(clean)}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new RumbleEmbedError(
      res.status === 404
        ? "Rumble does not recognise that URL. Check it is the video page, not a channel or a search."
        : `Rumble returned ${res.status} for that URL.`,
    );
  }

  const body = (await res.json()) as {
    html?: string;
    title?: string;
    duration?: number;
    thumbnail_url?: string;
  };

  if (!body.html) {
    throw new RumbleEmbedError("Rumble returned no embed for that URL.");
  }

  return {
    html: body.html,
    title: body.title ?? "",
    durationSeconds: typeof body.duration === "number" ? body.duration : null,
    thumbnailUrl: body.thumbnail_url ?? null,
  };
}

/** Within this many seconds, the Rumble video is the same broadcast. */
const DURATION_TOLERANCE = 180;

export function checkDuration(
  rumbleSeconds: number | null,
  broadcastSeconds: number | null,
): string | null {
  if (rumbleSeconds == null || broadcastSeconds == null) return null;
  const difference = Math.abs(rumbleSeconds - broadcastSeconds);
  if (difference <= DURATION_TOLERANCE) return null;
  return (
    `That Rumble video runs ${Math.round(rumbleSeconds / 60)} minutes, but the broadcast ` +
    `is ${Math.round(broadcastSeconds / 60)}. It may be a clip or a different episode.`
  );
}

export interface PostParts {
  embedHtml: string | null;
  summary: string | null;
  chapters: string | null;
  youtubeUrl: string | null;
  podcastUrl: string | null;
  standingBlocks: string | null;
}

/**
 * Build the post body.
 *
 * Plain HTML rather than Gutenberg blocks: the site runs Elementor, the
 * classic editor accepts this unchanged, and block markup would be one more
 * thing to keep in step with a theme we do not control.
 */
export function composePostBody(parts: PostParts): string {
  const sections: string[] = [];

  if (parts.embedHtml) {
    sections.push(
      `<figure class="wp-block-embed is-type-video">${parts.embedHtml}</figure>`,
    );
  }

  if (parts.summary) {
    for (const paragraph of parts.summary.split(/\n{2,}/)) {
      const text = paragraph.trim();
      if (text) sections.push(`<p>${escapeHtml(text)}</p>`);
    }
  }

  if (parts.chapters) {
    const items = parts.chapters
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("");
    if (items) {
      sections.push(`<h2>Chapters</h2>`, `<ul>${items}</ul>`);
    }
  }

  const links: string[] = [];
  if (parts.youtubeUrl) {
    links.push(`<a href="${parts.youtubeUrl}">Watch on YouTube</a>`);
  }
  if (parts.podcastUrl) {
    links.push(`<a href="${parts.podcastUrl}">Listen to the podcast</a>`);
  }
  if (links.length > 0) {
    sections.push(`<p>${links.join(" &middot; ")}</p>`);
  }

  // Standing blocks are already composed HTML-safe copy from Settings; they are
  // the one part an operator authored directly, so they are not re-escaped.
  if (parts.standingBlocks) {
    sections.push(parts.standingBlocks);
  }

  return sections.join("\n\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
