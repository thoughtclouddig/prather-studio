/**
 * Composing the final platform description.
 *
 * Phase 2 shipped an AI-written description straight to YouTube and in doing so
 * removed a StreamYard affiliate link that had been in the original. The lesson
 * is not "ask the model to remember the link". A model asked to reproduce a
 * promo code and a referral URL every episode will eventually get one character
 * wrong, and nobody will notice until the sponsor does.
 *
 * So the two kinds of content are separated and only one of them is generated:
 *
 *   EDITORIAL   episode-specific, written by Claude, approved by a human
 *   STANDING    recurring business content, authored once in Settings,
 *               reproduced verbatim, never regenerated
 *
 *   FINAL = approved editorial description
 *         + approved chapters
 *         + enabled standing blocks for this platform
 *
 * Everything here is pure and deterministic: the same inputs compose to the
 * same string, byte for byte. That is a testable property and it is tested.
 *
 * Two safety properties enforced here rather than in the UI:
 *   · Only APPROVED editorial content can enter a composition. A PROPOSED
 *     draft has no path to a platform.
 *   · Standing blocks are inserted verbatim. Nothing trims, re-wraps, or
 *     "tidies" a promo code.
 */
import type { Platform, StandingBlock } from "@/db/schema";

/** Order is fixed. Editorial leads; recurring business content follows. */
const SECTION_SEPARATOR = "\n\n";

export interface CompositionInput {
  /** The approved, platform-specific editorial body. */
  editorial: string | null;
  /** The approved chapter list, already formatted "0:00 Title" per line. */
  chapters: string | null;
  /** All standing blocks for the show. Filtering happens here, not upstream. */
  standingBlocks: StandingBlock[];
  platform: Platform;
  /**
   * Chapters are a video affordance. A podcast player shows show notes, not a
   * YouTube chapter strip, so the caller says whether they belong.
   */
  includeChapters?: boolean;
  /** Heading printed above the chapter list. Platform convention differs. */
  chaptersHeading?: string;
}

export interface CompositionResult {
  /** What will actually be sent to the platform. */
  text: string;
  /** The pieces, in order, for the review preview. */
  sections: CompositionSection[];
  /** Standing blocks that were skipped, and why. Keeps the preview honest. */
  omitted: { label: string; reason: string }[];
}

export interface CompositionSection {
  kind: "EDITORIAL" | "CHAPTERS" | "STANDING";
  /** Shown as the section label in Review. */
  label: string;
  text: string;
  /** Set for STANDING sections so the operator can jump to Settings. */
  blockId?: string;
}

/**
 * Does this block belong on this platform?
 *
 * An empty or absent `platforms` array means "everywhere". That is the useful
 * default: most recurring content is platform-agnostic, and requiring every
 * block to enumerate every platform would guarantee a forgotten one.
 */
export function blockAppliesTo(block: StandingBlock, platform: Platform): boolean {
  const platforms = block.platforms ?? [];
  return platforms.length === 0 || platforms.includes(platform);
}

export function composeDescription(input: CompositionInput): CompositionResult {
  const sections: CompositionSection[] = [];
  const omitted: { label: string; reason: string }[] = [];

  if (input.editorial && input.editorial.trim()) {
    sections.push({
      kind: "EDITORIAL",
      label: "Episode description",
      text: input.editorial.trim(),
    });
  }

  const wantsChapters = input.includeChapters ?? true;
  if (wantsChapters && input.chapters && input.chapters.trim()) {
    const heading = input.chaptersHeading ?? "CHAPTERS";
    sections.push({
      kind: "CHAPTERS",
      label: "Chapters",
      text: `${heading}\n${input.chapters.trim()}`,
    });
  }

  // Deterministic order: sortOrder, then id. Never insertion or fetch order —
  // the composition must not change because a row was touched.
  const ordered = [...input.standingBlocks].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
  );

  for (const block of ordered) {
    if (!block.enabled) {
      omitted.push({ label: block.label, reason: "disabled in Settings" });
      continue;
    }
    if (!blockAppliesTo(block, input.platform)) {
      omitted.push({
        label: block.label,
        reason: `not enabled for ${input.platform}`,
      });
      continue;
    }
    if (!block.body.trim()) {
      omitted.push({ label: block.label, reason: "empty" });
      continue;
    }
    sections.push({
      kind: "STANDING",
      label: block.label,
      // Verbatim. Trailing whitespace is stripped so blocks join cleanly, but
      // nothing inside the block is altered.
      text: block.body.replace(/\s+$/, ""),
      blockId: block.id,
    });
  }

  return {
    text: sections.map((s) => s.text).join(SECTION_SEPARATOR),
    sections,
    omitted,
  };
}

/**
 * Compose from raw draft rows, enforcing the approval gate.
 *
 * `drafts` may contain anything; only APPROVED rows are readable. This is the
 * single place that decides what "approved editorial content" means, so there
 * is no second implementation to drift.
 */
export interface DraftLike {
  field: string;
  platform: Platform | null;
  value: string;
  state: string;
}

export function selectApprovedEditorial(
  drafts: DraftLike[],
  platform: Platform,
): { editorial: string | null; chapters: string | null; title: string | null } {
  const approved = drafts.filter((d) => d.state === "APPROVED");
  const pick = (field: string, forPlatform?: Platform) =>
    approved.find(
      (d) => d.field === field && (forPlatform ? d.platform === forPlatform : true),
    )?.value ?? null;

  return {
    // A platform-specific title wins over the general approved headline.
    title: pick("platform_title", platform) ?? pick("primary_headline"),
    editorial: pick("platform_description", platform),
    chapters: pick("chapters"),
  };
}

/** Platform conventions, in one place rather than scattered at call sites. */
export const PLATFORM_COMPOSITION: Record<
  string,
  { includeChapters: boolean; chaptersHeading: string }
> = {
  // YouTube parses "0:00 Title" lines in the description into a chapter strip.
  YOUTUBE: { includeChapters: true, chaptersHeading: "CHAPTERS" },
  // Podcast apps render show notes as prose. Timestamps are still useful to a
  // listener, so they stay — under a heading that reads naturally in a player.
  BUZZSPROUT: { includeChapters: true, chaptersHeading: "IN THIS EPISODE" },
};

export function compositionOptionsFor(platform: Platform) {
  return (
    PLATFORM_COMPOSITION[platform] ?? {
      includeChapters: true,
      chaptersHeading: "CHAPTERS",
    }
  );
}
