import { describe, expect, it } from "vitest";
import {
  EXPECTED_DURATION_OFFSET_S,
  matchBuzzsproutEpisode,
  scoreBuzzsproutCandidate,
  type BuzzsproutForMatch,
  type CanonicalForMatch,
} from "@/lib/domain/buzzsprout-match";

/** The real Sep 8 broadcast: aired 18:00:08Z, video 1:24:54. */
const CANONICAL: CanonicalForMatch = {
  airedAt: new Date("2026-09-08T18:00:08Z"),
  videoDurationSeconds: 5094,
  title: "Ukraine Just Had the Opposite of 9/11",
};

const bz = (over: Partial<BuzzsproutForMatch>): BuzzsproutForMatch => ({
  id: 1,
  title: "Some podcast episode",
  publishedAt: "2026-09-10T07:00:00.000-07:00",
  durationSeconds: 5102,
  ...over,
});

describe("duration is the strong key", () => {
  it("scores a candidate at the measured +8s offset highly", () => {
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({ durationSeconds: 5094 + EXPECTED_DURATION_OFFSET_S }),
    );
    expect(c.disqualified).toBeNull();
    expect(c.confidence).toBeGreaterThan(0.85);
  });

  it("disqualifies a recording that is minutes off", () => {
    const c = scoreBuzzsproutCandidate(CANONICAL, bz({ durationSeconds: 5094 + 600 }));
    expect(c.disqualified).toMatch(/Duration differs/);
  });

  it("says so when duration is unavailable rather than guessing", () => {
    const c = scoreBuzzsproutCandidate(CANONICAL, bz({ durationSeconds: null }));
    expect(c.reasons.join(" ")).toMatch(/Duration unavailable/);
    expect(c.confidence).toBeLessThan(0.4);
  });
});

describe("a podcast cannot precede the broadcast it contains", () => {
  /**
   * The regression that running against the live account caught. This
   * candidate is a genuine Buzzsprout episode whose duration is within
   * tolerance and whose rounded lag displayed as "0 days after" — but it went
   * out two hours before the show it was being offered for had finished. It
   * belongs to the previous broadcast.
   */
  it("disqualifies an episode published before the broadcast ended", () => {
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({
        title: "Five U.S. Bases Hit: The War Trump Won't Admit He Lost",
        publishedAt: "2026-09-08T09:00:00.000-07:00", // 16:00Z — before 18:00Z
        durationSeconds: 5100,
      }),
    );
    expect(c.disqualified).toMatch(/BEFORE this broadcast finished/);
  });

  it("uses the instant, not the rounded day", () => {
    // Published one minute before the broadcast ends: same calendar day, and
    // still impossible.
    const endsAt = new Date("2026-09-08T18:00:08Z").getTime() + 5094 * 1000;
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({ publishedAt: new Date(endsAt - 60_000).toISOString() }),
    );
    expect(c.disqualified).toMatch(/BEFORE this broadcast finished/);
  });

  it("accepts an episode published just after the broadcast ends", () => {
    const endsAt = new Date("2026-09-08T18:00:08Z").getTime() + 5094 * 1000;
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({ publishedAt: new Date(endsAt + 60_000).toISOString() }),
    );
    expect(c.disqualified).toBeNull();
  });

  it("disqualifies an episode published far too late", () => {
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({ publishedAt: "2026-10-20T07:00:00.000-07:00" }),
    );
    expect(c.disqualified).toMatch(/days after the broadcast/);
  });

  it("recognises the usual one-slot lag", () => {
    const two = scoreBuzzsproutCandidate(CANONICAL, bz({}));
    expect(two.reasons.join(" ")).toMatch(/usual one-slot lag/);
  });
});

describe("title is a tiebreaker, never the decision", () => {
  /** Only 6 of 15 real episodes shared a title. Leading with it mis-links. */
  it("matches a correct episode whose title is completely different", () => {
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({
        title: "Ukraine's Spies Just Turned on Each Other — Here's What It Means",
        durationSeconds: 5103,
      }),
    );
    expect(c.titleScore).toBeLessThan(0.5);
    expect(c.confidence).toBeGreaterThan(0.85);
    expect(c.disqualified).toBeNull();
  });

  it("a perfect title cannot rescue a wrong duration", () => {
    const c = scoreBuzzsproutCandidate(
      CANONICAL,
      bz({ title: CANONICAL.title, durationSeconds: 9000 }),
    );
    expect(c.titleScore).toBeGreaterThan(0.9);
    expect(c.disqualified).toMatch(/Duration differs/);
    expect(c.confidence).toBeLessThanOrEqual(0.25);
  });
});

describe("selecting a match", () => {
  /** The live-data case, end to end. */
  it("picks the right episode out of the real candidate set", () => {
    const result = matchBuzzsproutEpisode(CANONICAL, [
      {
        id: 19773334,
        title: "Ukraine's Spies Just Turned on Each Other — Here's What It Means",
        publishedAt: "2026-09-10T07:00:00.000-07:00",
        durationSeconds: 5103,
      },
      {
        id: 19749760,
        title: "Five U.S. Bases Hit: The War Trump Won't Admit He Lost",
        publishedAt: "2026-09-08T09:00:00.000-07:00",
        durationSeconds: 5100,
      },
      {
        id: 19737556,
        title: "Why DEA, DOJ and CIA Slandered to Silence Me!",
        publishedAt: "2026-09-03T09:00:00.000-07:00",
        durationSeconds: 5573,
      },
    ]);

    expect(result.best?.episode.id).toBe(19773334);
    expect(result.ambiguous).toBeNull();
    expect(result.best!.confidence).toBeGreaterThan(0.85);
  });

  /** A suggestion is always a suggestion. */
  it("requires human confirmation even when confident", () => {
    const result = matchBuzzsproutEpisode(CANONICAL, [
      { id: 1, title: "x", publishedAt: "2026-09-10T07:00:00-07:00", durationSeconds: 5102 },
    ]);
    expect(result.best).not.toBeNull();
    expect(result.requiresConfirmation).toBe(true);
  });

  it("refuses to choose between two equally good candidates", () => {
    const result = matchBuzzsproutEpisode(CANONICAL, [
      { id: 1, title: "a", publishedAt: "2026-09-10T07:00:00-07:00", durationSeconds: 5102 },
      { id: 2, title: "b", publishedAt: "2026-09-10T08:00:00-07:00", durationSeconds: 5102 },
    ]);
    expect(result.best).toBeNull();
    expect(result.ambiguous).toMatch(/Confirm which one/i);
    expect(result.ambiguous).toMatch(/overwrite/i);
  });

  it("reports nothing rather than reaching when no candidate qualifies", () => {
    const result = matchBuzzsproutEpisode(CANONICAL, [
      { id: 1, title: "x", publishedAt: "2026-07-01T07:00:00-07:00", durationSeconds: 9000 },
    ]);
    expect(result.best).toBeNull();
    expect(result.ambiguous).toMatch(/may simply not be up yet/i);
  });

  it("still returns the ranked candidates so a human can look", () => {
    const result = matchBuzzsproutEpisode(CANONICAL, [
      { id: 1, title: "x", publishedAt: "2026-07-01T07:00:00-07:00", durationSeconds: 9000 },
    ]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("handles an episode that has not aired", () => {
    const result = matchBuzzsproutEpisode(
      { ...CANONICAL, airedAt: null },
      [{ id: 1, title: "x", publishedAt: "2026-09-10T07:00:00-07:00", durationSeconds: 5102 }],
    );
    expect(result.requiresConfirmation).toBe(true);
  });
});
