/**
 * Helpers for the tests of the evaluation runner and its command line. They copy the committed
 * dataset into a temporary folder so that a test can change a key, a document or the splits file
 * without touching the repository, capture what a run prints, and build scripted stand-ins for the
 * model. Nothing here is used by the runner itself, and nothing reads a real credential or calls
 * a model.
 *
 * Everything a test fabricates is labelled as fabricated where it is made.
 */
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnthropicUsage, ObjectGenerator } from "@clausewise/llm";
import type { SourceSpan } from "../../../apps/parol/src/contracts.js";
import {
  keyFileNames,
  splitHash,
  splitKeyParts,
  totalsOf,
  type BuiltFile,
} from "../../../fixtures/parol/build.js";
import type { AnswerKeyFile, Split, SplitsFile } from "../../../fixtures/parol/types.js";
import { runParol, type ParolGeneratorRequest, type ParolIo } from "./cli.js";
import { createKeyOracle } from "./oracle.js";
import { parseResults, type ResultsFile } from "./results.js";

export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** A key that exists only so that the configuration loads. Every test injects its own model. */
export const TEST_ENV = { ANTHROPIC_API_KEY: "sk-test-not-a-real-key" };

/**
 * What one repeat of a split of the committed dataset consists of, read from the answer keys: the
 * cases and injection twins that are run, the rule slots they hold (the twins are run and scored
 * with their original, so they count here) and the model calls of a scripted run, which makes one
 * extract call and one analyze call for each rule. A test that checks a count a run must produce
 * takes it from here, so it follows the dataset and does not repeat its size.
 */
export interface RunShape {
  cases: number;
  twins: number;
  /** Cases and twins: the runs of one repeat. */
  runs: number;
  rules: number;
  /** Rule slots of the cases alone, which is what the scores are over. */
  slots: number;
  /** Rule slots of the cases and the twins, which is what the plan counts. */
  runSlots: number;
  /** Model calls of one repeat. */
  calls: number;
}

export function committedRunShape(split: Split, root: string = REPO_ROOT): RunShape {
  const keys = JSON.parse(
    readFileSync(join(root, "fixtures", "parol", "answer-keys.json"), "utf8"),
  ) as AnswerKeyFile;
  const cases = keys.cases.filter((entry) => entry.split === split).length;
  const twins = keys.twins.filter((entry) => entry.split === split).length;
  const rules = Object.keys(keys.playbook.rules).length;
  const runs = cases + twins;
  return {
    cases,
    twins,
    runs,
    rules,
    slots: cases * rules,
    runSlots: runs * rules,
    calls: runs * (1 + rules),
  };
}

export async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "parol-evals-"));
}

export async function removeDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/** A copy of the dataset and the playbook under a new root, laid out as the repository is. */
export async function copyRoot(into: string): Promise<string> {
  const root = join(into, "root");
  await mkdir(join(root, "apps", "parol", "playbooks"), { recursive: true });
  await cp(
    join(REPO_ROOT, "fixtures", "parol", "files"),
    join(root, "fixtures", "parol", "files"),
    {
      recursive: true,
    },
  );
  for (const name of ["answer-keys.json", "splits.json"]) {
    await cp(join(REPO_ROOT, "fixtures", "parol", name), join(root, "fixtures", "parol", name));
  }
  // The calibration set, when the dataset has one: splits.json records its hash.
  await cp(
    join(REPO_ROOT, "fixtures", "parol", "calibration.json"),
    join(root, "fixtures", "parol", "calibration.json"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await cp(
    join(REPO_ROOT, "apps", "parol", "playbooks", "parol-nda-recipient.yaml"),
    join(root, "apps", "parol", "playbooks", "parol-nda-recipient.yaml"),
  );
  return root;
}

export async function editJson<T>(path: string, change: (value: T) => void): Promise<void> {
  const value = JSON.parse(await readFile(path, "utf8")) as T;
  change(value);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

const keysPath = (root: string): string => join(root, "fixtures", "parol", "answer-keys.json");
const splitsPath = (root: string): string => join(root, "fixtures", "parol", "splits.json");
export const filePath = (root: string, name: string): string =>
  join(root, "fixtures", "parol", "files", name);

/**
 * Rewrites splits.json to agree with the keys and files as they now are, so that a test can make
 * a change that the hashes do not catch (and see what else does). The files of a split are all the
 * files its keys name: documents, the extra files of upload steps and the canary matters.
 */
export async function rehash(root: string): Promise<void> {
  const keys = JSON.parse(await readFile(keysPath(root), "utf8")) as AnswerKeyFile;
  const splits = JSON.parse(await readFile(splitsPath(root), "utf8")) as SplitsFile;
  for (const split of ["dev", "heldout"] as Split[]) {
    const parts = splitKeyParts(keys, split);
    if (parts.cases.length === 0) continue;
    const names = keyFileNames(keys, split);
    const files: BuiltFile[] = [];
    for (const name of names) {
      files.push({ name, bytes: new Uint8Array(await readFile(filePath(root, name))) });
    }
    splits.splits[split] = {
      ...totalsOf(parts.cases, parts.twins, (rule) => keys.playbook.rules[rule]?.severity ?? ""),
      sha256: splitHash(parts, files),
      files: names.length,
    };
  }
  await writeFile(splitsPath(root), `${JSON.stringify(splits, null, 2)}\n`);
}

export async function changeKey(
  root: string,
  change: (keys: AnswerKeyFile) => void,
): Promise<void> {
  await editJson<AnswerKeyFile>(keysPath(root), change);
}

export const readKeys = async (root: string): Promise<AnswerKeyFile> =>
  JSON.parse(await readFile(keysPath(root), "utf8")) as AnswerKeyFile;

// ---------------------------------------------------------------------------------------------
// Running the command
// ---------------------------------------------------------------------------------------------

export interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  args: string[],
  io: Partial<ParolIo> & { resultsDir: string },
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await runParol(args, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: TEST_ENV,
    ...io,
  });
  return { code, stdout, stderr };
}

export async function readResults(path: string): Promise<ResultsFile> {
  return parseResults(await readFile(path, "utf8"));
}

// ---------------------------------------------------------------------------------------------
// Scripted stand-ins
// ---------------------------------------------------------------------------------------------

/**
 * A model stand-in that answers as the key does, and reports token usage for every call the way
 * the Anthropic adapter does. `usage` gets the 1-based number of the call.
 */
export function oracleFactory(options: {
  usage?: (call: number) => AnthropicUsage;
  /** Throws instead of answering from this call on. */
  failFrom?: { call: number; error: unknown };
}): { factory: (request: ParolGeneratorRequest) => ObjectGenerator; calls: () => number } {
  let calls = 0;
  const factory = (request: ParolGeneratorRequest): ObjectGenerator => {
    const inner = createKeyOracle({
      caseKey: request.prepared.runnable.caseKey,
      expect: request.prepared.runnable.expect,
      spans: request.prepared.ingest.spans,
      rules: request.playbook.rules,
    });
    return {
      provider: request.config?.provider ?? inner.provider,
      model: request.config?.model ?? inner.model,
      disclosure: "a scripted stand-in for a live model (nothing is sent anywhere)",
      cachesSharedPrefix: false,
      async generate(call) {
        calls += 1;
        if (options.failFrom !== undefined && calls >= options.failFrom.call) {
          throw options.failFrom.error;
        }
        if (options.usage !== undefined) request.onUsage(options.usage(calls));
        return inner.generate(call);
      },
    };
  };
  return { factory, calls: () => calls };
}

/** Every 30-character window of every span, to look for document text in an output. */
export function documentWindows(spans: readonly SourceSpan[], width = 30): Set<string> {
  const windows = new Set<string>();
  for (const span of spans) {
    for (let i = 0; i + width <= span.text.length; i++) {
      windows.add(span.text.slice(i, i + width));
    }
  }
  return windows;
}

export function containsDocumentText(output: string, windows: ReadonlySet<string>): boolean {
  for (let i = 0; i + 30 <= output.length; i++) {
    if (windows.has(output.slice(i, i + 30))) return true;
  }
  return false;
}
