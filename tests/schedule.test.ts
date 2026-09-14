import { describe, expect, it } from "vitest";
import {
  cadenceFrom,
  classifyEpisode,
  countdownTo,
  getNextExpectedShowSlot,
  selectCurrentShow,
  selectNextShow,
  selectPastUnresolved,
  type Cadence,
  type SchedulableEpisode,
} from "@/lib/domain/schedule";
import { partsInZone, zonedTimeToInstant } from "@/lib/time/zone";
import type { EpisodePhase } from "@/db/schema";

const ET = "America/New_York";
const CADENCE: Cadence = { days: [2, 4], startTime: "14:00", timeZone: ET };

/** A wall-clock moment in Eastern, as an instant. */
const et = (y: number, m: number, d: number, hour = 0, minute = 0) =>
  zonedTimeToInstant({ year: y, month: m, day: d, hour, minute }, ET);

/** How the slot reads to a human in Eastern — the only view that matters. */
const readET = (instant: Date) => {
  const p = partsInZone(instant, ET);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

const episode = (
  id: string,
  scheduled: Date | null,
  phase: EpisodePhase,
  aired: Date | null = null,
): SchedulableEpisode => ({ id, scheduledAt: scheduled, airedAt: aired, phase });

describe("next expected show slot", () => {
  /** The case from the bug report: Monday 14 Sep must point at Tue 15 Sep. */
  it("returns Tuesday 2 PM when asked on the Monday before", () => {
    const slot = getNextExpectedShowSlot(et(2026, 9, 14, 11, 48), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2026-09-15 14:00");
  });

  it("returns today's slot when asked earlier the same Tuesday", () => {
    const slot = getNextExpectedShowSlot(et(2026, 9, 15, 13, 0), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2026-09-15 14:00");
  });

  it("rolls to Thursday once Tuesday's show has started", () => {
    const slot = getNextExpectedShowSlot(et(2026, 9, 15, 15, 0), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2026-09-17 14:00");
  });

  it("rolls to the following Tuesday once Thursday's show has started", () => {
    const slot = getNextExpectedShowSlot(et(2026, 9, 17, 15, 0), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2026-09-22 14:00");
  });

  /** The slot is "next" right up to its start, and not one second after. */
  it("treats the exact start time as no longer next", () => {
    const before = getNextExpectedShowSlot(et(2026, 9, 15, 13, 59), CADENCE);
    expect(readET(before!.startsAt)).toBe("2026-09-15 14:00");
    const atStart = getNextExpectedShowSlot(et(2026, 9, 15, 14, 0), CADENCE);
    expect(readET(atStart!.startsAt)).toBe("2026-09-17 14:00");
  });

  it("crosses a month boundary", () => {
    const slot = getNextExpectedShowSlot(et(2026, 9, 30, 18, 0), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2026-10-01 14:00");
  });

  /**
   * The show follows the Eastern clock, not a fixed offset. Across the
   * November DST change the wall time stays 2 PM while the UTC instant moves
   * by an hour — storing an offset instead of a zone would drift the show.
   */
  it("keeps 2 PM Eastern across the autumn DST change", () => {
    const beforeFallBack = getNextExpectedShowSlot(et(2026, 10, 29, 15, 0), CADENCE);
    const afterFallBack = getNextExpectedShowSlot(et(2026, 11, 2, 9, 0), CADENCE);

    expect(readET(beforeFallBack!.startsAt)).toBe("2026-11-03 14:00");
    expect(readET(afterFallBack!.startsAt)).toBe("2026-11-03 14:00");

    // EDT is UTC-4, EST is UTC-5: same wall time, different instants.
    const octoberSlot = getNextExpectedShowSlot(et(2026, 10, 20, 15, 0), CADENCE);
    expect(octoberSlot!.startsAt.getUTCHours()).toBe(18); // 14:00 EDT
    expect(beforeFallBack!.startsAt.getUTCHours()).toBe(19); // 14:00 EST
  });

  it("keeps 2 PM Eastern across the spring DST change", () => {
    const slot = getNextExpectedShowSlot(et(2027, 3, 9, 15, 0), CADENCE);
    expect(readET(slot!.startsAt)).toBe("2027-03-11 14:00");
  });

  /**
   * The answer must not depend on where the Studio happens to run. A browser
   * in Arizona (no DST) and a Replit VM in UTC must agree.
   */
  it("gives the same answer regardless of the host timezone", () => {
    const original = process.env.TZ;
    const answers = new Set<string>();
    for (const tz of ["UTC", "America/Phoenix", "Asia/Tokyo", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      const slot = getNextExpectedShowSlot(
        new Date("2026-09-14T15:48:00Z"),
        CADENCE,
      );
      answers.add(slot!.startsAt.toISOString());
    }
    process.env.TZ = original;
    expect(answers.size).toBe(1);
    expect([...answers][0]).toBe("2026-09-15T18:00:00.000Z"); // 2 PM EDT
  });

  it("honours a different cadence without code changes", () => {
    const daily = { days: [0, 1, 2, 3, 4, 5, 6], startTime: "09:30", timeZone: ET };
    const slot = getNextExpectedShowSlot(et(2026, 9, 14, 11, 0), daily);
    expect(readET(slot!.startsAt)).toBe("2026-09-15 09:30");
  });

  it("returns null when the cadence has no days", () => {
    expect(getNextExpectedShowSlot(et(2026, 9, 14), { ...CADENCE, days: [] })).toBeNull();
  });

  it("falls back to Tue/Thu when the show row predates the column", () => {
    expect(
      cadenceFrom({ defaultStartTime: "14:00", timezone: ET, cadenceDays: null }).days,
    ).toEqual([2, 4]);
  });
});

describe("episode classification", () => {
  const NOW = et(2026, 9, 14, 11, 48); // Monday 14 Sep, the reported moment

  /** The exact defect: a past SCHEDULED episode was counted as upcoming. */
  it("does not call a past SCHEDULED episode upcoming", () => {
    expect(classifyEpisode(episode("a", et(2026, 9, 10, 14), "SCHEDULED"), NOW)).toBe(
      "PAST_UNRESOLVED",
    );
  });

  it("calls a genuinely future episode upcoming", () => {
    expect(classifyEpisode(episode("a", et(2026, 9, 15, 14), "SCHEDULED"), NOW)).toBe(
      "UPCOMING",
    );
  });

  it("treats a past episode with evidence as resolved", () => {
    expect(
      classifyEpisode(episode("a", et(2026, 9, 8, 14), "RELEASED", et(2026, 9, 8, 14)), NOW),
    ).toBe("RESOLVED");
    // Phase alone is enough evidence even without an aired stamp.
    expect(classifyEpisode(episode("b", et(2026, 9, 8, 14), "REVIEW"), NOW)).toBe("RESOLVED");
  });

  /** A start time passing is not an observation. */
  it("does not promote an overdue episode to LIVE", () => {
    expect(classifyEpisode(episode("a", et(2026, 9, 10, 14), "SCHEDULED"), NOW)).not.toBe(
      "LIVE",
    );
  });

  it("only an observed LIVE phase counts as live", () => {
    expect(classifyEpisode(episode("a", et(2026, 9, 14, 11), "LIVE"), NOW)).toBe("LIVE");
  });

  it("handles an episode with no scheduled time", () => {
    expect(classifyEpisode(episode("a", null, "PLANNED"), NOW)).toBe("UNSCHEDULED");
  });
});

describe("selection", () => {
  const NOW = et(2026, 9, 14, 11, 48);

  /** The reported symptom, as a regression test. */
  it("never selects a past episode as next show", () => {
    const next = selectNextShow(
      [
        episode("sep8", et(2026, 9, 8, 14), "RELEASED"),
        episode("sep10", et(2026, 9, 10, 14), "SCHEDULED"),
      ],
      NOW,
    );
    expect(next).toBeNull();
  });

  it("selects the earliest future episode", () => {
    const next = selectNextShow(
      [
        episode("sep22", et(2026, 9, 22, 14), "PLANNED"),
        episode("sep8", et(2026, 9, 8, 14), "SCHEDULED"),
        episode("sep15", et(2026, 9, 15, 14), "SCHEDULED"),
        episode("sep17", et(2026, 9, 17, 14), "SCHEDULED"),
      ],
      NOW,
    );
    expect(next?.id).toBe("sep15");
  });

  /** Ordering is by time, not by phase, insertion order or episode number. */
  it("ignores phase and array order when choosing", () => {
    const next = selectNextShow(
      [
        episode("later-but-scheduled", et(2026, 9, 17, 14), "SCHEDULED"),
        episode("sooner-but-planned", et(2026, 9, 15, 14), "PLANNED"),
      ],
      NOW,
    );
    expect(next?.id).toBe("sooner-but-planned");
  });

  it("a completed episode cannot return as next show", () => {
    const next = selectNextShow(
      [episode("done", et(2026, 9, 8, 14), "RELEASED", et(2026, 9, 8, 14))],
      NOW,
    );
    expect(next).toBeNull();
  });

  it("a future episode already marked released is not offered as next", () => {
    const next = selectNextShow([episode("odd", et(2026, 9, 15, 14), "RELEASED")], NOW);
    expect(next).toBeNull();
  });

  it("an observed LIVE episode is the current show", () => {
    const rows = [
      episode("live", et(2026, 9, 14, 11), "LIVE"),
      episode("next", et(2026, 9, 15, 14), "SCHEDULED"),
    ];
    expect(selectCurrentShow(rows)?.id).toBe("live");
    // …and it does not also occupy the next-show position.
    expect(selectNextShow(rows, NOW)?.id).toBe("next");
  });

  it("there is no current show when nothing is observed live", () => {
    expect(selectCurrentShow([episode("a", et(2026, 9, 10, 14), "SCHEDULED")])).toBeNull();
  });

  it("surfaces overdue unobserved episodes, oldest first", () => {
    const unresolved = selectPastUnresolved(
      [
        episode("sep10", et(2026, 9, 10, 14), "SCHEDULED"),
        episode("sep3", et(2026, 9, 3, 14), "SCHEDULED"),
        episode("done", et(2026, 9, 8, 14), "RELEASED", et(2026, 9, 8, 14)),
        episode("future", et(2026, 9, 15, 14), "SCHEDULED"),
      ],
      NOW,
    );
    expect(unresolved.map((e) => e.id)).toEqual(["sep3", "sep10"]);
  });
});

describe("countdown", () => {
  const NOW = et(2026, 9, 14, 11, 48);

  it("counts down to a future show", () => {
    const state = countdownTo(et(2026, 9, 15, 14), NOW);
    expect(state.kind).toBe("counting");
    expect(state.label).toBe("1d 2h 12m");
  });

  /**
   * The old label was "on air / passed", which asserted the show was airing.
   * The Studio has no such knowledge until an observer reports it.
   */
  it("says the start time passed rather than claiming the show is on air", () => {
    const state = countdownTo(et(2026, 9, 10, 14), NOW);
    expect(state.kind).toBe("overdue");
    expect(state.label).toBe("START TIME PASSED");
    expect(state.label).not.toMatch(/on air/i);
  });

  it("says LIVE only when something actually observed it", () => {
    const state = countdownTo(et(2026, 9, 14, 11), NOW, { isLive: true });
    expect(state.kind).toBe("live");
    expect(state.label).toBe("LIVE");
  });

  it("renders hours and minutes inside a day", () => {
    expect(countdownTo(et(2026, 9, 14, 14), NOW).label).toBe("2h 12m");
  });

  it("handles a missing time", () => {
    expect(countdownTo(null, NOW).kind).toBe("none");
  });
});
