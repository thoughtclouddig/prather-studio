/**
 * Episode ↔ YouTube video matching.
 *
 * This module RANKS candidates. It never attaches one. A wrong link would put
 * an approved title onto someone else's video, so the decision stays with a
 * human — the scoring exists to make that decision fast, not to make it
 * automatically.
 */
import type { YouTubeVideo } from "./client";

export interface MatchCandidate {
  video: YouTubeVideo;
  score: number;
  confidence: "strong" | "possible" | "weak";
  reasons: string[];
  /** Other candidates that are the same broadcast uploaded more than once. */
  duplicateOf?: string[];
  /** Within a duplicate group, the copy with the most views. */
  isMostWatchedCopy?: boolean;
}

export interface MatchTarget {
  workingTitle: string;
  approvedTitle: string | null;
  scheduledAt: Date | null;
  airedAt: Date | null;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "it",
  "with", "that", "this", "at", "by", "from", "as", "was", "were", "be",
]);

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity over meaningful title words. 0…1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  let shared = 0;
  for (const token of ta) if (tb.has(token)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Score one video against one episode.
 *
 * Air-date proximity dominates: the show is a scheduled twice-weekly
 * livestream, so "which day did this go out" is far more reliable evidence
 * than title wording, which the packaging step is about to rewrite anyway.
 */
export function scoreCandidate(target: MatchTarget, video: YouTubeVideo): MatchCandidate {
  const reasons: string[] = [];
  let score = 0;

  // The instant the show actually began, when YouTube knows it.
  const videoTime = new Date(
    video.live?.actualStartTime ?? video.live?.scheduledStartTime ?? video.publishedAt,
  );
  const episodeTime = target.airedAt ?? target.scheduledAt;

  if (episodeTime) {
    const hours = Math.abs(videoTime.getTime() - episodeTime.getTime()) / 3_600_000;
    if (hours <= 3) {
      score += 60;
      reasons.push(`Within ${hours.toFixed(1)}h of the episode's air time`);
    } else if (hours <= 12) {
      score += 40;
      reasons.push(`Same day (${hours.toFixed(1)}h apart)`);
    } else if (hours <= 36) {
      score += 18;
      reasons.push(`About a day apart (${hours.toFixed(1)}h)`);
    } else if (hours <= 24 * 7) {
      score += 4;
      reasons.push(`Same week (${Math.round(hours / 24)}d apart)`);
    } else {
      reasons.push(`${Math.round(hours / 24)} days from the episode's air time`);
    }
  }

  const bestTitle = target.approvedTitle ?? target.workingTitle;
  const similarity = Math.max(
    titleSimilarity(bestTitle, video.title),
    titleSimilarity(target.workingTitle, video.title),
  );
  if (similarity > 0) {
    score += Math.round(similarity * 35);
    reasons.push(`Title overlap ${Math.round(similarity * 100)}%`);
  }

  // A completed livestream is what a Prather Point episode actually is.
  if (video.live?.actualEndTime) {
    score += 5;
    reasons.push("Completed livestream");
  }

  const confidence: MatchCandidate["confidence"] =
    score >= 70 ? "strong" : score >= 35 ? "possible" : "weak";

  return { video, score, confidence, reasons };
}

/** The instant a video actually went to air, when YouTube knows it. */
function airedAt(video: YouTubeVideo): Date {
  return new Date(
    video.live?.actualStartTime ?? video.live?.scheduledStartTime ?? video.publishedAt,
  );
}

/** Strip emoji, punctuation and repeated spaces so near-identical titles compare equal. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TWO_MINUTES = 120_000;
const near = (a: number, b: number, tolerance = TWO_MINUTES) => Math.abs(a - b) < tolerance;

/**
 * Two uploads of the same broadcast.
 *
 * The JP Intel channel really does carry these. Linking the wrong copy means
 * updating metadata on a video nobody watches while the real one keeps its old
 * title.
 *
 * The primary signal is the broadcast WINDOW — same start and same end. Two
 * genuinely different shows cannot share both. Title and duration are only a
 * fallback for non-livestream uploads, because the real pair differed by a
 * trailing emoji in the title and by one second of duration, which defeated an
 * earlier version that compared those for equality.
 */
export function areDuplicates(a: YouTubeVideo, b: YouTubeVideo): boolean {
  if (a.id === b.id) return false;

  const aEnd = a.live?.actualEndTime;
  const bEnd = b.live?.actualEndTime;
  if (aEnd && bEnd) {
    return (
      near(airedAt(a).getTime(), airedAt(b).getTime()) &&
      near(new Date(aEnd).getTime(), new Date(bEnd).getTime())
    );
  }

  // Not livestreams: fall back to the same moment plus a matching title or
  // near-identical runtime.
  if (!near(airedAt(a).getTime(), airedAt(b).getTime())) return false;
  if (normalizeTitle(a.title) === normalizeTitle(b.title)) return true;
  return (
    !!a.durationSeconds &&
    !!b.durationSeconds &&
    Math.abs(a.durationSeconds - b.durationSeconds) <= 5 &&
    titleSimilarity(a.title, b.title) > 0.6
  );
}

/**
 * Rank candidates.
 *
 * `ambiguous` is true when the top two are close enough that a human could
 * reasonably pick either. The caller must not auto-attach when it is set — it
 * is the signal that produces a Needs Attention item instead.
 *
 * Note this deliberately does NOT require the leader to be confident. An
 * earlier version suppressed the warning when the best match was only "weak",
 * which had it exactly backwards: a low-confidence near-tie is the case most
 * in need of a human, not least.
 */
export function rankCandidates(
  target: MatchTarget,
  videos: YouTubeVideo[],
  limit = 5,
): {
  candidates: MatchCandidate[];
  ambiguous: boolean;
  duplicates: MatchCandidate[][];
  best: MatchCandidate | null;
} {
  const ranked = videos
    .map((video) => scoreCandidate(target, video))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Group duplicate uploads so the UI can say so rather than showing two
  // identical-looking rows and leaving the operator to spot it.
  const groups: MatchCandidate[][] = [];
  const claimed = new Set<string>();
  for (const candidate of ranked) {
    if (claimed.has(candidate.video.id)) continue;
    const group = ranked.filter(
      (other) =>
        other.video.id === candidate.video.id ||
        (!claimed.has(other.video.id) && areDuplicates(candidate.video, other.video)),
    );
    if (group.length > 1) {
      // Views are the only reliable way to tell which copy the audience uses.
      // Upload order is not a guide: on the live channel the popular copy was
      // the later upload in one pair and the earlier one in the other.
      const mostWatched = group.reduce((a, b) =>
        (b.video.viewCount ?? -1) > (a.video.viewCount ?? -1) ? b : a,
      );
      for (const member of group) {
        claimed.add(member.video.id);
        member.duplicateOf = group
          .filter((m) => m.video.id !== member.video.id)
          .map((m) => m.video.id);
        member.isMostWatchedCopy = member.video.id === mostWatched.video.id;
      }
      groups.push(group);
    }
  }

  const [best, runnerUp] = ranked;
  const nearTie = !!best && !!runnerUp && best.score - runnerUp.score < 15;

  return {
    candidates: ranked,
    ambiguous: nearTie || groups.length > 0,
    duplicates: groups,
    best: best ?? null,
  };
}
