import { describe, expect, it } from "vitest";
import {
  EPSILON,
  Z95,
  atLeast,
  atMost,
  mean,
  percentile,
  rate,
  summarizeNumbers,
  wilson,
} from "../src/parol/stats.js";

/**
 * The Wilson interval is the set of proportions p0 that a score test at 95 percent does not
 * reject: |phat - p0| <= z * sqrt(p0 (1 - p0) / n). This finds its ends by bisection on that
 * inequality, which shares no code or algebra with the closed form in the implementation.
 */
function byBisection(successes: number, n: number): { low: number; high: number } {
  const phat = successes / n;
  const outside = (p0: number): boolean =>
    Math.abs(phat - p0) > Z95 * Math.sqrt((p0 * (1 - p0)) / n);
  let low = 0;
  if (successes > 0) {
    let a = 0;
    let b = phat;
    for (let i = 0; i < 200; i++) {
      const m = (a + b) / 2;
      if (outside(m)) a = m;
      else b = m;
    }
    low = (a + b) / 2;
  }
  let high = 1;
  if (successes < n) {
    let a = phat;
    let b = 1;
    for (let i = 0; i < 200; i++) {
      const m = (a + b) / 2;
      if (outside(m)) b = m;
      else a = m;
    }
    high = (a + b) / 2;
  }
  return { low, high };
}

describe("wilson", () => {
  it("gives the interval document 5 quotes for 17 of 18, about 0.74 to 0.99", () => {
    const interval = wilson(17, 18)!;
    expect(interval.low).toBeCloseTo(0.7424, 4);
    expect(interval.high).toBeCloseTo(0.9901, 4);
  });

  it.each([
    // [successes, n, low, high], from published tables of the Wilson score interval
    [5, 10, 0.2366, 0.7634],
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [81, 263, 0.2553, 0.3662],
    [16, 18, 0.672, 0.969],
    [18, 20, 0.699, 0.9721],
  ])("%i of %i is %f to %f", (successes, n, low, high) => {
    const interval = wilson(successes, n)!;
    expect(interval.low).toBeCloseTo(low, 3);
    expect(interval.high).toBeCloseTo(high, 3);
  });

  it("agrees with an independent inversion of the score test on every count up to 40", () => {
    for (let n = 1; n <= 40; n++) {
      for (let s = 0; s <= n; s++) {
        const closed = wilson(s, n)!;
        const inverted = byBisection(s, n);
        expect(closed.low).toBeCloseTo(inverted.low, 9);
        expect(closed.high).toBeCloseTo(inverted.high, 9);
      }
    }
  });

  it("stays inside [0, 1], touches the ends only at 0 and n, and contains the estimate", () => {
    for (let n = 1; n <= 30; n++) {
      for (let s = 0; s <= n; s++) {
        const { low, high } = wilson(s, n)!;
        expect(low).toBeGreaterThanOrEqual(0);
        expect(high).toBeLessThanOrEqual(1);
        expect(low).toBeLessThanOrEqual(s / n);
        expect(high).toBeGreaterThanOrEqual(s / n);
        expect(low === 0).toBe(s === 0);
        expect(high === 1).toBe(s === n);
      }
    }
  });

  it("narrows as the sample grows for the same proportion", () => {
    const width = (s: number, n: number): number => {
      const { low, high } = wilson(s, n)!;
      return high - low;
    };
    expect(width(90, 100)).toBeLessThan(width(9, 10));
    expect(width(900, 1000)).toBeLessThan(width(90, 100));
  });

  it("has no interval for an empty sample, and refuses counts that make no sense", () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 2)).toThrow(RangeError);
    expect(() => wilson(1.5, 4)).toThrow(RangeError);
    expect(() => wilson(1, 4.5)).toThrow(RangeError);
  });
});

describe("rate", () => {
  it("carries the counts, the value and the interval", () => {
    const r = rate(17, 18);
    expect(r.numerator).toBe(17);
    expect(r.denominator).toBe(18);
    expect(r.value).toBeCloseTo(17 / 18, 12);
    expect(r.ci).toEqual(wilson(17, 18));
  });

  it("gives null, never 1 and never 0, when the denominator is zero", () => {
    expect(rate(0, 0)).toEqual({ numerator: 0, denominator: 0, value: null, ci: null });
  });

  it("gives 0 for none of some and 1 for all of some", () => {
    expect(rate(0, 4).value).toBe(0);
    expect(rate(4, 4).value).toBe(1);
  });
});

describe("percentile (nearest rank)", () => {
  it("returns one of the values: the smallest with at least p percent at or below it", () => {
    const values = [15, 20, 35, 40, 50];
    expect(percentile(values, 30)).toBe(20); // ceil(0.3 * 5) = 2nd
    expect(percentile(values, 40)).toBe(20); // ceil(0.4 * 5) = 2nd
    expect(percentile(values, 50)).toBe(35); // ceil(0.5 * 5) = 3rd
    expect(percentile(values, 100)).toBe(50);
    expect(percentile(values, 0)).toBe(15);
  });

  it("does not depend on the order of the input", () => {
    expect(percentile([50, 15, 40, 20, 35], 50)).toBe(35);
  });

  it("takes the 19th of 20 for p95 and the 35th of 36", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(twenty, 95)).toBe(19);
    const thirtySix = Array.from({ length: 36 }, (_, i) => (i + 1) * 10);
    expect(percentile(thirtySix, 95)).toBe(350);
    expect(percentile(thirtySix, 50)).toBe(180);
  });

  it("is the value itself for one value, null for none", () => {
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("refuses a p outside 0 to 100", () => {
    expect(() => percentile([1], 101)).toThrow(RangeError);
    expect(() => percentile([1], -1)).toThrow(RangeError);
  });
});

describe("mean and summarizeNumbers", () => {
  it("averages, and has no mean of nothing", () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeNull();
  });

  it("summarises a list", () => {
    expect(summarizeNumbers([4, 1, 3, 2])).toEqual({
      n: 4,
      min: 1,
      mean: 2.5,
      p50: 2,
      p95: 4,
      max: 4,
    });
  });

  it("has nothing to report for no values", () => {
    expect(summarizeNumbers([])).toEqual({
      n: 0,
      min: null,
      mean: null,
      p50: null,
      p95: null,
      max: null,
    });
  });
});

describe("threshold comparison", () => {
  it("treats a value on the threshold as meeting it, whichever side rounding falls on", () => {
    expect(atLeast(0.9, 0.9)).toBe(true);
    expect(atLeast(0.9 - EPSILON / 2, 0.9)).toBe(true);
    expect(atLeast(0.9 - 1e-6, 0.9)).toBe(false);
    expect(atMost(0.15, 0.15)).toBe(true);
    expect(atMost(0.15 + EPSILON / 2, 0.15)).toBe(true);
    expect(atMost(0.15 + 1e-6, 0.15)).toBe(false);
    // The mean of three repeats of 18 of 20 is 0.9 only up to rounding.
    expect(atLeast((18 / 20 + 18 / 20 + 18 / 20) / 3, 0.9)).toBe(true);
  });
});
