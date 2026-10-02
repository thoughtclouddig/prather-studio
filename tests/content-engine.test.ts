import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
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

  it("approving a generated headline is what sets the canonical title", async () => {
    const { approveDraft } = await import("@/lib/domain/drafts");
    const owner = await makeUser("OWNER");
    await writeDrafts(episodeId, PKG);

    const [headline] = await db
      .select()
      .from(episodeContentDrafts)
      .where(eq(episodeContentDrafts.field, "primary_headline"));

    await approveDraft(owner, headline!.id);

    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    expect(episode!.approvedTitle).toBe("Five U.S. Bases Hit");
  });
});
