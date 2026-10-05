import { describe, expect, it } from "vitest";
import { layoutHeadline } from "@/lib/images/composite";

describe("headline layout", () => {
  /**
   * The first version split into equal word-counts and produced
   * "MIKE ADAMS / ON DATA / CENTER DANGERS!" — breaks landing mid-phrase,
   * which read as a mistake. Greedy wrapping to a width budget is what a
   * typesetter does.
   */
  it("breaks on width, not on equal word counts", () => {
    const { lines } = layoutHeadline("Mike Adams on Data Center Dangers!");
    // Equal word-counts produced "MIKE ADAMS / ON DATA / CENTER DANGERS!" —
    // a break landing mid-phrase, which reads as a mistake.
    expect(lines).not.toContain("ON DATA");
    expect(lines.at(-1)).toBe("DANGERS!");
  });

  /**
   * The failure this guards against is silent: an oversized line is
   * soft-wrapped by the renderer, so a layout claiming three lines renders as
   * four. It looked fine by luck once, which is worse than looking wrong.
   */
  it("never returns a line too wide for its column", () => {
    const columnWidth = 883;
    const usable = columnWidth * 0.88;
    for (const headline of [
      "Five Bases Hit",
      "Mike Adams on Data Center Dangers!",
      "Iraq Israeli False Flag War Just Ended Did Another Just Begin",
      "Supercalifragilistic Extraordinarily Unbrokenword Headline",
    ]) {
      const { lines, fontSize } = layoutHeadline(headline, columnWidth, 670);
      for (const line of lines) {
        const estimated = line.length * 0.46 * fontSize;
        expect(estimated, `"${line}" at ${fontSize}px`).toBeLessThanOrEqual(usable + 1);
      }
    }
  });

  it("uppercases and drops a trailing full stop", () => {
    const { lines } = layoutHeadline("Five bases hit.");
    expect(lines.join(" ")).toBe("FIVE BASES HIT");
  });

  /**
   * A timid headline is the difference between a poster and a caption. The
   * reference artwork makes short headlines enormous, so the wrap budget has
   * to scale — a fixed one rendered "Five Bases Hit" at the same size as a
   * sixty-character headline.
   */
  it("makes a short headline much larger than a long one", () => {
    const short = layoutHeadline("Five Bases Hit", 883, 670);
    const long = layoutHeadline(
      "Iraq Israeli False Flag War Just Ended Did Another Just Begin",
      883,
      670,
    );
    expect(short.fontSize).toBeGreaterThan(long.fontSize);
    expect(short.fontSize).toBeLessThanOrEqual(168);
    expect(long.fontSize).toBeGreaterThanOrEqual(44);
  });

  it("never returns an empty line", () => {
    for (const h of ["A", "Two Words", "  spaced   out   headline  ", "X".repeat(90)]) {
      const { lines } = layoutHeadline(h);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line.trim()).not.toBe("");
    }
  });

  it("keeps every word from the headline", () => {
    const headline = "Iraq Israeli False Flag War Just Ended Did Another Just Begin";
    const { lines } = layoutHeadline(headline);
    expect(lines.join(" ")).toBe(headline.toUpperCase());
  });
});
