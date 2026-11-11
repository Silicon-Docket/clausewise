import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CallRecord } from "../../src/contracts.js";
import {
  NO_PRICING,
  PriceFileError,
  costOf,
  createCallPricer,
  loadPriceFile,
  parsePriceTable,
  priceFor,
  priceTableSha256,
  type Price,
} from "../../src/usage/prices.js";

const dir = mkdtempSync(join(tmpdir(), "parol-prices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PRICE: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const file = (name: string, text: string): string => {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
};

describe("a price table", () => {
  it("is read from a file in the format of the evaluation's, notes ignored", () => {
    const table = loadPriceFile(
      file("ok.json", JSON.stringify({ _note: "not a model", "model-a": PRICE })),
    );
    expect([...table.prices.keys()]).toEqual(["model-a"]);
    expect(priceFor(table, "model-a")).toEqual(PRICE);
    expect(table.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a hash that follows every model and price, and not the order of the file", () => {
    const one = parsePriceTable({ "model-a": PRICE, "model-b": PRICE });
    const reordered = parsePriceTable({ "model-b": PRICE, "model-a": PRICE });
    const changed = parsePriceTable({ "model-a": { ...PRICE, output: 11 }, "model-b": PRICE });
    expect(reordered.sha256).toBe(one.sha256);
    expect(changed.sha256).not.toBe(one.sha256);
    expect(priceTableSha256(one.prices)).toBe(one.sha256);
  });

  it("refuses an entry that is not exactly four non-negative finite rates", () => {
    const bad: unknown[] = [
      { input: 1, output: 1, cacheRead: 1 },
      { ...PRICE, extra: 1 },
      { ...PRICE, input: -1 },
      { ...PRICE, input: "1" },
      { ...PRICE, output: null },
      "2",
      null,
      [],
    ];
    for (const entry of bad)
      expect(() => parsePriceTable({ "model-a": entry }), JSON.stringify(entry)).toThrow(
        PriceFileError,
      );
    // JSON has no way to write a non-finite number, so one is built in memory.
    expect(() => parsePriceTable({ "model-a": { ...PRICE, input: Infinity } })).toThrow(
      PriceFileError,
    );
    expect(() => parsePriceTable({ "model-a": { ...PRICE, input: Number.NaN } })).toThrow(
      PriceFileError,
    );
  });

  it("refuses a file that is not an object of prices, or a name that is not a model name", () => {
    for (const raw of [[], null, "text", 3])
      expect(() => parsePriceTable(raw)).toThrow(PriceFileError);
    expect(() => parsePriceTable({ "bad name\n": PRICE })).toThrow(PriceFileError);
    expect(() => parsePriceTable({ "": PRICE })).toThrow(PriceFileError);
  });

  it("gives a price to exactly the model it names, and never to a near match", () => {
    const table = parsePriceTable({ "model-a": PRICE });
    expect(priceFor(table, "model-a")).toEqual(PRICE);
    for (const near of ["model-a-20260101", "model-", "Model-A", "model-a ", ""])
      expect(priceFor(table, near), near).toBeNull();
  });

  it("says what is wrong with the file without printing a value or a path", () => {
    const secret = "SECRET-VALUE-3f9a";
    const cases: [string, string][] = [
      ["not-json.json", `{ "model-a": "${secret}`],
      ["wrong-shape.json", `{ "model-a": { "input": "${secret}" } }`],
      ["array.json", `["${secret}"]`],
    ];
    for (const [name, text] of cases) {
      const path = file(name, text);
      let message = "";
      try {
        loadPriceFile(path);
      } catch (error) {
        expect(error).toBeInstanceOf(PriceFileError);
        message = (error as Error).message;
      }
      expect(message, name).toContain("PAROL_PRICES_FILE");
      expect(message, name).not.toContain(secret);
      expect(message, name).not.toContain(dir);
      expect(message, name).not.toContain(name);
    }
    let missing = "";
    try {
      loadPriceFile(join(dir, "does-not-exist.json"));
    } catch (error) {
      missing = (error as Error).message;
    }
    expect(missing).toContain("PAROL_PRICES_FILE");
    expect(missing).not.toContain(dir);
  });

  it("refuses a file too large to be a price table", () => {
    const path = file("big.json", `{ "_note": "${"x".repeat(1024 * 1024)}" }`);
    expect(() => loadPriceFile(path)).toThrow(PriceFileError);
  });
});

describe("the cost of a call", () => {
  it("is the tokens at their rates, per million", () => {
    expect(
      costOf(
        {
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 400_000,
        },
        PRICE,
      ),
    ).toBeCloseTo(2 + 5 + 0.4 + 1, 10);
    expect(
      costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, PRICE),
    ).toBe(0);
  });

  const record = (over: Partial<CallRecord> = {}): CallRecord => ({
    stage: "analyze",
    ruleKey: "dur-1",
    promptVersionId: "analyze.p1",
    requestSha256: "a".repeat(64),
    attempt: 1,
    outcome: "ok",
    latencyMs: 5,
    inputTokens: 100_000,
    outputTokens: 10_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  });

  it("is given to a call with tokens, with the hash of the table that priced it", () => {
    const table = parsePriceTable({ "model-a": PRICE });
    const [priced] = createCallPricer(table).priceCalls([record()], "model-a");
    expect(priced?.costUsdEstimate).toBeCloseTo(0.3, 10);
    expect(priced?.priceTableSha256).toBe(table.sha256);
  });

  it("is left empty for a call that reported no tokens, and for a model with no price", () => {
    const table = parsePriceTable({ "model-a": PRICE });
    const pricer = createCallPricer(table);
    const nothing = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
    expect(pricer.priceCalls([record(nothing)], "model-a")[0]).toMatchObject({
      costUsdEstimate: null,
      priceTableSha256: null,
    });
    expect(pricer.priceCalls([record()], "model-b")[0]).toMatchObject({
      costUsdEstimate: null,
      priceTableSha256: null,
    });
    // The record itself is carried through unchanged.
    expect(pricer.priceCalls([record()], "model-b")[0]).toMatchObject(record());
  });

  it("is never given when no price table was named", () => {
    expect(NO_PRICING.priceCalls([record()], "model-a")[0]).toMatchObject({
      inputTokens: 100_000,
      costUsdEstimate: null,
      priceTableSha256: null,
    });
  });
});
