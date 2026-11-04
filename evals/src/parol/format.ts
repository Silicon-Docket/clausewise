/**
 * Plain-text and Markdown helpers shared by the report and the comparison. Every cell that comes
 * from a results file passes through `md`, because a file on disk is input and a cell must not be
 * able to break a table or send a control code to the terminal.
 *
 * A number is printed only when it has a denominator. A rate with none is "n/a", and the counts
 * beside it say "0 of 0", so a reader can see why.
 */
import type { Interval, Rate } from "./stats.js";
import type { RateSummary } from "./score.js";

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text for one table cell or one line: no control codes, no line breaks, no pipes, bounded. */
export function md(value: unknown, max = 200): string {
  const text = String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const cut = text.length > max ? `${text.slice(0, max - 3)}...` : text;
  return cut.replace(/\|/g, "\\|").replace(/`/g, "'");
}

export const NA = "n/a";

export const ratio = (value: number | null, digits = 3): string =>
  value === null ? NA : value.toFixed(digits);

export const intervalText = (ci: Interval | null): string =>
  ci === null ? NA : `${ci.low.toFixed(2)} to ${ci.high.toFixed(2)}`;

export const countsText = (rate: Rate): string => `${rate.numerator} of ${rate.denominator}`;

export const shortSha = (sha: string | null | undefined): string =>
  sha === null || sha === undefined ? NA : sha.slice(0, 12);

export const seconds = (ms: number | null): string => (ms === null ? NA : (ms / 1000).toFixed(2));

export const dollars = (value: number | null): string =>
  value === null ? NA : `$${value.toFixed(4)}`;

export const whole = (value: number | null): string =>
  value === null ? NA : value.toLocaleString("en-US");

/** A signed difference, or n/a when either side has no value. */
export function change(baseline: number | null, candidate: number | null, digits = 3): string {
  if (baseline === null || candidate === null) return NA;
  const delta = candidate - baseline;
  if (Math.abs(delta) < 0.5 * 10 ** -digits) return "0";
  return `${delta > 0 ? "+" : "-"}${Math.abs(delta).toFixed(digits)}`;
}

export interface RateCell {
  /** The mean over repeats with its range, or the single value, or n/a. */
  result: string;
  /** Counts of each repeat. */
  counts: string;
  /** Wilson interval of each repeat. */
  interval: string;
}

/**
 * One metric over the repeats of a run. With one repeat the cell is that repeat's value; with
 * several it is the mean and the range, and the counts and intervals are listed repeat by repeat,
 * because pooling repeats of the same slots would claim a precision the data does not have.
 */
export function rateCell(summary: RateSummary): RateCell {
  const counts = summary.perRepeat.map(countsText).join("; ");
  const interval = summary.perRepeat.map((rate) => intervalText(rate.ci)).join("; ");
  if (summary.mean === null) return { result: NA, counts, interval };
  if (summary.repeats === 1) return { result: ratio(summary.mean), counts, interval };
  const range =
    summary.min === summary.max ? "" : ` (range ${ratio(summary.min)} to ${ratio(summary.max)})`;
  const partial =
    summary.defined < summary.repeats
      ? `, ${summary.defined} of ${summary.repeats} repeats had a value`
      : "";
  return { result: `mean ${ratio(summary.mean)}${range}${partial}`, counts, interval };
}

/** A GitHub-flavoured Markdown table. Cells are used as given, so callers pass them through `md`. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
