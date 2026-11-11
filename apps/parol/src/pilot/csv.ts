/**
 * The CSV of the pilot measures: long format, one row per number, codes and numbers only.
 *
 * What the file holds. One header row, then one row per measure row, then one row per line of the
 * population table. Every row repeats `scope` (`pilot` or `synthetic`), `calendar_start` (empty
 * with none) and `as_of`, so a row lifted out of the file still says which scope it counts. A row
 * with no data has an empty `value` (never `-`, `n/a` or `0`) and a `reason` code. No row holds a
 * matter id, a run id, a finding id, a user id, a name, a title, a note, a reason text, a location
 * or a quote: the records never carried one (`types.ts`).
 *
 * Formula injection. A spreadsheet reads a cell that begins with `=`, `+`, `-`, `@`, a tab or a
 * carriage return as a formula. `csvCell` is the only place a cell is written, and it puts a single
 * quote in front of any such text (the OWASP rule). The strings in rows come from closed
 * vocabularies and from two lists other code owns (the rule keys of an approved playbook and the
 * reason codes), but the guard applies to every string cell all the same.
 *
 * Numbers are written by one formatter and are never negative: a negative number is a programming
 * error and throws, so a number can never begin with `-` and be taken for text to neutralise.
 */
import { parseInstant } from "./calendar.js";
import type { MeasureRow, PilotMeasures, PilotScope, Unit } from "./types.js";

export const CSV_COLUMNS = [
  "scope",
  "calendar_start",
  "as_of",
  "measure",
  "breakdown",
  "key",
  "numerator",
  "denominator",
  "value",
  "unit",
  "min",
  "max",
  "status",
  "reason",
] as const;

/** Lines end with CRLF (RFC 4180), and so does the last one. */
const EOL = "\r\n";

// Characters a spreadsheet skips before it decides whether a cell is a formula: spaces, no-break
// spaces and the other white space and control characters.
const LEADING =
  /^[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*/u;
const CONTROL = /[\u0000-\u001f\u007f]/gu;

/** A number as it is written in a cell: whole, or with at most four decimals and no trailing zero. */
export function csvNumber(value: number, decimals: 1 | 4 = 4): string {
  if (!Number.isFinite(value)) throw new RangeError("a CSV number is finite");
  if (value < 0 || Object.is(value, -0)) throw new RangeError("a CSV number is not negative");
  if (Number.isInteger(value) && decimals !== 1) return String(value);
  const fixed = value.toFixed(decimals === 1 ? 1 : 4);
  return decimals === 1 ? fixed : fixed.replace(/\.?0+$/u, "");
}

/** One cell, ready to put between commas. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return csvNumber(value);

  // (1) The check looks at the original text, before control characters are blanked.
  const first = value.charAt(0);
  const afterBlanks = value.replace(LEADING, "").charAt(0);
  const beginsLikeAFormula =
    first === "\t" || first === "\r" || (afterBlanks !== "" && "=+-@".includes(afterBlanks));
  let text = beginsLikeAFormula ? `'${value}` : value;

  // (2) A cell is one line: every control character becomes a space.
  text = text.replace(CONTROL, " ");

  // (3) RFC 4180 quoting.
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** `value`, `min` and `max` are written in the unit of the row: minutes to one decimal, the rest to four. */
const numberOf = (value: number | null, unit: Unit): string =>
  value === null ? "" : csvNumber(value, unit === "minutes" ? 1 : 4);

const line = (cells: readonly (string | number | null)[]): string =>
  cells.map(csvCell).join(",") + EOL;

function measureLine(prefix: readonly string[], row: MeasureRow): string {
  return line([
    ...prefix,
    row.measure,
    row.breakdown,
    row.key,
    row.numerator,
    row.denominator,
    row.status === "value" ? numberOf(row.value, row.unit) : null,
    row.unit,
    numberOf(row.min, row.unit),
    numberOf(row.max, row.unit),
    row.status,
    row.reason,
  ]);
}

export function toCsv(measures: PilotMeasures): string {
  const prefix = [measures.scope, measures.calendar?.startDate ?? "", measures.asOf];
  const out = [line([...CSV_COLUMNS])];
  for (const row of measures.rows) out.push(measureLine(prefix, row));
  for (const { code, count } of measures.population) {
    out.push(
      line([
        ...prefix,
        "population",
        "count",
        code,
        count,
        null,
        null,
        "count",
        null,
        null,
        "value",
        null,
      ]),
    );
  }
  return out.join("");
}

/**
 * `parol-pilot-measures-pilot-2026-02-10.csv`, or `parol-pilot-measures-SYNTHETIC-2026-02-10.csv`
 * for the synthetic scope, so that a file lifted out of its folder still says what it is. The date
 * is the UTC date of `asOf`. The name is plain characters only (the download header checks it).
 */
export function csvFileName(scope: PilotScope, asOf: string): string {
  parseInstant(asOf); // throws RangeError for anything but an ISO time in UTC
  const day = asOf.slice(0, 10);
  const word = scope === "synthetic" ? "SYNTHETIC" : "pilot";
  return `parol-pilot-measures-${word}-${day}.csv`;
}
