import { describe, expect, it } from "vitest";
import { buildThumbnailBrief, slugFor } from "@/lib/images/thumbnail-brief";

const HEADLINE = "Iraq Israeli False Flag War Just Ended. Did Another Just Begin?";

describe("the brief is the operator's text", () => {
  /**
   * This text is tuned against a ChatGPT thread that responds to it. An edit
   * that reads better in isolation can quietly change what comes back, so the
   * wording is pinned by tests rather than left to taste.
   */
  it("carries the exact lines the working brief depends on", () => {
    const brief = buildThumbnailBrief({ headline: HEADLINE, slug: "x" });
    for (const line of [
      "Create TWO separate image files",
      "Exactly 1920 × 1080 pixels, 16:9",
      "Exactly 1024 × 1024 pixels",
      "The Prather Point logo in the upper-left",
      '"FREEDOM IS TAKEN"',
      "condensed, distressed, bold uppercase typography",
      "Do not change or paraphrase the supplied headline",
      "Spell every word correctly",
      "theatrical political thriller/documentary poster",
      "CONSISTENCY RULE",
      "Return them as TWO SEPARATE image files",
    ]) {
      expect(brief, `missing: ${line}`).toContain(line);
    }
  });

  it("puts the headline in both the topic and headline slots", () => {
    const brief = buildThumbnailBrief({ headline: HEADLINE, slug: "x" });
    expect(brief).toContain(`EPISODE TOPIC:\n**${HEADLINE}**`);
    expect(brief).toContain(`HEADLINE:\n**${HEADLINE}**`);
  });

  it("keeps every prohibition on the square", () => {
    const brief = buildThumbnailBrief({ headline: HEADLINE, slug: "x" });
    for (const line of [
      "• NO headline.",
      "• NO typography.",
      "• NO Prather Point logo.",
      "• NO tagline.",
      "• NO additional text anywhere.",
    ]) {
      expect(brief).toContain(line);
    }
  });

  it("names the two output files from the slug", () => {
    const brief = buildThumbnailBrief({ headline: HEADLINE, slug: "iraq-false-flag" });
    expect(brief).toContain("iraq-false-flag-1920x1080.png");
    expect(brief).toContain("iraq-false-flag-1024x1024.png");
  });
});

describe("slugs", () => {
  it("makes a filename-safe slug", () => {
    expect(slugFor("Iraq Israeli False Flag War Just Ended!")).toBe(
      "iraq-israeli-false-flag-war-just-ended",
    );
  });

  it("drops apostrophes rather than turning them into hyphens", () => {
    expect(slugFor("Ukraine's Spies")).toBe("ukraines-spies");
  });

  it("never ends in a hyphen, even when truncated", () => {
    expect(slugFor("a ".repeat(60))).not.toMatch(/-$/);
  });

  it("falls back rather than returning an empty string", () => {
    expect(slugFor("!!!")).toBe("episode");
  });
});
