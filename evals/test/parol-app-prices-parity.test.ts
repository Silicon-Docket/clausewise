import { describe, expect, it } from "vitest";
import {
  loadPriceFile,
  costOf as appCostOf,
  priceFor as appPriceFor,
} from "../../apps/parol/src/usage/prices.js";
import { BUILT_IN_PRICES, costOf, loadPriceTable, priceFor } from "../src/prices.js";
import { priceTableSha256 } from "../src/parol/results.js";

/**
 * The application prices its model calls with its own copy of the evaluation's price code
 * (apps/parol/src/usage/prices.ts), because the application does not import from `evals`. The two
 * must give the same cost for the same tokens and the same pin for the same file, or a cost in a
 * results file and a cost on a review page would not be comparable.
 */

describe("the application's prices and the evaluation's", () => {
  it("work out the same cost for the same tokens at the same rates", async () => {
    const table = await loadPriceTable(undefined);
    const grid = [0, 1, 999, 123_456, 40_000_000];
    let compared = 0;
    for (const model of table.keys()) {
      const price = priceFor(table, model);
      for (const inputTokens of grid)
        for (const outputTokens of grid)
          for (const cacheReadTokens of [0, 777, 5_000_000])
            for (const cacheWriteTokens of [0, 3, 900_000]) {
              const tokens = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
              expect(appCostOf(tokens, price)).toBe(costOf(tokens, price));
              compared += 1;
            }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it("read the shipped price file to the same table and the same hash", async () => {
    const theirs = await loadPriceTable(undefined);
    const ours = loadPriceFile(BUILT_IN_PRICES);
    expect([...ours.prices.keys()].sort()).toEqual([...theirs.keys()].sort());
    for (const [model, price] of theirs) expect(appPriceFor(ours, model)).toEqual(price);
    expect(ours.sha256).toBe(priceTableSha256(theirs));
    expect(ours.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
