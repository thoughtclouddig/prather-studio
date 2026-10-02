import { describe, expect, it } from "vitest";
import {
  evaluateBroadcast,
  observationKey,
  terminalObservationKey,
  UNOBSERVED_GRACE_MS,
} from "@/lib/domain/broadcast";
import type { BroadcastSignal, IntegrationProvider } from "@/db/schema";

const AIRED = new Date("2026-09-15T18:00:00Z"); // 2 PM ET
const DURING = new Date("2026-09-15T18:30:00Z");
const AFTER = new Date("2026-09-15T20:00:00Z");

const episode = (scheduledAt: Date | null = AIRED) =>
  ({ scheduledAt, phase: "SCHEDULED" }) as const;

let seq = 0;
const obs = (
  provider: IntegrationProvider,
  signal: BroadcastSignal,
  observedAt: Date,
  detail: Record<string, unknown> | null = null,
  externalId = "stream-1",
) => ({
  id: `obs-${++seq}`,
  provider,
  signal,
  externalId,
  observedAt,
  summary: `${provider} ${signal}`,
  detail,
});

describe("broadcast evidence — the clock proves nothing", () => {
  /**
   * The rule cb1e8a1 established, restated for provider observations: an
   * elapsed start time is not evidence that a broadcast happened.
   */
  it("does not call an unobserved episode LIVE however long ago it was due", () => {
    const evidence = evaluateBroadcast(episode(), [], AFTER);
    expect(evidence.state).not.toBe("LIVE");
    expect(evidence.state).not.toBe("COMPLETED");
    expect(evidence.state).toBe("NEEDS_ATTENTION");
  });

  it("does not call an unobserved episode COMPLETED however long ago it was due", () => {
    const wayLater = new Date(AIRED.getTime() + 12 * 3600_000);
    expect(evaluateBroadcast(episode(), [], wayLater).state).toBe("NEEDS_ATTENTION");
  });

  it("stays UPCOMING inside the grace window rather than crying wolf", () => {
    const justAfter = new Date(AIRED.getTime() + UNOBSERVED_GRACE_MS - 60_000);
    const evidence = evaluateBroadcast(episode(), [], justAfter);
    expect(evidence.state).toBe("UPCOMING");
    expect(evidence.attention).toBeNull();
  });

  it("raises attention once the grace window passes with nothing observed", () => {
    const wellAfter = new Date(AIRED.getTime() + UNOBSERVED_GRACE_MS + 60_000);
    const evidence = evaluateBroadcast(episode(), [], wellAfter);
    expect(evidence.state).toBe("NEEDS_ATTENTION");
    expect(evidence.attention).toMatch(/no provider observation/i);
    expect(evidence.readyForPostShow).toBe(false);
  });

  it("is UPCOMING before the scheduled time", () => {
    const before = new Date(AIRED.getTime() - 3600_000);
    expect(evaluateBroadcast(episode(), [], before).state).toBe("UPCOMING");
  });
});

describe("broadcast evidence — LIVE", () => {
  it("Rumble observing a live stream is enough to be LIVE", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [obs("RUMBLE", "LIVE", DURING)],
      DURING,
    );
    expect(evidence.state).toBe("LIVE");
    expect(evidence.reason).toMatch(/SHOW START OBSERVED/);
  });

  it("YouTube observing a live broadcast is independently enough", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [obs("YOUTUBE", "LIVE", DURING, { actualStartTime: AIRED.toISOString() })],
      DURING,
    );
    expect(evidence.state).toBe("LIVE");
    expect(evidence.startedAt?.toISOString()).toBe(AIRED.toISOString());
  });

  it("does not go back to LIVE once the stream has gone", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("RUMBLE", "LIVE", DURING),
        obs("RUMBLE", "OFFLINE", new Date(DURING.getTime() + 60 * 60_000)),
      ],
      AFTER,
    );
    expect(evidence.state).toBe("LIKELY_ENDED");
  });
});

describe("broadcast evidence — ending", () => {
  /** Rumble emits no completion event. Disappearance is all there is. */
  it("infers the end when a previously-live stream disappears", () => {
    const gone = new Date("2026-09-15T19:26:00Z");
    const evidence = evaluateBroadcast(
      episode(),
      [obs("RUMBLE", "LIVE", DURING), obs("RUMBLE", "OFFLINE", gone)],
      AFTER,
    );
    expect(evidence.state).toBe("LIKELY_ENDED");
    expect(evidence.reason).toMatch(/SHOW COMPLETION INFERRED/);
    expect(evidence.readyForPostShow).toBe(true);
  });

  /**
   * A disappearance says the stream is over, not when it ended. Writing the
   * poll time into an end time would invent precision we do not have.
   */
  it("does not invent an end time from an inferred ending", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("RUMBLE", "LIVE", DURING),
        obs("RUMBLE", "OFFLINE", new Date("2026-09-15T19:26:00Z")),
      ],
      AFTER,
    );
    expect(evidence.endedAt).toBeNull();
  });

  it("an OFFLINE with no prior LIVE is not an ending", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [obs("RUMBLE", "OFFLINE", DURING)],
      new Date(AIRED.getTime() + 10 * 60_000),
    );
    expect(evidence.state).toBe("UPCOMING");
    expect(evidence.readyForPostShow).toBe(false);
  });

  it("YouTube actualEndTime is definitive completion", () => {
    const ended = "2026-09-15T19:24:57Z";
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("YOUTUBE", "COMPLETED", AFTER, {
          actualStartTime: "2026-09-15T18:00:08Z",
          actualEndTime: ended,
        }),
      ],
      AFTER,
    );
    expect(evidence.state).toBe("COMPLETED");
    expect(evidence.endedAt?.toISOString()).toBe(new Date(ended).toISOString());
    expect(evidence.readyForPostShow).toBe(true);
  });

  /** Either provider alone must be able to carry the episode forward. */
  it("YouTube completion works with no Rumble evidence at all", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [obs("YOUTUBE", "COMPLETED", AFTER, { actualEndTime: AFTER.toISOString() })],
      AFTER,
    );
    expect(evidence.state).toBe("COMPLETED");
  });

  it("Rumble inference works with no YouTube evidence at all", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("RUMBLE", "LIVE", DURING),
        obs("RUMBLE", "OFFLINE", new Date(DURING.getTime() + 3600_000)),
      ],
      AFTER,
    );
    expect(evidence.readyForPostShow).toBe(true);
  });

  it("definitive completion outranks an inferred ending", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("RUMBLE", "LIVE", DURING),
        obs("RUMBLE", "OFFLINE", new Date("2026-09-15T19:26:00Z")),
        obs("YOUTUBE", "COMPLETED", AFTER, { actualEndTime: "2026-09-15T19:24:57Z" }),
      ],
      AFTER,
    );
    expect(evidence.state).toBe("COMPLETED");
    expect(evidence.endedAt?.toISOString()).toBe("2026-09-15T19:24:57.000Z");
  });
});

describe("broadcast evidence — disagreement", () => {
  it("a provider still reporting live after another reported completion needs a human", () => {
    const completedAt = new Date("2026-09-15T19:30:00Z");
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("YOUTUBE", "COMPLETED", completedAt, {
          actualEndTime: "2026-09-15T19:24:57Z",
        }),
        obs("RUMBLE", "LIVE", new Date(completedAt.getTime() + 120_000)),
      ],
      AFTER,
    );
    expect(evidence.state).toBe("NEEDS_ATTENTION");
    expect(evidence.attention).toMatch(/disagree/i);
    expect(evidence.readyForPostShow).toBe(false);
  });

  it("a stale live report from BEFORE the completion is not a disagreement", () => {
    const evidence = evaluateBroadcast(
      episode(),
      [
        obs("RUMBLE", "LIVE", DURING),
        obs("YOUTUBE", "COMPLETED", AFTER, { actualEndTime: AFTER.toISOString() }),
      ],
      AFTER,
    );
    expect(evidence.state).toBe("COMPLETED");
    expect(evidence.attention).toBeNull();
  });
});

describe("observation keys — replay safety", () => {
  it("the same transition in the same minute produces one key", () => {
    const a = observationKey("RUMBLE", "LIVE", "s1", new Date("2026-09-15T18:00:10Z"));
    const b = observationKey("RUMBLE", "LIVE", "s1", new Date("2026-09-15T18:00:55Z"));
    expect(a).toBe(b);
  });

  it("different minutes, providers, signals and streams produce different keys", () => {
    const base = observationKey("RUMBLE", "LIVE", "s1", new Date("2026-09-15T18:00:10Z"));
    expect(base).not.toBe(
      observationKey("RUMBLE", "LIVE", "s1", new Date("2026-09-15T18:01:10Z")),
    );
    expect(base).not.toBe(
      observationKey("YOUTUBE", "LIVE", "s1", new Date("2026-09-15T18:00:10Z")),
    );
    expect(base).not.toBe(
      observationKey("RUMBLE", "OFFLINE", "s1", new Date("2026-09-15T18:00:10Z")),
    );
    expect(base).not.toBe(
      observationKey("RUMBLE", "LIVE", "s2", new Date("2026-09-15T18:00:10Z")),
    );
  });

  /**
   * A completion has one true time however many polls see it. Its key must not
   * depend on when we happened to notice, or a worker restart would record the
   * same completion twice.
   */
  it("a terminal key ignores when it was noticed", () => {
    expect(terminalObservationKey("YOUTUBE", "COMPLETED", "vid1")).toBe(
      terminalObservationKey("YOUTUBE", "COMPLETED", "vid1"),
    );
    expect(terminalObservationKey("YOUTUBE", "COMPLETED", "vid1")).not.toBe(
      terminalObservationKey("YOUTUBE", "COMPLETED", "vid2"),
    );
  });
});

describe("restart recovery", () => {
  /**
   * The worker may be down for the exact minute a stream ends. Persisted
   * observations must let the NEXT worker reach the same conclusion without
   * having witnessed the transition itself.
   */
  it("reaches the same conclusion from persisted rows alone", () => {
    const persisted = [
      obs("RUMBLE", "LIVE", DURING),
      obs("RUMBLE", "OFFLINE", new Date("2026-09-15T19:26:00Z")),
    ];
    const witnessed = evaluateBroadcast(episode(), persisted, AFTER);
    // A fresh process with no memory, reading the same rows:
    const recovered = evaluateBroadcast(episode(), [...persisted].reverse(), AFTER);
    expect(recovered.state).toBe(witnessed.state);
    expect(recovered.readyForPostShow).toBe(witnessed.readyForPostShow);
  });

  it("is unaffected by replayed duplicate observations", () => {
    const once = [
      obs("YOUTUBE", "COMPLETED", AFTER, { actualEndTime: "2026-09-15T19:24:57Z" }),
    ];
    const twice = [...once, ...once];
    expect(evaluateBroadcast(episode(), twice, AFTER).state).toBe(
      evaluateBroadcast(episode(), once, AFTER).state,
    );
  });
});
