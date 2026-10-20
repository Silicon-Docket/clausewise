import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export const DEFAULT_RUNS = 1;
export const DEFAULT_MAX_COST_USD = 2;
export const DEFAULT_ASSUMED_OUTPUT_TOKENS = 1500;

export interface EvalOptions {
  /** Fixture file names. Empty means every fixture in expected.json. */
  fixtures: string[];
  runs: number;
  maxCostUsd: number;
  yes: boolean;
  out: string | undefined;
  compare: string | undefined;
  prices: string | undefined;
  assumedOutputTokens: number;
  selftest: boolean;
  help: boolean;
}

export const USAGE_HINT = 'Run "pnpm eval --help" for usage.';

export const USAGE = `Clausewise evaluation harness: run the real review pipeline on the fixtures in
fixtures/ and score the result against fixtures/expected.json.

Usage:
  pnpm eval [options]
  pnpm eval --selftest

Options:
  --fixture <file.docx>        A fixture to run, as named in fixtures/expected.json. Repeat the
                               option for several. Default: all of them.
  --runs <n>                   Reviews per fixture, to measure stability. Default: ${DEFAULT_RUNS}.
  --max-cost <usd>             Refuse to run when the cost upper bound is higher, and stop a run
                               whose recorded spend passes it. Default: ${DEFAULT_MAX_COST_USD.toFixed(2)}.
  --assumed-output-tokens <n>  Output tokens assumed per model call in the cost upper bound.
                               Default: ${DEFAULT_ASSUMED_OUTPUT_TOKENS}.
  --yes                        Spend the money. Without it the plan is printed and nothing is sent.
  --out <file.json>            Where to write the full results. Default: evals/results/<UTC time>.json.
  --compare <previous.json>    Show per-rule changes and the accuracy and F1 delta against an
                               earlier results file.
  --prices <file.json>         Prices to use on top of evals/prices.json, in USD per million tokens:
                               { "<model>": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } }
  --selftest                   Run against a perfect scripted oracle built from expected.json. It
                               needs no key and no --yes, calls no model and ignores prices.
  -h, --help                   Show this help.

The model comes from the same environment variables as the clausewise command (CLAUSEWISE_PROVIDER,
CLAUSEWISE_MODEL, ANTHROPIC_API_KEY, CLAUSEWISE_CONCURRENCY, CLAUSEWISE_MAX_CONTEXT_TOKENS, ...).

The plan and progress go to stderr and the Markdown report to stdout.

Exit codes:
  0    The evaluation finished and every integrity check passed.
  1    Something went wrong, including a fatal error from the model provider.
  2    An integrity check failed: a redlined file did not reject back to the original text, or its
       tracked changes do not match the report. This is the most serious result, so it is the exit
       code even when the run also stopped early.
  3    The spend guard refused to run, or stopped the run: no --yes, a cost upper bound above
       --max-cost, or recorded spend above it.
  130  Interrupted with Ctrl-C, SIGTERM or SIGHUP.
`;

function fail(message: string): never {
  throw new UsageError(message);
}

function wholeNumber(name: string, raw: string): number {
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 1) fail(`--${name} must be a positive whole number.`);
  return value;
}

function positiveAmount(name: string, raw: string): number {
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) fail(`--${name} must be a number above 0.`);
  return value;
}

export function parseEvalArgs(args: readonly string[]): EvalOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: {
        fixture: { type: "string", multiple: true },
        runs: { type: "string" },
        "max-cost": { type: "string" },
        "assumed-output-tokens": { type: "string" },
        yes: { type: "boolean" },
        out: { type: "string" },
        compare: { type: "string" },
        prices: { type: "string" },
        selftest: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
      strict: true,
      tokens: true,
    });
  } catch (error) {
    // The first line of the parser's message names the option. The rest is advice about
    // positional arguments that does not apply here.
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : "";
    return fail(first === "" ? "The options could not be read." : first);
  }

  const { values, positionals, tokens = [] } = parsed;
  if (values.help === true) return emptyOptions({ help: true });
  if (positionals.length > 0) fail(`Unexpected argument: ${positionals[0]}`);

  // A repeated option would silently keep the last value, which is a bad surprise for a limit.
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option" || token.name === "fixture") continue;
    if (seen.has(token.name)) fail(`Option --${token.name} was given more than once.`);
    seen.add(token.name);
  }

  const { runs, out, compare, prices } = values;
  const maxCost = values["max-cost"];
  const assumed = values["assumed-output-tokens"];
  for (const [name, value] of [
    ["out", out],
    ["compare", compare],
    ["prices", prices],
  ] as const) {
    if (value === "") fail(`Option --${name} needs a value.`);
  }

  // An empty name is most likely an unset shell variable, and ignoring it would run every fixture.
  const fixtures = values.fixture ?? [];
  if (fixtures.includes("")) fail("Option --fixture needs a value.");
  return {
    fixtures,
    runs: runs === undefined ? DEFAULT_RUNS : wholeNumber("runs", runs),
    maxCostUsd: maxCost === undefined ? DEFAULT_MAX_COST_USD : positiveAmount("max-cost", maxCost),
    yes: values.yes === true,
    out,
    compare,
    prices,
    assumedOutputTokens:
      assumed === undefined
        ? DEFAULT_ASSUMED_OUTPUT_TOKENS
        : wholeNumber("assumed-output-tokens", assumed),
    selftest: values.selftest === true,
    help: false,
  };
}

function emptyOptions(overrides: Partial<EvalOptions>): EvalOptions {
  return {
    fixtures: [],
    runs: DEFAULT_RUNS,
    maxCostUsd: DEFAULT_MAX_COST_USD,
    yes: false,
    out: undefined,
    compare: undefined,
    prices: undefined,
    assumedOutputTokens: DEFAULT_ASSUMED_OUTPUT_TOKENS,
    selftest: false,
    help: false,
    ...overrides,
  };
}
