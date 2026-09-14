import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { episodePublications, type User } from "@/db/schema";
import { extractVideoId } from "@/lib/integrations/youtube/video-id";
import {
  normalizeTitle,
  rankCandidates,
  titleSimilarity,
} from "@/lib/integrations/youtube/matching";
import type { YouTubeVideo } from "@/lib/integrations/youtube/client";
import { makeEpisode, makePublication, makeShow, makeUser, resetDb } from "./helpers";

// The invariants under test are ours, not Google's. The API surface is stubbed
// so the guards can be exercised without a live channel.
vi.mock("@/lib/integrations/youtube/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/integrations/youtube/client")>(
    "@/lib/integrations/youtube/client",
  );
  return {
    ...actual,
    getVideo: vi.fn(async (id: string) => (KNOWN.has(id) ? KNOWN.get(id)! : null)),
  };
});

const video = (id: string, title: string, publishedAt: string, live?: Record<string, string>) =>
  ({
    id, title, description: "old description", publishedAt, thumbnailUrl: null,
    durationIso: null, durationSeconds: null, privacyStatus: "public", categoryId: "25",
    tags: ["existing"], defaultLanguage: null, defaultAudioLanguage: null,
    liveBroadcastContent: "none", live: live ?? null,
  }) as YouTubeVideo;

const KNOWN = new Map<string, YouTubeVideo>([
  ["aaaaaaaaaaa", video("aaaaaaaaaaa", "Five U.S. Bases Hit", "2026-09-08T18:04:00Z")],
  ["bbbbbbbbbbb", video("bbbbbbbbbbb", "A different show", "2026-09-03T18:00:00Z")],
]);

let owner: User;
let episodeId: string;
let otherEpisodeId: string;

beforeEach(async () => {
  await resetDb();
  owner = await makeUser("OWNER");
  const show = await makeShow();
  episodeId = (await makeEpisode(show.id)).id;
  otherEpisodeId = (await makeEpisode(show.id)).id;
  await makePublication(episodeId, "YOUTUBE");
  await makePublication(otherEpisodeId, "YOUTUBE");
});

describe("video id extraction", () => {
  it("accepts every form an operator is likely to paste", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    // What a finished livestream's URL looks like.
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("rejects anything that is not a video id", () => {
    expect(extractVideoId("https://www.youtube.com/@JeffreyPrather")).toBeNull();
    expect(extractVideoId("not an id")).toBeNull();
    expect(extractVideoId("")).toBeNull();
  });
});

describe("candidate ranking", () => {
  const target = {
    workingTitle: "Five bases hit",
    approvedTitle: null,
    scheduledAt: new Date("2026-09-08T18:00:00Z"),
    airedAt: new Date("2026-09-08T18:00:00Z"),
  };

  it("ranks the same-day stream first", () => {
    const { best } = rankCandidates(target, [
      video("bbbbbbbbbbb", "A different show", "2026-08-01T18:00:00Z"),
      video("aaaaaaaaaaa", "Five U.S. Bases Hit", "2026-09-08T18:04:00Z"),
    ]);
    expect(best?.video.id).toBe("aaaaaaaaaaa");
    expect(best?.confidence).toBe("strong");
  });

  /**
   * Two streams on the same day must never resolve automatically — this flag
   * is what turns the situation into a Needs Attention item instead.
   */
  it("flags two close candidates as ambiguous", () => {
    const { ambiguous } = rankCandidates(target, [
      video("aaaaaaaaaaa", "The Prather Point", "2026-09-08T18:00:00Z"),
      video("bbbbbbbbbbb", "The Prather Point Part Two", "2026-09-08T19:30:00Z"),
    ]);
    expect(ambiguous).toBe(true);
  });

  /**
   * A low-confidence near-tie is the case that most needs a human. An earlier
   * version suppressed the warning precisely when confidence was weak.
   */
  it("flags a near-tie even when both candidates score weakly", () => {
    const { ambiguous, best } = rankCandidates(target, [
      video("aaaaaaaaaaa", "Something unrelated", "2025-01-01T00:00:00Z"),
      video("bbbbbbbbbbb", "Something else entirely", "2025-01-02T00:00:00Z"),
    ]);
    expect(best?.confidence).toBe("weak");
    expect(ambiguous).toBe(true);
  });

  /**
   * Real JP Intel data: the 9 Sep show exists twice, one second apart, same
   * title and duration. Linking the wrong copy updates a video nobody watches.
   */
  /**
   * Exact values from the live channel. The pair differs by a trailing emoji
   * in the title and by one second of duration, which is why matching on the
   * broadcast window beats matching on title or runtime equality.
   */
  it("groups the same broadcast uploaded twice", () => {
    const { duplicates, ambiguous, candidates } = rankCandidates(target, [
      video(
        "cqbI52zgl7o",
        "Ukraine\'s Reverse  9-11:  Not Intel Agencies Running Ops But  Targeting Each Other! \u{1F4F1}",
        "2026-09-09T07:42:07Z",
        { actualStartTime: "2026-09-08T18:00:08Z", actualEndTime: "2026-09-08T19:24:57Z" },
      ),
      video(
        "NNR4wUsprmo",
        "Ukraine\'s Reverse  9-11:  Not Intel Agencies Running Ops But  Targeting Each Other!",
        "2026-09-09T07:36:28Z",
        { actualStartTime: "2026-09-08T18:00:07Z", actualEndTime: "2026-09-08T19:24:57Z" },
      ),
    ]);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]).toHaveLength(2);
    expect(ambiguous).toBe(true);
    expect(candidates[0]!.duplicateOf).toContain(
      candidates[0]!.video.id === "cqbI52zgl7o" ? "NNR4wUsprmo" : "cqbI52zgl7o",
    );
  });

  /** The real pair differed only by a trailing emoji and doubled spaces. */
  it("normalizes emoji and spacing so near-identical titles compare equal", () => {
    expect(normalizeTitle("Ukraine\'s Reverse  9-11! \u{1F4F1}")).toBe(
      normalizeTitle("Ukraine\'s Reverse 9-11!"),
    );
    expect(normalizeTitle("A totally different show")).not.toBe(
      normalizeTitle("Ukraine\'s Reverse 9-11!"),
    );
  });

  it("does not treat two different shows as duplicates", () => {
    const { duplicates } = rankCandidates(target, [
      video("aaaaaaaaaaa", "Show A", "2026-09-08T18:00:00Z", { actualStartTime: "2026-09-08T18:00:00Z" }),
      video("bbbbbbbbbbb", "Show B", "2026-09-10T18:00:00Z", { actualStartTime: "2026-09-10T18:00:00Z" }),
    ]);
    expect(duplicates).toHaveLength(0);
  });

  it("does not call an unrelated video a match", () => {
    const { best } = rankCandidates(target, [
      video("bbbbbbbbbbb", "Unrelated", "2024-01-01T00:00:00Z"),
    ]);
    expect(best?.confidence).toBe("weak");
  });

  it("scores title overlap on meaningful words only", () => {
    expect(titleSimilarity("The war on the border", "A war at the border")).toBeGreaterThan(0.5);
    expect(titleSimilarity("Border war", "Quantum chemistry")).toBe(0);
  });
});

describe("linking", () => {
  it("stores the external id and url on confirmation", async () => {
    const { linkYouTubeVideo } = await import("@/lib/domain/linkage");
    await linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa", { via: "candidate" });

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      );
    expect(pub!.externalId).toBe("aaaaaaaaaaa");
    expect(pub!.externalUrl).toContain("aaaaaaaaaaa");
    expect(pub!.state).toBe("PUBLISHED");
    // The snapshot is what later drift detection compares against.
    expect((pub!.remoteSnapshot as { title: string }).title).toBe("Five U.S. Bases Hit");
  });

  /** An episode must never end up pointing at two different current videos. */
  it("refuses to silently re-point an episode at a different video", async () => {
    const { linkYouTubeVideo, AlreadyLinkedError } = await import("@/lib/domain/linkage");
    await linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa");
    await expect(linkYouTubeVideo(owner, episodeId, "bbbbbbbbbbb")).rejects.toThrow(
      AlreadyLinkedError,
    );
  });

  it("re-linking the same video is idempotent", async () => {
    const { linkYouTubeVideo } = await import("@/lib/domain/linkage");
    await linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa");
    await expect(linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa")).resolves.toBeDefined();
  });

  /** And one video must never be claimed by two episodes. */
  it("refuses a video already linked to another episode", async () => {
    const { linkYouTubeVideo } = await import("@/lib/domain/linkage");
    await linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa");
    await expect(linkYouTubeVideo(owner, otherEpisodeId, "aaaaaaaaaaa")).rejects.toThrow(
      /already linked to a different episode/,
    );
  });

  it("rejects a video the channel cannot see", async () => {
    const { linkYouTubeVideo } = await import("@/lib/domain/linkage");
    await expect(linkYouTubeVideo(owner, episodeId, "zzzzzzzzzzz")).rejects.toThrow(/no video/);
  });

  it("unlink clears the id, url and snapshot", async () => {
    const { linkYouTubeVideo, unlinkYouTubeVideo } = await import("@/lib/domain/linkage");
    await linkYouTubeVideo(owner, episodeId, "aaaaaaaaaaa");
    await unlinkYouTubeVideo(owner, episodeId);

    const [pub] = await db
      .select()
      .from(episodePublications)
      .where(
        and(
          eq(episodePublications.episodeId, episodeId),
          eq(episodePublications.platform, "YOUTUBE"),
        ),
      );
    expect(pub!.externalId).toBeNull();
    expect(pub!.remoteSnapshot).toBeNull();
  });
});
