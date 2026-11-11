/**
 * The pilot calendar: which of the five pilot weeks a moment falls in, and which phase that week is.
 *
 * Everything is UTC (`Date.UTC`), so a week does not move with a time zone or a daylight saving
 * change. Week `n` covers days `7(n-1)` to `7n-1` counted from 00:00:00.000Z of the start date.
 *
 * Strictness. The database only holds ISO strings that its own clock wrote and start dates that the
 * store checked, so a string that is not one is a fixture bug and must be loud: it throws
 * `RangeError`. `Date.parse` is not used on its own, because it reads "2026-02-30" as 2 March and
 * "24:00:00" as midnight of the next day, and reads a string without a zone in local time.
 */
import { PHASE_OF_WEEK, PILOT_WEEKS, type Phase } from "./types.js";

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

/** Midnight UTC of a real calendar date, in milliseconds; throws `RangeError` for anything else. */
function dateMs(year: number, month: number, day: number, what: string): number {
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (
    Number.isNaN(ms) ||
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    throw new RangeError(`${what} is not a real calendar date`);
  }
  return ms;
}

/** A start date, `YYYY-MM-DD`, as the milliseconds of its midnight UTC. */
export function parseStartDate(startDate: string): number {
  const match = DATE_RE.exec(startDate);
  if (match === null) throw new RangeError("a start date is written year-month-day");
  return dateMs(Number(match[1]), Number(match[2]), Number(match[3]), "the start date");
}

/**
 * An ISO instant as written by `Date.prototype.toISOString` (`YYYY-MM-DDTHH:MM:SS.sssZ`, the
 * fraction optional), as milliseconds since the epoch.
 */
export function parseInstant(at: string): number {
  const match = INSTANT_RE.exec(at);
  if (match === null) throw new RangeError("a timestamp is written as an ISO time in UTC");
  const [, y, mo, d, h, mi, s, ms] = match;
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new RangeError("a timestamp has a real time of day");
  }
  const midnight = dateMs(Number(y), Number(mo), Number(d), "a timestamp");
  return midnight + ((hour * 60 + minute) * 60 + second) * 1000 + Number(ms ?? "0");
}

export type WindowPosition = "no_calendar" | "before" | "within" | "after";

/** Where a moment lies against the five pilot weeks. */
export function windowPosition(calendar: { startDate: string } | null, at: string): WindowPosition {
  const moment = parseInstant(at);
  if (calendar === null) return "no_calendar";
  const offset = moment - parseStartDate(calendar.startDate);
  if (offset < 0) return "before";
  return offset < PILOT_WEEKS * 7 * DAY_MS ? "within" : "after";
}

/** 1 to `PILOT_WEEKS` inside the window, otherwise null (also null with no calendar). */
export function pilotWeekOf(calendar: { startDate: string } | null, at: string): number | null {
  if (windowPosition(calendar, at) !== "within" || calendar === null) return null;
  const offset = parseInstant(at) - parseStartDate(calendar.startDate);
  return Math.floor(offset / (7 * DAY_MS)) + 1;
}

/** Week 1 is the baseline, week 2 training and shadow mode, weeks 3 to 5 assisted use. */
export function phaseOfWeek(week: number): Phase {
  const phase = Number.isInteger(week) ? PHASE_OF_WEEK[week - 1] : undefined;
  if (phase === undefined) throw new RangeError("a pilot week is a whole number from 1 to 5");
  return phase;
}

/** The last day (YYYY-MM-DD, inclusive) of week `PILOT_WEEKS`. */
export function calendarEnd(startDate: string): string {
  return new Date(parseStartDate(startDate) + (PILOT_WEEKS * 7 - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * The first moment after the pilot (00:00:00.000Z of the day after `calendarEnd`). A matter whose
 * retention date is earlier than this moment is deleted before the pilot is over.
 */
export function windowEnd(startDate: string): string {
  return new Date(parseStartDate(startDate) + PILOT_WEEKS * 7 * DAY_MS).toISOString();
}
