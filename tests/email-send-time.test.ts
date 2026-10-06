import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEND_TIME,
  DEFAULT_SEND_ZONE,
  describeGap,
  resolveSendTime,
  SendTimeError,
} from "@/lib/email/send-time";

/** 2:00 PM Eastern on an October (EDT) show day. */
const OCT_AIR = new Date("2026-10-06T18:00:00Z");
/** 2:00 PM Eastern on a December (EST) show day. */
const DEC_AIR = new Date("2026-12-09T19:00:00Z");

describe("the default is Arizona", () => {
  it("defaults to 11:00 in America/Phoenix", () => {
    const r = resolveSendTime({ scheduledAt: OCT_AIR, now: new Date("2026-10-06T06:00:00Z") });
    expect(r.wallTime).toBe(DEFAULT_SEND_TIME);
    expect(r.zone).toBe(DEFAULT_SEND_ZONE);
    expect(DEFAULT_SEND_ZONE).toBe("America/Phoenix");
  });

  it("is NOT America/Denver — Denver observes DST and Phoenix does not", () => {
    // The two agree all summer, so a wrong zone passes every October test.
    // They diverge in winter, which is the only time the mistake is visible.
    const phoenix = resolveSendTime({ scheduledAt: DEC_AIR, sendTimezone: "America/Phoenix" });
    const denver = resolveSendTime({ scheduledAt: DEC_AIR, sendTimezone: "America/Denver" });
    expect(phoenix.at.toISOString()).toBe(denver.at.toISOString());

    // ...and in summer they also agree, because Denver springs forward TO
    // Arizona's year-round offset. The hazard is that this looks like proof
    // the zones are interchangeable. They are not: Phoenix never moves.
    const phoenixOct = resolveSendTime({ scheduledAt: OCT_AIR, sendTimezone: "America/Phoenix" });
    const denverOct = resolveSendTime({ scheduledAt: OCT_AIR, sendTimezone: "America/Denver" });
    expect(phoenixOct.at.getTime()).not.toBe(denverOct.at.getTime());
  });
});

describe("Arizona holds its clock time across DST", () => {
  it("sends at 11:00 Arizona in October AND in December", () => {
    for (const air of [OCT_AIR, DEC_AIR]) {
      const r = resolveSendTime({ scheduledAt: air });
      const wall = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Phoenix",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(r.at);
      expect(wall).toBe("11:00");
    }
  });

  it("resolves to the same UTC instant year-round, because Arizona never shifts", () => {
    const oct = resolveSendTime({ scheduledAt: OCT_AIR });
    const dec = resolveSendTime({ scheduledAt: DEC_AIR });
    expect(oct.at.toISOString()).toBe("2026-10-06T18:00:00.000Z");
    expect(dec.at.toISOString()).toBe("2026-12-09T18:00:00.000Z");
  });
});

describe("the gap to air changes even though the send time does not", () => {
  it("lands as the show starts in October", () => {
    const r = resolveSendTime({ scheduledAt: OCT_AIR });
    expect(r.gapToAirMinutes).toBe(0);
    expect(describeGap(r.gapToAirMinutes)).toBe("as the show starts");
  });

  it("lands an hour before the show in December", () => {
    // Not a bug. Arizona stays put; Eastern falls back; the distance moves.
    const r = resolveSendTime({ scheduledAt: DEC_AIR });
    expect(r.gapToAirMinutes).toBe(60);
    expect(describeGap(r.gapToAirMinutes)).toBe("1 hour before the show starts");
  });
});

describe("labelling", () => {
  it("names the zone abbreviation, because MST is the point", () => {
    const r = resolveSendTime({ scheduledAt: OCT_AIR });
    expect(r.label).toContain("11:00");
    expect(r.label).toContain("MST");
  });
});

describe("the date is read in the send zone", () => {
  it("does not slip a day for a show that crosses midnight UTC", () => {
    // 7:00 PM Pacific = 02:00 UTC the NEXT day. Reading the date in UTC would
    // schedule the briefing for the morning after the show.
    const lateAir = new Date("2026-10-07T02:00:00Z");
    const r = resolveSendTime({ scheduledAt: lateAir, sendTimezone: "America/Phoenix" });
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Phoenix",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(r.at);
    expect(day).toBe("2026-10-06");
  });
});

describe("past slots", () => {
  it("reports a slot already behind us rather than scheduling into the past", () => {
    const r = resolveSendTime({
      scheduledAt: OCT_AIR,
      now: new Date("2026-10-06T19:00:00Z"),
    });
    expect(r.isPast).toBe(true);
  });

  it("is not past when the slot is still ahead", () => {
    const r = resolveSendTime({
      scheduledAt: OCT_AIR,
      now: new Date("2026-10-06T15:00:00Z"),
    });
    expect(r.isPast).toBe(false);
  });
});

describe("bad configuration is refused, not defaulted", () => {
  it("refuses a time that is not a time", () => {
    expect(() => resolveSendTime({ scheduledAt: OCT_AIR, sendTime: "11am" })).toThrow(
      SendTimeError,
    );
  });

  it("refuses a zone that is not a zone", () => {
    expect(() =>
      resolveSendTime({ scheduledAt: OCT_AIR, sendTimezone: "Arizona" }),
    ).toThrow(SendTimeError);
  });

  it("treats blank settings as unset and uses the default", () => {
    const r = resolveSendTime({ scheduledAt: OCT_AIR, sendTime: "  ", sendTimezone: "" });
    expect(r.wallTime).toBe("11:00");
    expect(r.zone).toBe("America/Phoenix");
  });
});
