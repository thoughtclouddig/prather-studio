/**
 * Timezone primitives.
 *
 * The Prather Point airs at a fixed WALL-CLOCK time in America/New_York —
 * 2:00 PM Eastern, which is a different UTC instant in summer than in winter.
 * Every calculation here therefore goes through the IANA zone rather than a
 * stored offset, and none of it reads the host's local timezone. A Studio
 * running on a laptop in Arizona and one running on a Replit VM in UTC must
 * agree on which show is next.
 *
 * This module is the single place that does zone arithmetic. Nothing in a
 * component or a page should be converting times by hand.
 */

/** Wall-clock fields in a specific zone. */
export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, in the target zone. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Read an instant's wall-clock fields as seen in `timeZone`. */
export function partsInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  return {
    year: Number(parts["year"]),
    month: Number(parts["month"]),
    day: Number(parts["day"]),
    // Intl renders midnight as "24" in some locales/engines.
    hour: Number(parts["hour"]) % 24,
    minute: Number(parts["minute"]),
    second: Number(parts["second"]),
    weekday: WEEKDAY_INDEX[parts["weekday"] ?? "Sun"] ?? 0,
  };
}

/** Milliseconds `timeZone` is ahead of UTC at `instant`. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = partsInZone(instant, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime()
  );
}

/**
 * The instant at which a given wall-clock time occurs in `timeZone`.
 *
 * Two passes, because the offset needed to answer the question depends on the
 * answer: the first pass guesses using the offset at the naive instant, the
 * second corrects it if that guess landed on the far side of a DST boundary.
 *
 * DST edges, matching how a broadcaster thinks about them:
 *  · Spring forward — 2:30 AM does not exist. Returns the instant the clock
 *    jumps to, so nothing silently lands an hour early.
 *  · Fall back — 1:30 AM happens twice. Returns the FIRST occurrence.
 * Neither affects a 2:00 PM show, but a caller changing the show time should
 * not have to rediscover this.
 */
export function zonedTimeToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0);

  const firstGuess = new Date(asUtc - zoneOffsetMs(new Date(asUtc), timeZone));
  const settled = new Date(asUtc - zoneOffsetMs(firstGuess, timeZone));

  // If the corrected instant reads back as a different wall time, the
  // requested time does not exist (spring forward). Keep the first guess,
  // which is the moment the clock jumps to.
  const readBack = partsInZone(settled, timeZone);
  if (readBack.hour !== wall.hour || readBack.minute !== wall.minute) {
    return firstGuess;
  }
  return settled;
}

/** Parse "14:00" into hour and minute. Throws rather than silently defaulting. */
export function parseWallTime(value: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) throw new Error(`Expected a "HH:MM" time, got "${value}".`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`"${value}" is not a valid time of day.`);
  return { hour, minute };
}

/** Add whole days to a wall-clock date, normalizing month/year rollover. */
export function addDays(
  date: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}
