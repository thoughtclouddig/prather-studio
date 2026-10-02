/**
 * Polling YouTube for the broadcast lifecycle.
 *
 * This is the second, independent completion signal. Rumble is a good realtime
 * signal but a bad sole one: it emits no completion event, its stream list
 * empties the instant a show ends, and if the worker is down for that minute
 * the transition is never witnessed. YouTube's `liveStreamingDetails` is
 * retrospective — `actualEndTime` is still there an hour later — so it can
 * recover a transition nobody saw happen.
 *
 * Between them the episode can move forward if Rumble is unavailable, if the
 * Rumble URL was rotated, if Rumble was never used for that show, or if the
 * worker restarted at the wrong moment.
 *
 * ## Cadence
 *
 * `videos.list` costs 1 quota unit against a 10,000/day allowance, so cost is
 * not the constraint — pointlessness is. There is nothing to learn at 3 a.m. on
 * a Wednesday, so the poller sleeps unless a show is plausibly happening.
 *
 * | When | Interval | Why |
 * |---|---|---|
 * | > 30 min before the slot | not polled | nothing can have started |
 * | 30 min before → started | 2 min | catch the start promptly |
 * | observed live | 5 min | we know it is live; we want the end |
 * | past the typical run, no end yet | 2 min | the end is the event that matters |
 * | > 3 h past the slot, still nothing | 15 min | probably not happening; keep a slow watch |
 * | completed | stopped | there is nothing left to learn |
 *
 * A whole show at the busiest cadence costs roughly 90 units — under 1% of the
 * daily quota.
 */
import type { BroadcastState } from "./broadcast";

export const POLL_LEAD_MS = 30 * 60_000;
export const POLL_NEAR_START_MS = 2 * 60_000;
export const POLL_WHILE_LIVE_MS = 5 * 60_000;
export const POLL_AWAITING_END_MS = 2 * 60_000;
export const POLL_SLOW_MS = 15 * 60_000;

/** Beyond this past the slot with nothing observed, back off to a slow watch. */
export const POLL_GIVE_UP_LEAN_MS = 3 * 3600_000;

/** Typical show length. Used only to decide when the end becomes interesting. */
export const TYPICAL_SHOW_MS = 85 * 60_000;

export interface PollDecision {
  shouldPoll: boolean;
  /** Suggested delay until the next poll. Null when polling should stop. */
  nextIntervalMs: number | null;
  reason: string;
}

/**
 * Should we ask YouTube about this episode right now, and when again?
 *
 * Pure so the cadence is testable without a network or a clock.
 */
export function decidePoll(
  episode: { scheduledAt: Date | null },
  state: BroadcastState,
  now: Date,
): PollDecision {
  if (state === "COMPLETED") {
    return {
      shouldPoll: false,
      nextIntervalMs: null,
      reason: "Completion already recorded; nothing further to learn.",
    };
  }

  if (state === "LIVE") {
    return {
      shouldPoll: true,
      nextIntervalMs: POLL_WHILE_LIVE_MS,
      reason: "Observed live — watching for the end.",
    };
  }

  const scheduled = episode.scheduledAt;
  if (!scheduled) {
    return {
      shouldPoll: false,
      nextIntervalMs: null,
      reason: "No scheduled time, so there is no window to watch.",
    };
  }

  const untilStart = scheduled.getTime() - now.getTime();

  if (untilStart > POLL_LEAD_MS) {
    return {
      shouldPoll: false,
      // Wake up when the lead window opens rather than idling through the gap.
      nextIntervalMs: untilStart - POLL_LEAD_MS,
      reason: "More than 30 minutes before the slot; nothing can have started.",
    };
  }

  const pastStart = -untilStart;

  if (pastStart < 0) {
    return {
      shouldPoll: true,
      nextIntervalMs: POLL_NEAR_START_MS,
      reason: "Inside the lead window; watching for the start.",
    };
  }

  if (state === "LIKELY_ENDED") {
    return {
      shouldPoll: true,
      nextIntervalMs: POLL_AWAITING_END_MS,
      reason:
        "An ending was inferred from Rumble; asking YouTube for a definitive end time.",
    };
  }

  if (pastStart > POLL_GIVE_UP_LEAN_MS) {
    return {
      shouldPoll: true,
      nextIntervalMs: POLL_SLOW_MS,
      reason:
        "Well past the slot with nothing observed; keeping a slow watch rather than giving up.",
    };
  }

  return {
    shouldPoll: true,
    nextIntervalMs:
      pastStart > TYPICAL_SHOW_MS ? POLL_AWAITING_END_MS : POLL_NEAR_START_MS,
    reason:
      pastStart > TYPICAL_SHOW_MS
        ? "Past the typical run length; the end is the event that matters."
        : "Inside the show window.",
  };
}

/**
 * Translate a YouTube video's live details into a broadcast signal.
 *
 * Returns null when the video says nothing about a live lifecycle — a plain
 * upload, or a livestream whose details have not populated yet. Null is not a
 * failure; it means "no evidence", which is different from "evidence of no".
 */
export interface LiveDetails {
  scheduledStartTime?: string | undefined;
  actualStartTime?: string | undefined;
  actualEndTime?: string | undefined;
  concurrentViewers?: string | undefined;
}

export interface SignalReading {
  signal: "SCHEDULED" | "LIVE" | "COMPLETED";
  at: Date;
  summary: string;
  detail: Record<string, unknown>;
  /** True for a fact with one true time however often it is polled. */
  terminal: boolean;
}

export function readLiveDetails(
  videoId: string,
  live: LiveDetails | null,
  liveBroadcastContent: string | null,
): SignalReading | null {
  if (!live) return null;

  // Strongest first. An end time is retrospective and permanent — this is the
  // signal that lets a restarted worker recover a transition it never saw.
  if (live.actualEndTime) {
    const at = new Date(live.actualEndTime);
    return {
      signal: "COMPLETED",
      at,
      summary: `YouTube actualEndTime ${live.actualEndTime} for video ${videoId}`,
      detail: {
        videoId,
        actualStartTime: live.actualStartTime ?? null,
        actualEndTime: live.actualEndTime,
      },
      terminal: true,
    };
  }

  if (live.actualStartTime) {
    return {
      signal: "LIVE",
      at: new Date(live.actualStartTime),
      summary: `YouTube reports video ${videoId} started at ${live.actualStartTime} and has not ended`,
      detail: {
        videoId,
        actualStartTime: live.actualStartTime,
        concurrentViewers: live.concurrentViewers ?? null,
        liveBroadcastContent,
      },
      // Keyed by start time, so re-polling a still-running stream does not
      // accumulate a row per poll.
      terminal: true,
    };
  }

  if (live.scheduledStartTime) {
    return {
      signal: "SCHEDULED",
      at: new Date(live.scheduledStartTime),
      summary: `YouTube has video ${videoId} scheduled for ${live.scheduledStartTime}`,
      detail: { videoId, scheduledStartTime: live.scheduledStartTime },
      terminal: true,
    };
  }

  return null;
}
