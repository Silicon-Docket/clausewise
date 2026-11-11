import { toJSONSchema } from "zod";
import { describe, expect, it } from "vitest";
import {
  AnalysisSchema,
  type RunManifest,
  type SourceSpan,
  type WorkflowManifest,
} from "../../src/contracts.js";
import { renderRule, renderSpans } from "../../src/prompts/render.js";
import { createRepository, openDatabase } from "../../src/store/index.js";
import { SpendRefusedError } from "../../src/usage/errors.js";
import { createSpendGuard } from "../../src/usage/guard.js";
import { parsePriceTable } from "../../src/usage/prices.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { estimateTokens } from "@clausewise/review";
import { emptyExtractOutput, runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import {
  boundTokens,
  estimateThirds,
  largestSelectionTokens,
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

describe("a document longer than the context budget", () => {
  // One clause is padded so that the documents together are far over the budget of 12,000 tokens:
  // every rule reading the whole document is over budget and cannot be sent. A real extract answer
  // locates a few clauses per category, and the rules whose clauses it located are sent with those
  // clauses and still fit. The plan cannot know which, so it must bound every rule that could be.
  const longIngest = {
    ...world.ingest,
    spans: world.ingest.spans.map((span, index) =>
      index === 0 ? { ...span, text: `${span.text} ${"word ".repeat(9000)}` } : span,
    ),
  };
  const planLong = (workflow: WorkflowManifest) =>
    planRun({
      ingest: longIngest,
      manifest: world.manifest as RunManifest,
      rules: world.playbook.rules,
      workflow,
      assumedOutputTokens: 1500,
    });
  const schemaTokens = boundTokens(JSON.stringify(toJSONSchema(AnalysisSchema)));

  /** What the real stages send for this document: the bundles of a real extract answer. */
  async function realRun(workflow: WorkflowManifest) {
    const generator = scriptedModel(world);
    const extracted = await runExtract({
      generator,
      ingest: longIngest,
      manifest: world.manifest,
      prompt: getPrompt(workflow.prompts.extract),
    });
    const bundles = buildBundles({
      ingest: longIngest,
      extract: extracted.output,
      rules: world.playbook.rules,
      policy: workflow.retrieval,
      budgetTokens: workflow.budgetTokens,
    });
    const sent = [] as { ruleKey: string; first: number; second: number }[];
    for (const bundle of bundles) {
      if (bundle.overBudget) continue;
      const answering = scriptedModel(world, { firstAnswerCitesUnknownClause: [bundle.ruleKey] });
      await runAnalyze({
        generator: answering,
        bundle,
        ingest: longIngest,
        manifest: world.manifest,
        prompt: getPrompt(workflow.prompts.analyze),
        repairAttempts: workflow.repairAttempts,
      });
      const tokens = (i: number): number =>
        boundTokens(answering.calls[i]!.system) +
        boundTokens(answering.calls[i]!.prompt) +
        schemaTokens;
      sent.push({ ruleKey: bundle.ruleKey, first: tokens(0), second: tokens(1) });
    }
    return { bundles, sent };
  }

  it("is read as the test intends: the whole document is over budget and a real extract answer makes rules sendable", async () => {
    const { bundles, sent } = await realRun(V1);
    // Every bundle that reads the whole document is over budget. Some do, because they share a category.
    expect(bundles.filter((b) => b.fullDocument).every((b) => b.overBudget)).toBe(true);
    expect(bundles.some((b) => b.overBudget)).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(3);
  });

  for (const workflow of [V1, V2]) {
    it(`bounds every rule that the real run would send, under ${workflow.label}`, async () => {
      const { sent } = await realRun(workflow);
      const planned = planLong(workflow);
      for (const real of sent) {
        const unit = planned.units.find((u) => u.stage === "analyze" && u.unit === real.ruleKey);
        expect(unit, `the plan has an analyze unit for ${real.ruleKey}`).toBeDefined();
        expect(unit!.inputTokens, real.ruleKey).toBeGreaterThanOrEqual(real.first);
        expect(unit!.inputTokensWithRepair, real.ruleKey).toBeGreaterThanOrEqual(
          real.first + real.second,
        );
      }
    });
  }

  it("does not plan the rules that always read the whole document, which are never sent", () => {
    const planned = planLong(V1);
    const bundles = buildBundles({
      ingest: longIngest,
      extract: emptyExtractOutput(longIngest, { degraded: false, notFoundReason: "dry run" }),
      rules: world.playbook.rules,
      policy: V1.retrieval,
      budgetTokens: V1.budgetTokens,
    });
    expect(bundles.every((b) => b.overBudget)).toBe(true);
    const shared = world.playbook.rules.filter(
      (rule) => world.playbook.rules.filter((r) => r.category === rule.category).length > 1,
    );
    expect(shared.length).toBeGreaterThanOrEqual(2);
    const analysed = planned.units.filter((u) => u.stage === "analyze").map((u) => u.unit);
    for (const rule of shared) expect(analysed, rule.key).not.toContain(rule.key);
    expect(analysed.length).toBe(RULES - shared.length);
  });

  it("is never more than a rule can send: a rule is planned at the budget, not at the document", () => {
    const planned = planLong(V1);
    const wholeAnalyze = plan(V1).units.find((u) => u.stage === "analyze")!;
    const capped = planned.units.filter((u) => u.stage === "analyze");
    expect(capped.length).toBeGreaterThan(0);
    for (const unit of capped) {
      // A prompt of 12,000 estimated tokens plus the fixed parts, and not the 15,000 of the document.
      expect(unit.inputTokens, unit.unit).toBeLessThan(
        V1.budgetTokens * 1.2 + wholeAnalyze.inputTokens,
      );
    }
  });

  it("adds a support call for each rule that could be sent, when the workflow has a support prompt", () => {
    const planned = planLong(V3);
    const analysed = planned.units.filter((u) => u.stage === "analyze").map((u) => u.unit);
    expect(analysed.length).toBeGreaterThan(0);
    expect(planned.units.filter((u) => u.stage === "verify").map((u) => u.unit)).toEqual(analysed);
  });

  it("raises the bound of the review, so that the start is refused when the limit is between the two", () => {
    const longPlan = planLong(V1);
    const extractOnly: RunPlan = {
      ...longPlan,
      units: longPlan.units.filter((u) => u.stage === "extract"),
    };
    const was = upperBoundUsd(extractOnly, PRICE);
    const now = upperBoundUsd(longPlan, PRICE);
    expect(now).toBeGreaterThan(was * 2);
    const guard = createSpendGuard({
      limits: { perReviewUsd: (was + now) / 2, perDayUsd: 100, assumedOutputTokens: 1500 },
      provider: "anthropic",
      model: "model-a",
      priceTable: parsePriceTable({ "model-a": PRICE }),
      price: PRICE,
      repo: createRepository(openDatabase(":memory:")),
      log: () => undefined,
    });
    const start = { kind: "start" as const, finishedUnits: new Set<string>(), spentOnRunUsd: 0 };
    expect(() => guard.preflight({ ...start, plan: longPlan })).toThrow(SpendRefusedError);
    // What the old plan counted for this document fits, which is why it was accepted.
    expect(guard.preflight({ ...start, plan: extractOnly }).boundUsd).toBeCloseTo(was, 12);
  });
});

describe("the largest selection a rule can be sent with", () => {
  const rule = world.playbook.rules[0]!;
  const BUDGET = 400;
  const span = (index: number, text: string): SourceSpan => ({
    ...world.ingest.spans[0]!,
    id: `span-${index}` as SourceSpan["id"],
    modelLabel: `c${index}`,
    label: `D1-p${index}`,
    clauseNumber: `${index}.1`,
    text,
  });
  const PIECES = [
    "the receiving party shall keep it secret ",
    "caf\u00e9 na\u00efve r\u00e9sum\u00e9 \u00fcber \u00e0 la ",
    "\u0414\u043e\u0433\u043e\u0432\u043e\u0440 \u043e \u043d\u0435\u0440\u0430\u0437\u0433\u043b\u0430\u0448\u0435\u043d\u0438\u0438 ",
    "\u7684\u4fdd\u5bc6\u4e49\u52a1\u5e94\u5f53\u5c65\u884c ",
    "\u{1F600}\u{1F4C4} ",
  ];

  it("counts the estimate in thirds the way estimateTokens counts it, rounded up", () => {
    for (const text of [
      "",
      "a",
      "abc",
      "abcd",
      "caf\u00e9 \u00fcber",
      "\u0414\u043e\u0433\u043e\u0432\u043e\u0440",
      "\u7684\u4fdd\u5bc6 and some Latin",
      "\u{1F600} \u{1F4C4} x",
      "lone \ud800 surrogate",
      ...PIECES,
    ])
      expect(Math.ceil(estimateThirds(text) / 3), JSON.stringify(text)).toBe(estimateTokens(text));
  });

  it("is the room the budget leaves for plain Latin text, and not a token more", () => {
    const spans = Array.from({ length: 200 }, (_, i) =>
      span(i, "the receiving party shall keep it secret"),
    );
    // The budget less the rule's own text, which the retrieval counts in the same estimate.
    const room = BUDGET - Math.floor(estimateThirds(renderRule(rule)) / 3);
    expect(largestSelectionTokens(spans, rule, BUDGET)).toBe(room);
  });

  it("is larger where a script takes more bytes than the estimate allows for, and never above twice the room", () => {
    const latin = Array.from({ length: 200 }, (_, i) =>
      span(i, "the receiving party shall keep it secret"),
    );
    const accented = Array.from({ length: 200 }, (_, i) => span(i, "\u00e9".repeat(40)));
    const base = largestSelectionTokens(latin, rule, BUDGET)!;
    const bound = largestSelectionTokens(accented, rule, BUDGET)!;
    expect(bound).toBeGreaterThan(base * 1.3);
    expect(bound).toBeLessThanOrEqual(2 * BUDGET);
  });

  it("has no selection when not one clause fits with the rule's own text", () => {
    expect(largestSelectionTokens([span(1, "x".repeat(3000))], rule, BUDGET)).toBeNull();
    expect(
      largestSelectionTokens([span(1, "x")], rule, estimateTokens(renderRule(rule))),
    ).toBeNull();
    expect(largestSelectionTokens([], rule, BUDGET)).toBeNull();
  });

  it("is at least what any selection that fits the budget adds to a prompt, whatever the scripts", () => {
    // A fixed pseudo-random sequence, so that a failure repeats.
    let seed = 12345;
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const spans = Array.from({ length: 60 }, (_, i) =>
      span(
        i,
        Array.from({ length: 1 + next(4) }, () =>
          PIECES[next(PIECES.length)]!.repeat(1 + next(3)),
        ).join(""),
      ),
    );
    const bound = largestSelectionTokens(spans, rule, BUDGET)!;
    let tried = 0;
    let widest = 0;
    for (let round = 0; round < 400; round++) {
      const order = spans.map((s, i) => [next(1000) + i, s] as const).sort((a, b) => a[0] - b[0]);
      const chosen: SourceSpan[] = [];
      for (const [, candidate] of order) {
        const trial = [...chosen, candidate];
        // The retrieval's own test of whether a bundle fits.
        if (estimateTokens(`${renderSpans(trial)}\n\n${renderRule(rule)}`) > BUDGET) continue;
        chosen.push(candidate);
      }
      if (chosen.length === 0) continue;
      tried += 1;
      const added = boundTokens(renderSpans(chosen));
      widest = Math.max(widest, added);
      expect(added, `round ${round}`).toBeLessThanOrEqual(bound);
    }
    expect(tried).toBeGreaterThan(300);
    // The figure is a bound and not far above what was found: it is within the budget's own 2x.
    expect(bound).toBeLessThanOrEqual(2 * BUDGET);
    expect(widest).toBeGreaterThan(0);
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
