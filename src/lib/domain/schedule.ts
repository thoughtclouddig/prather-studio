/**
 * Show scheduling and episode-state selection.
 *
 * The bug this module exists to prevent: the Dashboard and the Episodes filter
 * both used `airedAt === null` to mean "hasn't happened yet". But `airedAt` is
 * only ever written by the Rumble observer, so an episode nobody observed kept
 * a null `airedAt` forever and therefore stayed "upcoming" forever — which is
 * how a 8 September show was still being shown as NEXT SHOW on 14 September.
 *
 * Absence of evidence is not evidence of absence. The rule here is that the
 * clock decides whether something is in the future; observation decides what
 * happened to it; and when the two disagree the episode is UNRESOLVED and a
 * human is told, rather than the system picking a story.
 */
import type { Episode, EpisodePhase } from "@/db/schema";
import { addDays, parseWallTime, partsInZone, zonedTimeToInstant } from "@/lib/time/zone";

/** Phases meaning "this episode's broadcast is behind us". */
const TERMINAL_PHASES: ReadonlySet<EpisodePhase> = new Set<EpisodePhase>([
  "RELEASED",
  "ARCHIVED",
]);

/** Phases meaning "we have positive evidence the show happened". */
const POST_BROADCAST_PHASES: ReadonlySet<EpisodePhase> = new Set<EpisodePhase>([
  "CAPTURING",
  "PRODUCING",
  "REVIEW",
  "RELEASED",
  "ARCHIVED",
]);

/** The minimum an episode needs for scheduling decisions. */
export interface SchedulableEpisode {
  id: string;
  scheduledAt: Date | null;
  airedAt: Date | null;
  phase: EpisodePhase;
}

/* ------------------------------------------------------------ cadence */

export interface Cadence {
  /** Weekdays the show airs. 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Wall-clock start in `timeZone`, e.g. "14:00". */
  startTime: string;
  /** IANA zone. Never a fixed UTC offset — the show follows the clock, not UTC. */
  timeZone: string;
}

export interface ExpectedSlot {
  startsAt: Date;
  timeZone: string;
}

/**
 * The next time the show is expected to air, from the cadence alone.
 *
 * This PREDICTS a slot. It does not create anything — a slot is not an
 * episode, and the Studio must never invent phantom episodes because the
 * calendar says a show usually happens. A human creates the episode.
 *
 * Boundary behaviour is "the slot is next until it starts": at 1:00 PM on a
 * Tuesday the answer is that same Tuesday at 2:00 PM; at exactly 2:00 PM and
 * after, it rolls to Thursday.
 */
export function getNextExpectedShowSlot(
  now: Date,
  cadence: Cadence,
  lookaheadDays = 21,
): ExpectedSlot | null {
  if (cadence.days.length === 0) return null;

  const { hour, minute } = parseWallTime(cadence.startTime);
  const today = partsInZone(now, cadence.timeZone);
  const wanted = new Set(cadence.days);

  for (let offset = 0; offset <= lookaheadDays; offset++) {
    const date = addDays(today, offset);
    // Weekday of the candidate date, read back in the target zone so the
    // answer cannot drift with the host's locale.
    const probe = zonedTimeToInstant({ ...date, hour: 12, minute: 0 }, cadence.timeZone);
    if (!wanted.has(partsInZone(probe, cadence.timeZone).weekday)) continue;

    const startsAt = zonedTimeToInstant({ ...date, hour, minute }, cadence.timeZone);
    if (startsAt.getTime() > now.getTime()) {
      return { startsAt, timeZone: cadence.timeZone };
    }
  }
  return null;
}

/** Parse the stored cadence, tolerating a show row that predates the column. */
export function cadenceFrom(show: {
  cadenceDays?: number[] | null;
  defaultStartTime: string;
  timezone: string;
}): Cadence {
  return {
    days: show.cadenceDays?.length ? show.cadenceDays : [2, 4], // Tue, Thu
    startTime: show.defaultStartTime || "14:00",
    timeZone: show.timezone || "America/New_York",
  };
}

/* -------------------------------------------------- episode classification */

export type EpisodeTiming =
  /** Scheduled in the future. */
  | "UPCOMING"
  /** Observed live right now. */
  | "LIVE"
  /** Start time has passed and we have evidence of what happened. */
  | "RESOLVED"
  /**
   * Start time has passed and we do NOT know whether it aired. Not upcoming,
   * not complete — an operator task. This is the state that used to be
   * silently mislabelled "upcoming".
   */
  | "PAST_UNRESOLVED"
  /** No scheduled time at all. */
  | "UNSCHEDULED";

export function classifyEpisode(episode: SchedulableEpisode, now: Date): EpisodeTiming {
  if (episode.phase === "LIVE") return "LIVE";
  if (!episode.scheduledAt) return "UNSCHEDULED";

  if (episode.scheduledAt.getTime() > now.getTime()) {
    // A future episode already marked released or archived is contradictory;
    // trust the evidence over the calendar.
    return TERMINAL_PHASES.has(episode.phase) ? "RESOLVED" : "UPCOMING";
  }

  // The start time has passed. Do we know what happened?
  if (episode.airedAt) return "RESOLVED";
  if (POST_BROADCAST_PHASES.has(episode.phase)) return "RESOLVED";
  return "PAST_UNRESOLVED";
}

export const isUpcoming = (e: SchedulableEpisode, now: Date) =>
  classifyEpisode(e, now) === "UPCOMING";

export const isPastUnresolved = (e: SchedulableEpisode, now: Date) =>
  classifyEpisode(e, now) === "PAST_UNRESOLVED";

/* ------------------------------------------------------------ selection */

/**
 * The episode on air right now.
 *
 * Only a LIVE phase qualifies, and LIVE is only ever set by an observer that
 * actually saw the stream. A scheduled time passing does not make a show live.
 */
export function selectCurrentShow<T extends SchedulableEpisode>(
  episodes: T[],
): T | null {
  return episodes.find((e) => e.phase === "LIVE") ?? null;
}

/**
 * The next show: the EARLIEST genuinely future episode.
 *
 * Ordering is by scheduled time and nothing else — not phase, not insertion
 * order, not episode number. A past episode can never be selected, whatever
 * its phase says.
 */
export function selectNextShow<T extends SchedulableEpisode>(
  episodes: T[],
  now: Date,
): T | null {
  return (
    episodes
      .filter((e) => isUpcoming(e, now))
      .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime())[0] ?? null
  );
}

/** Past-dated episodes we cannot account for. Operator tasks, oldest first. */
export function selectPastUnresolved<T extends SchedulableEpisode>(
  episodes: T[],
  now: Date,
): T[] {
  return episodes
    .filter((e) => isPastUnresolved(e, now))
    .sort((a, b) => a.scheduledAt!.getTime() - b.scheduledAt!.getTime());
}

/* ------------------------------------------------------------- countdown */

export type CountdownState =
  | { kind: "counting"; label: string }
  | { kind: "live"; label: string }
  /**
   * The scheduled moment has passed with no observation. Deliberately NOT
   * "on air / passed", which claimed knowledge the Studio does not have.
   */
  | { kind: "overdue"; label: string }
  | { kind: "none"; label: string };

export function countdownTo(
  target: Date | null | undefined,
  now: Date,
  opts: { isLive?: boolean } = {},
): CountdownState {
  if (opts.isLive) return { kind: "live", label: "LIVE" };
  if (!target) return { kind: "none", label: "—" };

  const diff = target.getTime() - now.getTime();
  if (diff <= 0) return { kind: "overdue", label: "START TIME PASSED" };

  const minutes = Math.floor(diff / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return { kind: "counting", label: `${days}d ${hours}h ${mins}m` };
  if (hours > 0) return { kind: "counting", label: `${hours}h ${mins}m` };
  return { kind: "counting", label: `${mins}m` };
}
