const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const ISO =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The instant an ISO 8601 date or date and time names, read as UTC when no zone is given and
 * converted when one is. Null for anything else, including a day that does not exist. The
 * components are checked here and not left to `Date`, which rolls 30 February over into March.
 */
export function parseUtcInstant(iso: unknown): Date | null {
  if (typeof iso !== "string") return null;
  const m = ISO.exec(iso.trim());
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hour, minute, second] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const zone = m[7];
  if (zone !== undefined && zone !== "Z") {
    const digits = zone.replace(":", "");
    if (Number(digits.slice(1, 3)) > 23 || Number(digits.slice(3, 5)) > 59) return null;
  }
  const offsetMinutes =
    zone === undefined || zone === "Z"
      ? 0
      : (zone.startsWith("-") ? -1 : 1) *
        (Number(zone.slice(1, 3)) * 60 + Number(zone.replace(":", "").slice(3, 5)));
  const at = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000,
  );
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * "3 November 2026" in UTC, or null when the input is not an ISO 8601 date. The month is spelled
 * out by this code and not by a locale, so the memo reads the same on every machine, and the clock
 * is never consulted.
 */
export function formatUtcDate(iso: unknown): string | null {
  const at = parseUtcInstant(iso);
  if (at === null) return null;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}
