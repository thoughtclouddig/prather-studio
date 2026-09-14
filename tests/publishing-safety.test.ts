import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodeContentDrafts, episodePublications, type User } from "@/db/schema";
import { validateChapters, validatePackage, PackageValidationError } from "@/lib/content/schema";
import { makeEpisode, makePublication, makeShow, makeUser, resetDb } from "./helpers";
import type { YouTubeVideo } from "@/lib/integrations/youtube/client";

let remote: YouTubeVideo;
let updateCalls: Array<{ id: string; snippet: Record<string, unknown> }> = [];
let updateShouldFail = false;

vi.mock("@/lib/integrations/youtube/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/youtube/client")>(
    "@/lib/integrations/youtube/client",
  );
  return {
    ...actual,
    getVideo: vi.fn(async (id: string) => (id === remote.id ? remote : null)),
    updateVideoSnippet: vi.fn(async (id: string, snippet: Record<string, unknown>) => {
      updateCalls.push({ id, snippet });
      if (updateShouldFail) throw new Error("YouTube rejected the update: quotaExceeded");
      remote = {
        ...remote,
        title: snippet["title"] as string,
        description: snippet["description"] as string,
        tags: (snippet["tags"] as string[]) ?? remote.tags,
        categoryId: (snippet["categoryId"] as string) ?? remote.categoryId,
      };
      return remote;
    }),
  };
});

let owner: User;
let episodeId: string;
const VIDEO_ID = "aaaaaaaaaaa";

async function draft(field: string, value: string, state: "PROPOSED" | "APPROVED", platform?: "YOUTUBE") {
  await db.insert(episodeContentDrafts).values({
    episodeId, field, value, state, source: "AI",
    ...(platform ? { platform } : {}),
  });
}

beforeEach(async () => {
  await resetDb();
  updateCalls = [];
  updateShouldFail = false;
  remote = {
    id: VIDEO_ID, title: "Old live title", description: "Old description",
    publishedAt: "2026-09-08T18:00:00Z", thumbnailUrl: null, durationIso: null,
    durationSeconds: 3600, privacyStatus: "public", categoryId: "25",
    tags: ["prather", "intel"], defaultLanguage: "en", defaultAudioLanguage: "en",
    liveBroadcastContent: "none", viewCount: 1200, likeCount: 12, live: null,
  };
  owner = await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
  await makePublication(episodeId, "YOUTUBE");
  const { linkYouTubeVideo } = await import("@/lib/domain/linkage");
  await linkYouTubeVideo(owner, episodeId, VIDEO_ID);
});

describe("only approved content can reach YouTube", () => {
  /** The single most important invariant in the whole system. */
  it("ignores PROPOSED drafts entirely", async () => {
    const { buildApprovedMetadata } = await import("@/lib/domain/youtube-publish");
    await draft("primary_headline", "Proposed headline", "PROPOSED");
    await draft("platform_description", "Proposed description", "PROPOSED", "YOUTUBE");

    const approved = await buildApprovedMetadata(episodeId);
    expect(approved.title).toBeNull();
    expect(approved.composedDescription).toBeNull();
    expect(approved.missing).toHaveLength(2);
  });

  it("refuses to send when nothing is approved", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate, NothingApprovedError } = await import(
      "@/lib/domain/youtube-publish"
    );
    await draft("primary_headline", "Proposed headline", "PROPOSED");

    const plan = await planYouTubeUpdate(episodeId);
    await expect(
      applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint),
    ).rejects.toThrow(NothingApprovedError);
    expect(updateCalls).toHaveLength(0);
  });

  it("sends once content is APPROVED", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate } = await import(
      "@/lib/domain/youtube-publish"
    );
    await draft("primary_headline", "Five U.S. Bases Hit", "APPROVED");
    await draft("platform_description", "The full briefing.", "APPROVED", "YOUTUBE");

    const plan = await planYouTubeUpdate(episodeId);
    const { video } = await applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint);

    expect(video.title).toBe("Five U.S. Bases Hit");
    expect(updateCalls).toHaveLength(1);
  });

  /**
   * videos.update deletes any property of a submitted part that the request
   * omits. If this ever regresses, every video the Studio touches silently
   * loses its tags and category.
   */
  it("submits the FULL snippet so tags and category survive", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate } = await import(
      "@/lib/domain/youtube-publish"
    );
    await draft("primary_headline", "New title", "APPROVED");
    await draft("platform_description", "New description.", "APPROVED", "YOUTUBE");

    const plan = await planYouTubeUpdate(episodeId);
    await applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint);

    expect(updateCalls[0]!.snippet).toMatchObject({
      title: "New title",
      categoryId: "25",
      tags: ["prather", "intel"],
      defaultLanguage: "en",
    });
  });

  it("composes approved chapters into the description, with no second copy", async () => {
    const { buildApprovedMetadata } = await import("@/lib/domain/youtube-publish");
    await draft("primary_headline", "Title", "APPROVED");
    await draft("platform_description", "Body text.", "APPROVED", "YOUTUBE");
    await draft("chapters", "0:00 Cold open\n4:12 What CENTCOM admitted", "APPROVED");

    const approved = await buildApprovedMetadata(episodeId);
    expect(approved.composedDescription).toBe(
      "Body text.\n\nCHAPTERS\n0:00 Cold open\n4:12 What CENTCOM admitted",
    );
    // The chapter text appears exactly once in what gets sent.
    expect(approved.composedDescription!.match(/0:00 Cold open/g)).toHaveLength(1);
  });
});

describe("protecting the existing video", () => {
  beforeEach(async () => {
    await draft("primary_headline", "New title", "APPROVED");
    await draft("platform_description", "New description.", "APPROVED", "YOUTUBE");
  });

  it("shows a diff of exactly what would change", async () => {
    const { planYouTubeUpdate } = await import("@/lib/domain/youtube-publish");
    const plan = await planYouTubeUpdate(episodeId);

    const title = plan.changes.find((c) => c.field === "title")!;
    expect(title.current).toBe("Old live title");
    expect(title.proposed).toBe("New title");
    expect(title.changed).toBe(true);
    expect(plan.hasChanges).toBe(true);
  });

  /** A stale tab must not be able to replay a confirmation. */
  it("refuses a confirmation whose fingerprint no longer matches", async () => {
    const { applyYouTubeUpdate, RemoteChangedError } = await import(
      "@/lib/domain/youtube-publish"
    );
    await expect(
      applyYouTubeUpdate(owner, episodeId, "a-stale-fingerprint"),
    ).rejects.toThrow(RemoteChangedError);
    expect(updateCalls).toHaveLength(0);
  });

  /** Someone editing in YouTube Studio must not be silently overwritten. */
  it("blocks the update when the remote changed since our last sync", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate, RemoteChangedError } = await import(
      "@/lib/domain/youtube-publish"
    );
    remote = { ...remote, title: "Someone else edited this" };

    const plan = await planYouTubeUpdate(episodeId);
    expect(plan.remoteDrift).not.toBeNull();
    expect(plan.remoteDrift!.fields).toContain("title");

    await expect(
      applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint),
    ).rejects.toThrow(RemoteChangedError);
    expect(updateCalls).toHaveLength(0);
  });

  it("allows the overwrite once the operator acknowledges the drift", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate } = await import(
      "@/lib/domain/youtube-publish"
    );
    remote = { ...remote, title: "Someone else edited this" };
    const plan = await planYouTubeUpdate(episodeId);

    await applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint, {
      acknowledgeDrift: true,
    });
    expect(updateCalls).toHaveLength(1);
  });

  /** A failed write must not orphan the episode from its video. */
  it("preserves the link and records the error when the update fails", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate } = await import(
      "@/lib/domain/youtube-publish"
    );
    updateShouldFail = true;
    const plan = await planYouTubeUpdate(episodeId);

    await expect(
      applyYouTubeUpdate(owner, episodeId, plan.remoteFingerprint),
    ).rejects.toThrow(/quotaExceeded/);

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      );
    expect(pub!.externalId).toBe(VIDEO_ID);
    expect(pub!.externalUrl).toContain(VIDEO_ID);
    expect(pub!.state).toBe("FAILED");
    expect(pub!.errorMessage).toContain("quotaExceeded");
  });

  it("refuses when YouTube already matches", async () => {
    const { applyYouTubeUpdate, planYouTubeUpdate } = await import(
      "@/lib/domain/youtube-publish"
    );
    const first = await planYouTubeUpdate(episodeId);
    await applyYouTubeUpdate(owner, episodeId, first.remoteFingerprint);

    const second = await planYouTubeUpdate(episodeId);
    expect(second.hasChanges).toBe(false);
    await expect(
      applyYouTubeUpdate(owner, episodeId, second.remoteFingerprint),
    ).rejects.toThrow(/already matches/);
  });
});

describe("content engine output validation", () => {
  const valid = {
    primary_headline: "Five U.S. Bases Hit",
    alternate_headlines: ["A", "B", "C"],
    summary_short: "Short.",
    summary_long: "Long.",
    youtube_title: "Five U.S. Bases Hit",
    youtube_description: "Body.",
    chapters: [
      { start_seconds: 0, title: "Cold open" },
      { start_seconds: 120, title: "What CENTCOM admitted" },
      { start_seconds: 600, title: "The September pattern" },
    ],
    topics: [], people: [], organizations: [], places: [], search_terms: [],
    clip_candidates: [
      { start_seconds: 100, end_seconds: 160, title: "T", hook: "H", why_this_moment: "W" },
      { start_seconds: 300, end_seconds: 360, title: "T", hook: "H", why_this_moment: "W" },
      { start_seconds: 900, end_seconds: 960, title: "T", hook: "H", why_this_moment: "W" },
    ],
    follow_up_topics: ["one", "two"],
  };

  it("accepts a well-formed package", () => {
    expect(() => validatePackage(valid, { durationSeconds: 3600 })).not.toThrow();
  });

  /** The "fewer, better clips" rule, enforced rather than requested. */
  it("rejects more than five clips", () => {
    const tooMany = {
      ...valid,
      clip_candidates: Array.from({ length: 8 }, (_, i) => ({
        start_seconds: i * 200, end_seconds: i * 200 + 60,
        title: "T", hook: "H", why_this_moment: "W",
      })),
    };
    expect(() => validatePackage(tooMany)).toThrow(PackageValidationError);
  });

  it("rejects a title YouTube would truncate", () => {
    expect(() => validatePackage({ ...valid, youtube_title: "x".repeat(101) })).toThrow(/100/);
  });

  it("rejects a clip that runs past the end of the recording", () => {
    const past = {
      ...valid,
      clip_candidates: [
        ...valid.clip_candidates.slice(0, 2),
        { start_seconds: 7000, end_seconds: 7060, title: "T", hook: "H", why_this_moment: "W" },
      ],
    };
    expect(() => validatePackage(past, { durationSeconds: 3600 })).toThrow(/past the end/);
  });

  it("rejects malformed output outright", () => {
    expect(() => validatePackage("not an object")).toThrow(PackageValidationError);
    expect(() => validatePackage({})).toThrow(PackageValidationError);
  });
});

describe("chapter rules", () => {
  it("requires the first chapter at 0:00 — YouTube ignores them otherwise", () => {
    expect(
      validateChapters([
        { start_seconds: 30, title: "A" },
        { start_seconds: 90, title: "B" },
        { start_seconds: 200, title: "C" },
      ]),
    ).toEqual(expect.arrayContaining([expect.stringContaining("must start at 0:00")]));
  });

  it("requires strictly increasing timestamps", () => {
    expect(
      validateChapters([
        { start_seconds: 0, title: "A" },
        { start_seconds: 100, title: "B" },
        { start_seconds: 50, title: "C" },
      ]),
    ).toEqual(expect.arrayContaining([expect.stringContaining("does not come after")]));
  });

  it("requires at least 10 seconds between chapters", () => {
    expect(
      validateChapters([
        { start_seconds: 0, title: "A" },
        { start_seconds: 5, title: "B" },
        { start_seconds: 100, title: "C" },
      ]),
    ).toEqual(expect.arrayContaining([expect.stringContaining("less than 10s apart")]));
  });

  it("accepts a sane set", () => {
    expect(
      validateChapters(
        [
          { start_seconds: 0, title: "Cold open" },
          { start_seconds: 252, title: "What CENTCOM admitted" },
          { start_seconds: 700, title: "The September pattern" },
        ],
        3600,
      ),
    ).toEqual([]);
  });
});
