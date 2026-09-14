/**
 * Matching a canonical Episode to a real Buzzsprout episode.
 *
 * ## The evidence hierarchy, measured rather than assumed
 *
 * Phase 3 correlated 16 recent podcast episodes against the YouTube broadcasts
 * of the same shows (`docs/PHASE-3-INVESTIGATION.md` §4). For 15 of 16 there
 * was exactly one candidate satisfying both a date window and a duration
 * window, and the numbers were startlingly consistent:
 *
 *   DURATION   The MP3 runs 7-9 s LONGER than the video, median 8 s, every
 *              single time. That is the YouTube ingest handshake: the
 *              broadcast's `actualStartTime` is consistently 7-8 s after its
 *              `scheduledStartTime`, so the encoder's own recording is longer
 *              by exactly that margin. It is the strongest key available.
 *
 *   PUBLISH    Always 2 or 5 days after the broadcast — the podcast runs
 *              exactly one show slot behind. Never 0, never 1, never 3.
 *
 *   TITLE      Matched only 6 of 15. Jeff retitles freely for the podcast.
 *              A matcher that leads with title similarity WILL mis-link.
 *
 * So duration leads, the publish window qualifies, and title is a tiebreaker
 * only. This is the opposite of what a reasonable person would guess, which is
 * exactly why it was measured.
 *
 * ## Caution on first use
 *
 * Phase 3 §24 requires caution even when a match looks confident, because the
 * cost of being wrong is silent: the wrong podcast episode acquires our
 * approved metadata and is overwritten. `requiresConfirmation` therefore
 * returns true for a first link regardless of score. Confidence decides how
 * good the suggestion is, never whether to act without a human.
 */
import { titleSimilarity } from "@/lib/integrations/youtube/matching";

/** The measured offset: the MP3 is longer than the video by about this much. */
export const EXPECTED_DURATION_OFFSET_S = 8;

/** Tolerance around that offset. Observed spread was 7-9 s; this is generous. */
export const DURATION_TOLERANCE_S = 25;

/**
 * The podcast runs one slot behind. Observed lags were exactly 2 and 5 days.
 *
 * The lower bound is not a heuristic, it is physics: a podcast episode cannot
 * be published before the broadcast it contains has finished. Running this
 * matcher against the live account caught a candidate published TWO HOURS
 * BEFORE the broadcast it was being offered for — it belonged to the previous
 * show. Rounding the lag to whole days had displayed that as "0 days after",
 * which read as plausible. Fractional comparison against the broadcast's end
 * is exact and needs no tolerance.
 */
export const MAX_PUBLISH_LAG_DAYS = 9;

export interface CanonicalForMatch {
  /** When the broadcast actually aired. Null blocks date qualification. */
  airedAt: Date | null;
  /** The VIDEO duration in seconds. The MP3 is expected to be ~8 s longer. */
  videoDurationSeconds: number | null;
  title: string;
}

export interface BuzzsproutForMatch {
  id: number;
  title: string;
  publishedAt: string | null;
  durationSeconds: number | null;
}

export interface BuzzsproutCandidate {
  episode: BuzzsproutForMatch;
  /** MP3 minus video. Expected near +8. */
  durationDeltaSeconds: number | null;
  publishLagDays: number | null;
  titleScore: number;
  confidence: number;
  reasons: string[];
  /** Fails a hard qualifier — shown, but never auto-suggested. */
  disqualified: string | null;
}

export interface BuzzsproutMatchResult {
  candidates: BuzzsproutCandidate[];
  /** The single best suggestion, or null when nothing qualifies. */
  best: BuzzsproutCandidate | null;
  ambiguous: string | null;
  /** Always true for a first link. See the note above. */
  requiresConfirmation: boolean;
}

export function scoreBuzzsproutCandidate(
  canonical: CanonicalForMatch,
  candidate: BuzzsproutForMatch,
): BuzzsproutCandidate {
  const reasons: string[] = [];
  let disqualified: string | null = null;

  /* ---- duration: the strong key ---------------------------------------- */
  let durationScore = 0;
  let durationDeltaSeconds: number | null = null;

  if (canonical.videoDurationSeconds != null && candidate.durationSeconds != null) {
    durationDeltaSeconds = candidate.durationSeconds - canonical.videoDurationSeconds;
    const error = Math.abs(durationDeltaSeconds - EXPECTED_DURATION_OFFSET_S);

    if (error <= DURATION_TOLERANCE_S) {
      durationScore = 1 - (error / DURATION_TOLERANCE_S) * 0.35;
      reasons.push(
        `Runs ${durationDeltaSeconds >= 0 ? "+" : ""}${durationDeltaSeconds}s against the video ` +
          `(expected about +${EXPECTED_DURATION_OFFSET_S}s)`,
      );
    } else {
      // Off by minutes is a different recording, not a different encode.
      disqualified = `Duration differs by ${Math.round(durationDeltaSeconds / 60)} min from the broadcast`;
      reasons.push(disqualified);
    }
  } else {
    reasons.push("Duration unavailable on one side — cannot use the strongest key");
  }

  /* ---- publish window: the qualifier ----------------------------------- */
  let publishLagDays: number | null = null;
  let dateScore = 0;

  if (canonical.airedAt && candidate.publishedAt) {
    const published = new Date(candidate.publishedAt);
    if (!Number.isNaN(published.getTime())) {
      const lagMs = published.getTime() - canonical.airedAt.getTime();
      publishLagDays = Math.round(lagMs / 86_400_000);

      // The broadcast has to have FINISHED before its audio can be published.
      // Compared on the instant, not the rounded day: a podcast published two
      // hours before the show started rounds to "0 days after" and reads as
      // plausible, which is exactly how the wrong episode gets linked.
      const runtimeMs = (canonical.videoDurationSeconds ?? 0) * 1000;
      const endedAtMs = canonical.airedAt.getTime() + runtimeMs;

      if (published.getTime() < endedAtMs) {
        const hours = Math.round((endedAtMs - published.getTime()) / 3_600_000);
        const why =
          `Published ${hours}h BEFORE this broadcast finished — it cannot contain ` +
          "this show's audio";
        disqualified ??= why;
        reasons.push(why);
      } else if (publishLagDays <= MAX_PUBLISH_LAG_DAYS) {
        dateScore = 1;
        reasons.push(
          `Published ${publishLagDays} day(s) after the broadcast` +
            (publishLagDays === 2 || publishLagDays === 5
              ? " — the usual one-slot lag"
              : ""),
        );
      } else {
        const why = `Published ${publishLagDays} days after the broadcast — the podcast runs one slot behind, not ${publishLagDays} days`;
        disqualified ??= why;
        reasons.push(why);
      }
    }
  } else {
    reasons.push("No air date on one side — publish window cannot qualify it");
  }

  /* ---- title: tiebreaker only ------------------------------------------ */
  const titleScore = titleSimilarity(canonical.title, candidate.title);
  reasons.push(
    titleScore >= 0.6
      ? `Title agrees (${Math.round(titleScore * 100)}%)`
      : `Title differs (${Math.round(titleScore * 100)}% overlap) — expected; only 6 of 15 matched`,
  );

  // Duration dominates, the date window qualifies, title nudges. Weighted so a
  // perfect title can never outrank a duration mismatch.
  const confidence = Math.min(
    1,
    durationScore * 0.65 + dateScore * 0.25 + titleScore * 0.1,
  );

  return {
    episode: candidate,
    durationDeltaSeconds,
    publishLagDays,
    titleScore,
    confidence: disqualified ? Math.min(confidence, 0.25) : confidence,
    reasons,
    disqualified,
  };
}

export function matchBuzzsproutEpisode(
  canonical: CanonicalForMatch,
  candidates: BuzzsproutForMatch[],
): BuzzsproutMatchResult {
  const scored = candidates
    .map((c) => scoreBuzzsproutCandidate(canonical, c))
    .sort((a, b) => b.confidence - a.confidence);

  const qualified = scored.filter((c) => !c.disqualified);

  if (qualified.length === 0) {
    return {
      candidates: scored.slice(0, 8),
      best: null,
      ambiguous:
        "No Buzzsprout episode matches this broadcast on duration and publish " +
        "date. The podcast usually appears one show slot later, so it may simply " +
        "not be up yet.",
      requiresConfirmation: true,
    };
  }

  const best = qualified[0]!;
  const runnerUp = qualified[1];

  if (runnerUp && best.confidence - runnerUp.confidence < 0.12) {
    return {
      candidates: scored.slice(0, 8),
      best: null,
      ambiguous:
        `${qualified.length} Buzzsprout episodes fit this broadcast equally well. ` +
        "Confirm which one — attaching the wrong episode would overwrite a real " +
        "podcast entry with another show's metadata.",
      requiresConfirmation: true,
    };
  }

  return {
    candidates: scored.slice(0, 8),
    best,
    ambiguous: null,
    // Always. A confident suggestion is still a suggestion.
    requiresConfirmation: true,
  };
}
