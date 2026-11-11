import { isStandInProvider } from "../../stand-in.js";

/**
 * Dates, sizes and counts as people read them. Everything is computed in UTC from the ISO text the
 * services return, never from the clock or the locale of the machine, so a page renders the same
 * everywhere. A value that cannot be read gives a fixed phrase and never echoes the input.
 */
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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export const UNKNOWN_DATE = "unknown date";

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Date parts in UTC, or null. An offset such as +02:00 is applied, so the result is UTC. */
function partsOf(value: string): Parts | null {
  const only = DATE_ONLY.exec(value);
  if (only !== null) {
    const [year, month, day] = [Number(only[1]), Number(only[2]), Number(only[3])];
    return validDay(year, month, day) ? { year, month, day, hour: 0, minute: 0 } : null;
  }
  const full = DATE_TIME.exec(value);
  if (full === null) return null;
  const [year, month, day] = [Number(full[1]), Number(full[2]), Number(full[3])];
  const [hour, minute] = [Number(full[4]), Number(full[5])];
  if (!validDay(year, month, day) || hour > 23 || minute > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const at = new Date(ms);
  return {
    year: at.getUTCFullYear(),
    month: at.getUTCMonth() + 1,
    day: at.getUTCDate(),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
  };
}

/** `15 September 2026`, from `2026-09-15` or a full ISO time. */
export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN_DATE;
  const p = partsOf(value);
  if (p === null) return UNKNOWN_DATE;
  return `${p.day} ${MONTHS[p.month - 1] ?? ""} ${p.year}`;
}

/** `3 November 2026, 14:05 UTC`. */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined) return UNKNOWN_DATE;
  const p = partsOf(value);
  if (p === null) return UNKNOWN_DATE;
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${p.day} ${MONTHS[p.month - 1] ?? ""} ${p.year}, ${hh}:${mm} UTC`;
}

/** The value for `<input type="date">`: `2026-09-15`, or an empty string when there is none. */
export function dateInputValue(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return DATE_ONLY.test(value) && partsOf(value) !== null ? value : "";
}

/** `812 bytes`, `14 KB`, `1.2 MB`. Decimal units, as file managers show them. */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "unknown size";
  const n = Math.floor(size);
  if (n < 1000) return n === 1 ? "1 byte" : `${n} bytes`;
  const units = ["KB", "MB", "GB"] as const;
  let value = n;
  let unit = "bytes";
  for (const next of units) {
    value /= 1000;
    unit = next;
    if (value < 1000) break;
  }
  const text = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return `${text} ${unit}`;
}

/** The first characters of a hex digest, for display next to a full value elsewhere. */
export function shortHash(sha: string, length = 8): string {
  return /^[0-9a-f]+$/i.test(sha) ? sha.slice(0, length) : "";
}

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Which model answered a review, in words. The provider names the model in its responses, and the
 * name may differ from the one that was asked for (an alias that moved to a newer snapshot), so
 * both are shown when they differ. A program that stands in for a model is said to be one, with its
 * name; it is not described as a model, and the stand-in banner of the run page says the rest.
 */
export function modelLine(model: {
  provider: string;
  requested: string;
  reported: string | null;
}): string {
  if (isStandInProvider(model.provider))
    return `Read by a scripted stand-in (${model.provider}, ${model.requested})`;
  if (model.reported === null)
    return `Requested ${model.requested}; the provider did not say which model answered`;
  if (model.reported === model.requested) return `Answered by ${model.reported}`;
  return `Answered by ${model.reported} (requested ${model.requested})`;
}
