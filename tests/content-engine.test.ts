import { beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeContentDrafts, episodes } from "@/db/schema";
import { writeDrafts, PACKAGE_MODEL, PROMPT_VERSION } from "@/lib/content/package";
import { derivePackaging } from "@/lib/domain/vocabulary";
import { makeEpisode, makeShow, makeUser, resetDb } from "./helpers";
import type { EpisodePackage } from "@/lib/content/schema";

const PKG: EpisodePackage = {
  primary_headline: "Five U.S. Bases Hit",
  alternate_headlines: ["They Hit Five Bases", "The Undeclared War", "Zero Headlines"],
  summary_short: "Short summary.",
  summary_long: "Long summary.",
  youtube_title: "Five U.S. Bases Hit",
  youtube_description: "The full briefing body.",
  chapters: [
    { start_seconds: 0, title: "Cold open" },
    { start_seconds: 252, title: "What CENTCOM admitted" },
    { start_seconds: 700, title: "The September pattern" },
  ],
  topics: ["CENTCOM"],
  people: ["Jeffrey Prather"],
  organizations: ["CENTCOM"],
  places: ["Iraq"],
  search_terms: ["us bases hit"],
  clip_candidates: [
    { start_seconds: 252, end_seconds: 312, title: "The admission", hook: "They said it plainly.", why_this_moment: "It is the news." },
    { start_seconds: 700, end_seconds: 760, title: "The pattern", hook: "September again.", why_this_moment: "Recurring." },
    { start_seconds: 1400, end_seconds: 1460, title: "The financing", hook: "Follow the money.", why_this_moment: "Under-covered." },
  ],
  follow_up_topics: ["Canada financing", "The legal dodge"],
};

let episodeId: string;

beforeEach(async () => {
  await resetDb();
  await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
});

describe("generated content enters as proposals", () => {
  /** The invariant the whole approval architecture rests on. */
  it("writes every field as PROPOSED — never APPROVED", async () => {
    await writeDrafts(episodeId, PKG);

    const drafts = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId));

    expect(drafts.length).toBeGreaterThan(8);
    expect(drafts.every((d) => d.state === "PROPOSED")).toBe(true);
    expect(drafts.some((d) => d.state === "APPROVED")).toBe(false);
    expect(drafts.every((d) => d.source === "AI")).toBe(true);
    expect(drafts.every((d) => d.approvedBy === null)).toBe(true);
    expect(drafts.every((d) => d.approvedAt === null)).toBe(true);
  });

  /** Without these, "which headline approach performs" is unanswerable later. */
  it("records the model and prompt version on every draft", async () => {
    await writeDrafts(episodeId, PKG);
    const drafts = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId));

    expect(drafts.every((d) => d.model === PACKAGE_MODEL)).toBe(true);
    expect(drafts.every((d) => d.promptVersion === PROMPT_VERSION)).toBe(true);
  });

  it("does not touch the episode's approved title", async () => {
    await writeDrafts(episodeId, PKG);
    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.approvedTitle).toBeNull();
  });

  it("leaves the episode in a state Review recognises", async () => {
    await writeDrafts(episodeId, PKG);
    const drafts = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId));
    expect(derivePackaging(drafts)).toBe("REVIEW");
  });

  it("writes the YouTube title and description as platform-specific drafts", async () => {
    await writeDrafts(episodeId, PKG);
    const drafts = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId));

    const ytTitle = drafts.find((d) => d.field === "platform_title");
    const ytDescription = drafts.find((d) => d.field === "platform_description");
    expect(ytTitle?.platform).toBe("YOUTUBE");
    expect(ytDescription?.platform).toBe("YOUTUBE");
  });

  /** Chapters live in one draft, so the description cannot carry a stale copy. */
  it("keeps chapters out of the description draft", async () => {
    await writeDrafts(episodeId, PKG);
    const drafts = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.episodeId, episodeId));

    const description = drafts.find((d) => d.field === "platform_description")!;
    const chapters = drafts.find((d) => d.field === "chapters")!;

    expect(description.value).not.toContain("Cold open");
    expect(chapters.value).toContain("0:00 Cold open");
    expect(chapters.value).toContain("4:12 What CENTCOM admitted");
  });

  it("renders clip candidates with real timecodes", async () => {
    await writeDrafts(episodeId, PKG);
    const [clips] = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.field, "clip_candidates"));

    expect(clips!.value).toContain("4:12");
    expect(clips!.value).toContain("Hook:");
    expect(clips!.value).toContain("Why:");
    // Three clips proposed, not a flood.
    expect(clips!.value.match(/^\d+\. \[/gm)).toHaveLength(3);
  });

  /**
   * The show's headline is decided BEFORE the broadcast, from Jeff's
   * submission, because the thumbnail and the Rumble listing need it hours
   * before a transcript exists. A packaging run proposing a new show headline
   * would be proposing to retitle a show that already went out.
   */
  it("proposes no show headline — that decision happened before air", async () => {
    await writeDrafts(episodeId, PKG);

    const headlines = await db
      .select()
      .from(episodeContentDrafts)
      .where(
        inArray(episodeContentDrafts.field, ["primary_headline", "alternate_headline"]),
      );

    expect(headlines).toHaveLength(0);
  });

  /**
   * What the transcript IS good for is a YouTube title: it can see which
   * moment actually landed. Three variants, because YouTube's Test & Compare
   * takes three.
   */
  it("turns its headline work into YouTube title variants", async () => {
    await writeDrafts(episodeId, PKG);

    const variants = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.field, "alternate_platform_title"));

    expect(variants.length).toBeGreaterThan(0);
    expect(variants.length).toBeLessThanOrEqual(3);
    expect(variants.every((v) => v.platform === "YOUTUBE")).toBe(true);
    expect(variants.map((v) => v.value)).toContain("Five U.S. Bases Hit");
  });

  /**
   * A packaging run arriving hours after air must not wipe the headline
   * options someone was choosing between hours before it.
   */
  it("leaves the pre-show headline drafts alone when it runs", async () => {
    const [kept] = await db
      .insert(episodeContentDrafts)
      .values({
        episodeId,
        field: "primary_headline",
        value: "Jeff's own headline",
        source: "HUMAN",
        state: "PROPOSED",
      })
      .returning();

    await writeDrafts(episodeId, PKG);

    const [after] = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.id, kept!.id));

    expect(after!.state).toBe("PROPOSED");
  });
});

describe("choosing which headline the show runs under", () => {
  /**
   * Approving an alternate used to do nothing: syncApprovedTitle read
   * `primary_headline` only, so the draft went green while the episode kept
   * the old title — and the thumbnail and Rumble listing carried a headline
   * nobody had chosen.
   */
  it("an approved alternate becomes the episode's title", async () => {
    const { approveDraft } = await import("@/lib/domain/drafts");
    const owner = await makeUser("OWNER");

    const [alternate] = await db
      .insert(episodeContentDrafts)
      .values({
        episodeId,
        field: "alternate_headline",
        value: "Shorter, Plainer, His Point",
        state: "PROPOSED",
      })
      .returning();

    await approveDraft(owner, alternate!.id);

    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.approvedTitle).toBe("Shorter, Plainer, His Point");
  });

  it("choosing a second headline returns the first to the options", async () => {
    const { approveDraft } = await import("@/lib/domain/drafts");
    const owner = await makeUser("OWNER");

    const [his] = await db
      .insert(episodeContentDrafts)
      .values({
        episodeId,
        field: "primary_headline",
        value: "Jeff's own, at length",
        source: "HUMAN",
        state: "PROPOSED",
      })
      .returning();
    const [shorter] = await db
      .insert(episodeContentDrafts)
      .values({
        episodeId,
        field: "alternate_headline",
        value: "Jeff's own, shorter",
        state: "PROPOSED",
      })
      .returning();

    await approveDraft(owner, his!.id);
    await approveDraft(owner, shorter!.id);

    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.approvedTitle).toBe("Jeff's own, shorter");

    // Returned to the pile, not rejected — changing your mind about which to
    // run is not a judgement that the other was bad.
    const [first] = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.id, his!.id));
    expect(first!.state).toBe("PROPOSED");
  });
});
