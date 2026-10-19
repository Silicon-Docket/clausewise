import { CliError, UsageError, describeError } from "./errors.js";
import type { CliIo } from "./io.js";
import { playbookCheck } from "./playbook.js";
import { reviewCommand } from "./review.js";
import { USAGE, USAGE_HINT, readVersion } from "./usage.js";

export type { CliIo } from "./io.js";

const INTERRUPTED = 130;

async function playbookCommand(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) {
    throw new UsageError("playbook needs a command. The one available is: check");
  }
  if (subcommand === "--help" || subcommand === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (subcommand.startsWith("-")) throw new UsageError(`Unknown option: ${subcommand}`);
  if (subcommand !== "check") throw new UsageError(`Unknown playbook command: ${subcommand}`);
  return playbookCheck(rest, io);
}

async function dispatch(argv: string[], io: CliIo): Promise<number> {
  const [first, ...rest] = argv;
  if (first === undefined) {
    io.stderr(USAGE);
    return 1;
  }
  if (first === "--help" || first === "-h") {
    io.stdout(USAGE);
    return 0;
  }
  if (first === "--version") {
    io.stdout(`${await readVersion()}\n`);
    return 0;
  }
  if (first.startsWith("-")) throw new UsageError(`Unknown option: ${first}`);
  switch (first) {
    case "review":
      return reviewCommand(rest, io);
    case "playbook":
      return playbookCommand(rest, io);
    default:
      throw new UsageError(`Unknown command: ${first}`);
  }
}

function fail(error: unknown, io: CliIo): number {
  if (error instanceof CliError) {
    io.stderr(`Error: ${error.message}\n`);
    if (error instanceof UsageError) io.stderr(`${USAGE_HINT}\n`);
    return error.exitCode;
  }
  // Ctrl-C ends whatever the review was doing with an error of its own, which is not worth showing.
  if (io.signal?.aborted === true) {
    io.stderr("Interrupted. No files were written.\n");
    return INTERRUPTED;
  }
  io.stderr(`Error: ${describeError(error)}\n`);
  return 1;
}

/**
 * Runs the command line and returns the process exit code. Nothing a user can do wrong makes it
 * throw, and nothing it prints can hold contract text.
 */
export async function run(argv: string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return fail(error, io);
  }
}
