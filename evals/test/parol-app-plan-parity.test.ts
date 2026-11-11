import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { LoadedPlaybook } from "../../apps/parol/src/module-contracts.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { planRun, upperBoundUsd, type RunPlan } from "../../apps/parol/src/usage/plan.js";
import { loadDataset, selectCases, type Dataset } from "../src/parol/dataset.js";
import { buildParolPlan, costBounds } from "../src/parol/plan.js";
import { prepareCase, runnableCases, type ParsedFiles } from "../src/parol/runner.js";
import { REPO_ROOT } from "../src/parol/testing-run.js";

/**
 * The application plans a review's calls from the stored documents with its own synchronous
 * planner (apps/parol/src/usage/plan.ts), because a review is started inside a synchronous
 * transaction. The evaluation plans by running the real stages against a generator that sends
 * nothing. They must agree on every case of the dataset, the twins included, under every workflow
 * version, or the spend guard of the server and the spend guard of the evaluation would bound two
 * different reviews.
 */

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

describe("the application's planner and the evaluation's dry run", () => {
  for (const label of ["v1", "v2", "v3"]) {
    it(`count the same calls and the same input tokens for every case, under ${label}`, async () => {
      const workflow = workflowFor(label);
      const groups = selectCases(dataset, "all", []);
      expect(groups.map((g) => g.split)).toEqual(["dev", "heldout"]);
      let compared = 0;
      const everyUnit: RunPlan["units"] = [];
      let evalCases = 0;
      for (const group of groups) {
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
            // The model is no part of any prompt; the evaluation's own plan gives it the same placeholder.
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
          everyUnit.push(...ours.units);
          compared += 1;
        }
        evalCases += theirs.cases.length;
        // The money: the evaluation's bound for the whole group and the application's for the
        // same units are the same number, because both sum whole tokens before they price them.
        const total: RunPlan = {
          units: everyUnit.splice(0),
          assumedOutputTokens: OUTPUT,
          calls: 0,
          callsWithRepairs: 0,
          inputTokens: 0,
          inputTokensWithRepairs: 0,
        };
        expect(upperBoundUsd(total, PRICE), `${label} ${group.split}`).toBe(
          costBounds(theirs, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 }).withRepairsUsd,
        );
      }
      // Every case and every twin of both splits was compared, not a sample.
      expect(compared).toBe(evalCases);
      expect(compared).toBeGreaterThanOrEqual(26);
    });
  }
});
