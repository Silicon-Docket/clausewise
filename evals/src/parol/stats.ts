/**
 * Small statistics for the Parol metrics. Pure functions, no input or output.
 *
 * A rate whose denominator is zero has no value: it is null, never 1 and never 0, because "no
 * flagged slot was missed" is a different statement from "there was no flagged slot".
 */

export interface Interval {
  low: number;
  high: number;
}

/** The 97.5th percentile of the standard normal distribution, for a two-sided 95 percent interval. */
export const Z95 = 1.959963984540054;

/**
 * The Wilson score interval for a proportion. It stays inside [0, 1] and is not degenerate at 0
 * or n successes, which matters here: the held-out set has 18 expected flags, and 17 of 18 gives
 * about 0.74 to 0.99, not the "0.94 plus or minus" a normal approximation would print.
 *
 * Null when `n` is zero. Throws for counts that are not whole numbers with 0 <= successes <= n,
 * because an out-of-range count is a bug in the caller and not something to clamp.
 */
export function wilson(successes: number, n: number, z: number = Z95): Interval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || n < 0 || successes < 0) {
    throw new RangeError("wilson: counts must be whole numbers, not negative");
  }
  if (successes > n) throw new RangeError("wilson: successes exceed the sample size");
  if (n === 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    low: successes === 0 ? 0 : Math.max(0, centre - half),
    high: successes === n ? 1 : Math.min(1, centre + half),
  };
}

/** A count over a denominator, with its value and interval. The counts are the evidence. */
export interface Rate {
  numerator: number;
  denominator: number;
  /** Null when the denominator is zero. */
  value: number | null;
  /** Wilson 95 percent interval. Null when the denominator is zero. */
  ci: Interval | null;
}

export function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    ci: wilson(numerator, denominator),
  };
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * The p-th percentile by the nearest-rank method: the smallest value such that at least p percent
 * of the values are at or below it. It always returns one of the values, so a p95 of 36 runs is
 * the 35th slowest and never an interpolation between two runs. `p` is between 0 and 100.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 100)) throw new RangeError("percentile: p must be between 0 and 100");
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export interface NumberSummary {
  n: number;
  min: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summarizeNumbers(values: readonly number[]): NumberSummary {
  return {
    n: values.length,
    min: values.length === 0 ? null : Math.min(...values),
    mean: mean(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

/** Comparison slack for thresholds, so that 18 of 20 against 0.9 is not decided by rounding. */
export const EPSILON = 1e-9;
export const atLeast = (value: number, threshold: number): boolean => value >= threshold - EPSILON;
export const atMost = (value: number, threshold: number): boolean => value <= threshold + EPSILON;
