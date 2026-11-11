import { toJSONSchema } from "zod";
import { describe, expect, it } from "vitest";
import { AnalysisSchema, type RunManifest, type WorkflowManifest } from "../../src/contracts.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { emptyExtractOutput } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import {
  boundTokens,
  planRun,
  unitKey,
  upperBoundUsd,
  type RunPlan,
} from "../../src/usage/plan.js";
import { buildCaseWorld, scriptedModel } from "../integration/pipeline.js";

/**
 * What a review will ask of the model, planned from the stored documents before any call. The
 * numbers here are counts of the stages' own requests; the prices are invented.
 */

const world = await buildCaseWorld("PAROL-D05");
const RULES = world.playbook.rules.length;
const plan = (workflow: WorkflowManifest, over: { assumedOutputTokens?: number } = {}) =>
  planRun({
    ingest: world.ingest,
    manifest: world.manifest as RunManifest,
    rules: world.playbook.rules,
    workflow,
    assumedOutputTokens: over.assumedOutputTokens ?? 1500,
  });
const V1 = workflowFor("v1").manifest;
const V2 = workflowFor("v2").manifest;
const V3 = workflowFor("v3").manifest;
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

describe("the calls of a review", () => {
  it("are one extract call and one analyze call for each rule, and a repair call for each rule", () => {
    for (const workflow of [V1, V2]) {
      const planned = plan(workflow);
      expect(planned.calls, workflow.label).toBe(1 + RULES);
      expect(planned.callsWithRepairs, workflow.label).toBe(1 + 2 * RULES);
      expect(planned.units.map((u) => u.stage)).toEqual([
        "extract",
        ...Array.from({ length: RULES }, () => "analyze"),
      ]);
      expect(planned.units[0]).toMatchObject({ unit: "*", calls: 1, callsWithRepair: 1 });
      for (const unit of planned.units.slice(1))
        expect(unit, unit.unit).toMatchObject({ calls: 1, callsWithRepair: 2 });
    }
  });

  it("include a support call for each rule when the workflow pins a support prompt", () => {
    const planned = plan(V3);
    expect(planned.calls).toBe(1 + 2 * RULES);
    expect(planned.callsWithRepairs).toBe(1 + 3 * RULES);
    expect(planned.units.filter((u) => u.stage === "verify")).toHaveLength(RULES);
    expect(planned.units.filter((u) => u.stage === "verify").map((u) => u.unit)).toEqual(
      planned.units.filter((u) => u.stage === "analyze").map((u) => u.unit),
    );
  });

  it("have no repair call when the workflow allows none", () => {
    const planned = plan({ ...V1, repairAttempts: 0 });
    expect(planned.callsWithRepairs).toBe(planned.calls);
    expect(planned.inputTokensWithRepairs).toBe(planned.inputTokens);
  });

  it("are one repair call, however many repairs the workflow allows, because that is what the bound covers", () => {
    const planned = plan({ ...V1, repairAttempts: 3 });
    expect(planned.callsWithRepairs).toBe(1 + 2 * RULES);
  });

  it("leave out a rule that is over the context budget, which is never sent", () => {
    const planned = plan({ ...V1, budgetTokens: 5 });
    // Every rule reads the whole document, so with a budget of 5 tokens none can be sent.
    expect(planned.units.map((u) => u.stage)).toEqual(["extract"]);
    expect(planned.calls).toBe(1);
    expect(planned.callsWithRepairs).toBe(1);
  });

  it("are those of a run with no documents: none", () => {
    const planned = planRun({
      ingest: { spans: [], annotations: [], warnings: [] },
      manifest: world.manifest,
      rules: world.playbook.rules,
      workflow: V1,
      assumedOutputTokens: 1500,
    });
    expect(planned.units).toEqual([]);
    expect(planned.calls).toBe(0);
    expect(upperBoundUsd(planned, PRICE)).toBe(0);
  });

  it("add up: the totals are the sums of the units", () => {
    const planned = plan(V3);
    const sum = (pick: (u: RunPlan["units"][number]) => number) =>
      planned.units.reduce((total, u) => total + pick(u), 0);
    expect(planned.calls).toBe(sum((u) => u.calls));
    expect(planned.callsWithRepairs).toBe(sum((u) => u.callsWithRepair));
    expect(planned.inputTokens).toBe(sum((u) => u.inputTokens));
    expect(planned.inputTokensWithRepairs).toBe(sum((u) => u.inputTokensWithRepair));
    for (const unit of planned.units) {
      expect(unit.inputTokensWithRepair).toBeGreaterThanOrEqual(unit.inputTokens);
      expect(unit.callsWithRepair).toBeGreaterThanOrEqual(unit.calls);
    }
  });
});

describe("the tokens of a review", () => {
  it("grow with the documents", () => {
    const base = plan(V1);
    const longer = planRun({
      ingest: {
        ...world.ingest,
        spans: world.ingest.spans.map((span, index) =>
          index === 0 ? { ...span, text: `${span.text} ${"word ".repeat(1200)}` } : span,
        ),
      },
      manifest: world.manifest,
      rules: world.playbook.rules,
      workflow: V1,
      assumedOutputTokens: 1500,
    });
    // Six thousand characters more in the one clause that every call reads.
    expect(longer.inputTokens - base.inputTokens).toBeGreaterThanOrEqual(1500 * (1 + RULES));
    expect(longer.calls).toBe(base.calls);
  });

  it("count the repair prompt as the stage builds it: the first request, the note, and the schema", async () => {
    // The real stage, with a first answer that cites a clause it was not shown.
    const wm = V1;
    const analyze = getPrompt(wm.prompts.analyze);
    const bundles = buildBundles({
      ingest: world.ingest,
      extract: emptyExtractOutput(world.ingest, { degraded: false, notFoundReason: "dry run" }),
      rules: world.playbook.rules,
      policy: wm.retrieval,
      budgetTokens: wm.budgetTokens,
    });
    const schema = boundTokens(JSON.stringify(toJSONSchema(AnalysisSchema)));
    const planned = plan(wm);
    for (const bundle of bundles) {
      const generator = scriptedModel(world, { firstAnswerCitesUnknownClause: [bundle.ruleKey] });
      await runAnalyze({
        generator,
        bundle,
        ingest: world.ingest,
        manifest: world.manifest,
        prompt: analyze,
        repairAttempts: 1,
      });
      expect(generator.calls).toHaveLength(2);
      const tokens = (i: number): number =>
        boundTokens(generator.calls[i]!.system) + boundTokens(generator.calls[i]!.prompt) + schema;
      const unit = planned.units.find((u) => u.stage === "analyze" && u.unit === bundle.ruleKey);
      expect(unit?.inputTokens, bundle.ruleKey).toBe(tokens(0));
      // The note names a label that is not shown ("c999"), and the planner names "c999999": the
      // two notes are within a few tokens of each other, and the plan is the larger.
      expect(unit?.inputTokensWithRepair, bundle.ruleKey).toBeGreaterThanOrEqual(
        tokens(0) + tokens(1) - 4,
      );
      expect(unit?.inputTokensWithRepair, bundle.ruleKey).toBeLessThanOrEqual(
        tokens(0) + tokens(1) + 4,
      );
    }
  });

  it("are counted by the larger of the estimate and a third of the bytes", () => {
    expect(boundTokens("")).toBe(0);
    // Latin text: the estimate is a third of the characters, and so is a third of the bytes.
    expect(boundTokens("a".repeat(30))).toBe(10);
    // Another script: one token for each character, which is also a third of its three bytes.
    expect(boundTokens("\u6587".repeat(30))).toBe(30);
    // A character outside the basic plane takes four bytes, so the bytes give the larger figure.
    expect(boundTokens("\u{1F600}".repeat(30))).toBeGreaterThanOrEqual(40);
  });
});

describe("the most a review can cost", () => {
  const HAND: RunPlan = {
    units: [
      {
        stage: "extract",
        unit: "*",
        calls: 1,
        callsWithRepair: 1,
        inputTokens: 1000,
        inputTokensWithRepair: 1000,
      },
      {
        stage: "analyze",
        unit: "a-1",
        calls: 1,
        callsWithRepair: 2,
        inputTokens: 500,
        inputTokensWithRepair: 900,
      },
      {
        stage: "analyze",
        unit: "b-1",
        calls: 1,
        callsWithRepair: 2,
        inputTokens: 500,
        inputTokensWithRepair: 900,
      },
    ],
    assumedOutputTokens: 1500,
    calls: 3,
    callsWithRepairs: 5,
    inputTokens: 2000,
    inputTokensWithRepairs: 2800,
  };

  it("is the input at the plain price and the assumed output for every call, worked out by hand", () => {
    // 2,800 input tokens at $2 per million is $0.0056. Five calls of 1,500 output tokens at $10 is $0.075.
    expect(upperBoundUsd(HAND, PRICE)).toBeCloseTo(0.0806, 10);
  });

  it("counts only the units that have not finished", () => {
    const finished = new Set(["extract:*", "analyze:a-1"]);
    const rest = upperBoundUsd(HAND, PRICE, (unit) => !finished.has(unitKey(unit)));
    // One unit left: 900 input tokens ($0.0018) and two calls of 1,500 output tokens ($0.03).
    expect(rest).toBeCloseTo(0.0318, 10);
    expect(upperBoundUsd(HAND, PRICE, () => false)).toBe(0);
  });

  it("does not move with the cache prices, which are not assumed", () => {
    expect(upperBoundUsd(HAND, { ...PRICE, cacheRead: 99, cacheWrite: 99 })).toBe(
      upperBoundUsd(HAND, PRICE),
    );
  });

  it("grows with the output assumed for each call, and with nothing else that is free", () => {
    const low = upperBoundUsd(plan(V2, { assumedOutputTokens: 500 }), PRICE);
    const mid = upperBoundUsd(plan(V2, { assumedOutputTokens: 1500 }), PRICE);
    const high = upperBoundUsd(plan(V2, { assumedOutputTokens: 4000 }), PRICE);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    // The difference is the output only: calls times the extra tokens at the output price.
    const calls = plan(V2).callsWithRepairs;
    expect(high - mid).toBeCloseTo((calls * 2500 * PRICE.output) / 1_000_000, 10);
  });

  it("names a unit by its stage and its key", () => {
    expect(unitKey({ stage: "analyze", unit: "dur-1" })).toBe("analyze:dur-1");
    expect(unitKey({ stage: "extract", unit: "*" })).toBe("extract:*");
  });
});
