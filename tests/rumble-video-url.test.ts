import { describe, expect, it } from "vitest";
import {
  normalizeRumbleVideoUrl,
  rumbleLinkLabel,
} from "@/lib/integrations/rumble/video-url";

describe("the missing v", () => {
  /**
   * The real failure: a stored embed URL whose id had lost its leading `v`.
   * /embed/7eamjw/ returns Rumble's 404 page; /embed/v7eamjw/ serves the
   * video. One character, and the only symptom was a dead link.
   */
  it("restores an embed id that lost its prefix", () => {
    const link = normalizeRumbleVideoUrl("https://rumble.com/embed/7eamjw/");
    expect(link).toMatchObject({
      kind: "embed",
      embedId: "v7eamjw",
      url: "https://rumble.com/embed/v7eamjw/",
    });
  });

  it("leaves an intact embed id alone", () => {
    expect(normalizeRumbleVideoUrl("https://rumble.com/embed/v7eamjw/")).toMatchObject({
      embedId: "v7eamjw",
      url: "https://rumble.com/embed/v7eamjw/",
    });
  });
});

describe("pages and embeds are not interchangeable", () => {
  it("recognises a video page and does not rewrite it", () => {
    const page = "https://rumble.com/v7g8rbk-iraq-israeli-false-flag-war-trap.html";
    expect(normalizeRumbleVideoUrl(page)).toEqual({ kind: "page", url: page });
  });

  it("strips tracking from a page URL without touching the slug", () => {
    // The slug is opaque — reconstructing one is exactly the guess that
    // produces a dead link.
    const link = normalizeRumbleVideoUrl(
      "https://rumble.com/v7g8rbk-some-slug.html?e9s=src_v1_upp",
    );
    expect(link).toEqual({
      kind: "page",
      url: "https://rumble.com/v7g8rbk-some-slug.html",
    });
  });

  it("labels a player as a player, not as the page", () => {
    const embed = normalizeRumbleVideoUrl("https://rumble.com/embed/v7eamjw/")!;
    const page = normalizeRumbleVideoUrl("https://rumble.com/v7g8rbk-x.html")!;
    expect(rumbleLinkLabel(embed)).toBe("Open the player");
    expect(rumbleLinkLabel(page)).toBe("Open on Rumble");
  });
});

describe("rejecting what is not a Rumble video", () => {
  it("adds a scheme rather than producing a relative link", () => {
    expect(normalizeRumbleVideoUrl("rumble.com/embed/v7eamjw/")?.url).toBe(
      "https://rumble.com/embed/v7eamjw/",
    );
  });

  it("marks a non-Rumble host unknown", () => {
    expect(normalizeRumbleVideoUrl("https://youtube.com/watch?v=x")).toMatchObject({
      kind: "unknown",
    });
  });

  it("marks a Rumble channel or search unknown rather than calling it a video", () => {
    expect(normalizeRumbleVideoUrl("https://rumble.com/c/ThePratherPoint")).toMatchObject({
      kind: "unknown",
    });
  });

  it("returns nothing for nothing", () => {
    expect(normalizeRumbleVideoUrl(null)).toBeNull();
    expect(normalizeRumbleVideoUrl("  ")).toBeNull();
  });
});
