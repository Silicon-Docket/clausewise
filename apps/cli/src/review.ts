import type { Stats } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { parseDocx } from "@clausewise/docx";
import { createObjectGenerator, loadLlmConfig, type ObjectGenerator } from "@clausewise/llm";
import { SEVERITIES, type Severity } from "@clausewise/playbook";
import {
  renderMarkdown,
  reviewContract,
  type ProgressEvent,
  type ReviewOptions,
  type ReviewReport,
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
import { loadPlaybook } from "./playbook.js";
import { formatSummary } from "./summary.js";
import { plain, plural } from "./text.js";
import { USAGE } from "./usage.js";

const OPTIONS = {
  playbook: "string",
  out: "string",
  report: "string",
  summary: "string",
  author: "string",
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
  if (stats === undefined) throw new CliError(`Contract file not found: ${path}`);
  if (!stats.isFile()) throw new CliError(`${path} is not a file.`);

  let bytes: Uint8Array;
  try {
    bytes = await (io.readFile ?? readFile)(path);
  } catch (error) {
    throw new CliError(`Cannot read ${path}: ${fsReason(error)}.`);
  }
  // Every .docx is a zip, and a zip starts with PK. Anything else is the wrong kind of file, most
  // often an old .doc, which Word can save again as .docx.
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new CliError(
      `${path} is not a .docx file: it is not a zip archive. ` +
        "If it is an older .doc file, open it in Word and save it as .docx.",
    );
  }
  return { path, stats, bytes };
}

function buildGenerator(io: CliIo): {
  generator: ObjectGenerator;
  limits: Pick<ReviewOptions, "concurrency" | "maxContextTokens">;
} {
  if (io.generatorFactory !== undefined) {
    return { generator: io.generatorFactory(io.env), limits: {} };
  }
  const config = loadLlmConfig(io.env);
  return {
    generator: createObjectGenerator(config),
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
    const windows =
      event.windows > 1 ? `, in ${event.windows} overlapping parts of the contract` : "";
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

/**
 * Writes the outputs one after another. A file this run created is removed again if a later write
 * fails, so a review never leaves half of its outputs behind. A file that was replaced under
 * --force cannot be put back.
 */
async function writeOutputs(
  io: CliIo,
  files: readonly { target: OutputTarget; data: Uint8Array | string }[],
  present: ReadonlySet<string>,
): Promise<void> {
  const write = io.writeFile ?? writeFile;
  const created: string[] = [];
  for (const { target, data } of files) {
    if (!present.has(resolve(target.path))) created.push(target.path);
    try {
      await write(target.path, data);
    } catch (error) {
      await Promise.all(created.map((path) => rm(path, { force: true }).catch(() => undefined)));
      throw new CliError(
        `Could not write the ${target.label} to ${target.path}: ${fsReason(error)}.`,
      );
    }
  }
}

function openAtOrAbove(report: ReviewReport, severity: Severity): number {
  return SEVERITIES.slice(0, SEVERITIES.indexOf(severity) + 1).reduce(
    (total, level) => total + report.open[level],
    0,
  );
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
  const playbook = await loadPlaybook(options.playbook);
  const { generator, limits } = buildGenerator(io);

  // A damaged file is reported before the notice below, so the notice is never printed for text
  // that cannot be sent.
  await parseDocx(input.bytes);
  io.stderr(`Sending the contract text to: ${plain(generator.disclosure)}\n`);

  const { report, redlined } = await reviewContract(
    { docx: input.bytes, playbook, fileName: basename(options.input) },
    generator,
    {
      ...limits,
      ...(options.author === undefined ? {} : { author: options.author }),
      ...(io.signal === undefined ? {} : { signal: io.signal }),
      ...(options.quiet ? {} : { onProgress: (event: ProgressEvent) => reportProgress(io, event) }),
    },
  );

  // The last point where Ctrl-C can still mean that nothing is written.
  io.signal?.throwIfAborted();
  const present = await checkOutputs(input, options.outputs, options.force);
  const [redlinedTarget, reportTarget, summaryTarget] = options.outputs;
  await writeOutputs(
    io,
    [
      { target: redlinedTarget, data: redlined },
      { target: reportTarget, data: `${JSON.stringify(report, null, 2)}\n` },
      { target: summaryTarget, data: renderMarkdown(report) },
    ],
    present,
  );

  io.stdout(
    formatSummary(report, {
      redlined: redlinedTarget.path,
      report: reportTarget.path,
      summary: summaryTarget.path,
    }),
  );

  const { failOn } = options;
  if (failOn === undefined) return 0;
  if (report.counts.error > 0) {
    io.stderr(
      `Warning: ${report.counts.error} ${plural(report.counts.error, "rule", "rules")} could not ` +
        "be checked, and --fail-on does not count them.\n",
    );
  }
  const failing = openAtOrAbove(report, failOn);
  if (failing === 0) return 0;
  io.stderr(
    `Exiting with code 2: ${failing} open ${plural(failing, "item", "items")} at ${failOn} ` +
      `severity or above (--fail-on ${failOn}).\n`,
  );
  return 2;
}
