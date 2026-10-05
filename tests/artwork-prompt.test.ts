import { describe, expect, it } from "vitest";
import { buildMasterPrompt, buildSquarePrompt } from "@/lib/images/artwork-prompt";

const base = { headline: "Mike Adams on Data Center Dangers!" };

describe("the master prompt", () => {
  /**
   * The headline is rendered BY the model, exactly as supplied. An earlier
   * version stripped the typography instructions and composited type instead;
   * the result had none of the distressed weight the real thumbnails carry, so
   * the working prompt was restored.
   */
  it("carries the headline verbatim and forbids paraphrase", () => {
    const p = buildMasterPrompt(base);
    expect(p).toContain(base.headline);
    expect(p).toMatch(/Do not change or paraphrase the supplied headline/i);
    expect(p).toMatch(/Spell every word correctly/i);
  });

  it("asks for the logo, tagline and the house style", () => {
    const p = buildMasterPrompt(base);
    expect(p).toMatch(/Prather Point logo in the upper-left/i);
    expect(p).toContain("FREEDOM IS TAKEN");
    expect(p).toMatch(/distressed/i);
    expect(p).toMatch(/theatrical political thriller/i);
  });

  it("tells the model to reproduce a supplied logo rather than redraw it", () => {
    const p = buildMasterPrompt({ ...base, hasLogoReference: true });
    expect(p).toMatch(/do not redraw, restyle or re-letter/i);
  });
});

describe("the square companion", () => {
  it("forbids text of any kind", () => {
    const p = buildSquarePrompt(base);
    expect(p).toMatch(/NO headline/);
    expect(p).toMatch(/NO typography/);
    expect(p).toMatch(/NO logo/);
    expect(p).toMatch(/No letters, no numbers/i);
  });

  it("requires the same artwork, recomposed rather than cropped", () => {
    const p = buildSquarePrompt(base);
    expect(p).toMatch(/SAME subjects/);
    expect(p).toMatch(/rather than simply cropping/i);
  });
});

describe("who appears", () => {
  /** Jeff is never depicted — only guests are. */
  it("depicts nobody when there is no guest", () => {
    for (const p of [buildMasterPrompt(base), buildSquarePrompt(base)]) {
      expect(p).toMatch(/not depict any identifiable real person/i);
    }
  });

  it("uses the reference photograph when one was uploaded", () => {
    const p = buildMasterPrompt({ ...base, guestName: "Mike Adams", hasGuestPhoto: true });
    expect(p).toMatch(/reference photograph/i);
    expect(p).toMatch(/same face/i);
  });

  /** A wrong likeness of a real person is worse than no likeness. */
  it("refuses to invent a likeness when no photo was supplied", () => {
    const p = buildMasterPrompt({ ...base, guestName: "Mike Adams", hasGuestPhoto: false });
    expect(p).toMatch(/Do NOT invent their likeness/i);
  });

  it("carries a regeneration note into both prompts", () => {
    for (const build of [buildMasterPrompt, buildSquarePrompt]) {
      expect(build({ ...base, note: "darker, lose the flag" })).toContain("darker, lose the flag");
    }
  });
});

/**
 * The gap between the API output and the weekly ChatGPT output was not the
 * prose — it was that ChatGPT has previous thumbnails in the conversation and
 * mirrors them. An example of a style is a far stronger signal than a
 * description of one.
 */
describe("the style reference", () => {
  const base = { headline: "Mike Adams on Data Center Dangers!" };

  it("tells the model to match the reference's style", () => {
    const p = buildMasterPrompt({ ...base, hasStyleReference: true });
    expect(p).toMatch(/STYLE REFERENCE/);
    expect(p).toMatch(/same typographic treatment/i);
    expect(p).toMatch(/same logo placement/i);
  });

  /** Mirroring the style must not mean reusing the subject or the headline. */
  it("forbids copying the reference's subject or text", () => {
    const p = buildMasterPrompt({ ...base, hasStyleReference: true });
    expect(p).toMatch(/Do NOT copy its subject matter, its headline text or its people/i);
  });

  it("asks the square to match the grade but not the typography", () => {
    const p = buildSquarePrompt({ ...base, hasStyleReference: true });
    expect(p).toMatch(/NOT its typography/i);
    expect(p).toMatch(/no text at all/i);
  });

  it("says nothing about a reference when none is supplied", () => {
    expect(buildMasterPrompt(base)).not.toMatch(/STYLE REFERENCE/);
  });
});
