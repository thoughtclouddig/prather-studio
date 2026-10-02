/**
 * Waiting for YouTube to finish generating captions.
 *
 * Phase 2 proved `captions.download` works. It did NOT prove captions exist the
 * moment a livestream ends — that experiment ran against a video that had been
 * up for days. Auto-captions are asynchronous provider work: YouTube has to
 * transcode the recording and then run ASR over roughly 90 minutes of audio.
 *
 * So "no caption tracks yet" is the NORMAL state for a while after a show, and
 * treating it as a failure would fill the Jobs page with red on every single
 * episode and train the operator to ignore it. It is a deferral, not an error:
 * the job goes back to PENDING with a later `run_after`, its attempt is not
 * spent, and nothing is marked FAILED.
 *
 * ## The schedule, and why
 *
 * Nothing is gained by asking immediately — YouTube has not started. The first
 * check waits 20 minutes, then the interval widens:
 *
 *     20m, 30m, 45m, 60m, 90m, 120m, 120m, 120m …
 *
 * Cumulative elapsed time at each check:
 *
 *     0:20  0:50  1:35  2:35  4:05  6:05  8:05  10:05  12:05
 *
 * `captions.list` costs 50 quota units, so this whole sequence is ~450 units of
 * a 10,000/day allowance — about 4.5%.
 *
 * ## The escalation threshold: 6 hours
 *
 * Chosen from the real shape of the problem rather than a round number. The
 * show is 85–115 minutes; YouTube's own guidance is that automatic captions
 * for long videos can take several hours, and community reports for 90-minute
 * livestreams cluster well under two. Six hours is comfortably past the point
 * where a healthy pipeline would have delivered, and still the same working day
 * — a Tuesday 2 PM show escalates by 9 PM, not the following morning.
 *
 * Escalation raises Needs Attention. It does NOT stop the retries: captions
 * that arrive at hour seven are still wanted, and the operator having been told
 * is the point.
 */

/** Delay before each successive attempt, in minutes. */
const SCHEDULE_MINUTES = [20, 30, 45, 60, 90, 120];

/** Past this much time since the broadcast ended, tell a human. */
export const CAPTION_ESCALATION_MS = 6 * 3600_000;

/** Cap on the interval once the schedule is exhausted. */
export const CAPTION_MAX_INTERVAL_MS = 120 * 60_000;

export interface CaptionWaitDecision {
  /** How long to wait before looking again. */
  delayMs: number;
  /** True once a human should be told it is taking too long. */
  escalate: boolean;
  /** Operator-facing explanation. Written to Activity. */
  reason: string;
}

/**
 * How long to wait before the next caption check.
 *
 * `attempt` is 1-based: the first call after a show ends is attempt 1.
 * `sinceEndedMs` is time since the broadcast ended, which is what the
 * escalation threshold is measured against — not time since the job was
 * created, which could be much later if the episode was linked after the fact.
 */
export function nextCaptionCheck(
  attempt: number,
  sinceEndedMs: number,
): CaptionWaitDecision {
  const index = Math.max(0, attempt - 1);
  const minutes =
    index < SCHEDULE_MINUTES.length
      ? SCHEDULE_MINUTES[index]!
      : SCHEDULE_MINUTES[SCHEDULE_MINUTES.length - 1]!;
  const delayMs = Math.min(minutes * 60_000, CAPTION_MAX_INTERVAL_MS);

  const escalate = sinceEndedMs >= CAPTION_ESCALATION_MS;
  const hours = (sinceEndedMs / 3600_000).toFixed(1);

  return {
    delayMs,
    escalate,
    reason: escalate
      ? `YouTube still reports no usable caption track ${hours}h after the broadcast ended. ` +
        "Automatic captions normally appear within about two hours for a show this " +
        "length, so this is past the point where it should be looked at. Retries continue."
      : `Captions are not ready yet (${hours}h since the broadcast ended). ` +
        `This is normal; checking again in ${minutes} minutes.`,
  };
}

/**
 * Is this a "not ready yet" condition or a real failure?
 *
 * Only absence is normal. A 403, a malformed response, or a track that
 * downloads empty are all genuine problems and must not be dressed up as
 * patience — the Phase 2 bug where a broken `und` track silently produced an
 * empty transcript is exactly what that would recreate.
 */
export function isAwaitingCaptions(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name !== "CaptionRetrievalError") return false;

  const status = (error as { status?: number }).status;
  // A provider error with a status code is a failure, not a wait.
  if (typeof status === "number") return false;

  return /reports no caption tracks|no usable caption track|all are drafts/i.test(
    error.message,
  );
}
