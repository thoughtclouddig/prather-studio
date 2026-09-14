/**
 * Matching a Rumble livestream to a canonical Episode.
 *
 * The evidence hierarchy is deliberate and comes from what the two signals are
 * actually worth:
 *
 *   PRIMARY    start-time proximity. The show has a fixed slot, Rumble reports
 *              when a stream went live, and the two agree to within minutes.
 *   SECONDARY  title similarity. Useful as corroboration, unreliable alone —
 *              Phase 3's Buzzsprout correlation found that only 6 of 15 recent
 *              podcast titles matched the YouTube title for the same recording,
 *              and Jeff retitles freely between platforms.
 *
 * If exactly one episode is a strong candidate, it is linked. If two are
 * plausible, or none is, the answer is Needs Attention. The Studio never picks
 * between plausible episodes — a wrong link silently attaches a transcript, an
 * AI package and eventually a publication to the wrong show.
 */
import { titleSimilarity } from "@/lib/integrations/youtube/matching";

/** Inside this, the times agree well enough to stand on their own. */
export const STRONG_PROXIMITY_MS = 45 * 60_000;

/** Beyond this, proximity says nothing and the episode is not a candidate. */
export const MAX_PROXIMITY_MS = 6 * 3600_000;

/** Title agreement at or above this corroborates a weak time match. */
export const TITLE_CORROBORATION = 0.5;

export interface MatchableEpisode {
  id: string;
  workingTitle: string;
  approvedTitle: string | null;
  scheduledAt: Date | null;
}

export interface RumbleCandidate {
  episode: MatchableEpisode;
  /** Distance from the episode's slot to the stream's live interval. */
  proximityMs: number;
  titleScore: number;
  /** 0–1. Time-led, with title able to lift a weak time match. */
  confidence: number;
  reasons: string[];
}

export interface RumbleMatchResult {
  candidates: RumbleCandidate[];
  /** Set only when exactly one candidate is strong and no other is close. */
  matched: RumbleCandidate | null;
  /** Set when a human must choose. Never both this and `matched`. */
  ambiguous: string | null;
}

/**
 * How far the episode's slot is from the window during which the stream was
 * live — NOT from a single instant.
 *
 * Two readings of "when the stream happened" are available and neither is
 * trustworthy alone. Rumble's `created_on` is when the stream OBJECT was
 * created, which for a scheduled broadcast can be hours before it goes live;
 * the poll time is somewhere in the middle of the show and drifts later the
 * longer the show runs. Measuring from either instant alone produces false
 * negatives: an early-created stream looks hours off, and a two-hour show
 * looks further from its slot the longer it goes on.
 *
 * Treating the stream as the interval [created, observed] and asking how far
 * the slot is from that interval is correct under both readings. A slot inside
 * the interval scores zero, which is what "this stream is the show" means.
 */
export function slotProximityMs(
  scheduledAt: Date,
  stream: { startedAt: Date; observedAt: Date },
): number {
  const slot = scheduledAt.getTime();
  const from = Math.min(stream.startedAt.getTime(), stream.observedAt.getTime());
  const to = Math.max(stream.startedAt.getTime(), stream.observedAt.getTime());
  if (slot >= from && slot <= to) return 0;
  return slot < from ? from - slot : slot - to;
}

export interface ObservedStream {
  title: string;
  /** Rumble's `created_on` for the stream. */
  startedAt: Date;
  /** When this poll saw it live. Defaults to the start when not supplied. */
  observedAt?: Date;
}

export function scoreRumbleCandidate(
  episode: MatchableEpisode,
  stream: ObservedStream,
): RumbleCandidate | null {
  if (!episode.scheduledAt) return null;

  const observedAt = stream.observedAt ?? stream.startedAt;
  const proximityMs = slotProximityMs(episode.scheduledAt, {
    startedAt: stream.startedAt,
    observedAt,
  });
  if (proximityMs > MAX_PROXIMITY_MS) return null;

  const titleScore = Math.max(
    titleSimilarity(stream.title, episode.workingTitle),
    episode.approvedTitle ? titleSimilarity(stream.title, episode.approvedTitle) : 0,
  );

  // Time carries the decision; title can only add to it. A stream that starts
  // in the slot is the episode even if Jeff typed a different title into
  // StreamYard, which he routinely does.
  const timeScore = proximityMs <= STRONG_PROXIMITY_MS
    ? 1 - (proximityMs / STRONG_PROXIMITY_MS) * 0.15
    : Math.max(0, 0.55 - (proximityMs - STRONG_PROXIMITY_MS) / MAX_PROXIMITY_MS);

  const confidence = Math.min(1, timeScore + titleScore * 0.25);

  const reasons: string[] = [];
  const mins = Math.round(proximityMs / 60_000);
  reasons.push(
    proximityMs === 0
      ? "Was live across the scheduled slot"
      : proximityMs <= STRONG_PROXIMITY_MS
        ? `Live within ${mins} min of the scheduled slot`
        : `Live ${mins} min from the scheduled slot — outside the usual window`,
  );
  if (titleScore >= TITLE_CORROBORATION) {
    reasons.push(`Title agrees (${Math.round(titleScore * 100)}%)`);
  } else if (titleScore > 0) {
    reasons.push(`Title differs (${Math.round(titleScore * 100)}% overlap)`);
  } else {
    reasons.push("Title shares nothing with the episode");
  }

  return { episode, proximityMs, titleScore, confidence, reasons };
}

export function matchRumbleStream(
  episodes: MatchableEpisode[],
  stream: ObservedStream,
): RumbleMatchResult {
  const candidates = episodes
    .map((e) => scoreRumbleCandidate(e, stream))
    .filter((c): c is RumbleCandidate => c !== null)
    .sort((a, b) => b.confidence - a.confidence);

  if (candidates.length === 0) {
    return {
      candidates,
      matched: null,
      ambiguous:
        `Rumble is live ("${stream.title}") but no episode is scheduled within ` +
        "6 hours of when it started. Create or reschedule the episode, then link it.",
    };
  }

  const best = candidates[0]!;
  const runnerUp = candidates[1];

  // Two episodes in the same window is exactly the case where guessing is
  // worst: both are plausible, and the wrong one silently collects the
  // transcript and the AI package.
  if (runnerUp && best.confidence - runnerUp.confidence < 0.15) {
    return {
      candidates,
      matched: null,
      ambiguous:
        `Rumble is live ("${stream.title}") and ${candidates.length} episodes are ` +
        "plausible. Confirm which one this is — the Studio will not choose.",
    };
  }

  if (best.proximityMs > STRONG_PROXIMITY_MS && best.titleScore < TITLE_CORROBORATION) {
    return {
      candidates,
      matched: null,
      ambiguous:
        `Rumble is live ("${stream.title}") but the nearest episode started ` +
        `${Math.round(best.proximityMs / 60_000)} minutes away and the titles do not ` +
        "agree. Confirm the link.",
    };
  }

  return { candidates, matched: best, ambiguous: null };
}
