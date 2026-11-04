/**
 * Reads the evaluation dataset from fixtures/parol and checks it against the hashes recorded in
 * splits.json before anything is run. A run on a key or a document that is not the one that was
 * committed measures something else, so a difference stops the run with an integrity failure
 * (exit code 2) before a model is called or a cent is spent.
 *
 * The check recomputes, with the builder's own `splitHash`, what splits.json records for each
 * split, and separately compares each file with the hash its answer key holds. It catches a
 * changed key entry, a changed byte of a document, a missing or added file, and a splits file
 * edited to say something else. It cannot catch an attacker who changes the key, the files and the
 * splits file together, which is why the held-out hash is committed to the repository's history
 * before the first baseline (docs/parol/05).
 *
 * Problems name a case, a file or a split and never repeat the content of a key or a document.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex } from "../../../apps/parol/src/canonical.js";
import { splitHash, totalsOf, type BuiltFile } from "../../../fixtures/parol/build.js";
import {
  SPLITS,
  type AnswerKeyCase,
  type AnswerKeyFile,
  type AnswerKeyTwin,
  type PlaybookRuleFacts,
  type Split,
  type SplitsFile,
} from "../../../fixtures/parol/types.js";

/** Where the dataset lives, relative to the repository root. */
export const DATASET_DIR = "fixtures/parol";

// A file name comes out of the answer key, which has not been verified when it is read. Only a
// plain name is opened, so a changed key cannot make the runner read another path.
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface SplitIntegrity {
  split: Split;
  /** Recomputed from the keys and the files as read. */
  sha256: string;
  /** What splits.json records. */
  recorded: string;
  matches: boolean;
}

export interface Dataset {
  root: string;
  /** `dataset` in splits.json, such as "parol-cases v1". */
  label: string;
  keys: AnswerKeyFile;
  splits: SplitsFile;
  /** Every file the keys name, by file name. */
  files: ReadonlyMap<string, Uint8Array>;
  /** Of answer-keys.json and splits.json exactly as read. */
  answerKeysSha256: string;
  splitsFileSha256: string;
  integrity: SplitIntegrity[];
}

export type DatasetLoad =
  { ok: true; dataset: Dataset } | { ok: false; problems: string[]; integrity: SplitIntegrity[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(path: string, name: string, problems: string[]) {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    problems.push(`${name} cannot be read`);
    return undefined;
  }
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown, sha256: sha256Hex(bytes) };
  } catch {
    problems.push(`${name} is not valid JSON`);
    return undefined;
  }
}

/** The named documents of a case or a twin, in key order. */
const documentFiles = (entry: AnswerKeyCase | AnswerKeyTwin): string[] =>
  entry.documents.map((document) => document.file);

export async function loadDataset(root: string): Promise<DatasetLoad> {
  const dir = join(root, DATASET_DIR);
  const problems: string[] = [];
  const keysRead = await readJson(join(dir, "answer-keys.json"), "answer-keys.json", problems);
  const splitsRead = await readJson(join(dir, "splits.json"), "splits.json", problems);
  if (keysRead === undefined || splitsRead === undefined) {
    return { ok: false, problems, integrity: [] };
  }
  const keys = keysRead.value as AnswerKeyFile;
  const splits = splitsRead.value as SplitsFile;
  if (
    !isObject(keys) ||
    keys.format !== 1 ||
    !Array.isArray(keys.cases) ||
    !Array.isArray(keys.twins) ||
    !isObject(keys.playbook) ||
    !isObject(keys.playbook.rules)
  ) {
    return {
      ok: false,
      problems: ["answer-keys.json does not have the shape of an answer key file"],
      integrity: [],
    };
  }
  if (!isObject(splits) || splits.format !== 1 || !isObject(splits.splits)) {
    return {
      ok: false,
      problems: ["splits.json does not have the shape of a splits file"],
      integrity: [],
    };
  }

  // Every file the keys name, read once.
  const files = new Map<string, Uint8Array>();
  for (const entry of [...keys.cases, ...keys.twins]) {
    if (!isObject(entry) || !Array.isArray(entry.documents)) {
      problems.push("answer-keys.json holds an entry without documents");
      continue;
    }
    const where = String(entry.case);
    for (const file of documentFiles(entry)) {
      if (typeof file !== "string" || !SAFE_FILE.test(file)) {
        problems.push(`${where}: a document has a file name that is not a plain name`);
        continue;
      }
      if (files.has(file)) continue;
      try {
        files.set(file, new Uint8Array(await readFile(join(dir, "files", file))));
      } catch {
        problems.push(`${where} ${file}: the file is missing`);
      }
    }
  }

  // Each file against the hash its own key entry records.
  for (const entry of [...keys.cases, ...keys.twins]) {
    if (!Array.isArray(entry.documents)) continue;
    for (const document of entry.documents) {
      const bytes = files.get(document.file);
      if (bytes !== undefined && sha256Hex(bytes) !== document.sha256) {
        problems.push(
          `${entry.case} ${document.file}: the file differs from the hash in the answer key`,
        );
      }
    }
  }

  // Each split against splits.json.
  const integrity: SplitIntegrity[] = [];
  const severity = (ruleKey: string): string => keys.playbook.rules[ruleKey]?.severity ?? "";
  for (const split of SPLITS) {
    const cases = keys.cases.filter((entry) => entry.split === split);
    const twins = keys.twins.filter((entry) => entry.split === split);
    const recorded = splits.splits[split];
    if (recorded === undefined) {
      if (cases.length > 0) {
        problems.push(`split ${split}: the answer keys hold cases but splits.json records no hash`);
      }
      continue;
    }
    if (cases.length === 0) {
      problems.push(`split ${split}: splits.json records a hash but the answer keys hold no cases`);
      continue;
    }
    const names = [...new Set([...cases, ...twins].flatMap(documentFiles))];
    const built: BuiltFile[] = [];
    let complete = true;
    for (const name of names) {
      const bytes = files.get(name);
      if (bytes === undefined) complete = false;
      else built.push({ name, bytes });
    }
    // With a file missing there is nothing sound to hash. The file is already a problem.
    if (!complete) continue;
    const sha256 = splitHash({ cases, twins }, built);
    const matches = sha256 === recorded.sha256;
    integrity.push({ split, sha256, recorded: recorded.sha256, matches });
    if (!matches) {
      problems.push(
        `split ${split}: the answer keys and files hash to ${sha256.slice(0, 12)} but ` +
          `splits.json records ${String(recorded.sha256).slice(0, 12)}`,
      );
    }
    if (recorded.files !== names.length) {
      problems.push(
        `split ${split}: it holds ${names.length} files and splits.json records ${recorded.files}`,
      );
    }
    // The totals are derived from the keys and never maintained by hand (docs/parol/05).
    const totals = totalsOf(cases, twins, severity);
    for (const [name, value] of Object.entries(totals)) {
      if ((recorded as unknown as Record<string, unknown>)[name] !== value) {
        problems.push(`split ${split}: the recorded total "${name}" is not what the keys give`);
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems, integrity };
  return {
    ok: true,
    dataset: {
      root,
      label: typeof splits.dataset === "string" ? splits.dataset : "unlabelled",
      keys,
      splits,
      files,
      answerKeysSha256: keysRead.sha256,
      splitsFileSha256: splitsRead.sha256,
      integrity,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The playbook facts of the key
// ---------------------------------------------------------------------------------------------

// A rule id is repeated only when it reads as one; a key that has been edited can hold anything.
const PLAIN_RULE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * The facts about each playbook rule that the answer key carries (category, severity, required)
 * against the playbook as loaded. `splitHash` covers the cases, the twins and the files, so these
 * facts are not under any recorded hash, and the severity of a rule sets the weight of every slot
 * of that rule (SWF, and gate G4's high-severity count). The playbook text itself is pinned by its
 * own hash, so once that matches, any difference here is an edit of the key.
 *
 * Problems name the rule and the fact and never repeat a value.
 */
export function playbookFactProblems(
  keyRules: Readonly<Record<string, PlaybookRuleFacts>>,
  playbookRules: readonly { key: string; category: string; severity: string; required: boolean }[],
): string[] {
  const problems: string[] = [];
  const inPlaybook = new Set(playbookRules.map((rule) => rule.key));
  for (const rule of playbookRules) {
    const fact = Object.hasOwn(keyRules, rule.key) ? keyRules[rule.key] : undefined;
    if (!isObject(fact)) {
      problems.push(`rule ${rule.key}: the answer key holds no facts for a rule of the playbook`);
      continue;
    }
    if (fact.category !== rule.category) {
      problems.push(`rule ${rule.key}: the category in the answer key differs from the playbook`);
    }
    if (fact.severity !== rule.severity) {
      problems.push(`rule ${rule.key}: the severity in the answer key differs from the playbook`);
    }
    if (fact.required !== rule.required) {
      problems.push(
        `rule ${rule.key}: the required flag in the answer key differs from the playbook`,
      );
    }
  }
  for (const key of Object.keys(keyRules)) {
    if (!inPlaybook.has(key)) {
      problems.push(
        `rule ${PLAIN_RULE.test(key) ? key : "(a name that is not shown)"}: the answer key holds facts for a rule the playbook does not have`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Choosing cases
// ---------------------------------------------------------------------------------------------

export class CaseSelectionError extends Error {
  override name = "CaseSelectionError";
}

export interface CaseGroup {
  split: Split;
  cases: AnswerKeyCase[];
  /** The twins of the selected cases. They are run with them, so that the injection effect can be scored. */
  twins: AnswerKeyTwin[];
  /** Cases the split holds, selected or not. */
  splitCases: number;
}

/**
 * The cases to run. `which` is a split, or "all" for every split that has cases; `only` limits it
 * to the named cases. A name that is not a case of the chosen splits is refused, because a typo
 * that quietly ran nothing would look like a clean result.
 */
export function selectCases(
  dataset: Dataset,
  which: Split | "all",
  only: readonly string[],
): CaseGroup[] {
  const splits = which === "all" ? SPLITS : [which];
  const groups: CaseGroup[] = [];
  const chosen = new Set<string>();
  for (const split of splits) {
    const all = dataset.keys.cases.filter((entry) => entry.split === split);
    if (all.length === 0) continue;
    const cases = only.length === 0 ? all : all.filter((entry) => only.includes(entry.case));
    for (const entry of cases) chosen.add(entry.case);
    if (cases.length === 0) continue;
    const names = new Set(cases.map((entry) => entry.case));
    groups.push({
      split,
      cases,
      twins: dataset.keys.twins.filter((twin) => twin.split === split && names.has(twin.twinOf)),
      splitCases: all.length,
    });
  }
  const unknown = only.filter((name) => !chosen.has(name));
  if (unknown.length > 0) {
    throw new CaseSelectionError(
      `${unknown.length === 1 ? "A case you named is" : `${unknown.length} cases you named are`} ` +
        `not in the chosen split of this dataset. List the keys with the case names in ` +
        `fixtures/parol/answer-keys.json (PAROL-D01 and so on).`,
    );
  }
  if (groups.length === 0) {
    throw new CaseSelectionError(
      which === "all"
        ? "The dataset has no cases."
        : `The ${which} split has no cases in this dataset.`,
    );
  }
  return groups;
}
