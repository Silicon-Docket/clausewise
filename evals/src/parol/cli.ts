/**
 * The command line of the Parol evaluation (`pnpm eval:parol`): the options, the checks that run
 * before anything is spent, the run, and the report. `run.ts` is the thin entry point that wires
 * it to the process.
 *
 * Order of events, and what each step can stop:
 *
 *  1. The options are read (exit 1 for a bad one) and the held-out seal is checked (exit 1 without
 *     --allow-heldout).
 *  2. The dataset is read and checked against the hashes in fixtures/parol/splits.json, and every
 *     anchor of the key is resolved in the documents as ingested (exit 2, the most serious result).
 *  3. The playbook, the workflow and, for a live run, the model credentials and the price of the
 *     model are checked (exit 1). With --compare, the pins of the earlier run are checked against
 *     this run's (exit 1), so that a comparison that will be refused is refused before it is paid for.
 *  4. The plan is printed. A live run without --yes stops here (exit 3) with nothing sent, and so
 *     does one whose cost bound is above --max-cost.
 *  5. The run. The spend guard of the Clausewise harness holds a live run to --max-cost request by
 *     request (exit 3 when it stops a run). Ctrl-C ends the run (exit 130).
 *  6. The results file is written whole, the report goes to stdout, and with --compare the
 *     comparison follows.
 *
 * The plan and the progress go to stderr, the Markdown report to stdout. Nothing here logs,
 * stores or throws text from a document, a model or a provider.
 */
import { readFile, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import {
  LlmConfigError,
  createObjectGenerator,
  loadLlmConfig,
  type AnthropicUsage,
  type LlmConfig,
  type ObjectGenerator,
} from "@clausewise/llm";
import { loadPlaybook } from "../../../apps/parol/src/playbooks/load.js";
import type { LoadedPlaybook } from "../../../apps/parol/src/module-contracts.js";
import { WORKFLOWS, workflowFor } from "../../../apps/parol/src/prompts/workflows.js";
import { EvaluationProviderFailure } from "./runner.js";
import { DEFAULT_ASSUMED_OUTPUT_TOKENS, DEFAULT_MAX_COST_USD } from "../args.js";
import { BudgetExceeded, createBudget } from "../budget.js";
import { EvalError, UsageError, quoted, shown } from "../errors.js";
import { plain, usd } from "../guard.js";
import { costOf, loadPriceTable, priceFor, type Price } from "../prices.js";
import { assertWritable, writeFileAtomically } from "../results-file.js";
import { counted } from "../usage.js";
import { AnchorResolutionError } from "./anchors.js";
import {
  PIN_NAMES,
  compareResults,
  describeRefusal,
  diffPins,
  parseAllowDifferences,
  renderComparison,
  type PinName,
} from "./compare.js";
import {
  CaseSelectionError,
  loadDataset,
  playbookFactProblems,
  selectCases,
  type CaseGroup,
} from "./dataset.js";
import { ORACLE_MODEL, ORACLE_PROVIDER, createKeyOracle } from "./oracle.js";
import { buildParolPlan, costBounds, decideSpend, describeParolPlan } from "./plan.js";
import { renderReport } from "./report.js";
import { reportingFetch } from "./reported-model.js";
import {
  HELDOUT_SEAL_WARNING,
  NOT_CLEAN,
  assembleResults,
  costOfRun,
  endpointHost,
  evaluationPin,
  findContamination,
  loadResults,
  priceTableSha256,
  providerOwnHost,
  readGitInfo,
  recordHeldoutRun,
  runHealth,
  serialiseResults,
  workflowPin,
  type GitInfo,
  type ObservedRun,
  type Pins,
  type ResultsFile,
  type RunMode,
  type RunRecord,
} from "./results.js";
import {
  Meter,
  RULE_CONCURRENCY,
  anchorProblems,
  countOutcomes,
  observeRun,
  prepareCase,
  runStages,
  runnableCases,
  type ParsedFiles,
  type PreparedCase,
} from "./runner.js";
import { selftestFailures } from "./selftest.js";

export const EXIT_INTEGRITY = 2;
export const EXIT_SPEND_GUARD = 3;
export const EXIT_INTERRUPTED = 130;

const DEFAULT_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEFAULT_RESULTS_DIR = fileURLToPath(new URL("../../results/", import.meta.url));

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

export type SplitChoice = "dev" | "heldout" | "all";

export interface ParolOptions {
  selftest: boolean;
  simulate: boolean;
  split: SplitChoice;
  allowHeldout: boolean;
  workflow: string;
  runs: number;
  cases: string[];
  yes: boolean;
  maxCostUsd: number;
  assumedOutputTokens: number;
  prices: string | undefined;
  out: string | undefined;
  compare: string | undefined;
  allowDifferences: PinName[];
  playbook: string | undefined;
  help: boolean;
}

export const USAGE_HINT = 'Run "pnpm eval:parol --help" for usage.';

export const USAGE = `Parol evaluation: run the Parol stages over the synthetic cases of fixtures/parol, score the
result against the answer keys, check the release gates and write a results file.

Usage:
  pnpm eval:parol --selftest
  pnpm eval:parol [options]

Options:
  --selftest                   Run against a perfect scripted oracle that reads the answer key. It needs
                               no key and no --yes and sends nothing. A selftest score says nothing
                               about any model.
  --simulate                   Run against the demo's scripted simulated reader (apps/parol/src/demo).
                               Results are labelled SIMULATED and are not a measurement of any model.
  --split dev|heldout|all      The cases to run. Default: dev. The held-out set is sealed: see
                               --allow-heldout.
  --allow-heldout              Allow a run that touches the held-out split. Read the warning that is
                               printed: each candidate gets one held-out run.
  --workflow v1|v2             The workflow version. Default: v1.
  --runs <k>                   Repeats of every case, to measure stability. Default: 1. The gates of
                               document 5 are written for 3.
  --case <key>                 Run only this case, such as PAROL-D05. Repeat for several. The injection
                               twin of a case runs with it.
  --yes                        Spend the money. Without it a live run prints its plan and exits 3.
  --max-cost <usd>             Refuse to run when the cost upper bound is higher, and stop a run whose
                               spend passes it. Default: ${DEFAULT_MAX_COST_USD.toFixed(2)}.
  --assumed-output-tokens <n>  Output tokens assumed per call in the cost bound. Default: ${DEFAULT_ASSUMED_OUTPUT_TOKENS}.
  --prices <file.json>         Prices on top of evals/prices.json, in USD per million tokens.
  --out <file.json>            Where to write the results. Default: evals/results/parol-<UTC time>.json.
  --compare <previous.json>    Compare with an earlier results file (the baseline) after the run. The pins
                               are checked first: the runs may differ only in the workflow.
  --allow-differences <names>  Pins that are expected to differ, comma separated: ${PIN_NAMES.filter((name) => name !== "evaluation").join(", ")}.
                               A difference in the evaluation version is never allowed.
  --playbook <file.yaml>       The playbook. Default: apps/parol/playbooks/<slug of the answer keys>.yaml.
                               It must be the version the answer keys were built for.
  -h, --help                   Show this help.

The model of a live run comes from the same variables as the clausewise command
(CLAUSEWISE_PROVIDER, CLAUSEWISE_MODEL, ANTHROPIC_API_KEY, CLAUSEWISE_MAX_OUTPUT_TOKENS, ...).

The plan and progress go to stderr and the Markdown report to stdout.

Exit codes:
  0    The run finished. (Gates that fail are results, not errors.)
  1    Something went wrong, including a failed selftest and a fatal answer from the provider.
  2    An integrity failure: the answer keys or a case file differ from the hashes in
       fixtures/parol/splits.json, or an anchor of a key does not resolve in the documents.
  3    The spend guard refused to run or stopped the run: no --yes, a cost bound above --max-cost, or
       recorded spend above it.
  130  Interrupted with Ctrl-C, SIGTERM or SIGHUP.
`;

function wholeNumber(name: string, raw: string): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive whole number.`);
  }
  return value;
}

function positiveAmount(name: string, raw: string): number {
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    throw new UsageError(`--${name} must be a number above 0.`);
  }
  return value;
}

export function parseParolArgs(args: readonly string[]): ParolOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        selftest: { type: "boolean" },
        simulate: { type: "boolean" },
        split: { type: "string" },
        "allow-heldout": { type: "boolean" },
        workflow: { type: "string" },
        runs: { type: "string" },
        case: { type: "string", multiple: true },
        yes: { type: "boolean" },
        "max-cost": { type: "string" },
        "assumed-output-tokens": { type: "string" },
        prices: { type: "string" },
        out: { type: "string" },
        compare: { type: "string" },
        "allow-differences": { type: "string", multiple: true },
        playbook: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    // The first line of the parser's message names the option. The rest is advice that does not apply.
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
    throw new UsageError(first === "" ? "The options could not be read." : first);
  }
  const { values, positionals, tokens = [] } = parsed;
  const defaults: ParolOptions = {
    selftest: false,
    simulate: false,
    split: "dev",
    allowHeldout: false,
    workflow: "v1",
    runs: 1,
    cases: [],
    yes: false,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    assumedOutputTokens: DEFAULT_ASSUMED_OUTPUT_TOKENS,
    prices: undefined,
    out: undefined,
    compare: undefined,
    allowDifferences: [],
    playbook: undefined,
    help: false,
  };
  if (values.help === true) return { ...defaults, help: true };
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);

  // A repeated option would silently keep the last value, which is a bad surprise for a limit.
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === "case" || token.name === "allow-differences") {
      continue;
    }
    if (seen.has(token.name)) {
      throw new UsageError(`Option --${token.name} was given more than once.`);
    }
    seen.add(token.name);
  }
  for (const name of ["split", "workflow", "prices", "out", "compare", "playbook"] as const) {
    if (values[name] === "") throw new UsageError(`Option --${name} needs a value.`);
  }
  const cases = values.case ?? [];
  if (cases.includes("")) throw new UsageError("Option --case needs a value.");

  const split = values.split ?? "dev";
  if (split !== "dev" && split !== "heldout" && split !== "all") {
    throw new UsageError("--split must be dev, heldout or all.");
  }
  const workflow = values.workflow ?? "v1";
  if (!Object.hasOwn(WORKFLOWS, workflow)) {
    throw new UsageError(
      `--workflow must be one of: ${Object.keys(WORKFLOWS).join(", ")}. You gave ${quoted(workflow, "workflow")}.`,
    );
  }
  if (values.selftest === true && values.simulate === true) {
    throw new UsageError("--selftest and --simulate cannot be used together.");
  }
  const maxCost = values["max-cost"];
  const assumed = values["assumed-output-tokens"];
  return {
    ...defaults,
    selftest: values.selftest === true,
    simulate: values.simulate === true,
    split,
    allowHeldout: values["allow-heldout"] === true,
    workflow,
    runs: values.runs === undefined ? 1 : wholeNumber("runs", values.runs),
    cases,
    yes: values.yes === true,
    maxCostUsd: maxCost === undefined ? DEFAULT_MAX_COST_USD : positiveAmount("max-cost", maxCost),
    assumedOutputTokens:
      assumed === undefined
        ? DEFAULT_ASSUMED_OUTPUT_TOKENS
        : wholeNumber("assumed-output-tokens", assumed),
    prices: values.prices,
    out: values.out,
    compare: values.compare,
    allowDifferences: parseAllowDifferences(values["allow-differences"] ?? []),
    playbook: values.playbook,
  };
}

// ---------------------------------------------------------------------------------------------
// The environment of a run
// ---------------------------------------------------------------------------------------------

/** What a generator is built for. Tests inject scripted generators through `generatorFactory`. */
export interface ParolGeneratorRequest {
  mode: RunMode;
  prepared: PreparedCase;
  playbook: LoadedPlaybook;
  /** Undefined unless the run is live. */
  config: LlmConfig | undefined;
  /** Report each response's token usage here, as the Anthropic adapter does. */
  onUsage: (usage: AnthropicUsage) => void;
}

export interface SimulatedModelModule {
  createSimulatedModel: () => ObjectGenerator;
  SIMULATED_PROVIDER?: string;
  SIMULATED_MODEL?: string;
}

export interface ParolIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** When it aborts, no further model calls are started and the run ends with code 130. */
  signal?: AbortSignal;
  /** The repository root. Default: the one this file is in. */
  root?: string;
  /** Where results go when --out is not given, and where earlier results are read for the held-out note. */
  resultsDir?: string;
  now?: () => Date;
  /** Milliseconds from any origin, for the latency of runs. */
  clock?: () => number;
  gitInfo?: () => Promise<GitInfo>;
  /**
   * Replaces the model. Called once for every run of a case, with the prepared case, so a test can
   * build an oracle or a script from its spans. For a live run without it, one generator serves
   * every case, as in the clausewise command.
   */
  generatorFactory?: (request: ParolGeneratorRequest) => ObjectGenerator;
  /** Loads the demo's simulated model. Tests replace it to see the missing-module path. */
  loadSimulatedModel?: () => Promise<SimulatedModelModule>;
}

const defaultSimulatedModel = async (): Promise<SimulatedModelModule> =>
  import("../../../apps/parol/src/demo/simulated-model.js");

// ---------------------------------------------------------------------------------------------
// Errors that are safe to show
// ---------------------------------------------------------------------------------------------

// Errors of these classes name ids, counts and problems and never quote a document or a key.
const SAFE_NAMES = new Set([
  "DocxError",
  "PlaybookError",
  "LlmConfigError",
  "UploadError",
  "ScoringError",
  "AnchorResolutionError",
  "CaseSelectionError",
]);

export function describeParolError(error: unknown): string {
  if (error instanceof EvalError) return error.message;
  if (error instanceof Error && SAFE_NAMES.has(error.name)) return error.message;
  const name = error instanceof Error && /^[\w.]{1,64}$/.test(error.name) ? error.name : "Error";
  return (
    `Unexpected error (${name}). This is a bug in the evaluation runner. Its details are not ` +
    "shown because they can contain contract text."
  );
}

const PROVIDER_MESSAGES = {
  provider_auth:
    "The provider rejected the API key (HTTP 401). Check ANTHROPIC_API_KEY, or the key variable of your provider.",
  provider_permission: "The key is not allowed to make this request (HTTP 403).",
  provider_model:
    "The provider does not know the model (HTTP 404). Check CLAUSEWISE_MODEL and CLAUSEWISE_BASE_URL.",
  provider_billing:
    "The account cannot pay for the request. Check the credit balance and the spend limits.",
  provider_redirect:
    "The provider answered with a redirect, which is never followed. Check CLAUSEWISE_BASE_URL.",
  interrupted: "The run was interrupted.",
  internal: "The provider failed the request in a way that ends the run.",
} as const;

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

interface ModelSetup {
  mode: RunMode;
  config: LlmConfig | undefined;
  price: Price | null;
  priceSha256: string | null;
  usageAvailable: boolean;
  usageNote: string | null;
  provider: string;
  model: string;
  /** The demo's simulated model, for a simulated run. */
  simulated?: SimulatedModelModule;
}

async function prepareModel(
  options: ParolOptions,
  io: ParolIo,
  mode: RunMode,
): Promise<ModelSetup> {
  if (mode === "selftest") {
    return {
      mode,
      config: undefined,
      price: null,
      priceSha256: null,
      usageAvailable: false,
      usageNote: "A selftest calls no model, so no tokens are used.",
      provider: ORACLE_PROVIDER,
      model: ORACLE_MODEL,
    };
  }
  if (mode === "simulated") {
    // The simulated reader belongs to the demo and is written separately. A checkout without it
    // cannot be simulated, and says so before anything else is done.
    let simulated: SimulatedModelModule | undefined;
    if (io.generatorFactory === undefined) {
      try {
        simulated = await (io.loadSimulatedModel ?? defaultSimulatedModel)();
        if (typeof simulated.createSimulatedModel !== "function") throw new Error("no model");
      } catch {
        throw new EvalError(
          "--simulate needs the simulated model at apps/parol/src/demo/simulated-model.ts, and it " +
            "could not be loaded (it may not exist in this checkout yet). Nothing was run. To check " +
            "the plumbing without a key, run: pnpm eval:parol --selftest",
        );
      }
    }
    return {
      mode,
      config: undefined,
      price: null,
      priceSha256: null,
      usageAvailable: false,
      usageNote: "A simulated run calls no model, so no tokens are used.",
      provider: simulated?.SIMULATED_PROVIDER ?? "simulated",
      model: simulated?.SIMULATED_MODEL ?? "simulated",
      ...(simulated === undefined ? {} : { simulated }),
    };
  }
  let config: LlmConfig;
  try {
    config = loadLlmConfig(io.env);
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    throw new EvalError(
      `${error.message} No model credentials are configured, so a live run cannot start. ` +
        "To try the runner without a key, run: pnpm eval:parol --selftest",
    );
  }
  const table = await loadPriceTable(options.prices);
  const price = priceFor(table, config.model);
  // A hosted provider is never free. A price of zero, typed by mistake into the prices file, would
  // make the cost bound zero and switch off the whole guard.
  if (
    (config.provider === "anthropic" || config.provider === "openai") &&
    price.input === 0 &&
    price.output === 0
  ) {
    throw new EvalError(
      `The price of the model for the ${config.provider} provider has an input and output rate of 0, ` +
        "which would switch off the spend guard. Fix the entry in evals/prices.json or in the file given with --prices.",
    );
  }
  const usageAvailable = config.provider === "anthropic";
  return {
    mode,
    config,
    price,
    priceSha256: priceTableSha256(table),
    usageAvailable,
    usageNote: usageAvailable
      ? null
      : `Token usage is not reported for the ${config.provider} provider, so only model calls are counted and no spend can be worked out.`,
    provider: config.provider,
    model: config.model,
  };
}

// The sampling temperature the adapter sends, by provider. Anthropic and OpenAI models that think
// adaptively are sent none; the OpenAI-compatible adapter asks for 0 (packages/llm/src/generator.ts).
const temperatureOf = (provider: LlmConfig["provider"]): number | null =>
  provider === "openai-compatible" ? 0 : null;

function modelNote(setup: ModelSetup): string {
  if (setup.mode !== "live") return "A scripted stand-in reports no model.";
  return setup.config?.provider === "anthropic"
    ? "Read from the model field of the provider's responses, which names the snapshot an alias resolved to. Empty when no response named one."
    : "The adapter does not report which model answered.";
}

/**
 * A name from the command line, for an error message: repeated only when it reads as a plain name.
 * A value typed in the wrong place can be a key, and nothing the caller sent is repeated unchecked.
 */
function plainName(value: string | undefined): string {
  return value !== undefined && shown(value, "name") === value ? ` ${value}` : "";
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function defaultOutPath(dir: string, startedAt: Date): Promise<string> {
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  for (let attempt = 1; ; attempt += 1) {
    const path = resolve(
      dir,
      attempt === 1 ? `parol-${stamp}.json` : `parol-${stamp}-${attempt}.json`,
    );
    if (!(await exists(path))) return path;
  }
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

interface Stopped {
  reason: string;
  exitCode: number;
  label: "Stopped" | "Error";
}

async function execute(argv: string[], io: ParolIo): Promise<number> {
  const options = parseParolArgs(argv);
  if (options.help) {
    io.stdout(USAGE);
    return 0;
  }
  const mode: RunMode = options.selftest ? "selftest" : options.simulate ? "simulated" : "live";
  const root = io.root ?? DEFAULT_ROOT;
  const now = io.now ?? ((): Date => new Date());
  const clock = io.clock ?? ((): number => performance.now());
  const startedAt = now();

  // ---- 1. The held-out seal.
  if (options.split !== "dev" && !options.allowHeldout) {
    throw new EvalError(
      `Refusing to run the held-out split without --allow-heldout. ${HELDOUT_SEAL_WARNING} ` +
        "Add --allow-heldout when a candidate is ready for its one held-out run.",
    );
  }

  // ---- 2. The dataset.
  const loaded = await loadDataset(root);
  if (!loaded.ok) {
    io.stderr(
      `INTEGRITY FAILURE: the dataset is not the one that was committed. Nothing was run and nothing was sent.\n${loaded.problems.map((p) => `  ${p}`).join("\n")}\n` +
        "Rebuild it with pnpm fixtures:parol only if the change to a case was meant, and commit the result.\n",
    );
    return EXIT_INTEGRITY;
  }
  const { dataset } = loaded;
  const groups: CaseGroup[] = selectCases(dataset, options.split, options.cases);
  const runnables = groups.flatMap((group) => runnableCases(group));

  // ---- 3. The playbook, the workflow, the model.
  const playbookPath = resolve(
    options.playbook ??
      join(root, "apps", "parol", "playbooks", `${dataset.keys.playbook.slug}.yaml`),
  );
  let yaml: string;
  try {
    yaml = await readFile(playbookPath, "utf8");
  } catch (error) {
    throw new EvalError(
      `Cannot read the playbook${plainName(options.playbook)} (${(error as NodeJS.ErrnoException).code ?? "an error"}).`,
    );
  }
  const playbook = loadPlaybook({ yaml, slug: dataset.keys.playbook.slug, source: playbookPath });
  if (playbook.sha256 !== dataset.keys.playbook.sha256) {
    throw new EvalError(
      "The playbook is not the version the answer keys were built for (its hash differs from the one " +
        "in fixtures/parol/answer-keys.json). A playbook change is a new dataset version: rebuild the " +
        "keys with pnpm fixtures:parol and commit them.",
    );
  }
  // The hashes of the dataset cover the cases, the twins and the files, not the facts about each
  // rule that the key carries. The severity of a rule weights every slot of it, so an edited fact
  // changes what a score means. The playbook is pinned by its hash, so a difference is the key's.
  const factProblems = playbookFactProblems(dataset.keys.playbook.rules, playbook.rules);
  if (factProblems.length > 0) {
    io.stderr(
      `INTEGRITY FAILURE: the facts about the playbook rules in the answer key differ from the playbook it pins. Nothing was run and nothing was sent.\n${factProblems
        .slice(0, 30)
        .map((p) => `  ${p}`)
        .join("\n")}\n` +
        "Rebuild the keys with pnpm fixtures:parol only if the change was meant, and commit the result.\n",
    );
    return EXIT_INTEGRITY;
  }
  const workflow = workflowFor(options.workflow);
  const setup = await prepareModel(options, io, mode);

  const git = await (io.gitInfo ?? ((): Promise<GitInfo> => readGitInfo(root)))();
  const resultsDir = io.resultsDir ?? DEFAULT_RESULTS_DIR;
  const buildPins = (reported: string[] | null): Pins => ({
    dataset: {
      label: dataset.label,
      answerKeysSha256: dataset.answerKeysSha256,
      splitsFileSha256: dataset.splitsFileSha256,
      splits: Object.fromEntries(
        dataset.integrity
          .filter((entry) => groups.some((group) => group.split === entry.split))
          .map((entry) => [entry.split, entry.sha256]),
      ),
    },
    split: options.split,
    cases: runnables
      .filter((r) => r.twinOf === null)
      .map((r) => r.caseKey)
      .sort(),
    playbook: { slug: playbook.slug, version: playbook.version, sha256: playbook.sha256 },
    workflow: workflowPin(workflow),
    model: {
      provider: setup.provider,
      requested: setup.model,
      endpoint:
        setup.config === undefined
          ? null
          : endpointHost(setup.config.provider, setup.config.baseUrl),
      reported,
      reportedNote: modelNote(setup),
    },
    generation:
      setup.config === undefined
        ? null
        : {
            maxOutputTokens: setup.config.maxOutputTokens,
            effort: setup.config.effort ?? null,
            maxRetries: setup.config.maxRetries,
            ruleConcurrency: RULE_CONCURRENCY,
            temperature: temperatureOf(setup.config.provider),
            fallback: setup.config.fallback ?? null,
          },
    prices:
      setup.price === null || setup.priceSha256 === null
        ? null
        : { sha256: setup.priceSha256, model: setup.price },
    evaluation: evaluationPin(),
    code: git,
    repeats: options.runs,
    mode,
  });

  // ---- The earlier run, and whether this one can be compared with it. Before any spending.
  const previous = options.compare === undefined ? undefined : await loadResults(options.compare);
  if (previous !== undefined) {
    const differences = diffPins(previous.pins, buildPins(null), {
      allow: options.allowDifferences,
      // What the provider will report is not known until the run has been made.
      skip: ["model-reported"],
    });
    const problems = previous.complete
      ? []
      : ["The baseline run is incomplete; a comparison needs finished runs."];
    if (differences.some((d) => d.status === "refused") || problems.length > 0) {
      io.stderr(describeRefusal({ ok: false, differences, problems }));
      io.stderr("Nothing was sent.\n");
      return 1;
    }
  }

  const outPath =
    options.out !== undefined ? resolve(options.out) : await defaultOutPath(resultsDir, startedAt);
  if (await exists(outPath)) {
    throw new EvalError(
      `The results file${plainName(options.out)} already exists. Choose another file with --out.`,
    );
  }
  await assertWritable(outPath);

  // ---- The documents, and the key against them.
  const parsed: ParsedFiles = new Map();
  const problems: string[] = [];
  for (const runnable of runnables) {
    const prepared = await prepareCase({
      dataset,
      runnable,
      repeat: 1,
      playbook,
      workflow,
      parsed,
    });
    problems.push(...anchorProblems(prepared, runnable));
  }
  if (problems.length > 0) {
    io.stderr(
      `INTEGRITY FAILURE: the answer keys do not match the documents as this version of the code reads them. Nothing was sent.\n${problems
        .slice(0, 30)
        .map((p) => `  ${p}`)
        .join("\n")}${problems.length > 30 ? `\n  and ${problems.length - 30} more` : ""}\n`,
    );
    return EXIT_INTEGRITY;
  }

  // ---- The held-out warning and the contamination note.
  const touchesHeldout = groups.some((group) => group.split === "heldout");
  const contamination = touchesHeldout
    ? await findContamination({
        resultsDir,
        workflowLabel: workflow.manifest.label,
        workflowSha256: workflow.sha256,
      })
    : null;
  if (touchesHeldout) {
    io.stderr(`HELD-OUT SPLIT. ${HELDOUT_SEAL_WARNING}\n`);
    if (contamination !== null) io.stderr(`${contamination.note}\n`);
  }

  // ---- 4. The plan and the spend guard. Nothing has called a model up to the end of this block.
  const plan = await buildParolPlan({
    dataset,
    runnables,
    playbook,
    workflow,
    repeats: options.runs,
    assumedOutputTokens: options.assumedOutputTokens,
  });
  const bounds =
    setup.price === null || setup.config === undefined
      ? null
      : costBounds(plan, setup.price, {
          maxOutputTokens: setup.config.maxOutputTokens,
          maxRetries: setup.config.maxRetries,
        });
  io.stderr(
    describeParolPlan(plan, {
      mode,
      datasetLabel: dataset.label,
      splitLabel: options.split,
      workflowLabel: workflow.manifest.label,
      retrieval: workflow.manifest.retrieval,
      provider: setup.provider,
      model: setup.model,
      price: setup.price,
      bounds,
      maxRetries: setup.config?.maxRetries ?? null,
      maxOutputTokens: setup.config?.maxOutputTokens ?? null,
      maxCostUsd: options.maxCostUsd,
      fallback: setup.config?.fallback !== undefined,
    }),
  );
  if (mode === "live" && !setup.usageAvailable) {
    io.stderr(
      `Note: ${setup.usageNote ?? "Token usage is not reported."} The runtime spend limit therefore cannot see spend: only the cost bound above is checked against --max-cost, and a run can cost more than it.\n`,
    );
  }
  if (mode === "live" && bounds !== null) {
    const decision = decideSpend({
      yes: options.yes,
      plan,
      bounds,
      maxCostUsd: options.maxCostUsd,
      fallback: setup.config?.fallback !== undefined,
    });
    if (!decision.go) {
      io.stderr(`${decision.message}\n`);
      return EXIT_SPEND_GUARD;
    }
  }

  // A live run of the held-out split is written down before its first call, wherever its results
  // go, so that a later run is told the split was used. A run that cannot be recorded is not made.
  if (mode === "live" && touchesHeldout) {
    try {
      await recordHeldoutRun({
        resultsDir,
        startedAt,
        workflowLabel: workflow.manifest.label,
        workflowSha256: workflow.sha256,
        model: setup.model,
        outPath,
      });
    } catch (error) {
      throw new EvalError(
        `Refusing to run the held-out split: this run cannot be recorded in the results folder (${(error as NodeJS.ErrnoException).code ?? "an error"}), and a later run could then not warn that the split was used. Nothing was sent.`,
      );
    }
  }

  // ---- 5. The run.
  const controller = new AbortController();
  const relay = (): void => controller.abort(io.signal?.reason);
  if (io.signal?.aborted === true) relay();
  else io.signal?.addEventListener("abort", relay, { once: true });

  const meter = new Meter();
  const { price } = setup;
  // Only the Anthropic adapter takes a fetch of its own and reports usage, so it is the only
  // provider whose requests can be held back one by one.
  const budget =
    mode !== "live" || price === null || setup.config?.provider !== "anthropic"
      ? undefined
      : createBudget({
          price,
          maxCostUsd: options.maxCostUsd,
          spentUsd: () => costOf(meter.total, price),
          stop: (reason) => controller.abort(reason),
        });
  // A request cut off by the abort may already have been generated and billed, and its usage never
  // arrives. What was under way at that moment is the most that can be missing from the spend.
  let unreportedUsd = 0;
  controller.signal.addEventListener(
    "abort",
    () => {
      unreportedUsd = budget?.reservedUsd() ?? 0;
    },
    { once: true },
  );
  const onUsage = (usage: AnthropicUsage): void => {
    meter.onUsage(usage);
    budget?.settled();
    // The bound should keep a run under the limit. This is for the day it does not, because
    // retries, an unexpected tokenisation or a wrong price can all make a run cost more.
    if (price !== null && costOf(meter.total, price) > options.maxCostUsd) {
      controller.abort(
        new BudgetExceeded(
          `Recorded spend passed the --max-cost limit of ${usd(options.maxCostUsd)}, ` +
            "so no further model calls were started. Raise it with --max-cost to continue.",
        ),
      );
    }
  };

  // The Anthropic adapter does not report which model answered, but it takes a fetch of its own,
  // and the model field of each response is what shows an alias moving to a new snapshot.
  const reporter = reportingFetch(budget?.fetch ?? globalThis.fetch, (model) =>
    meter.noteModel(model),
  );

  let shared: ObjectGenerator | undefined;
  let disclosed = false;
  const generatorFor = async (prepared: PreparedCase): Promise<ObjectGenerator> => {
    const request: ParolGeneratorRequest = {
      mode,
      prepared,
      playbook,
      config: setup.config,
      onUsage,
    };
    let base: ObjectGenerator;
    if (io.generatorFactory !== undefined) {
      base = io.generatorFactory(request);
    } else if (mode === "selftest") {
      base = createKeyOracle({
        caseKey: prepared.runnable.caseKey,
        expect: prepared.runnable.expect,
        spans: prepared.ingest.spans,
        rules: playbook.rules,
      });
    } else if (mode === "simulated") {
      shared ??= setup.simulated!.createSimulatedModel();
      base = shared;
    } else {
      shared ??= createObjectGenerator(
        setup.config!,
        setup.config!.provider === "anthropic" ? { onUsage, fetch: reporter.fetch } : undefined,
      );
      base = shared;
    }
    if (!disclosed) {
      disclosed = true;
      io.stderr(
        mode === "live"
          ? `Sending the contract text to: ${plain(base.disclosure)}\n`
          : `Answers come from: ${plain(base.disclosure)}\n`,
      );
    }
    return counted(base, () => meter.countCall());
  };

  const observed: ObservedRun[] = [];
  const runs: RunRecord[] = [];
  const rules = dataset.keys.playbook.rules;
  const notes: string[] = [];
  if (options.prices !== undefined && mode !== "live") {
    notes.push("--prices was given and ignored: a scripted run sends no request and has no cost.");
  }
  const endpoint =
    setup.config === undefined ? null : endpointHost(setup.config.provider, setup.config.baseUrl);
  const ownHost = setup.config === undefined ? null : providerOwnHost(setup.config.provider);
  if (mode === "live" && endpoint !== null && ownHost !== null && endpoint !== ownHost) {
    notes.push(
      `The model was reached at ${endpoint}, not at the provider's own API host (${ownHost}). ` +
        "The scores are those of whatever answered there, which the model name does not establish.",
    );
  }
  const optionsRecord: ResultsFile["options"] = {
    split: options.split,
    workflow: options.workflow,
    repeats: options.runs,
    cases: [...options.cases],
    maxCostUsd: mode === "live" ? options.maxCostUsd : null,
    assumedOutputTokens: options.assumedOutputTokens,
    allowHeldout: options.allowHeldout,
  };
  const usageOf = (): ResultsFile["usage"] => ({
    available: setup.usageAvailable,
    note: setup.usageNote,
    calls: meter.totalCalls,
    total: setup.usageAvailable ? { ...meter.total } : null,
    costUsd: setup.usageAvailable && price !== null ? costOf(meter.total, price) : null,
  });
  const reportedModels = (): string[] | null =>
    meter.reportedModels.size === 0 ? null : [...meter.reportedModels].sort();

  // Scoring failures must not lose a run that was paid for. If scoring cannot be done, the file
  // is still written, without scores, and says why.
  let scoringFailure: unknown;
  const assemble = (complete: boolean, stoppedBecause: string | null): ResultsFile => {
    const input = {
      mode,
      startedAt,
      finishedAt: now(),
      complete,
      stoppedBecause,
      pins: buildPins(reportedModels()),
      options: optionsRecord,
      integrity: dataset.integrity,
      groups,
      rules,
      runs,
      usage: usageOf(),
      priced: price !== null && setup.usageAvailable,
      contamination,
      notes,
    };
    try {
      return assembleResults({ ...input, observed });
    } catch (error) {
      scoringFailure = error;
      return assembleResults({
        ...input,
        complete: false,
        stoppedBecause: `Scoring failed (${describeParolError(error)}). The runs and the usage are recorded; the scores are not.`,
        observed: [],
      });
    }
  };

  const partialPath = `${outPath}.partial`;
  const checkpoint = async (): Promise<void> => {
    await reporter.settle();
    const snapshot = assemble(false, "The run did not finish. This is the checkpoint it left.");
    await writeFileAtomically(partialPath, serialiseResults(snapshot), { replace: true }).catch(
      () => undefined,
    );
  };

  let stopped: Stopped | undefined;
  try {
    for (let repeat = 1; repeat <= options.runs; repeat += 1) {
      for (const group of groups) {
        for (const runnable of runnableCases(group)) {
          controller.signal.throwIfAborted();
          io.stderr(`Running ${plain(runnable.caseKey)}, repeat ${repeat} of ${options.runs}.\n`);
          meter.begin();
          const prepared = await prepareCase({
            dataset,
            runnable,
            repeat,
            playbook,
            workflow,
            parsed,
          });
          const generator = await generatorFor(prepared);
          const record = (
            outcome: RunRecord["outcome"],
            extra: Pick<
              RunRecord,
              "totalMs" | "stagesMs" | "callOutcomes" | "rulesOverBudget" | "extractDegraded"
            >,
          ): RunRecord => {
            const tally = meter.take();
            const usage = setup.usageAvailable ? tally.usage : null;
            return {
              split: runnable.split,
              caseKey: runnable.caseKey,
              twinOf: runnable.twinOf,
              repeat,
              outcome,
              modelCalls: tally.calls,
              usage,
              costUsd: costOfRun(usage, price),
              ...extra,
            };
          };
          const began = clock();
          try {
            const run = await runStages({
              prepared,
              playbook,
              workflow,
              generator,
              signal: controller.signal,
              clock,
            });
            const seen = observeRun(prepared, run);
            observed.push({
              split: runnable.split,
              caseKey: runnable.caseKey,
              repeat,
              slots: seen.slots,
              extraction: seen.extraction,
              spans: prepared.ingest.spans,
            });
            const done = record("succeeded", {
              totalMs: mode === "live" ? run.totalMs : null,
              stagesMs: mode === "live" ? run.stagesMs : {},
              callOutcomes: countOutcomes(run.calls),
              rulesOverBudget: run.rulesOverBudget,
              extractDegraded: run.extract.degraded,
            });
            runs.push(done);
            io.stderr(
              `  ${run.findings.length} rule slots, ${done.modelCalls} model calls${run.extract.degraded ? ", extract degraded" : ""}.\n`,
            );
          } catch (error) {
            // The run that was cut short is recorded, with what it spent, and the cause goes on up.
            runs.push(
              record("failed", {
                totalMs: mode === "live" ? Math.max(0, clock() - began) : null,
                stagesMs: {},
                callOutcomes: {},
                rulesOverBudget: 0,
                extractDegraded: false,
              }),
            );
            throw error;
          }
          if (mode === "live") await checkpoint();
        }
      }
    }
  } catch (error) {
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined;
    if (reason instanceof BudgetExceeded) {
      stopped = { reason: reason.message, exitCode: EXIT_SPEND_GUARD, label: "Stopped" };
    } else if (io.signal?.aborted === true) {
      stopped = { reason: "Interrupted.", exitCode: EXIT_INTERRUPTED, label: "Stopped" };
    } else if (error instanceof EvaluationProviderFailure) {
      stopped = { reason: PROVIDER_MESSAGES[error.kind], exitCode: 1, label: "Error" };
    } else {
      stopped = {
        reason: describeParolError(error),
        exitCode: error instanceof EvalError ? error.exitCode : 1,
        label: "Error",
      };
    }
  } finally {
    io.signal?.removeEventListener("abort", relay);
  }

  // ---- 6. What came of it.
  await reporter.settle();
  const results = assemble(stopped === undefined, stopped?.reason ?? null);
  let exitCode = stopped?.exitCode ?? 0;
  if (scoringFailure instanceof AnchorResolutionError) {
    io.stderr(
      `INTEGRITY FAILURE: ${scoringFailure.message}. The answer keys do not match the documents as the run read them.\n`,
    );
    exitCode = EXIT_INTEGRITY;
  } else if (scoringFailure !== undefined) {
    io.stderr(
      `Error: the scores could not be worked out (${describeParolError(scoringFailure)})\n`,
    );
    exitCode ||= 1;
  }

  if (mode === "live") {
    io.stderr(
      setup.usageAvailable && price !== null
        ? `${stopped === undefined ? "Spent" : "Spent so far"}: ${meter.total.inputTokens} input, ${meter.total.outputTokens} output, ${meter.total.cacheReadTokens} cache read and ${meter.total.cacheWriteTokens} cache write tokens over ${meter.totalCalls} calls, which is ${usd(costOf(meter.total, price))}.\n`
        : `Model calls made: ${meter.totalCalls}. ${setup.usageNote ?? ""}\n`,
    );
  } else {
    io.stderr(
      `Model calls made to the scripted stand-in: ${meter.totalCalls}. Nothing was sent anywhere.\n`,
    );
  }
  const health = runHealth(results);
  if (!health.clean) {
    io.stderr(`Warning, ${NOT_CLEAN}: ${health.problems.join(" ")}\n`);
  }
  if (stopped !== undefined) io.stderr(`${stopped.label}: ${stopped.reason}\n`);
  if (stopped !== undefined && unreportedUsd > 0) {
    io.stderr(
      `Requests that were under way when the run stopped were cut off and may still have been billed, by up to ${usd(unreportedUsd)} more than the spend above.\n`,
    );
  }

  if (mode === "selftest" && stopped === undefined && scoringFailure === undefined) {
    const failures = selftestFailures(results.sections);
    if (failures.length > 0) {
      io.stderr(
        `SELFTEST FAILED: a perfect oracle did not get a perfect score, so the plumbing disagrees with itself.\n${failures
          .slice(0, 20)
          .map((f) => `  ${f}`)
          .join("\n")}\n`,
      );
      exitCode ||= 1;
    }
  }

  if (runs.length > 0 || meter.total.responses > 0) {
    try {
      await writeFileAtomically(outPath, serialiseResults(results), { replace: false });
      io.stderr(`Results written to ${outPath}\n`);
      await unlink(partialPath).catch(() => undefined);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "an error";
      io.stderr(
        `Error: the results could not be written to ${outPath} (${code}).${runs.length > 0 && mode === "live" ? ` What finished is in ${partialPath}.` : ""}\n`,
      );
      exitCode ||= 1;
    }
    let text = renderReport(results);
    if (previous !== undefined) {
      const comparison = compareResults(previous, results, {
        allow: options.allowDifferences,
        baselineName: basename(options.compare ?? "baseline"),
        candidateName: basename(outPath),
      });
      if (comparison.ok) {
        text += `\n${renderComparison(comparison, {
          baseline: previous.pins.workflow.label,
          candidate: results.pins.workflow.label,
        })}`;
      } else {
        io.stderr(describeRefusal(comparison));
        exitCode ||= 1;
      }
    }
    io.stdout(text);
  }
  return exitCode;
}

/** Runs the command and returns its exit code. Never throws. */
export async function runParol(argv: string[], io: ParolIo): Promise<number> {
  try {
    return await execute(argv, io);
  } catch (error) {
    if (error instanceof EvalError) {
      io.stderr(`Error: ${error.message}\n`);
      if (error instanceof UsageError) io.stderr(`${USAGE_HINT}\n`);
      return error.exitCode;
    }
    if (error instanceof CaseSelectionError) {
      io.stderr(`Error: ${error.message}\n`);
      return 1;
    }
    if (io.signal?.aborted === true) {
      io.stderr("Interrupted.\n");
      return EXIT_INTERRUPTED;
    }
    io.stderr(`Error: ${describeParolError(error)}\n`);
    return 1;
  }
}
