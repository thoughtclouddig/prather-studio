const TZ = "America/New_York";

export function showDateTime(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
    timeZoneName: "short",
  }).format(value);
}

export function shortDate(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: TZ,
  }).format(value);
}

export function stamp(value: Date | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: TZ,
  }).format(value);
}

export function relative(value: Date | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - value.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

export function countdown(target: Date | null | undefined): string {
  if (!target) return "—";
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return "on air / passed";
  const hours = Math.floor(diff / 3_600_000);
  const mins = Math.floor((diff % 3_600_000) / 60_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${mins}m`;
}

/* ---------------------------------------------------------------- zoning --
 * The show airs at a fixed wall-clock time in ET. An operator in Phoenix
 * editing an episode must not silently shift it, so schedule inputs are read
 * and written in SHOW time, not browser time. No dependency needed — Intl
 * already knows the offsets, including across DST.
 */

export const SHOW_TZ = TZ;

/** Milliseconds that `timeZone` is ahead of UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  const asUtc = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) % 24,
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return asUtc - date.getTime();
}

/** An instant → the `YYYY-MM-DDTHH:mm` a datetime-local input expects, in show time. */
export function toShowInputValue(
  date: Date | null | undefined,
  timeZone = TZ,
): string {
  if (!date) return "";
  return new Date(date.getTime() + zoneOffsetMs(date, timeZone))
    .toISOString()
    .slice(0, 16);
}

/** `YYYY-MM-DDTHH:mm` typed in show time → the instant it refers to. */
export function fromShowInputValue(
  value: string,
  timeZone = TZ,
): Date | null {
  if (!value) return null;
  const naive = new Date(`${value.slice(0, 16)}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;

  // One correction pass, then a second in case the first landed on the far
  // side of a DST transition.
  let instant = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const settled = zoneOffsetMs(instant, timeZone);
  if (settled !== zoneOffsetMs(naive, timeZone)) {
    instant = new Date(naive.getTime() - settled);
  }
  return instant;
}
