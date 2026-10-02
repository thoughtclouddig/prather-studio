/**
 * Observations → evidence → broadcast state.
 *
 * This module answers one question: given what providers actually told us,
 * what do we believe happened to this broadcast?
 *
 * It is NOT a second episode-state model. `classifyEpisode` in `schedule.ts`
 * remains responsible for the canonical episode's relationship to the clock —
 * whether it is ahead of us or behind us. This module supplies the evidence
 * that `classifyEpisode` treats as "we know what happened", and nothing here
 * may promote an episode on the strength of elapsed time alone.
 *
 * The governing rule, carried forward from commit cb1e8a1 unchanged:
 *
 *     The clock decides whether something is in the future.
 *     Observation decides what actually happened.
 *
 * Two failure modes this is shaped against:
 *
 *  1. RUMBLE AS A SINGLE POINT OF TRUTH. Rumble has no completion event; a
 *     stream simply stops being listed. If the worker is down for that minute
 *     the transition is never witnessed. So YouTube's `actualEndTime` is a
 *     parallel, independent and *stronger* signal, and either path alone can
 *     carry an episode forward.
 *
 *  2. TIME AS PROOF. A show that was scheduled for 2 PM and is now four hours
 *     past does not thereby become LIVE or COMPLETED. It becomes a question
 *     for a human. Time only ever contributes to a WARNING.
 */
import type { BroadcastObservation, BroadcastSignal, Episode } from "@/db/schema";

/** Evidence, ordered weakest to strongest. Used to resolve disagreement. */
const SIGNAL_WEIGHT: Record<BroadcastSignal, number> = {
  SCHEDULED: 0,
  LIVE: 1,
  OFFLINE: 2,
  COMPLETED: 3,
};

export type BroadcastState =
  /** Scheduled ahead of us, nothing observed yet. */
  | "UPCOMING"
  /** A provider reports the stream is live right now. */
  | "LIVE"
  /**
   * Observed live, then the stream disappeared. Rumble's only available end
   * signal. Good enough to start post-show work, not a definitive end time.
   */
  | "LIKELY_ENDED"
  /** A provider gave a real end time. Definitive. */
  | "COMPLETED"
  /** Providers disagree, or the window passed with nothing observed at all. */
  | "NEEDS_ATTENTION";

export interface BroadcastEvidence {
  state: BroadcastState;
  /** Why, in the operator's language. Written to Activity, not just logs. */
  reason: string;
  /** Provider-reported end, when one exists. Never inferred from the clock. */
  endedAt: Date | null;
  /** Provider-reported start, when one exists. */
  startedAt: Date | null;
  /** Whether post-show work (captions, packaging) may begin. */
  readyForPostShow: boolean;
  /** Set when a human needs to look. Feeds Needs Attention. */
  attention: string | null;
  /** The observations that produced this conclusion, strongest first. */
  basis: BroadcastObservation[];
}

/**
 * How long after a scheduled start we wait before calling an unobserved show
 * a problem.
 *
 * The show runs 85–115 minutes and both providers are polled every minute, so
 * 30 minutes of total silence is already well past any plausible transient. It
 * is generous enough that a late start or a brief provider outage does not
 * raise a false alarm, and short enough that an operator finds out during the
 * show rather than the next morning.
 */
export const UNOBSERVED_GRACE_MS = 30 * 60_000;

type Observationish = Pick<
  BroadcastObservation,
  "provider" | "signal" | "externalId" | "observedAt" | "summary" | "detail"
> &
  Partial<BroadcastObservation>;

function latest<T extends { observedAt: Date }>(rows: T[]): T | undefined {
  return [...rows].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())[0];
}

/**
 * Interpret the evidence for one episode.
 *
 * `now` is passed rather than read so that this is a pure function and the
 * tests can put it wherever they need it.
 */
export function evaluateBroadcast(
  episode: Pick<Episode, "scheduledAt" | "phase">,
  observations: Observationish[],
  now: Date,
): BroadcastEvidence {
  const sorted = [...observations].sort(
    (a, b) =>
      b.observedAt.getTime() - a.observedAt.getTime() ||
      SIGNAL_WEIGHT[b.signal] - SIGNAL_WEIGHT[a.signal],
  ) as BroadcastObservation[];

  const completed = sorted.filter((o) => o.signal === "COMPLETED");
  const live = sorted.filter((o) => o.signal === "LIVE");
  const offline = sorted.filter((o) => o.signal === "OFFLINE");

  // ---- Strongest evidence first: somebody gave us a real end time. --------
  if (completed.length > 0) {
    const best = latest(completed)!;
    const endedAt = readTime(best.detail, "actualEndTime") ?? best.observedAt;
    const startedAt =
      readTime(best.detail, "actualStartTime") ?? latest(live)?.observedAt ?? null;

    // A provider still reporting LIVE *after* another reported completion is a
    // real disagreement, not a stale poll. Say so instead of picking a winner.
    const contradicting = live.filter(
      (o) => o.observedAt.getTime() > best.observedAt.getTime(),
    );
    if (contradicting.length > 0) {
      const who = [...new Set(contradicting.map((o) => o.provider))].join(", ");
      return {
        state: "NEEDS_ATTENTION",
        reason:
          `${best.provider} reported the broadcast completed at ` +
          `${endedAt.toISOString()}, but ${who} reported it still live afterwards.`,
        endedAt,
        startedAt,
        readyForPostShow: false,
        attention: `${best.provider} and ${who} disagree about whether the show has ended.`,
        basis: [best, ...contradicting],
      };
    }

    return {
      state: "COMPLETED",
      reason: `SHOW COMPLETION OBSERVED — ${best.summary}`,
      endedAt,
      startedAt,
      readyForPostShow: true,
      attention: null,
      basis: [best],
    };
  }

  // ---- A provider says it is live right now. ------------------------------
  const newestLive = latest(live);
  const newestOffline = latest(offline);

  if (
    newestLive &&
    (!newestOffline || newestOffline.observedAt <= newestLive.observedAt)
  ) {
    return {
      state: "LIVE",
      reason: `SHOW START OBSERVED — ${newestLive.summary}`,
      endedAt: null,
      startedAt: readTime(newestLive.detail, "actualStartTime") ?? newestLive.observedAt,
      readyForPostShow: false,
      attention: null,
      basis: [newestLive],
    };
  }

  // ---- Observed live, then gone. Rumble's only end signal. ----------------
  if (newestLive && newestOffline && newestOffline.observedAt > newestLive.observedAt) {
    return {
      state: "LIKELY_ENDED",
      reason: `SHOW COMPLETION INFERRED — ${newestOffline.summary}`,
      // Deliberately null: a stream disappearing tells us it is over, not when
      // it ended. Writing the poll time into airedAt would invent precision.
      endedAt: null,
      startedAt: newestLive.observedAt,
      readyForPostShow: true,
      attention: null,
      basis: [newestOffline, newestLive],
    };
  }

  // ---- Nothing observed. The clock may only raise a question. -------------
  const scheduled = episode.scheduledAt;
  if (!scheduled) {
    return {
      state: "UPCOMING",
      reason: "No scheduled time and no provider observation.",
      endedAt: null,
      startedAt: null,
      readyForPostShow: false,
      attention: null,
      basis: [],
    };
  }

  const pastBy = now.getTime() - scheduled.getTime();
  if (pastBy > UNOBSERVED_GRACE_MS) {
    const minutes = Math.floor(pastBy / 60_000);
    return {
      // NOT "COMPLETED", and NOT "LIVE". Time is not proof that a broadcast
      // happened — this is precisely the regression cb1e8a1 fixed.
      state: "NEEDS_ATTENTION",
      reason:
        `Scheduled start passed ${minutes} minutes ago and no provider has ` +
        "reported this broadcast. The Studio does not know whether it aired.",
      endedAt: null,
      startedAt: null,
      readyForPostShow: false,
      attention: `Expected show time passed ${minutes} minutes ago with no provider observation.`,
      basis: [],
    };
  }

  return {
    state: "UPCOMING",
    reason:
      pastBy > 0
        ? "Scheduled start has just passed; waiting for a provider to report it."
        : "Scheduled ahead of us.",
    endedAt: null,
    startedAt: null,
    readyForPostShow: false,
    attention: null,
    basis: [],
  };
}

function readTime(detail: unknown, key: string): Date | null {
  if (!detail || typeof detail !== "object") return null;
  const value = (detail as Record<string, unknown>)[key];
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ------------------------------------------------------------- dedupe keys */

/**
 * The key that makes replay harmless.
 *
 * A worker that restarts and re-polls will re-see the same facts. Keying on
 * (provider, signal, external id, the provider's own timestamp) means the
 * second write collides instead of adding a duplicate row. The timestamp is
 * rounded to the minute so two polls seconds apart describing the same
 * transition do not both land.
 */
export function observationKey(
  provider: string,
  signal: BroadcastSignal,
  externalId: string | null,
  at: Date,
): string {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  return `${provider}:${signal}:${externalId ?? "-"}:${minute}`;
}

/**
 * For a signal that should exist at most once per broadcast regardless of when
 * we noticed it — a completion has one true time, however many polls see it.
 */
export function terminalObservationKey(
  provider: string,
  signal: BroadcastSignal,
  externalId: string,
): string {
  return `${provider}:${signal}:${externalId}:terminal`;
}
