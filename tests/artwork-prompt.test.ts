import { describe, expect, it } from "vitest";
import { buildArtworkPrompt } from "@/lib/images/artwork-prompt";

const base = { headline: "Iraq Israeli False Flag War Just Ended", aspect: "16:9" } as const;

describe("the no-text rule", () => {
  /**
   * The working hand-written prompt contained "Spell every word correctly",
   * which existed because image models misspell. We removed the problem rather
   * than the symptom: the model paints, the Studio sets type.
   */
  it("forbids text in every variant", () => {
    for (const aspect of ["16:9", "1:1"] as const) {
      for (const guest of [null, "Mike Adams"]) {
        const p = buildArtworkPrompt({ ...base, aspect, guestName: guest });
        expect(p).toMatch(/NO TEXT OF ANY KIND/i);
        expect(p).toMatch(/no logo/i);
        expect(p).toMatch(/no watermark/i);
      }
    }
  });

  it("never asks the model to render the headline", () => {
    const p = buildArtworkPrompt(base);
    // The headline informs the scene, but must not be given as copy to set.
    expect(p).not.toMatch(/render the headline|headline typography|set the headline/i);
  });
});

describe("who appears", () => {
  /** Jeff is never in a thumbnail — only guests are. */
  it("depicts nobody when there is no guest", () => {
    const p = buildArtworkPrompt(base);
    expect(p).toMatch(/no guest/i);
    expect(p).toMatch(/not depict any identifiable real person/i);
  });

  it("uses the reference photo when one was uploaded", () => {
    const p = buildArtworkPrompt({ ...base, guestName: "Mike Adams", hasGuestPhoto: true });
    expect(p).toMatch(/reference photograph/i);
    expect(p).toMatch(/same face/i);
  });

  /**
   * A named guest with no photo must NOT be invented. A wrong likeness of a
   * real person is worse than no likeness.
   */
  it("refuses to invent a likeness when no photo was supplied", () => {
    const p = buildArtworkPrompt({ ...base, guestName: "Mike Adams", hasGuestPhoto: false });
    expect(p).toMatch(/do NOT attempt to depict them/i);
    expect(p).toMatch(/invented likeness/i);
  });
});

describe("composition", () => {
  /** The left third stays quiet because the headline lands there. */
  it("reserves the left of the 16:9 frame for type", () => {
    const p = buildArtworkPrompt({ ...base, aspect: "16:9" });
    expect(p).toMatch(/LEFT 40-45%/);
    expect(p).toMatch(/visually calm/i);
  });

  it("asks the square to be recomposed rather than cropped", () => {
    const p = buildArtworkPrompt({ ...base, aspect: "1:1" });
    expect(p).toMatch(/rather than cropping/i);
  });

  it("carries the operator's regeneration note", () => {
    const p = buildArtworkPrompt({ ...base, note: "darker, lose the flag" });
    expect(p).toContain("darker, lose the flag");
  });

  it("includes the headline as subject matter", () => {
    expect(buildArtworkPrompt(base)).toContain(base.headline);
  });
});
