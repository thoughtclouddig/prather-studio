import { describe, expect, it } from "vitest";
import {
  blockAppliesTo,
  compositionOptionsFor,
  composeDescription,
  selectApprovedEditorial,
} from "@/lib/domain/composition";
import type { Platform, StandingBlock } from "@/db/schema";

let n = 0;
const block = (over: Partial<StandingBlock> = {}): StandingBlock =>
  ({
    id: over.id ?? `blk-${String(++n).padStart(3, "0")}`,
    showId: "show-1",
    kind: "CTA",
    label: "Block",
    body: "Body",
    platforms: null,
    enabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as StandingBlock;

const EDITORIAL = "Jeff's read on the week.";
const CHAPTERS = "0:00 Cold open\n1:40 The drone strike";

describe("composition is deterministic", () => {
  it("produces byte-identical output from identical inputs", () => {
    const blocks = [
      block({ label: "Subscribe", body: "Subscribe at JeffreyPrather.com", sortOrder: 1 }),
      block({ label: "Sponsor", body: "Code PRATHER for 10% off", sortOrder: 2 }),
    ];
    const once = composeDescription({
      editorial: EDITORIAL,
      chapters: CHAPTERS,
      standingBlocks: blocks,
      platform: "YOUTUBE",
    });
    const twice = composeDescription({
      editorial: EDITORIAL,
      chapters: CHAPTERS,
      standingBlocks: blocks,
      platform: "YOUTUBE",
    });
    expect(once.text).toBe(twice.text);
  });

  /** Order must come from sortOrder, not from however the rows were fetched. */
  it("does not depend on the order the blocks arrive in", () => {
    const a = block({ label: "A", body: "First", sortOrder: 1 });
    const b = block({ label: "B", body: "Second", sortOrder: 2 });
    const c = block({ label: "C", body: "Third", sortOrder: 3 });
    const forward = composeDescription({
      editorial: EDITORIAL, chapters: null, standingBlocks: [a, b, c], platform: "YOUTUBE",
    });
    const shuffled = composeDescription({
      editorial: EDITORIAL, chapters: null, standingBlocks: [c, a, b], platform: "YOUTUBE",
    });
    expect(shuffled.text).toBe(forward.text);
    expect(forward.text).toContain("First\n\nSecond\n\nThird");
  });

  it("puts editorial first, then chapters, then standing content", () => {
    const result = composeDescription({
      editorial: EDITORIAL,
      chapters: CHAPTERS,
      standingBlocks: [block({ label: "CTA", body: "Subscribe." })],
      platform: "YOUTUBE",
    });
    expect(result.sections.map((s) => s.kind)).toEqual([
      "EDITORIAL",
      "CHAPTERS",
      "STANDING",
    ]);
    expect(result.text.indexOf(EDITORIAL)).toBeLessThan(result.text.indexOf("CHAPTERS"));
    expect(result.text.indexOf("CHAPTERS")).toBeLessThan(result.text.indexOf("Subscribe."));
  });
});

describe("standing content is reproduced exactly", () => {
  /**
   * The whole reason this is not generated: a promo code that loses a
   * character is worse than no promo code, and nobody notices for weeks.
   */
  it("keeps a sponsor promo code byte-for-byte", () => {
    const body = "Nesa's Hemp — code THEPRATHERPOINT10 for 10% off. NesasHemp.com";
    const result = composeDescription({
      editorial: EDITORIAL,
      chapters: null,
      standingBlocks: [block({ kind: "SPONSOR", label: "Nesa's Hemp", body })],
      platform: "YOUTUBE",
    });
    expect(result.text).toContain(body);
    expect(result.text).toContain("THEPRATHERPOINT10");
  });

  it("keeps an affiliate URL byte-for-byte, query string included", () => {
    const url = "https://streamyard.com/pal/d/4997670971113472";
    const result = composeDescription({
      editorial: EDITORIAL,
      chapters: null,
      standingBlocks: [
        block({ kind: "AFFILIATE", label: "StreamYard", body: `Try StreamYard: ${url}` }),
      ],
      platform: "YOUTUBE",
    });
    expect(result.text).toContain(url);
  });

  it("preserves internal line breaks and spacing inside a block", () => {
    const body = "SPONSORS\n  Be Ready 123 — code PRATHER\n  SignalRelief.com";
    const result = composeDescription({
      editorial: EDITORIAL, chapters: null,
      standingBlocks: [block({ body })], platform: "YOUTUBE",
    });
    expect(result.text).toContain(body);
  });
});

describe("enablement and platform applicability", () => {
  it("a disabled block does not appear, and says why", () => {
    const result = composeDescription({
      editorial: EDITORIAL,
      chapters: null,
      standingBlocks: [
        block({ label: "Old sponsor", body: "PratherDeal.com", enabled: false }),
      ],
      platform: "YOUTUBE",
    });
    expect(result.text).not.toContain("PratherDeal.com");
    expect(result.omitted).toEqual([
      { label: "Old sponsor", reason: "disabled in Settings" },
    ]);
  });

  it("a block scoped to another platform does not appear", () => {
    const result = composeDescription({
      editorial: EDITORIAL,
      chapters: null,
      standingBlocks: [
        block({ label: "Podcast CTA", body: "Follow in your podcast app", platforms: ["BUZZSPROUT"] }),
      ],
      platform: "YOUTUBE",
    });
    expect(result.text).not.toContain("podcast app");
    expect(result.omitted[0]?.reason).toMatch(/not enabled for YOUTUBE/);
  });

  it("a block with no platform list appears everywhere", () => {
    const b = block({ platforms: null });
    expect(blockAppliesTo(b, "YOUTUBE")).toBe(true);
    expect(blockAppliesTo(b, "BUZZSPROUT")).toBe(true);
    expect(blockAppliesTo(block({ platforms: [] }), "YOUTUBE")).toBe(true);
  });

  it("an empty block is skipped rather than adding blank space", () => {
    const result = composeDescription({
      editorial: EDITORIAL, chapters: null,
      standingBlocks: [block({ label: "Empty", body: "   " })], platform: "YOUTUBE",
    });
    expect(result.text).toBe(EDITORIAL);
    expect(result.omitted[0]?.reason).toBe("empty");
  });
});

describe("platforms may differ without being forced apart", () => {
  it("YouTube and Buzzsprout share editorial but can carry different blocks", () => {
    const blocks = [
      block({ label: "Sub", body: "Subscribe on YouTube.", platforms: ["YOUTUBE"], sortOrder: 1 }),
      block({ label: "Follow", body: "Follow the podcast.", platforms: ["BUZZSPROUT"], sortOrder: 1 }),
      block({ label: "Site", body: "JeffreyPrather.com", sortOrder: 2 }),
    ];
    const yt = composeDescription({
      editorial: EDITORIAL, chapters: CHAPTERS, standingBlocks: blocks, platform: "YOUTUBE",
      ...compositionOptionsFor("YOUTUBE"),
    });
    const bz = composeDescription({
      editorial: EDITORIAL, chapters: CHAPTERS, standingBlocks: blocks, platform: "BUZZSPROUT",
      ...compositionOptionsFor("BUZZSPROUT"),
    });

    expect(yt.text).toContain("Subscribe on YouTube.");
    expect(yt.text).not.toContain("Follow the podcast.");
    expect(bz.text).toContain("Follow the podcast.");
    expect(bz.text).not.toContain("Subscribe on YouTube.");
    // Shared editorial, and the shared block, appear in both.
    expect(yt.text).toContain(EDITORIAL);
    expect(bz.text).toContain(EDITORIAL);
    expect(yt.text).toContain("JeffreyPrather.com");
    expect(bz.text).toContain("JeffreyPrather.com");
    // Not forced to be identical strings.
    expect(yt.text).not.toBe(bz.text);
  });

  it("uses the platform's own chapter heading", () => {
    const yt = composeDescription({
      editorial: EDITORIAL, chapters: CHAPTERS, standingBlocks: [], platform: "YOUTUBE",
      ...compositionOptionsFor("YOUTUBE"),
    });
    const bz = composeDescription({
      editorial: EDITORIAL, chapters: CHAPTERS, standingBlocks: [], platform: "BUZZSPROUT",
      ...compositionOptionsFor("BUZZSPROUT"),
    });
    expect(yt.text).toContain("CHAPTERS\n0:00 Cold open");
    expect(bz.text).toContain("IN THIS EPISODE\n0:00 Cold open");
  });

  it("omits chapters entirely when a platform does not want them", () => {
    const result = composeDescription({
      editorial: EDITORIAL, chapters: CHAPTERS, standingBlocks: [],
      platform: "BUZZSPROUT", includeChapters: false,
    });
    expect(result.text).not.toContain("0:00");
  });
});

describe("the approval gate", () => {
  const drafts = (state: string) => [
    { field: "primary_headline", platform: null, value: "Approved headline", state },
    { field: "platform_description", platform: "YOUTUBE" as Platform, value: "Body copy", state },
    { field: "chapters", platform: null, value: CHAPTERS, state },
  ];

  it("reads approved editorial content", () => {
    const picked = selectApprovedEditorial(drafts("APPROVED"), "YOUTUBE");
    expect(picked.editorial).toBe("Body copy");
    expect(picked.chapters).toBe(CHAPTERS);
    expect(picked.title).toBe("Approved headline");
  });

  /** A PROPOSED draft has no path to a platform. This is the gate. */
  it("refuses PROPOSED content", () => {
    const picked = selectApprovedEditorial(drafts("PROPOSED"), "YOUTUBE");
    expect(picked.editorial).toBeNull();
    expect(picked.chapters).toBeNull();
    expect(picked.title).toBeNull();
  });

  it("refuses REJECTED and SUPERSEDED content", () => {
    expect(selectApprovedEditorial(drafts("REJECTED"), "YOUTUBE").editorial).toBeNull();
    expect(selectApprovedEditorial(drafts("SUPERSEDED"), "YOUTUBE").editorial).toBeNull();
  });

  it("proposed editorial cannot reach a composition even alongside approved blocks", () => {
    const picked = selectApprovedEditorial(drafts("PROPOSED"), "YOUTUBE");
    const result = composeDescription({
      editorial: picked.editorial,
      chapters: picked.chapters,
      standingBlocks: [block({ label: "CTA", body: "Subscribe." })],
      platform: "YOUTUBE",
    });
    expect(result.text).not.toContain("Body copy");
    expect(result.text).toBe("Subscribe.");
  });

  it("a platform-specific title beats the general headline", () => {
    const picked = selectApprovedEditorial(
      [
        ...drafts("APPROVED"),
        { field: "platform_title", platform: "YOUTUBE" as Platform, value: "YT title", state: "APPROVED" },
      ],
      "YOUTUBE",
    );
    expect(picked.title).toBe("YT title");
  });

  it("does not read another platform's description", () => {
    const picked = selectApprovedEditorial(
      [{ field: "platform_description", platform: "BUZZSPROUT" as Platform, value: "Podcast notes", state: "APPROVED" }],
      "YOUTUBE",
    );
    expect(picked.editorial).toBeNull();
  });
});
