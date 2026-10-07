/**
 * Rumble video URLs, and the two shapes they come in.
 *
 * Rumble has a PAGE and an EMBED, they use different ids, and neither can be
 * derived from the other:
 *
 *   page   https://rumble.com/v7g8rbk-iraq-israeli-false-flag-war….html
 *   embed  https://rumble.com/embed/v7e2ee2/
 *
 * The page is where a person reads comments and subscribes. The embed is the
 * bare player, meant for an iframe. Both are legitimate; they are just not
 * interchangeable, and putting one where the other belongs fails quietly —
 * an embed URL in a post renders a dead player, and a page URL in an iframe
 * renders a whole web page inside the article.
 *
 * ## The missing `v`
 *
 * An embed id begins with `v`. A stored URL of `/embed/7eamjw/` 404s while
 * `/embed/v7eamjw/` serves the video — the same id with its prefix intact.
 * That single character is easy to lose when an id is copied out of a longer
 * string, so it is restored here rather than left to 404 in front of an
 * operator.
 *
 * ## What cannot be done
 *
 * An embed URL cannot be turned into its page URL. Rumble's oEmbed accepts
 * either and returns the title, the channel, the duration and the player
 * markup — but never the page address. So when all we have is an embed, the
 * honest thing is to say so and link to the player, not to invent a page
 * link that will 404.
 */

export type RumbleUrl =
  | { kind: "page"; url: string }
  | { kind: "embed"; url: string; embedId: string }
  | { kind: "unknown"; url: string };

const EMBED = /^\/embed\/([A-Za-z0-9]+)\/?$/i;

/**
 * Normalise a stored Rumble URL, repairing an embed id that lost its `v`.
 *
 * Page URLs are returned untouched: their slug is opaque and reconstructing
 * one is exactly the guess that produces a dead link.
 */
export function normalizeRumbleVideoUrl(raw: string | null | undefined): RumbleUrl | null {
  const value = raw?.trim();
  if (!value) return null;

  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { kind: "unknown", url: value };
  }

  if (!/(^|\.)rumble\.com$/i.test(parsed.hostname)) {
    return { kind: "unknown", url: parsed.toString() };
  }

  const embed = EMBED.exec(parsed.pathname);
  if (embed) {
    const raw_id = embed[1]!;
    // Every embed id starts with `v`; one that does not has lost it in a copy.
    const embedId = /^v/i.test(raw_id) ? raw_id : `v${raw_id}`;
    return {
      kind: "embed",
      url: `https://rumble.com/embed/${embedId}/`,
      embedId,
    };
  }

  // A video page: /v<id>-<slug>.html
  if (/^\/v[a-z0-9]+-/i.test(parsed.pathname)) {
    return { kind: "page", url: `${parsed.origin}${parsed.pathname}` };
  }

  return { kind: "unknown", url: parsed.toString() };
}

/** What to call the link, so nobody expects a page and gets a bare player. */
export function rumbleLinkLabel(link: RumbleUrl): string {
  switch (link.kind) {
    case "page":
      return "Open on Rumble";
    case "embed":
      return "Open the player";
    case "unknown":
      return "Open the link";
  }
}
