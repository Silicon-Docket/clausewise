import { readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvalError } from "../src/errors.js";
import { costOf, loadPriceTable, priceFor } from "../src/prices.js";
import { cacheStats, emptyUsage, addUsage } from "../src/usage.js";
import type { EvalResult } from "../src/result.js";
import { forbiddenFactory, makeTempDir, removeDir, run } from "./support.js";

let dir = "";
beforeAll(async () => {
  dir = await makeTempDir();
});
afterAll(async () => {
  await removeDir(dir);
});

describe("the price table", () => {
  it("holds the figures the harness was seeded with, in USD per million tokens", async () => {
    const table = await loadPriceTable(undefined);
    expect(Object.fromEntries(table)).toEqual({
      "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    });
  });

  it("carries a warning to check the figures against the current price list", async () => {
    const raw = await readFile(new URL("../prices.json", import.meta.url), "utf8");
    expect(JSON.parse(raw)._comment).toMatch(/current price list/);
  });

  it("refuses a model it does not know instead of guessing from a similar name", async () => {
    const table = await loadPriceTable(undefined);
    expect(() => priceFor(table, "claude-sonnet-5-5-20260301")).toThrow(EvalError);
    expect(() => priceFor(table, "claude-sonnet-5-5-20260301")).toThrow(/not in the price table/);
    expect(() => priceFor(table, "claude-sonnet-5-5-20260301")).toThrow(/--prices/);
  });

  it("does not mistake an inherited property for a model", async () => {
    const table = await loadPriceTable(undefined);
    expect(() => priceFor(table, "constructor")).toThrow(EvalError);
    expect(() => priceFor(table, "__proto__")).toThrow(EvalError);
  });

  it("takes extra models from --prices, which wins over the built-in entry", async () => {
    const path = `${dir}/extra.json`;
    await writeFile(
      path,
      JSON.stringify({
        _note: "ignored",
        "my-model": { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1.25 },
        "claude-haiku-5-5": { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
      }),
    );
    const table = await loadPriceTable(path);
    expect(priceFor(table, "my-model")).toEqual({
      input: 1,
      output: 3,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    });
    expect(priceFor(table, "claude-haiku-5-5").input).toBe(9);
    expect(priceFor(table, "claude-sonnet-5-5").input).toBe(2);
    expect(table.has("_note")).toBe(false);
  });

  it("rejects a prices file with a missing or negative rate", async () => {
    const path = `${dir}/bad.json`;
    await writeFile(path, JSON.stringify({ m: { input: 1, output: 2, cacheRead: 3 } }));
    await expect(loadPriceTable(path)).rejects.toThrow(/bad entry for "m"/);
    await writeFile(
      path,
      JSON.stringify({ m: { input: -1, output: 2, cacheRead: 3, cacheWrite: 4 } }),
    );
    await expect(loadPriceTable(path)).rejects.toThrow(/bad entry for "m"/);
    await writeFile(path, "not json");
    await expect(loadPriceTable(path)).rejects.toThrow(/not valid JSON/);
  });
});

describe("cost arithmetic", () => {
  const sonnet = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

  it("prices input, output, cache reads and cache writes separately", () => {
    // 1M x 2.00 + 0.5M x 10.00 + 2M x 0.20 + 0.4M x 2.50 = 2 + 5 + 0.4 + 1
    const cost = costOf(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 400_000,
      },
      sonnet,
    );
    expect(cost).toBeCloseTo(8.4, 10);
  });

  it("costs a single token in each class at its own rate", () => {
    const one = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf({ ...one, inputTokens: 1 }, sonnet)).toBeCloseTo(2e-6, 15);
    expect(costOf({ ...one, outputTokens: 1 }, sonnet)).toBeCloseTo(1e-5, 15);
    expect(costOf({ ...one, cacheReadTokens: 1 }, sonnet)).toBeCloseTo(2e-7, 15);
    expect(costOf({ ...one, cacheWriteTokens: 1 }, sonnet)).toBeCloseTo(2.5e-6, 15);
    expect(costOf(one, sonnet)).toBe(0);
  });

  it("works out what the cache saved against paying full price for every prompt token", () => {
    const usage = emptyUsage();
    // One write of 10,000 tokens, then nine reads of it, each with 300 uncached tokens after it.
    addUsage(usage, {
      inputTokens: 300,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 10_000,
    });
    for (let i = 0; i < 9; i += 1) {
      addUsage(usage, {
        inputTokens: 300,
        outputTokens: 200,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 0,
      });
    }
    const stats = cacheStats(usage, sonnet);
    expect(stats.promptTokens).toBe(10 * 300 + 10_000 + 9 * 10_000);
    expect(stats.readShare).toBeCloseTo(90_000 / 103_000, 12);
    // With caching: 3000 x 2 + 2000 x 10 + 90000 x 0.2 + 10000 x 2.5 = 6000 + 20000 + 18000 + 25000
    expect(stats.costWithCaching).toBeCloseTo(0.069, 12);
    // Without: 103000 x 2 + 2000 x 10 = 206000 + 20000
    expect(stats.costWithoutCaching).toBeCloseTo(0.226, 12);
    expect(stats.saving).toBeCloseTo(1 - 0.069 / 0.226, 12);
  });

  it("reports a negative saving when the cache was written and never read", () => {
    const usage = emptyUsage();
    addUsage(usage, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 1000,
    });
    expect(cacheStats(usage, sonnet).saving).toBeCloseTo(-0.25, 12);
  });
});

describe("a run with a model the table does not know", () => {
  const env = {
    ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
    CLAUSEWISE_MODEL: "claude-unlisted-1",
  };

  it("is an error before anything is planned or sent, with the way out in the message", async () => {
    const factory = forbiddenFactory();
    const { code, stderr, stdout } = await run(["--yes"], { dir, env, generatorFactory: factory });
    expect(code).toBe(1);
    expect(stderr).toMatch(/"claude-unlisted-1" is not in the price table/);
    expect(stderr).toMatch(/--prices/);
    expect(stdout).toBe("");
    expect(factory.used()).toBe(false);
  });

  it("is priced when --prices supplies it", async () => {
    const path = `${dir}/unlisted.json`;
    await writeFile(
      path,
      JSON.stringify({
        "claude-unlisted-1": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
      }),
    );
    const factory = forbiddenFactory();
    const { code, stderr } = await run(["--prices", path], { dir, env, generatorFactory: factory });
    // No --yes, so it stops at the plan, and the plan used the supplied rates.
    expect(code).toBe(3);
    expect(stderr).toMatch(/Prices per million tokens: 1 input, 5 output/);
    expect(factory.used()).toBe(false);
  });

  it("does not matter to a selftest, which ignores the price table", async () => {
    const out = `${dir}/selftest-unlisted.json`;
    const { code } = await run(["--selftest", "--out", out], { dir, env });
    expect(code).toBe(0);
    const result = JSON.parse(await readFile(out, "utf8")) as EvalResult;
    expect(result.cost).toEqual({
      price: null,
      actualUsd: null,
      upperBoundUsd: null,
      retryWorstCaseUsd: null,
    });
  });
});
