/**
 * Lifting the standing sponsor blocks out of a previous briefing.
 *
 * The sponsors and their promo codes were never in a database. They live in
 * the emails that have already gone out, which makes Mailchimp the system of
 * record for them until they are imported once.
 *
 * ## Why this proposes rather than imports
 *
 * The old emails were built in Mailchimp's own editor, so there is no schema
 * to read — only nested tables of marketing copy, where a sponsor link and a
 * "Join on Patreon" link look exactly alike. Any extraction from that is a
 * guess.
 *
 * So it guesses openly: it returns candidates with a reason, and a human ticks
 * the ones that are real before anything is written. The failure mode of a
 * confident parser here is a promo code quietly transcribed wrong and mailed
 * to the whole list, which is worse than a list that needs five seconds of
 * checking.
 */
import "server-only";

export interface SponsorCandidate {
  name: string;
  url: string | null;
  offer: string | null;
  /** Why this looked like a sponsor. Shown so the operator can judge it. */
  reason: string;
  /** Promo codes are the strongest signal; those come pre-ticked. */
  confident: boolean;
}

/** "code PRATHER", "promo code POINT15", "use coupon FREEDOM". */
const PROMO = /\b(?:promo\s+code|coupon(?:\s+code)?|code)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,19})\b/i;

/** Links that are never a sponsor, however much they look like one. */
const NOT_SPONSOR =
  /(unsubscribe|mailchi\.mp|list-manage|facebook|twitter|x\.com|instagram|youtube|rumble|patreon|locals|truthsocial|gab\.com|telegram|mailto:|tel:|\.mp4|#)/i;

const ANCHOR = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&mdash;/gi, "—")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find likely sponsors in a sent campaign.
 *
 * Two passes, because the two halves of the email fail differently. The HTML
 * carries the links but buries them in table markup; the plain text carries
 * the offer wording but loses every URL. Candidates from both are merged on
 * name.
 */
export function extractSponsors(html: string, plainText: string): SponsorCandidate[] {
  const found = new Map<string, SponsorCandidate>();

  const add = (candidate: SponsorCandidate) => {
    const key = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key || key.length < 2) return;
    const existing = found.get(key);
    if (!existing) {
      found.set(key, candidate);
      return;
    }
    // Merge: keep whichever half supplied the missing piece.
    found.set(key, {
      name: existing.name,
      url: existing.url ?? candidate.url,
      offer: existing.offer ?? candidate.offer,
      reason: existing.confident ? existing.reason : candidate.reason,
      confident: existing.confident || candidate.confident,
    });
  };

  // ---- pass 1: anchors, which is where the URLs are
  const plain = textOf(html);
  for (const match of html.matchAll(ANCHOR)) {
    const href = match[1]!.trim();
    const label = textOf(match[2]!);
    if (!label || label.length > 60) continue;
    if (NOT_SPONSOR.test(href) || NOT_SPONSOR.test(label)) continue;
    if (!/^https?:\/\//i.test(href)) continue;

    // Look at the sentence the link sits in for an offer or a code.
    const at = plain.indexOf(label);
    const around = at >= 0 ? plain.slice(Math.max(0, at - 120), at + 180) : "";
    const code = PROMO.exec(around);

    add({
      name: label.replace(/\s+/g, " ").trim(),
      url: href.split("?")[0] ?? href,
      offer: code ? code[0]!.trim() : null,
      reason: code
        ? `Linked, with "${code[0]!.trim()}" beside it`
        : "A link that is not a social or platform URL",
      confident: !!code,
    });
  }

  // ---- pass 2: promo codes in the plain text, which the HTML pass can miss
  for (const line of plainText.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.length > 200) continue;
    const code = PROMO.exec(text);
    if (!code) continue;
    if (NOT_SPONSOR.test(text)) continue;

    // The name is whatever precedes the dash, colon or the code itself.
    const before = text.slice(0, code.index).replace(/[-–—:|]+\s*$/, "").trim();
    const name = (before || text).replace(/\s+/g, " ").slice(0, 60).trim();
    if (!name || name.length < 2) continue;

    const url = /https?:\/\/[^\s<>")]+/.exec(text)?.[0] ?? null;

    add({
      name,
      url: url ? (url.split("?")[0] ?? url) : null,
      offer: code[0]!.trim(),
      reason: `Plain text carrying "${code[0]!.trim()}"`,
      confident: true,
    });
  }

  // Confident ones first — the operator reviews the strong guesses at the top
  // and the speculative ones below, rather than hunting through a flat list.
  return [...found.values()].sort((a, b) => {
    if (a.confident !== b.confident) return a.confident ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
