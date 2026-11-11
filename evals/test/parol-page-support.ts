/**
 * Support for the tests of the comparison page document (parol-page-build, parol-cli-publish,
 * parol-page-e2e). Not a test file.
 *
 * Every results file used here is a REAL one, written by the evaluation command in this process:
 * a SIMULATED run (the demo's scripted reader) or a SELFTEST run (the scripted oracle that reads
 * the answer key). No file is edited to say something it did not, except where a test says so at
 * the place it does. No model is called and no key is read; the numbers in these files are the
 * numbers of scripted stand-ins and say nothing about any model.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import type { SourceSpan } from "../../apps/parol/src/contracts.js";
import { buildIngest } from "../../apps/parol/src/ingest/ingest.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import type { LoadedPlaybook } from "../../apps/parol/src/module-contracts.js";
import type { AnswerKeyCase } from "../../fixtures/parol/types.js";
import { loadDataset, type Dataset } from "../src/parol/dataset.js";
import { readCaseDocuments, runnableCases } from "../src/parol/runner.js";
import { REPO_ROOT, run } from "../src/parol/testing-run.js";

/** A fixed commit, so that two runs agree on their `code` pin whatever state the checkout is in. */
export const GIT = async (): Promise<{ commit: string; dirty: boolean }> => ({
  commit: "a".repeat(40),
  dirty: false,
});

const NOW = (): Date => new Date("2026-11-05T09:00:00.000Z");

/**
 * A SIMULATED run of the worked example (PAROL-D05) under `workflow`, written to `<dir>/<name>`.
 * Returns the path of the results file.
 */
export async function simulatedRun(
  dir: string,
  name: string,
  workflow: "v1" | "v2",
): Promise<string> {
  const out = join(dir, name);
  const result = await run(
    ["--simulate", "--workflow", workflow, "--case", "PAROL-D05", "--out", out],
    { resultsDir: join(dir, "results"), gitInfo: GIT, now: NOW },
  );
  expect(result.code, result.stderr).toBe(0);
  return out;
}

/**
 * A scripted run of one case of the held-out split (PAROL-H01), written to `<dir>/<name>`. The
 * simulated reader declines every document but the worked example and the selftest oracle reads the
 * key, so a SIMULATED baseline against a SELFTEST candidate has changed slots on this split. The
 * two are compared with `--allow-differences model,mode`.
 */
export async function scriptedHeldoutRun(
  dir: string,
  name: string,
  mode: "simulate" | "selftest",
): Promise<string> {
  const out = join(dir, name);
  const result = await run(
    [`--${mode}`, "--split", "heldout", "--allow-heldout", "--case", "PAROL-H01", "--out", out],
    { resultsDir: join(dir, "results"), gitInfo: GIT, now: NOW },
  );
  expect(result.code, result.stderr).toBe(0);
  return out;
}

export const HELDOUT_ALLOW = ["model", "mode"] as const;

/** The committed dataset and the playbook its answer keys pin, loaded as the command loads them. */
export async function loadWorld(): Promise<{ dataset: Dataset; playbook: LoadedPlaybook }> {
  const loaded = await loadDataset(REPO_ROOT);
  if (!loaded.ok) throw new Error("the committed dataset does not load");
  const { dataset } = loaded;
  const yaml = await readFile(
    join(REPO_ROOT, "apps", "parol", "playbooks", `${dataset.keys.playbook.slug}.yaml`),
    "utf8",
  );
  return { dataset, playbook: loadPlaybook({ yaml, slug: dataset.keys.playbook.slug }) };
}

/** The key of a case and the paragraphs of its operative documents, read as a run reads them. */
export async function readCase(
  dataset: Dataset,
  caseKey: string,
): Promise<{ key: AnswerKeyCase; spans: SourceSpan[] }> {
  const key = dataset.keys.cases.find((entry) => entry.case === caseKey);
  if (key === undefined) throw new Error(`the dataset has no case ${caseKey}`);
  const [runnable] = runnableCases({ cases: [key], twins: [] });
  const documents = await readCaseDocuments({
    dataset,
    runnable: runnable!,
    repeat: 1,
    parsed: new Map(),
  });
  return { key, spans: buildIngest({ documents }).spans };
}

// The style rule bans en and em dashes. The pattern is built from code points so this file has none.
export const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
