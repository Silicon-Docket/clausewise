/**
 * Support for the tests of the exposure suite (evals/src/parol/exposure). Not a test file.
 *
 * The committed dataset does not yet register the cases that name a canary matter or that carry
 * upload steps, so the tests build one in memory from the case definitions (the same builder
 * `pnpm fixtures:parol` runs) and hand the suite a `Dataset` with the same shape `loadDataset`
 * gives. Every document is synthetic. Nothing here calls a model: the model of the suite is a
 * scripted oracle.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoadedPlaybook } from "../../apps/parol/src/module-contracts.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { buildDataset, type BuiltDataset } from "../../fixtures/parol/build.js";
import { PLAYBOOK_FILE, PLAYBOOK_SLUG } from "../../fixtures/parol/cases.js";
import { D05 } from "../../fixtures/parol/cases/d05.js";
import { D09 } from "../../fixtures/parol/cases/d09.js";
import { D10 } from "../../fixtures/parol/cases/d10.js";
import { H08 } from "../../fixtures/parol/cases/h08.js";
import { H09 } from "../../fixtures/parol/cases/h09.js";
import type { Dataset } from "../src/parol/dataset.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const YAML = readFileSync(join(ROOT, PLAYBOOK_FILE), "utf8");

/** What an exposure record says about the workflow its reviews ran under, for a record a test composes. */
export function reviewedUnder(label = "v2"): { label: string; sha256: string } {
  return { label, sha256: workflowFor(label).sha256 };
}

export const playbook: LoadedPlaybook = loadPlaybook({ yaml: YAML, slug: PLAYBOOK_SLUG });

let built: Promise<BuiltDataset> | undefined;

/** D05 (the probes), D09 and H08 (upload steps), D10 and H09 (canary matters). Built once per file. */
export function builtDataset(): Promise<BuiltDataset> {
  built ??= buildDataset({
    cases: [D05, D09, D10, H08, H09],
    playbookYaml: YAML,
    playbookSlug: PLAYBOOK_SLUG,
  });
  return built;
}

/** A `Dataset` as `loadDataset` makes one, from the built files held in memory. */
export async function memoryDataset(
  edit: (keys: BuiltDataset["answerKeys"]) => void = () => {},
): Promise<Dataset> {
  const source = await builtDataset();
  const keys = structuredClone(source.answerKeys);
  edit(keys);
  // Like loadDataset: only the files that cases and twins name as documents.
  const named = new Set(
    [...keys.cases, ...keys.twins].flatMap((entry) => entry.documents.map((doc) => doc.file)),
  );
  const files = new Map(
    source.files.filter((file) => named.has(file.name)).map((file) => [file.name, file.bytes]),
  );
  return {
    root: ROOT,
    label: source.splits.dataset,
    keys,
    splits: source.splits,
    files,
    answerKeysSha256: "",
    splitsFileSha256: "",
    integrity: [],
  };
}

/** The same, with every file the builder wrote, extras and canary documents included. */
export async function completeDataset(
  edit: (keys: BuiltDataset["answerKeys"]) => void = () => {},
): Promise<Dataset> {
  const source = await builtDataset();
  const dataset = await memoryDataset(edit);
  return {
    ...dataset,
    files: new Map(source.files.map((file) => [file.name, file.bytes])),
  };
}

export const never = (): AbortSignal => new AbortController().signal;

/** An en dash or an em dash, built from code points so that this file holds neither. */
export const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

/** The shape of a canary string, and of the ids of records: nothing printed may match either. */
export const CANARY_SHAPE = /CANARY-[A-Z]+-[0-9a-f]{12}/i;
export const ID_SHAPE = /(ver|mat|doc|dv)_[0-9a-f]{8}/;
