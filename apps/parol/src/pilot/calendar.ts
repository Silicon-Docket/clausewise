/**
 * The pilot calendar: which of the five pilot weeks a moment falls in, and which phase that week is.
 *
 * Everything is UTC, so a week does not move with a time zone or a daylight saving change. Week `n`
 * covers days `7(n-1)` to `7n-1` counted from 00:00:00.000Z of the start date.
 *
 * Strictness. The database only holds ISO strings that its own clock wrote and start dates that the
 * store checked, so a string that is not one is a fixture bug and must be loud: it throws
 * `RangeError`. `Date.parse` is not used on its own, because it reads "2026-02-30" as 2 March and
 * "24:00:00" as midnight of the next day, and reads a string without a zone in local time.
 * `Date.UTC` is not used for the year either, because it reads the years 0 to 99 as 1900 to 1999:
 * a date is built with `setUTCFullYear`, which takes the year as written.
 *
 * Which start dates exist. There is one definition, `isUsableStartDate`, and the store, the form
 * and this module all use it: a real calendar day of the years 1000 to 9999 (four digits that are
 * what they say), whose five weeks and the moment after them also lie in those years, so that every
 * date the pilot reaches is written by `toISOString` with four digits and read back by
 * `parseInstant`. The latest start date is therefore `START_DATE_MAX`, not the last day of 9999.
 */
import { PHASE_OF_WEEK, PILOT_WEEKS, type Phase } from "./types.js";

const DAY_MS = 86_400_000;
/** The five weeks, in milliseconds. */
const PILOT_MS = PILOT_WEEKS * 7 * DAY_MS;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

/** The first and the last year that a start date, and every moment of the pilot, may be in. */
const FIRST_YEAR = 1000;
const LAST_YEAR = 9999;

/**
 * Midnight UTC of a real calendar date, in milliseconds; throws `RangeError` for anything else. The
 * year is set as written (`setUTCFullYear`), so a year below 100 is not read as 19xx.
 */
function dateMs(year: number, month: number, day: number, what: string): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const ms = date.getTime();
  if (
    Number.isNaN(ms) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError(`${what} is not a real calendar date`);
  }
  return ms;
}

/** The last millisecond of the last year a pilot moment may be in. */
const LAST_MOMENT_MS = dateMs(LAST_YEAR, 12, 31, "the last day") + DAY_MS - 1;

/** The first and the last start date that can be used: the year 1000 begins, the five weeks fit. */
export const START_DATE_MIN = `${FIRST_YEAR}-01-01`;
export const START_DATE_MAX = new Date(LAST_MOMENT_MS - PILOT_MS).toISOString().slice(0, 10);

/** A start date, `YYYY-MM-DD`, as the milliseconds of its midnight UTC. */
export function parseStartDate(startDate: string): number {
  const match = DATE_RE.exec(startDate);
  if (match === null) throw new RangeError("a start date is written year-month-day");
  const year = Number(match[1]);
  const ms = dateMs(year, Number(match[2]), Number(match[3]), "the start date");
  if (year < FIRST_YEAR || ms + PILOT_MS > LAST_MOMENT_MS) {
    throw new RangeError(
      `the start date and its ${PILOT_WEEKS} weeks are not within the years ${FIRST_YEAR} to ${LAST_YEAR}`,
    );
  }
  return ms;
}

/** Whether `value` is a start date the pilot can be counted from: the one definition of a valid one. */
export function isUsableStartDate(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    parseStartDate(value);
    return true;
  } catch {
    return false;
  }
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
  return offset < PILOT_MS ? "within" : "after";
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
  return new Date(parseStartDate(startDate) + PILOT_MS).toISOString();
}
