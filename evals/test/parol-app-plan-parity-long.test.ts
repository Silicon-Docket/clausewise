import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LoadedPlaybook } from "../../apps/parol/src/module-contracts.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { planRun, upperBoundUsd, type RunPlan } from "../../apps/parol/src/usage/plan.js";
import { loadDataset, selectCases, type Dataset } from "../src/parol/dataset.js";
import { buildParolPlan, costBounds } from "../src/parol/plan.js";
import { prepareCase, runnableCases, type ParsedFiles } from "../src/parol/runner.js";
import { REPO_ROOT } from "../src/parol/testing-run.js";

/**
 * A document longer than the context budget. The dataset holds none, so the two planners (the
 * application's, apps/parol/src/usage/plan.ts, and the evaluation's dry run, evals/src/parol/plan.ts)
 * agree on every case of the dataset whether or not they handle one. This file pads the first
 * clause of every case, by wrapping the runner's `prepareCase` so that both planners see the same
 * padded ingest, and holds them to the same figures.
 *
 * Over the budget, a rule that reads the whole document is not sent with it. A rule that shares a
 * category with another always reads the whole document and is never sent. Any other rule is sent
 * with whatever clauses the real extract answer locates, so both planners must bound it by the
 * largest selection that could fit, and neither may leave it out of the bound.
 */
vi.mock("../src/parol/runner.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/parol/runner.js")>();
  return {
    ...real,
    prepareCase: async (...args: Parameters<typeof real.prepareCase>) => {
      const prepared = await real.prepareCase(...args);
      return {
        ...prepared,
        ingest: {
          ...prepared.ingest,
          spans: prepared.ingest.spans.map((span, index) =>
            index === 0 ? { ...span, text: `${span.text} ${"word ".repeat(9000)}` } : span,
          ),
        },
      };
    },
  };
});

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

// Invented rates, USD per million tokens. Nothing here is a price list.
const PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const OUTPUT = 1500;

describe("the application's planner and the evaluation's dry run, on documents over the context budget", () => {
  for (const label of ["v1", "v2", "v3"]) {
    it(`count the same calls, the same input tokens and the same money, under ${label}`, async () => {
      const workflow = workflowFor(label);
      const group = selectCases(dataset, "all", []).find((g) => g.split === "dev")!;
      const runnables = runnableCases(group);
      const theirs = await buildParolPlan({
        dataset,
        runnables,
        playbook,
        workflow,
        repeats: 1,
        assumedOutputTokens: OUTPUT,
      });
      const parsed: ParsedFiles = new Map();
      const units: RunPlan["units"] = [];
      let planned = 0;
      for (const runnable of runnables) {
        const prepared = await prepareCase({
          dataset,
          runnable,
          repeat: 1,
          playbook,
          workflow,
          parsed,
        });
        const ours = planRun({
          ingest: prepared.ingest,
          manifest: { ...prepared.manifest, model: { provider: "plan", model: "plan" } },
          rules: playbook.rules,
          workflow: workflow.manifest,
          assumedOutputTokens: OUTPUT,
        });
        const theirCase = theirs.cases.find((c) => c.caseKey === runnable.caseKey)!;
        const where = `${label} ${runnable.caseKey}`;
        expect(ours.calls, where).toBe(theirCase.calls);
        expect(ours.callsWithRepairs, where).toBe(theirCase.callsWithRepairs);
        expect(ours.inputTokens, where).toBe(theirCase.inputTokens);
        expect(ours.inputTokensWithRepairs, where).toBe(theirCase.inputTokensWithRepairs);
        // The rules the evaluation says are not sent are the rules the application has no
        // analyze unit for, and the padding really put some rules over the budget.
        const analyzed = ours.units.filter((unit) => unit.stage === "analyze").length;
        expect(theirCase.rulesOverBudget, where).toBe(playbook.rules.length - analyzed);
        expect(theirCase.rulesOverBudget, where).toBeGreaterThan(0);
        // A rule sent with a selection is in the bound: more analyze units than the rules that
        // fit with the whole document.
        expect(analyzed, where).toBeGreaterThan(0);
        units.push(...ours.units);
        planned += 1;
      }
      expect(planned).toBe(theirs.cases.length);
      expect(planned).toBeGreaterThanOrEqual(10);
      const total: RunPlan = {
        units,
        assumedOutputTokens: OUTPUT,
        calls: 0,
        callsWithRepairs: 0,
        inputTokens: 0,
        inputTokensWithRepairs: 0,
      };
      expect(upperBoundUsd(total, PRICE), label).toBe(
        costBounds(theirs, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 }).withRepairsUsd,
      );
    });
  }

  it("send some rule with a selection of the padded document, which the evaluation's bound used to leave out", async () => {
    const workflow = workflowFor("v1");
    const group = selectCases(dataset, "all", []).find((g) => g.split === "dev")!;
    const runnable = runnableCases(group)[0]!;
    const prepared = await prepareCase({
      dataset,
      runnable,
      repeat: 1,
      playbook,
      workflow,
      parsed: new Map(),
    });
    const ours = planRun({
      ingest: prepared.ingest,
      manifest: { ...prepared.manifest, model: { provider: "plan", model: "plan" } },
      rules: playbook.rules,
      workflow: workflow.manifest,
      assumedOutputTokens: OUTPUT,
    });
    const alone = new Map<string, number>();
    for (const rule of playbook.rules)
      alone.set(rule.category, (alone.get(rule.category) ?? 0) + 1);
    // Every rule that has its category to itself has an analyze unit, however long the document.
    for (const rule of playbook.rules.filter((r) => alone.get(r.category) === 1)) {
      expect(
        ours.units.some((unit) => unit.stage === "analyze" && unit.unit === rule.key),
        rule.key,
      ).toBe(true);
    }
    expect(playbook.rules.some((r) => alone.get(r.category) === 1)).toBe(true);
  });
});
