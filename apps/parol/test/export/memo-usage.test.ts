import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { buildMemo } from "../../src/export/memo.js";
import type { MemoInput } from "../../src/module-contracts.js";
import type { RunUsageAggregate } from "../../src/store/types.js";
import { summarizeUsage } from "../../src/usage/summary.js";
import { readMemo, workedExample } from "./support.js";

/**
 * Appendix B of the memo says which model answered and what its calls used. The memo is the file
 * that leaves the system, so the line gives counts with the number of calls they are out of and no
 * dollar figure: a price table is the operator's configuration and not a fact about the legal work,
 * and an estimate would change the memo whenever the operator changed a file. A stand-in has no
 * usage line, because the memo says in its own words that no model read the documents.
 */

const HASH = "0123456789abcdef".repeat(4);
const PRICED: RunUsageAggregate = {
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
};
const UNREPORTED: RunUsageAggregate = {
  ...PRICED,
  callsWithUsage: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  callsPriced: 0,
  costUsd: null,
  priceTables: 0,
  priceTableSha256: null,
};

async function provenance(input: MemoInput): Promise<string[]> {
  const read = await readMemo(await buildMemo(input));
  const start = read.paragraphs.findIndex((line) => line === "Appendix B. Provenance");
  return read.paragraphs.slice(start + 1);
}

function withUsage(
  aggregate: RunUsageAggregate,
  provider = "anthropic",
  over: Partial<MemoInput["run"]> = {},
): MemoInput {
  const input = workedExample();
  input.run = {
    ...input.run,
    modelProvider: provider,
    usage: summarizeUsage(aggregate, provider),
    ...over,
  };
  return input;
}

describe("the usage line of the provenance appendix", () => {
  it("gives the counts and the number of calls they are out of, after the model line", async () => {
    const out = await provenance(withUsage(PRICED));
    const model = out.findIndex((line) => line.startsWith("Model:"));
    expect(out[model + 1]).toBe(
      "Usage: input 123,456, output 7,890, cache read 1,000,000, cache write 12 tokens, from 9 of 9 recorded model calls.",
    );
  });

  it("says how many calls the counts are out of when only some reported", async () => {
    const out = await provenance(withUsage({ ...PRICED, callsWithUsage: 6 }));
    expect(out).toContain(
      "Usage: input 123,456, output 7,890, cache read 1,000,000, cache write 12 tokens, from 6 of 9 recorded model calls.",
    );
  });

  it("says usage was not reported, with the number of calls recorded", async () => {
    const out = await provenance(withUsage(UNREPORTED));
    expect(out).toContain("Usage: not reported (9 recorded model calls).");
  });

  it("has no usage line for a stand-in, and still says a stand-in read the documents", async () => {
    for (const provider of ["simulated", "scripted"]) {
      const out = await provenance(withUsage(PRICED, provider));
      expect(
        out.some((line) => line.startsWith("Usage:")),
        provider,
      ).toBe(false);
      expect(
        out.some((line) => line.startsWith("Stand-in reader:")),
        provider,
      ).toBe(true);
    }
  });

  it("has no usage line for an input that carries none, as before", async () => {
    const out = await provenance(workedExample());
    expect(out.some((line) => line.startsWith("Usage:"))).toBe(false);
  });

  it("prints no dollar figure whatever the cost, and no price table", async () => {
    const out = await provenance(withUsage(PRICED));
    expect(out.join("\n")).not.toContain("$");
    expect(out.join("\n")).not.toContain(HASH.slice(0, 12));
    expect(out.join("\n")).not.toMatch(/estimate|price/i);
  });

  it("is the same memo, byte for byte, built twice from the same recorded usage", async () => {
    const a = sha256Hex(await buildMemo(withUsage(PRICED)));
    const b = sha256Hex(await buildMemo(withUsage(PRICED)));
    expect(a).toBe(b);
    // And the usage is part of what the memo says: other counts make another memo.
    expect(sha256Hex(await buildMemo(withUsage({ ...PRICED, inputTokens: 1 })))).not.toBe(a);
  });

  it("prints the two models the provider named, sorted, on the model line", async () => {
    const out = await provenance(
      withUsage(PRICED, "anthropic", { modelReported: "model-a-2, model-b-1" }),
    );
    expect(out).toContain(
      "Model: requested anthropic claude-test-model; reported by the provider: model-a-2, model-b-1.",
    );
  });
});
