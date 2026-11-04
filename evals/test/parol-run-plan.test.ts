import { readFileSync } from "node:fs";
import { toJSONSchema, type ZodType } from "zod";
import { beforeAll, describe, expect, it } from "vitest";
import { AnalysisSchema, LocateSchema } from "../../apps/parol/src/contracts.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import type { LoadedPlaybook } from "../../apps/parol/src/module-contracts.js";
import { decide } from "../src/guard.js";
import { boundTokens } from "../src/plan.js";
import { loadDataset, selectCases, type Dataset } from "../src/parol/dataset.js";
import { createKeyOracle } from "../src/parol/oracle.js";
import {
  asHarnessPlan,
  buildParolPlan,
  costBounds,
  describeParolPlan,
  type ParolPlan,
} from "../src/parol/plan.js";
import { prepareCase, runStages, runnableCases, type ParsedFiles } from "../src/parol/runner.js";
import { REPO_ROOT } from "../src/parol/testing-run.js";

let dataset: Dataset;
let playbook: LoadedPlaybook;
beforeAll(async () => {
  const loaded = await loadDataset(REPO_ROOT);
  if (!loaded.ok) throw new Error(loaded.problems.join("; "));
  dataset = loaded.dataset;
  playbook = loadPlaybook({
    yaml: readFileSync(`${REPO_ROOT}/apps/parol/playbooks/parol-nda-recipient.yaml`, "utf8"),
    slug: "parol-nda-recipient",
  });
});

// A plan written out by hand, so that the arithmetic can be checked on paper. Nothing here was
// measured: it is FABRICATED FOR A TEST.
const HAND_PLAN: ParolPlan = {
  repeats: 2,
  assumedOutputTokens: 1500,
  cases: [
    {
      caseKey: "FAB-A",
      split: "dev",
      twinOf: null,
      documents: 1,
      spans: 20,
      rules: 8,
      rulesOverBudget: 0,
      calls: 9,
      callsWithRepairs: 17,
      inputTokens: 40_000,
      inputTokensWithRepairs: 76_000,
    },
    {
      caseKey: "FAB-B",
      split: "dev",
      twinOf: null,
      documents: 2,
      spans: 30,
      rules: 8,
      rulesOverBudget: 0,
      calls: 9,
      callsWithRepairs: 17,
      inputTokens: 60_000,
      inputTokensWithRepairs: 114_000,
    },
  ],
  runsPerRepeat: 2,
  slotsPerRepeat: 16,
  // Per repeat: 18 calls, 100,000 tokens. Two repeats.
  calls: 36,
  callsWithRepairs: 68,
  inputTokens: 200_000,
  inputTokensWithRepairs: 380_000,
  outputTokens: 36 * 1500,
  outputTokensWithRepairs: 68 * 1500,
};
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

describe("the cost bound", () => {
  it("is the input and the assumed output at the plain price, worked out by hand", () => {
    const bounds = costBounds(HAND_PLAN, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 });
    // 200,000 input tokens at $2 per million is $0.40; 54,000 output tokens at $10 is $0.54.
    expect(bounds.upperBoundUsd).toBeCloseTo(0.94, 10);
    // 380,000 input is $0.76 and 68 x 1,500 = 102,000 output is $1.02.
    expect(bounds.withRepairsUsd).toBeCloseTo(1.78, 10);
    // Document 3: three attempts of each call, so three times the figure with repairs.
    expect(bounds.retryWorstCaseUsd).toBeCloseTo(5.34, 10);
    // The ceiling: 380,000 x 3 attempts at the dearer cache-write rate of $2.50 is $2.85, and every
    // attempt of every one of 68 calls generating all 16,000 tokens is 3,264,000 at $10, $32.64.
    expect(bounds.ceilingUsd).toBeCloseTo(35.49, 10);
  });

  it("is the Clausewise arithmetic: the harness plan carries the same totals", () => {
    const once = asHarnessPlan(HAND_PLAN, false);
    expect(once).toMatchObject({ runs: 2, calls: 36, inputTokens: 200_000, outputTokens: 54_000 });
    expect(once.fixtures.map((f) => [f.fixture, f.callsPerRun, f.inputTokensPerRun])).toEqual([
      ["FAB-A", 9, 40_000],
      ["FAB-B", 9, 60_000],
    ]);
    const repaired = asHarnessPlan(HAND_PLAN, true);
    expect(repaired).toMatchObject({ calls: 68, inputTokens: 380_000, outputTokens: 102_000 });
  });

  it("is refused by the spend guard when it is above --max-cost, and when --yes is missing", () => {
    const bounds = costBounds(HAND_PLAN, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 });
    const base = { calls: 36, upperBoundUsd: bounds.upperBoundUsd, fallback: false };
    expect(decide({ ...base, yes: false, maxCostUsd: 2 })).toMatchObject({ go: false });
    expect(decide({ ...base, yes: true, maxCostUsd: 0.9 })).toMatchObject({ go: false });
    // A limit set to exactly the bound is accepted.
    expect(decide({ ...base, yes: true, maxCostUsd: bounds.upperBoundUsd })).toEqual({ go: true });
  });
});

describe("the plan of the dev split", () => {
  it("counts the calls of the real stages: one extract and one analyze per rule, and a repair for each", async () => {
    const [group] = selectCases(dataset, "dev", []);
    const plan = await buildParolPlan({
      dataset,
      runnables: runnableCases(group!),
      playbook,
      workflow: workflowFor("v1"),
      repeats: 3,
      assumedOutputTokens: 1500,
    });
    // Six cases and the twin of PAROL-D08, eight rules each.
    expect(plan.cases.map((c) => c.caseKey)).toEqual([
      "PAROL-D01",
      "PAROL-D03",
      "PAROL-D05",
      "PAROL-D06",
      "PAROL-D08",
      "PAROL-D08-twin",
      "PAROL-D12",
    ]);
    expect(plan.runsPerRepeat).toBe(7);
    expect(plan.slotsPerRepeat).toBe(56);
    for (const c of plan.cases) {
      expect(c.rules).toBe(8);
      expect(c.rulesOverBudget).toBe(0);
      expect(c.calls).toBe(9);
      // The repair attempt of the workflow doubles the analyze calls: 1 + 8 x 2.
      expect(c.callsWithRepairs).toBe(17);
      expect(c.inputTokensWithRepairs).toBeGreaterThan(c.inputTokens);
    }
    expect(plan.calls).toBe(7 * 9 * 3);
    expect(plan.callsWithRepairs).toBe(7 * 17 * 3);
    expect(plan.outputTokens).toBe(plan.calls * 1500);
    expect(plan.inputTokens).toBe(plan.cases.reduce((t, c) => t + c.inputTokens, 0) * 3);
  });

  it("is an upper bound on what the stages actually send, under both workflows", async () => {
    const schemaTokens = (schema: ZodType): number =>
      boundTokens(JSON.stringify(toJSONSchema(schema)));
    const [group] = selectCases(dataset, "dev", []);
    for (const label of ["v1", "v2"]) {
      const workflow = workflowFor(label);
      const plan = await buildParolPlan({
        dataset,
        runnables: runnableCases(group!),
        playbook,
        workflow,
        repeats: 1,
        assumedOutputTokens: 1500,
      });
      const parsed: ParsedFiles = new Map();
      for (const runnable of runnableCases(group!)) {
        const prepared = await prepareCase({
          dataset,
          runnable,
          repeat: 1,
          playbook,
          workflow,
          parsed,
        });
        const generator = createKeyOracle({
          caseKey: runnable.caseKey,
          expect: runnable.expect,
          spans: prepared.ingest.spans,
          rules: playbook.rules,
        });
        await runStages({
          prepared,
          playbook,
          workflow,
          generator,
          signal: new AbortController().signal,
        });
        const actual = generator.calls.reduce(
          (total, call) =>
            total +
            boundTokens(call.system) +
            boundTokens(call.prompt) +
            schemaTokens(call.schemaName === "locate_passages" ? LocateSchema : AnalysisSchema),
          0,
        );
        const planned = plan.cases.find((c) => c.caseKey === runnable.caseKey)!;
        // The same number of calls, and a bound that the real prompts stay under: the dry run
        // gives every rule the whole of every document, which is as much as R1 or R2 can show.
        expect(generator.calls.length, `${label} ${runnable.caseKey}`).toBe(planned.calls);
        expect(planned.inputTokens, `${label} ${runnable.caseKey}`).toBeGreaterThanOrEqual(actual);
        expect(planned.inputTokens).toBeLessThan(actual * 3);
      }
    }
  });

  it("prices a workflow that pins a support prompt with one more call per rule", async () => {
    const [group] = selectCases(dataset, "dev", ["PAROL-D01"]);
    const withSupport = {
      sha256: "0".repeat(64),
      manifest: {
        ...workflowFor("v1").manifest,
        prompts: { ...workflowFor("v1").manifest.prompts, support: "support.p1" },
      },
    };
    const base = await buildParolPlan({
      dataset,
      runnables: runnableCases(group!),
      playbook,
      workflow: workflowFor("v1"),
      repeats: 1,
      assumedOutputTokens: 1500,
    });
    const supported = await buildParolPlan({
      dataset,
      runnables: runnableCases(group!),
      playbook,
      workflow: withSupport,
      repeats: 1,
      assumedOutputTokens: 1500,
    });
    expect(base.calls).toBe(9);
    expect(supported.calls).toBe(17);
    expect(supported.inputTokens).toBeGreaterThan(base.inputTokens);
  });
});

describe("the plan as text", () => {
  const baseContext = {
    datasetLabel: "parol-cases v1",
    splitLabel: "dev",
    workflowLabel: "v1",
    retrieval: "R1",
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    price: PRICE,
    maxRetries: 2,
    maxOutputTokens: 16_000,
    maxCostUsd: 2,
    fallback: false,
  } as const;

  it("shows the calls, the bounds and the limit of a live run, with the price warning", () => {
    const bounds = costBounds(HAND_PLAN, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 });
    const text = describeParolPlan(HAND_PLAN, { ...baseContext, mode: "live", bounds });
    expect(text).toContain("Evaluation plan (nothing has been sent yet)");
    expect(text).toContain("Model calls in total: 36");
    expect(text).toContain("Model calls if every rule needed its repair call: 68");
    expect(text).toContain("Input tokens, upper bound: 200,000");
    expect(text).toContain(
      "Output tokens, upper bound: 54,000 (36 calls x 1,500 tokens assumed per call.",
    );
    // One attempt per call is not a bound on the run, and is not called one. The figure that
    // includes the repair call of every rule is the bound that --max-cost is checked against.
    expect(text).toContain("Cost with one attempt per call and no repair call: $0.9400");
    expect(text).toContain(
      "Cost upper bound, if every rule needed its repair call: $1.7800. --max-cost is checked against this figure.",
    );
    expect(text).not.toContain("Cost upper bound: $");
    expect(text).toContain("all 2 of its retries the bound would be $5.3400");
    expect(text).toContain("Hard ceiling: $35.4900");
    expect(text).toContain("Spend limit (--max-cost): $2.0000");
    expect(text).toContain("Check evals/prices.json against the provider's current price list");
  });

  it("shows no money for a scripted run", () => {
    for (const mode of ["selftest", "simulated"] as const) {
      const text = describeParolPlan(HAND_PLAN, {
        ...baseContext,
        mode,
        price: null,
        bounds: null,
        maxRetries: null,
        maxOutputTokens: null,
      });
      expect(text).toContain("no model will be called");
      expect(text).toContain("Model calls in total: 36");
      expect(text).not.toMatch(/\$|upper bound|price/i);
    }
  });
});
