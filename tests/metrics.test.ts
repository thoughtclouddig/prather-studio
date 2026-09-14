import { describe, expect, it } from "vitest";
import {
  growthBetween,
  readingConfidence,
  snapshotDay,
  snapshotKey,
  type Counters,
} from "@/lib/domain/metrics";

const day = (n: number) => new Date(`2026-09-${String(n).padStart(2, "0")}T06:00:00Z`);
const point = (n: number, counters: Counters) => ({ capturedAt: day(n), counters });

describe("one capture per subject per day", () => {
  it("keys by UTC day, not by instant", () => {
    const a = snapshotKey("RUMBLE", "CHANNEL", null, new Date("2026-09-14T00:05:00Z"));
    const b = snapshotKey("RUMBLE", "CHANNEL", null, new Date("2026-09-14T23:55:00Z"));
    expect(a).toBe(b);
    expect(a).toContain("2026-09-14");
  });

  it("separates days, providers, subjects and external ids", () => {
    const base = snapshotKey("RUMBLE", "CHANNEL", null, day(14));
    expect(base).not.toBe(snapshotKey("RUMBLE", "CHANNEL", null, day(15)));
    expect(base).not.toBe(snapshotKey("BUZZSPROUT", "CHANNEL", null, day(14)));
    expect(base).not.toBe(snapshotKey("RUMBLE", "EPISODE", null, day(14)));
    expect(base).not.toBe(snapshotKey("RUMBLE", "CHANNEL", "abc", day(14)));
  });

  it("formats the day as YYYY-MM-DD", () => {
    expect(snapshotDay(new Date("2026-09-14T22:00:00Z"))).toBe("2026-09-14");
  });
});

describe("growth arithmetic", () => {
  it("reports change between the earliest and latest capture", () => {
    const growth = growthBetween(
      [
        point(1, { followersTotal: 19000 }),
        point(8, { followersTotal: 19045 }),
        point(15, { followersTotal: 19090 }),
      ],
      "followersTotal",
    )!;
    expect(growth.first).toBe(19000);
    expect(growth.last).toBe(19090);
    expect(growth.delta).toBe(90);
    expect(growth.percent).toBeCloseTo(0.4736, 3);
    expect(growth.spanDays).toBe(14);
    expect(growth.samples).toBe(3);
  });

  it("does not depend on the order rows arrive in", () => {
    const rows = [
      point(15, { plays: 300 }),
      point(1, { plays: 100 }),
      point(8, { plays: 200 }),
    ];
    expect(growthBetween(rows, "plays")!.delta).toBe(200);
  });

  it("reports a decline as a negative delta rather than hiding it", () => {
    const growth = growthBetween(
      [point(1, { followersTotal: 100 }), point(8, { followersTotal: 90 })],
      "followersTotal",
    )!;
    expect(growth.delta).toBe(-10);
    expect(growth.percent).toBeCloseTo(-10);
  });

  /**
   * Growth from zero is undefined, not infinite. Rendering it as a percentage
   * produces "∞%" or "Infinity%", which is a lie with a number attached.
   */
  it("refuses to compute a percentage from a zero baseline", () => {
    const growth = growthBetween(
      [point(1, { plays: 0 }), point(8, { plays: 500 })],
      "plays",
    )!;
    expect(growth.delta).toBe(500);
    expect(growth.percent).toBeNull();
  });

  it("ignores captures missing the metric rather than treating them as zero", () => {
    const growth = growthBetween(
      [
        point(1, { followersTotal: 100 }),
        point(4, { subscribers: 5 }),
        point(8, { followersTotal: 120 }),
      ],
      "followersTotal",
    )!;
    expect(growth.samples).toBe(2);
    expect(growth.delta).toBe(20);
  });

  it("returns null when nothing measured the metric", () => {
    expect(growthBetween([point(1, { plays: 10 })], "followersTotal")).toBeNull();
    expect(growthBetween([], "plays")).toBeNull();
  });

  /** The span is what the data covers, not what was asked for. */
  it("reports the span the data actually covers", () => {
    const growth = growthBetween(
      [point(10, { plays: 1 }), point(12, { plays: 2 })],
      "plays",
    )!;
    expect(growth.spanDays).toBe(2);
  });
});

describe("confidence is stated, not implied", () => {
  const g = (samples: number, spanDays: number) => ({
    metric: "followersTotal",
    first: 100,
    last: 110,
    delta: 10,
    percent: 10,
    spanDays,
    samples,
  });

  it("a single capture is a value, not a change", () => {
    const c = readingConfidence(g(1, 0));
    expect(c.level).toBe("none");
    expect(c.note).toMatch(/only a value/i);
  });

  /**
   * Two points a day apart is the shape that most invites a wrong conclusion:
   * it produces a confident-looking percentage from nothing.
   */
  it("calls a short run weak and says not to read a direction into it", () => {
    const c = readingConfidence(g(2, 1));
    expect(c.level).toBe("weak");
    expect(c.note).toMatch(/not a direction/i);
    expect(c.note).toContain("2 captures");
    expect(c.note).toContain("1 day");
  });

  it("still calls a long span weak when there are too few captures", () => {
    expect(readingConfidence(g(3, 60)).level).toBe("weak");
  });

  it("still calls many captures weak when the span is short", () => {
    expect(readingConfidence(g(20, 3)).level).toBe("weak");
  });

  it("only two full weeks of daily capture is usable", () => {
    const c = readingConfidence(g(14, 14));
    expect(c.level).toBe("usable");
    expect(c.note).toContain("14 captures over 14 days");
  });

  /** Every level states the sample count, so nobody has to ask. */
  it("always reports how much data the reading rests on", () => {
    for (const level of [g(1, 0), g(2, 1), g(30, 30)]) {
      const note = readingConfidence(level).note;
      expect(note).toMatch(/capture/i);
    }
  });
});
