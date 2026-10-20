import type { Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { DocxError, parseDocx } from "@clausewise/docx";
import { createObjectGenerator, loadLlmConfig, type ObjectGenerator } from "@clausewise/llm";
import { SEVERITIES, type Severity } from "@clausewise/playbook";
import {
  renderMarkdown,
  reviewContract,
  type ProgressEvent,
  type ReviewOptions,
  type ReviewReport,
  type RuleResult,
} from "@clausewise/review";
import { parseCommandArgs, type OptionKind, type ParsedArgs } from "./args.js";
import { CliError, UsageError } from "./errors.js";
import {
  checkOutputs,
  defaultOutputPaths,
  fsReason,
  statIfPresent,
  type OutputTarget,
} from "./files.js";
import type { CliIo } from "./io.js";
import { outputMode, probeFolders, writeOutputs } from "./output.js";
import { loadPlaybook } from "./playbook.js";
import { atOrAbove, formatSummary, notShownLine } from "./summary.js";
import { createTokenMeter, type TokenMeter } from "./tokens.js";
import { plain, plural, visible } from "./text.js";
import { USAGE } from "./usage.js";

const OPTIONS = {
  playbook: "string",
  out: "string",
  report: "string",
  summary: "string",
  author: "string",
  client: "string",
  "fail-on": "string",
  force: "boolean",
  quiet: "boolean",
} as const satisfies Record<string, OptionKind>;

interface ReviewArgs {
  input: string;
  playbook: string;
  /** In the order they are written: redlined contract, report, summary. */
  outputs: [OutputTarget, OutputTarget, OutputTarget];
  author: string | undefined;
  client: string | undefined;
  failOn: Severity | undefined;
  force: boolean;
  quiet: boolean;
}

function readArgs(parsed: ParsedArgs): ReviewArgs {
  const [input, ...extra] = parsed.positionals;
  if (input === undefined) {
    throw new UsageError(
      "review needs the contract to check: clausewise review <contract.docx> --playbook <file.yaml>",
    );
  }
  if (extra.length > 0) {
    throw new UsageError(`review takes one contract, but ${parsed.positionals.length} were given.`);
  }
  const playbook = parsed.strings.get("playbook");
  if (playbook === undefined) {
    throw new UsageError("review needs a playbook: add --playbook <file.yaml>.");
  }

  const rawFailOn = parsed.strings.get("fail-on");
  const failOn = SEVERITIES.find((severity) => severity === rawFailOn);
  if (rawFailOn !== undefined && failOn === undefined) {
    throw new UsageError(`--fail-on must be one of: ${SEVERITIES.join(", ")}.`);
  }
  const author = parsed.strings.get("author");
  if (author !== undefined && author.trim() === "") {
    throw new UsageError("--author needs a name.");
  }
  const client = parsed.strings.get("client");
  if (client !== undefined && client.trim() === "") {
    throw new UsageError("--client needs the name of the party you act for.");
  }

  const defaults = defaultOutputPaths(input);
  return {
    input,
    playbook,
    outputs: [
      { label: "redlined contract", path: parsed.strings.get("out") ?? defaults.redlined },
      { label: "report", path: parsed.strings.get("report") ?? defaults.report },
      { label: "summary", path: parsed.strings.get("summary") ?? defaults.summary },
    ],
    author,
    client,
    failOn,
    force: parsed.flags.has("force"),
    quiet: parsed.flags.has("quiet"),
  };
}

// ---------------------------------------------------------------------------------------------
// Before the review
// ---------------------------------------------------------------------------------------------

async function readInput(
  path: string,
  io: CliIo,
): Promise<{ path: string; stats: Stats; bytes: Uint8Array }> {
  const stats = await statIfPresent(path);
  if (stats === undefined) throw new CliError(`Contract file not found: ${visible(path)}`);
  if (!stats.isFile()) throw new CliError(`${visible(path)} is not a file.`);

  let bytes: Uint8Array;
  try {
    bytes = await (io.readFile ?? readFile)(path);
  } catch (error) {
    throw new CliError(`Cannot read ${visible(path)}: ${fsReason(error)}.`);
  }
  await checkReadable(path, bytes);
  return { path, stats, bytes };
}

/**
 * Opens the contract before anything else is asked of the user, so that a file that is not Word
 * at all, an old .doc, a password protected file or a damaged one is refused first, in the words
 * of the Word engine, which knows which of them it is. No file is sniffed here.
 */
async function checkReadable(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await parseDocx(bytes);
  } catch (error) {
    if (!(error instanceof DocxError)) throw error;
    const reason = plain(error.message);
    throw new CliError(
      `Cannot open ${visible(path)}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`,
    );
  }
}

function buildGenerator(
  io: CliIo,
  meter: TokenMeter,
): {
  generator: ObjectGenerator;
  limits: Pick<ReviewOptions, "concurrency" | "maxContextTokens">;
} {
  if (io.generatorFactory !== undefined) {
    return { generator: io.generatorFactory(io.env), limits: {} };
  }
  const config = loadLlmConfig(io.env);
  return {
    // Only the Anthropic adapter reports what it used, so for the others there is nothing to add up.
    generator:
      config.provider === "anthropic"
        ? createObjectGenerator(config, { onUsage: (usage) => meter.add(usage) })
        : createObjectGenerator(config),
    limits: {
      concurrency: config.concurrency,
      ...(config.maxContextTokens === undefined
        ? {}
        : { maxContextTokens: config.maxContextTokens }),
    },
  };
}

function reportProgress(io: CliIo, event: ProgressEvent): void {
  if (event.type === "start") {
    // Windows overlap by a clause when the limit leaves room for it and not at all when it does
    // not, so only their number is certain.
    const windows = event.windows > 1 ? `, in ${event.windows} parts of the contract` : "";
    io.stderr(
      `Checking ${event.clauses} ${plural(event.clauses, "clause", "clauses")} against ` +
        `${event.rules} ${plural(event.rules, "rule", "rules")}${windows}.\n`,
    );
    return;
  }
  io.stderr(`[${event.done}/${event.total}] ${event.ruleId}: ${event.status}\n`);
}

// ---------------------------------------------------------------------------------------------
// After the review
// ---------------------------------------------------------------------------------------------

function openAtOrAbove(report: ReviewReport, severity: Severity): number {
  return SEVERITIES.slice(0, SEVERITIES.indexOf(severity) + 1).reduce(
    (total, level) => total + report.open[level],
    0,
  );
}

const unchecked = (report: ReviewReport): RuleResult[] =>
  report.results.filter((result) => result.status === "error");

/**
 * A review in which no rule ran says nothing about the contract, and an exit code of 0 with a
 * redline identical to the input would read as "reviewed, nothing to change". The reasons are
 * grouped, because a provider that is down gives the same one for every rule.
 */
function nothingChecked(report: ReviewReport): CliError {
  const reasons = new Map<string, number>();
  for (const result of report.results) {
    const reason = plain(result.error ?? "The rule was not checked.");
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const listed = [...reasons].slice(0, 5);
  const more = reasons.size - listed.length;
  return new CliError(
    [
      "No rule could be checked, so nothing was reviewed. No output files were written.",
      "Why:",
      ...listed.map(([reason, rules]) => `  ${rules} ${plural(rules, "rule", "rules")}: ${reason}`),
      ...(more > 0 ? [`  and ${more} other ${plural(more, "reason", "reasons")}`] : []),
      "Check the model settings and the state of the provider, then run the review again.",
    ].join("\n"),
  );
}

const MOST_NAMED = 8;

/** Said whether or not --fail-on is set: a review with holes in it must not pass for a whole one. */
function warnUnchecked(io: CliIo, report: ReviewReport, failOn: Severity | undefined): void {
  const failed = unchecked(report);
  if (failed.length === 0) return;
  const names = failed.map((result) => `${plain(result.title)} (${result.severity})`);
  const more = names.length - MOST_NAMED;
  const gate =
    failOn === undefined
      ? ""
      : ` Rules at ${failOn} severity or above count as open for --fail-on ${failOn}.`;
  io.stderr(
    `WARNING: ${failed.length} of ${report.results.length} rules could not be checked, so this ` +
      `review is incomplete: ${names.slice(0, MOST_NAMED).join(", ")}` +
      `${more > 0 ? `, and ${more} more` : ""}.${gate}\n`,
  );
}

/**
 * What the review itself says about the file, under the summary: the notes of the report, and in
 * one line what the model never saw. They are on stderr with the other warnings, so a script that
 * reads the summary from stdout gets the results alone.
 */
function warnAboutFile(io: CliIo, report: ReviewReport): void {
  for (const warning of report.warnings ?? []) {
    const text = plain(warning);
    if (text !== "") io.stderr(`Warning: ${text}\n`);
  }
  const notShown = notShownLine(report);
  if (notShown !== undefined) io.stderr(`${notShown}\n`);
}

/** The exit code of the gate, with the reason on stderr when it is not 0. */
function gate(io: CliIo, report: ReviewReport, failOn: Severity | undefined): number {
  if (failOn === undefined) return 0;
  // A rule nobody could check may hide a deviation, so for the gate it counts as one.
  const notChecked = unchecked(report).filter((result) => atOrAbove(result.severity, failOn));
  const failing = openAtOrAbove(report, failOn) + notChecked.length;
  if (failing === 0) return 0;
  const including =
    notChecked.length === 0
      ? ""
      : `, including ${notChecked.length} ${plural(notChecked.length, "rule", "rules")} that could ` +
        "not be checked";
  io.stderr(
    `Exiting with code 2: ${failing} open ${plural(failing, "item", "items")} at ${failOn} ` +
      `severity or above (--fail-on ${failOn})${including}.\n`,
  );
  return 2;
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

export async function reviewCommand(args: string[], io: CliIo): Promise<number> {
  const parsed = parseCommandArgs(args, OPTIONS);
  if (parsed.help) {
    io.stdout(USAGE);
    return 0;
  }
  const options = readArgs(parsed);

  const input = await readInput(options.input, io);
  // Checked now so a refusal costs nothing, and again before writing because a review can take
  // minutes.
  await checkOutputs(input, options.outputs, options.force);
  const mode = outputMode(input.stats);
  // A folder that cannot be written to is found out here, not after every rule was paid for.
  await probeFolders(io, options.outputs, mode);
  const playbook = await loadPlaybook(options.playbook);
  const meter = createTokenMeter();
  const { generator, limits } = buildGenerator(io, meter);

  io.stderr(`Sending the contract text to: ${plain(generator.disclosure)}\n`);

  try {
    return await reviewAndWrite(io, options, { input, playbook, generator, limits, mode });
  } finally {
    // After everything else, and also when the review fails: the calls were paid for either way.
    const tokens = meter.line();
    if (tokens !== undefined) io.stderr(`${tokens}\n`);
  }
}

async function reviewAndWrite(
  io: CliIo,
  options: ReviewArgs,
  context: {
    input: Awaited<ReturnType<typeof readInput>>;
    playbook: Awaited<ReturnType<typeof loadPlaybook>>;
    generator: ObjectGenerator;
    limits: Pick<ReviewOptions, "concurrency" | "maxContextTokens">;
    mode: number;
  },
): Promise<number> {
  const { input, playbook, generator, limits, mode } = context;
  const { report, redlined } = await reviewContract(
    { docx: input.bytes, playbook, fileName: basename(options.input) },
    generator,
    {
      ...limits,
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(options.client === undefined ? {} : { client: options.client }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(options.quiet ? {} : { onProgress: (event: ProgressEvent) => reportProgress(io, event) }),
    },
  );

  // The last point where Ctrl-C can still mean that nothing is written.
  io.signal?.throwIfAborted();
  if (report.results.length > 0 && unchecked(report).length === report.results.length) {
    throw nothingChecked(report);
  }

  const present = await checkOutputs(input, options.outputs, options.force);
  const [redlinedTarget, reportTarget, summaryTarget] = options.outputs;
  await writeOutputs(
    io,
    [
      { target: redlinedTarget, data: redlined },
      { target: reportTarget, data: `${JSON.stringify(report, null, 2)}\n` },
      { target: summaryTarget, data: renderMarkdown(report) },
    ],
    { mode, force: options.force, present },
  );

  io.stdout(
    formatSummary(
      report,
      {
        redlined: redlinedTarget.path,
        report: reportTarget.path,
        summary: summaryTarget.path,
      },
      { failOn: options.failOn },
    ),
  );
  warnUnchecked(io, report, options.failOn);
  warnAboutFile(io, report);
  return gate(io, report, options.failOn);
}
