import { describe, expect, it } from "vitest";
import { worstCaseUsd as appWorstCaseUsd } from "../../apps/parol/src/usage/guard.js";
import { DEFAULT_ASSUMED_OUTPUT_TOKENS as APP_DEFAULT } from "../../apps/parol/src/usage/plan.js";
import { DEFAULT_ASSUMED_OUTPUT_TOKENS } from "../src/args.js";
import { worstCaseUsd } from "../src/budget.js";

/**
 * The application's per-request cap (apps/parol/src/usage/guard.ts) holds a request back by the
 * most it can cost, worked out by a copy of the evaluation's function. The two must agree on every
 * body, or the cap of the server and the cap of the evaluation would hold two different lines.
 */

// Invented rates, USD per million tokens.
const PRICES = [
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 1 },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
];

const json = (value: unknown): string => JSON.stringify(value);

const BODIES: unknown[] = [
  json({ max_tokens: 4000, messages: [{ role: "user", content: "a short prompt" }] }),
  json({ max_tokens: 16_000, messages: [{ role: "user", content: "x".repeat(50_000) }] }),
  // Characters that take several bytes each, and one outside the basic plane.
  json({ max_tokens: 1000, messages: [{ role: "user", content: "文字".repeat(900) }] }),
  json({ max_tokens: 1000, messages: [{ role: "user", content: "\u{1F600}".repeat(500) }] }),
  json({ max_tokens: 0, messages: [] }),
  // Bodies that cannot be sized: no limit on the output, a limit that is not a number, not JSON, no body at all.
  json({ messages: [{ role: "user", content: "no limit" }] }),
  json({ max_tokens: "4000", messages: [] }),
  json({ max_tokens: null }),
  "{ not json",
  "",
  undefined,
  null,
  new Uint8Array([1, 2, 3]),
  { max_tokens: 4000 },
];

describe("the application's worst case of a request and the evaluation's", () => {
  it("are the same number for every body and every price, the infinite ones included", () => {
    let finite = 0;
    let infinite = 0;
    for (const price of PRICES)
      for (const body of BODIES) {
        const ours = appWorstCaseUsd(body, price);
        const theirs = worstCaseUsd(body, price);
        expect(ours, String(body).slice(0, 40)).toBe(theirs);
        if (Number.isFinite(ours)) finite += 1;
        else infinite += 1;
      }
    // Both kinds were compared.
    expect(finite).toBeGreaterThan(10);
    expect(infinite).toBeGreaterThan(20);
  });

  it("price a prompt at the dearer of the plain and the cache-write rate", () => {
    const body = json({ max_tokens: 0, messages: [{ role: "user", content: "x".repeat(3000) }] });
    const tokens = Math.ceil(Buffer.byteLength(body) / 3);
    const cheap = appWorstCaseUsd(body, { input: 1, output: 0, cacheRead: 0, cacheWrite: 2 });
    expect(cheap).toBeCloseTo((tokens * 2) / 1_000_000, 12);
  });
});

describe("the output the planned bound assumes for each call", () => {
  it("is the figure the evaluation assumes", () => {
    expect(APP_DEFAULT).toBe(DEFAULT_ASSUMED_OUTPUT_TOKENS);
    expect(APP_DEFAULT).toBe(1500);
  });
});
