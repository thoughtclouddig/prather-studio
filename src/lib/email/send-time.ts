/**
 * When the briefing is scheduled to go out.
 *
 * ## Why this is a setting and not a constant
 *
 * The send time is a WALL-CLOCK time in a named zone — "11:00 in
 * America/Phoenix" — resolved against the day the show airs. It is never an
 * offset, and never a gap measured back from air time. Both of those shortcuts
 * break, and they break silently, in opposite directions:
 *
 *  · **An offset breaks because the zone is Arizona.** Arizona does not
 *    observe DST, so America/Phoenix is -07:00 every day of the year. Storing
 *    "-07:00" would look correct through the summer and stay correct — until
 *    someone reasonably "fixed" it to America/Denver, which does shift, and
 *    the briefing moved an hour in November with nothing in the code to
 *    explain why.
 *
 *  · **A gap from air time breaks because the show is Eastern.** The
 *    broadcast is 2:00 PM Eastern, which shifts with DST while Arizona does
 *    not. So the distance between the email and the show is NOT fixed:
 *
 *        October   2:00 PM EDT = 11:00 Phoenix  → the email lands as it starts
 *        December  2:00 PM EST = 12:00 Phoenix  → the email lands an hour early
 *
 *    That hour is a real editorial change, not a rounding error. Deriving the
 *    send time from air time would quietly hold the gap constant and move the
 *    clock time instead — the opposite of what was asked for.
 *
 * So: the operator sets a clock time in a zone, and this resolves it per
 * episode. `gapToAirMinutes` reports the distance that results, so the shift
 * is visible in the Studio on the day it happens rather than discovered from a
 * subscriber's reply.
 */
import {
  parseWallTime,
  partsInZone,
  zonedTimeToInstant,
} from "@/lib/time/zone";

/** 11:00 Arizona — as the show starts through the summer. */
export const DEFAULT_SEND_TIME = "11:00";

/**
 * Arizona. Not America/Denver: Denver observes DST and Phoenix does not, so
 * the two agree all summer and differ by an hour from November. Picking the
 * wrong one is a bug that cannot be caught by testing in October.
 */
export const DEFAULT_SEND_ZONE = "America/Phoenix";

export interface SendTimeInput {
  /** The episode's air instant. Its date IN THE SEND ZONE picks the day. */
  scheduledAt: Date;
  /** "HH:MM" wall clock. Falls back to the default when unset. */
  sendTime?: string | null;
  /** IANA zone. Falls back to the default when unset. */
  sendTimezone?: string | null;
  /** For deciding whether the slot has passed. Injected so tests are stable. */
  now?: Date;
}

export interface ResolvedSendTime {
  /** The instant the campaign should go out. */
  at: Date;
  zone: string;
  wallTime: string;
  /** "11:00 AM MST" — what an operator should see, in the zone they set. */
  label: string;
  /** Minutes before air. Negative means the email lands after the show starts. */
  gapToAirMinutes: number;
  /** True when that slot is already behind us and Mailchimp would refuse it. */
  isPast: boolean;
}

export class SendTimeError extends Error {}

/**
 * Resolve the send instant for one episode.
 *
 * The show's DATE is read in the send zone rather than UTC. An 11:00 Phoenix
 * send and a 2:00 PM Eastern show fall on the same calendar day, but a show
 * late enough to cross midnight UTC would otherwise resolve to the day before
 * and send the briefing a full day early.
 */
export function resolveSendTime(input: SendTimeInput): ResolvedSendTime {
  const zone = (input.sendTimezone ?? "").trim() || DEFAULT_SEND_ZONE;
  const wallTime = (input.sendTime ?? "").trim() || DEFAULT_SEND_TIME;

  let hour: number;
  let minute: number;
  try {
    ({ hour, minute } = parseWallTime(wallTime));
  } catch {
    throw new SendTimeError(
      `The email send time is set to "${wallTime}", which is not a time of day. ` +
        `Use 24-hour "HH:MM", for example "11:00".`,
    );
  }

  let airParts;
  try {
    airParts = partsInZone(input.scheduledAt, zone);
  } catch {
    throw new SendTimeError(
      `"${zone}" is not a timezone this system recognises. Use an IANA name, ` +
        `for example "America/Phoenix".`,
    );
  }

  const at = zonedTimeToInstant(
    { year: airParts.year, month: airParts.month, day: airParts.day, hour, minute },
    zone,
  );

  const now = input.now ?? new Date();

  return {
    at,
    zone,
    wallTime,
    label: formatInZone(at, zone),
    gapToAirMinutes: Math.round((input.scheduledAt.getTime() - at.getTime()) / 60_000),
    isPast: at.getTime() <= now.getTime(),
  };
}

/** "11:00 AM MST" — the abbreviation included, because MST is the whole point. */
export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(instant);
}

/**
 * Describe the gap in words, for the Studio.
 *
 * Phrased so the November shift reads as information rather than as a fault:
 * the operator sees "an hour before the show starts" change to "as the show
 * starts" and knows immediately that nothing is broken.
 */
export function describeGap(gapToAirMinutes: number): string {
  if (gapToAirMinutes === 0) return "as the show starts";
  if (gapToAirMinutes > 0) {
    const hours = Math.floor(gapToAirMinutes / 60);
    const minutes = gapToAirMinutes % 60;
    const parts = [
      hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
      minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return `${parts.join(" ")} before the show starts`;
  }
  const after = Math.abs(gapToAirMinutes);
  const hours = Math.floor(after / 60);
  const minutes = after % 60;
  const parts = [
    hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return `${parts.join(" ")} AFTER the show starts`;
}
