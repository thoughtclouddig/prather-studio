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

/**
 * Rank candidates.
 *
 * `ambiguous` is true when the top two are close enough that a human could
 * reasonably pick either. The caller must not auto-attach when it is set — it
 * is the signal that produces a Needs Attention item instead.
 */
export function rankCandidates(
  target: MatchTarget,
  videos: YouTubeVideo[],
  limit = 5,
): { candidates: MatchCandidate[]; ambiguous: boolean; best: MatchCandidate | null } {
  const ranked = videos
    .map((video) => scoreCandidate(target, video))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const [best, runnerUp] = ranked;
  const ambiguous =
    !!best &&
    !!runnerUp &&
    best.confidence !== "weak" &&
    best.score - runnerUp.score < 15;

  return { candidates: ranked, ambiguous, best: best ?? null };
}
