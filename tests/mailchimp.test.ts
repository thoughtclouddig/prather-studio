import { describe, expect, it } from "vitest";
import { datacenterFromKey, roundToQuarterHour } from "@/lib/integrations/mailchimp/client";

describe("the datacenter lives in the key", () => {
  /**
   * There is no single Mailchimp endpoint — the key's suffix IS the API host,
   * and calling the wrong one returns 401 as though the key were invalid. That
   * sends people to regenerate a key that was fine, so the host is derived
   * rather than configured.
   */
  it("reads the datacenter suffix", () => {
    expect(datacenterFromKey("abc123def456-us21")).toBe("us21");
    expect(datacenterFromKey("abc123def456-us1")).toBe("us1");
    expect(datacenterFromKey("abc-US14")).toBe("us14");
  });

  it("trims whitespace from a pasted key", () => {
    expect(datacenterFromKey("  abc123-us21\n")).toBe("us21");
  });

  it("returns null for something that is not a key", () => {
    expect(datacenterFromKey("abc123def456")).toBeNull();
    expect(datacenterFromKey("")).toBeNull();
  });
});

describe("Mailchimp's 15-minute grid", () => {
  /**
   * A schedule_time off the quarter hour is refused, and the error does not
   * mention the grid — so rounding is better than relaying a confusing failure.
   */
  it("leaves a time already on the grid alone", () => {
    const at = new Date("2026-10-06T19:45:00.000Z");
    expect(roundToQuarterHour(at).toISOString()).toBe("2026-10-06T19:45:00.000Z");
  });

  it("rounds up to the next quarter hour", () => {
    expect(roundToQuarterHour(new Date("2026-10-06T19:46:00.000Z")).toISOString()).toBe(
      "2026-10-06T20:00:00.000Z",
    );
    expect(roundToQuarterHour(new Date("2026-10-06T19:01:00.000Z")).toISOString()).toBe(
      "2026-10-06T19:15:00.000Z",
    );
  });

  it("rolls the hour over correctly", () => {
    expect(roundToQuarterHour(new Date("2026-10-06T19:50:00.000Z")).toISOString()).toBe(
      "2026-10-06T20:00:00.000Z",
    );
  });

  it("drops seconds, which Mailchimp also refuses", () => {
    expect(roundToQuarterHour(new Date("2026-10-06T19:45:33.500Z")).toISOString()).toBe(
      "2026-10-06T19:45:00.000Z",
    );
  });

  /** 12:45 PM MST is the show's send time, and it is on the grid. */
  it("keeps the show's 12:45 MST send time unchanged", () => {
    // MST is UTC-7, so 12:45 MST is 19:45 UTC.
    const sendTime = new Date("2026-10-06T19:45:00.000Z");
    expect(roundToQuarterHour(sendTime).getTime()).toBe(sendTime.getTime());
  });
});
