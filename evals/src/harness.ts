import { stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LlmConfigError,
  createObjectGenerator,
  loadLlmConfig,
  type AnthropicUsage,
  type LlmConfig,
  type ObjectGenerator,
} from "@clausewise/llm";
import { reviewContract } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import { USAGE, USAGE_HINT, parseEvalArgs, type EvalOptions } from "./args.js";
import { BudgetExceeded, createBudget } from "./budget.js";
import { compareResults, loadPrevious } from "./compare.js";
import { EvalError, UsageError, describeError } from "./errors.js";
import { loadFixtures, type Fixture } from "./fixtures.js";
import { decide, describePlan, int, plain, usd } from "./guard.js";
import { checkIntegrity } from "./integrity.js";
import { buildPlan, costCeiling, costUpperBound, type Limits } from "./plan.js";
import { costOf, loadPriceTable, priceFor, type Price } from "./prices.js";
import { renderReport } from "./report.js";
import { assertWritable, writeFileAtomically } from "./results-file.js";
import { buildResult, summariseConfig, type EvalResult } from "./result.js";
import type { RunRecord } from "./score.js";
import { oracleScripts } from "./selftest.js";
import { addUsage, counted, emptyUsage, type UsageTotals } from "./usage.js";

const INTERRUPTED = 130;
const EXIT_INTEGRITY = 2;
const EXIT_SPEND_GUARD = 3;

const DEFAULT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_RESULTS_DIR = fileURLToPath(new URL("../results/", import.meta.url));

/** What the harness is asked to build a model for. */
export interface GeneratorRequest {
  fixture: Fixture;
  /** Undefined in a selftest. */
  config: LlmConfig | undefined;
  selftest: boolean;
  /** Report each response's token usage here, as the Anthropic adapter does. */
  onUsage: (usage: AnthropicUsage) => void;
}

export interface EvalIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  /** When it aborts, no further model calls are started and the run ends with code 130. */
  signal?: AbortSignal;
  /** The repository root. Default: the one this file is in. */
  root?: string;
  /** Where results go when --out is not given. Default: evals/results. */
  resultsDir?: string;
  now?: () => Date;
  /**
   * Replaces the model. For a real run it is called once and the generator serves every fixture,
   * as in the clausewise command. For a selftest it is called once per fixture. Tests inject
   * scripted generators here, so no test can reach a real model by accident.
   */
  generatorFactory?: (request: GeneratorRequest) => ObjectGenerator;
}

interface Setup {
  config: LlmConfig | undefined;
  limits: Limits;
  provider: string;
  model: string;
  price: Price | null;
  usageAvailable: boolean;
  usageNote: string | null;
}

// ---------------------------------------------------------------------------------------------
// Before anything runs
// ---------------------------------------------------------------------------------------------

async function prepare(options: EvalOptions, io: EvalIo): Promise<Setup> {
  if (options.selftest) {
    // Only the two limits that shape a review are read. A dummy key lets the same parser answer,
    // and it is never given to anything that could use it.
    const config = loadLlmConfig({
      ANTHROPIC_API_KEY: "selftest",
      CLAUSEWISE_CONCURRENCY: io.env.CLAUSEWISE_CONCURRENCY,
      CLAUSEWISE_MAX_CONTEXT_TOKENS: io.env.CLAUSEWISE_MAX_CONTEXT_TOKENS,
    });
    return {
      config: undefined,
      limits: { concurrency: config.concurrency, maxContextTokens: config.maxContextTokens },
      provider: "oracle",
      model: "oracle",
      price: null,
      usageAvailable: false,
      usageNote: "A selftest calls no model.",
    };
  }

  let config: LlmConfig;
  try {
    config = loadLlmConfig(io.env);
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    throw new EvalError(
      `${error.message} To try the harness without a key, run: pnpm eval --selftest`,
    );
  }
  const price = priceFor(await loadPriceTable(options.prices), config.model);
  // A hosted provider is never free. A price of zero, typed by mistake into the prices file, would
  // make the cost bound zero and the runtime limit unreachable, and switch off the whole guard.
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
    config,
    limits: { concurrency: config.concurrency, maxContextTokens: config.maxContextTokens },
    provider: config.provider,
    model: config.model,
    price,
    usageAvailable,
    usageNote: usageAvailable
      ? null
      : `Token usage is not reported for the ${config.provider} provider, so only model calls are counted and no spend can be worked out.`,
  };
}

// The default name has a resolution of one second. A second run started within the same second
// would be refused for a name nobody chose, so a number is added until the name is free. A name
// given with --out is never changed.
async function resultsPath(options: EvalOptions, io: EvalIo, startedAt: Date): Promise<string> {
  if (options.out !== undefined) return resolve(options.out);
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const directory = io.resultsDir ?? DEFAULT_RESULTS_DIR;
  for (let attempt = 1; ; attempt += 1) {
    const path = resolve(directory, attempt === 1 ? `${stamp}.json` : `${stamp}-${attempt}.json`);
    const taken = await stat(path).then(
      () => true,
      () => false,
    );
    if (!taken) return path;
  }
}

// A refusal is cheap before the run and a waste after it, so the file is checked first.
async function refuseExisting(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A parent that is not a directory is for assertWritable to report.
    if (code === "ENOENT" || code === "ENOTDIR") return;
    throw new EvalError(
      `Cannot check ${path} (${code ?? "an error"}). Choose another file with --out.`,
    );
  }
  throw new EvalError(`${path} already exists. Choose another file with --out.`);
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

function describeSpend(args: {
  setup: Setup;
  spent: UsageTotals;
  calls: number;
  selftest: boolean;
  finished: boolean;
}): string {
  const { setup, spent, calls } = args;
  if (args.selftest) return `Model calls made: ${int(calls)} (a selftest spends nothing).`;
  if (!setup.usageAvailable || setup.price === null) {
    return `Model calls made: ${int(calls)}. ${setup.usageNote ?? ""}`.trim();
  }
  return (
    `${args.finished ? "Spent" : "Spent so far"}: ${int(spent.inputTokens)} input, ` +
    `${int(spent.outputTokens)} output, ` +
    `${int(spent.cacheReadTokens)} cache read and ${int(spent.cacheWriteTokens)} cache write ` +
    `tokens over ${int(calls)} calls, which is ${usd(costOf(spent, setup.price))}.`
  );
}

const serialise = (result: EvalResult): string => `${JSON.stringify(result, null, 2)}\n`;

async function execute(argv: string[], io: EvalIo): Promise<number> {
  const options = parseEvalArgs(argv);
  if (options.help) {
    io.stdout(USAGE);
    return 0;
  }

  const now = io.now ?? ((): Date => new Date());
  const startedAt = now();
  const fixtures = await loadFixtures(io.root ?? DEFAULT_ROOT, options.fixtures);
  const previous = options.compare === undefined ? undefined : await loadPrevious(options.compare);
  const setup = await prepare(options, io);
  const outPath = await resultsPath(options, io, startedAt);
  await refuseExisting(outPath);
  await assertWritable(outPath);

  // ---- The plan and the spend guard. Nothing has called a model up to the end of this block.
  const plan = await buildPlan(fixtures, {
    runs: options.runs,
    assumedOutputTokens: options.assumedOutputTokens,
    limits: setup.limits,
  });
  const upperBoundUsd = setup.price === null ? null : costUpperBound(plan, setup.price);
  const maxRetries = setup.config?.maxRetries ?? null;
  const ceilingUsd =
    setup.price === null || setup.config === undefined
      ? null
      : costCeiling(plan, setup.price, {
          maxOutputTokens: setup.config.maxOutputTokens,
          maxRetries: setup.config.maxRetries,
        });
  io.stderr(
    describePlan(plan, {
      provider: setup.provider,
      model: setup.model,
      selftest: options.selftest,
      limits: setup.limits,
      price: setup.price,
      upperBoundUsd,
      retryWorstCaseUsd:
        upperBoundUsd === null || maxRetries === null ? null : upperBoundUsd * (1 + maxRetries),
      maxRetries,
      ceilingUsd,
      maxOutputTokens: setup.config?.maxOutputTokens ?? null,
      maxCostUsd: options.maxCostUsd,
      fallback: setup.config?.fallback !== undefined,
    }),
  );
  if (!options.selftest && upperBoundUsd !== null) {
    const decision = decide({
      yes: options.yes,
      calls: plan.calls,
      upperBoundUsd,
      maxCostUsd: options.maxCostUsd,
      fallback: setup.config?.fallback !== undefined,
    });
    if (!decision.go) {
      io.stderr(`${decision.message}\n`);
      return EXIT_SPEND_GUARD;
    }
  }

  // ---- The reviews.
  const controller = new AbortController();
  const relay = (): void => controller.abort(io.signal?.reason);
  if (io.signal?.aborted === true) relay();
  else io.signal?.addEventListener("abort", relay, { once: true });

  const spent = emptyUsage();
  let current = { calls: 0, usage: emptyUsage() };
  let totalCalls = 0;
  // Only the Anthropic adapter takes a fetch of its own and reports usage, so it is the only
  // provider whose requests can be held back one by one.
  const { price } = setup;
  const budget =
    price === null || setup.config?.provider !== "anthropic"
      ? undefined
      : createBudget({
          price,
          maxCostUsd: options.maxCostUsd,
          spentUsd: () => costOf(spent, price),
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
    addUsage(current.usage, usage);
    addUsage(spent, usage);
    budget?.settled();
    // The bound should keep a run under the limit. This is for the day it does not, because
    // retries, an unexpected tokenisation or a wrong price can all make a run cost more.
    if (setup.price !== null && costOf(spent, setup.price) > options.maxCostUsd) {
      controller.abort(
        new BudgetExceeded(
          `Recorded spend passed the --max-cost limit of ${usd(options.maxCostUsd)}, ` +
            `so no further model calls were started. Raise it with --max-cost to continue.`,
        ),
      );
    }
  };

  let shared: ObjectGenerator | undefined;
  let disclosure = options.selftest ? "a scripted oracle (nothing is sent anywhere)" : "";
  let disclosed = options.selftest;
  const build = (fixture: Fixture): ObjectGenerator => {
    const request: GeneratorRequest = {
      fixture,
      config: setup.config,
      selftest: options.selftest,
      onUsage,
    };
    if (io.generatorFactory !== undefined) return io.generatorFactory(request);
    if (setup.config === undefined) return createOracleGenerator(oracleScripts(fixture));
    return createObjectGenerator(
      setup.config,
      setup.config.provider === "anthropic"
        ? { onUsage, ...(budget === undefined ? {} : { fetch: budget.fetch }) }
        : undefined,
    );
  };
  const generatorFor = (fixture: Fixture): ObjectGenerator => {
    if (options.selftest) return build(fixture);
    shared ??= build(fixture);
    return shared;
  };

  const records: RunRecord[] = [];
  const makeResult = (stoppedBecause: string | null, finishedAt: Date): EvalResult =>
    buildResult({
      fixtures,
      records,
      plan,
      price: setup.price,
      selftest: options.selftest,
      usageAvailable: setup.usageAvailable,
      usageNote: setup.usageNote,
      totalCalls,
      spent: setup.usageAvailable ? { ...spent } : null,
      model: {
        provider: setup.provider,
        model: setup.model,
        disclosure,
      },
      config: setup.config === undefined ? null : summariseConfig(setup.config),
      options: {
        fixtures: fixtures.map((fixture) => fixture.name),
        runs: options.runs,
        assumedOutputTokens: options.assumedOutputTokens,
        maxCostUsd: options.selftest ? null : options.maxCostUsd,
      },
      maxRetries,
      startedAt,
      finishedAt,
      stoppedBecause,
    });

  // Written after every review, so that a run killed without a chance to write its results (SIGKILL,
  // a power cut) still leaves everything that finished. It is removed once the results are in place.
  const partialPath = `${outPath}.partial`;
  const checkpoint = async (): Promise<void> => {
    const snapshot = makeResult("The run did not finish. This is the checkpoint it left.", now());
    await writeFileAtomically(partialPath, serialise(snapshot), { replace: true }).catch(
      () => undefined,
    );
  };
  let stopped: { reason: string; exitCode: number; label: string } | undefined;
  try {
    for (const fixture of fixtures) {
      const generator = counted(generatorFor(fixture), () => {
        current.calls += 1;
        totalCalls += 1;
      });
      if (!disclosed) {
        disclosed = true;
        disclosure = generator.disclosure;
        io.stderr(`Sending the contract text to: ${plain(disclosure)}\n`);
      }
      for (let run = 1; run <= options.runs; run += 1) {
        const tally = { calls: 0, usage: emptyUsage() };
        current = tally;
        io.stderr(`Reviewing ${plain(fixture.name)}, review ${run} of ${options.runs}.\n`);
        const { report, redlined } = await reviewContract(
          { docx: fixture.docx, playbook: fixture.playbook, fileName: fixture.name },
          generator,
          {
            concurrency: setup.limits.concurrency,
            ...(setup.limits.maxContextTokens === undefined
              ? {}
              : { maxContextTokens: setup.limits.maxContextTokens }),
            signal: controller.signal,
          },
        );
        const integrity = await checkIntegrity({ original: fixture.docx, redlined, report });
        records.push({
          fixture: fixture.name,
          run,
          report,
          integrity,
          calls: tally.calls,
          usage: setup.usageAvailable ? tally.usage : null,
        });
        if (!options.selftest) await checkpoint();
        const right = report.results.filter(
          (result) => result.status === fixture.expected[result.ruleId],
        ).length;
        io.stderr(
          `  ${right} of ${report.results.length} rules as expected, ` +
            `${report.counts.error} errored, ${tally.calls} model calls` +
            `${integrity.ok ? "" : ", INTEGRITY FAILURE"}.\n`,
        );
      }
    }
  } catch (error) {
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined;
    if (reason instanceof BudgetExceeded) {
      stopped = { reason: reason.message, exitCode: EXIT_SPEND_GUARD, label: "Stopped" };
    } else if (io.signal?.aborted === true) {
      stopped = { reason: "Interrupted.", exitCode: INTERRUPTED, label: "Stopped" };
    } else {
      stopped = {
        reason: describeError(error),
        exitCode: error instanceof EvalError ? error.exitCode : 1,
        label: "Error",
      };
    }
  } finally {
    io.signal?.removeEventListener("abort", relay);
  }

  // ---- What came of it.
  const finishedAt = now();
  const result = makeResult(stopped?.reason ?? null, finishedAt);

  io.stderr(
    `${describeSpend({
      setup,
      spent,
      calls: totalCalls,
      selftest: options.selftest,
      finished: stopped === undefined,
    })}\n`,
  );
  if (stopped !== undefined) io.stderr(`${stopped.label}: ${stopped.reason}\n`);
  if (stopped !== undefined && unreportedUsd > 0) {
    io.stderr(
      `Requests that were under way when the run stopped were cut off and may still have been billed, by up to ${usd(unreportedUsd)} more than the spend above.\n`,
    );
  }

  let exitCode = stopped?.exitCode ?? 0;
  // A run stopped before its first review finished has still spent money, and the usage is worth
  // keeping next to the report.
  if (records.length > 0 || spent.responses > 0) {
    try {
      await writeFileAtomically(outPath, serialise(result), { replace: false });
      io.stderr(`Results written to ${outPath}\n`);
      await unlink(partialPath).catch(() => undefined);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "an error";
      io.stderr(
        `Error: the results could not be written to ${outPath} (${code}).` +
          `${records.length > 0 && !options.selftest ? ` What finished is in ${partialPath}.` : ""}\n`,
      );
      exitCode ||= 1;
    }
    const comparison = previous === undefined ? undefined : compareResults(previous, result);
    io.stdout(renderReport(result, comparison));
  }

  // Exit 2 is the most serious result, so a run that also stopped early still reports it.
  if (result.score.integrityFailures.length > 0) {
    io.stderr(
      "INTEGRITY FAILURE: a redlined file does not reject back to the original text, or its " +
        "tracked changes do not match the report. See the top of the report.\n",
    );
    exitCode = EXIT_INTEGRITY;
  }
  return exitCode;
}

export async function runEvals(argv: string[], io: EvalIo): Promise<number> {
  try {
    return await execute(argv, io);
  } catch (error) {
    if (error instanceof EvalError) {
      io.stderr(`Error: ${error.message}\n`);
      if (error instanceof UsageError) io.stderr(`${USAGE_HINT}\n`);
      return error.exitCode;
    }
    if (io.signal?.aborted === true) {
      io.stderr("Interrupted.\n");
      return INTERRUPTED;
    }
    io.stderr(`Error: ${describeError(error)}\n`);
    return 1;
  }
}
