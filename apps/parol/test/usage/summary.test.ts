import { describe, expect, it } from "vitest";
import type { RunUsageAggregate } from "../../src/store/types.js";
import {
  formatUsd,
  groups,
  memoUsageText,
  summarizeUsage,
  usageLines,
} from "../../src/usage/summary.js";

const HASH = "0123456789abcdef".repeat(4);

const aggregate = (over: Partial<RunUsageAggregate> = {}): RunUsageAggregate => ({
  calls: 9,
  callsWithUsage: 9,
  inputTokens: 123_456,
  outputTokens: 7_890,
  cacheReadTokens: 1_000_000,
  cacheWriteTokens: 12,
  callsPriced: 9,
  costUsd: 0.0123456,
  priceTables: 1,
  priceTableSha256: HASH,
  ...over,
});

const NONE = aggregate({
  callsWithUsage: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  callsPriced: 0,
  costUsd: null,
  priceTables: 0,
  priceTableSha256: null,
});

describe("the words for thousands and dollars", () => {
  it("group digits the same way on every machine", () => {
    expect([0, 7, 999, 1000, 12345, 1234567, 1000000000].map(groups)).toEqual([
      "0",
      "7",
      "999",
      "1,000",
      "12,345",
      "1,234,567",
      "1,000,000,000",
    ]);
  });

  it("show a cost with four decimals", () => {
    expect(formatUsd(0.0123456)).toBe("$0.0123");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(12)).toBe("$12.0000");
  });
});

describe("the summary of a run's usage", () => {
  it("says no model was called for a stand-in, and shows no figure", () => {
    for (const provider of ["scripted", "simulated"]) {
      const s = summarizeUsage(aggregate({ calls: 9, callsWithUsage: 0 }), provider);
      expect(s).toMatchObject({
        state: "stand_in",
        calls: 9,
        callsWithUsage: 0,
        inputTokens: null,
        cost: { state: "not_applicable", usd: null },
      });
      expect(s.lines).toEqual(["No model was called, so there is no usage to record."]);
    }
  });

  it("ignores tokens in the rows of a stand-in, because no model was called", () => {
    const s = summarizeUsage(aggregate(), "simulated");
    expect(s).toMatchObject({ state: "stand_in", inputTokens: null, callsWithUsage: 0 });
    expect(s.lines.join(" ")).not.toMatch(/\d{2}|\$/);
  });

  it("says no call has been recorded yet, for a run that has made none", () => {
    const s = summarizeUsage(aggregate({ ...NONE, calls: 0 }), "anthropic");
    expect(s.state).toBe("not_reported");
    expect(s.lines).toEqual(["No model call has been recorded for this review yet."]);
  });

  it("says the provider reported nothing, over the calls recorded, and for another provider why", () => {
    const anthropic = summarizeUsage(NONE, "anthropic");
    expect(anthropic).toMatchObject({ state: "not_reported", reportsUsage: true, calls: 9 });
    expect(anthropic.lines).toEqual([
      "The provider did not report usage for the 9 model calls of this review.",
    ]);
    const other = summarizeUsage(aggregate({ ...NONE, calls: 1 }), "openai");
    expect(other.reportsUsage).toBe(false);
    expect(other.lines).toEqual([
      "The provider did not report usage for the 1 model call of this review.",
      "Parol records usage only for the anthropic provider, so the cost of this review is not known.",
    ]);
  });

  it("gives every token figure with the calls it is out of", () => {
    const s = summarizeUsage(
      aggregate({ callsPriced: 0, costUsd: null, priceTables: 0, priceTableSha256: null }),
      "anthropic",
    );
    expect(s).toMatchObject({
      state: "reported",
      inputTokens: 123_456,
      outputTokens: 7_890,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 12,
    });
    expect(s.lines[0]).toBe(
      "Input 123,456, output 7,890, cache read 1,000,000 and cache write 12 tokens, from 9 of 9 recorded model calls.",
    );
  });

  it("says how many calls reported no usage when some did not", () => {
    const s = summarizeUsage(aggregate({ callsWithUsage: 6, callsPriced: 6 }), "anthropic");
    expect(s.lines[0]).toContain("from 6 of 9 recorded model calls. 3 reported no usage.");
    const one = summarizeUsage(
      aggregate({ calls: 1, callsWithUsage: 1, callsPriced: 1 }),
      "anthropic",
    );
    expect(one.lines[0]).toContain("from 1 of 1 recorded model call.");
  });

  it("calls a cost an estimate, names the table, and says what the calls are out of", () => {
    const s = summarizeUsage(aggregate(), "anthropic");
    expect(s.cost).toMatchObject({ state: "priced", usd: 0.0123456, callsPriced: 9 });
    expect(s.lines[1]).toBe(
      "Estimated cost about $0.0123 for the 9 calls that reported usage, from the price table 0123456789ab. This is a computed estimate, not an invoice, and Parol does not check the prices against a price list.",
    );
  });

  it("says so when the priced calls named more than one price table", () => {
    const s = summarizeUsage(aggregate({ priceTables: 2, priceTableSha256: null }), "anthropic");
    expect(s.cost).toMatchObject({
      state: "priced",
      mixedPriceTables: true,
      priceTableSha256: null,
    });
    expect(s.lines[1]).toContain("from more than one price table.");
  });

  it("says 'at least' when only some calls with tokens have a price", () => {
    const s = summarizeUsage(aggregate({ callsPriced: 4, costUsd: 0.05 }), "anthropic");
    expect(s.cost).toMatchObject({ state: "partly_priced", usd: 0.05, callsPriced: 4 });
    expect(s.lines[1]).toContain(
      "Estimated cost at least $0.0500: 4 of 9 calls with usage have a price.",
    );
  });

  it("says 'not priced' and prints no dollar sign when no call has a cost", () => {
    const s = summarizeUsage(
      aggregate({ callsPriced: 0, costUsd: null, priceTables: 0, priceTableSha256: null }),
      "anthropic",
    );
    expect(s.cost).toMatchObject({ state: "not_priced", usd: null, callsPriced: 0 });
    expect(s.lines[1]).toBe("Cost: not priced. No price is configured for this model.");
    expect(s.lines.join(" ")).not.toContain("$");
  });

  it("prints a dollar sign only where a price was applied", () => {
    for (const [name, over] of [
      ["no usage", NONE],
      ["not priced", aggregate({ callsPriced: 0, costUsd: null })],
    ] as const)
      expect(summarizeUsage(over, "anthropic").lines.join(" "), name).not.toContain("$");
    expect(summarizeUsage(aggregate(), "simulated").lines.join(" ")).not.toContain("$");
    expect(summarizeUsage(aggregate(), "anthropic").lines.join(" ")).toContain("$");
  });

  it("builds its lines from one function, so a page and the JSON cannot differ", () => {
    const s = summarizeUsage(aggregate(), "anthropic");
    const { lines, ...basis } = s;
    expect(usageLines(basis)).toEqual(lines);
  });
});

describe("the memo's line", () => {
  it("has none for a stand-in, whose memo says so in its own words", () => {
    const { lines: _lines, ...basis } = summarizeUsage(aggregate(), "simulated");
    expect(memoUsageText(basis)).toBeNull();
  });

  it("gives the counts with the calls they are out of, and no dollar figure", () => {
    const { lines: _lines, ...basis } = summarizeUsage(aggregate(), "anthropic");
    const text = memoUsageText(basis);
    expect(text).toBe(
      "input 123,456, output 7,890, cache read 1,000,000, cache write 12 tokens, from 9 of 9 recorded model calls.",
    );
    expect(text).not.toContain("$");
  });

  it("says usage was not reported, with the number of calls recorded", () => {
    const { lines: _lines, ...basis } = summarizeUsage(NONE, "anthropic");
    expect(memoUsageText(basis)).toBe("not reported (9 recorded model calls).");
  });
});
