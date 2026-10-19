import { DocxError } from "@clausewise/docx";
import {
  LlmConfigError,
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
} from "@clausewise/llm";
import { PlaybookError } from "@clausewise/playbook";
import { ReviewError } from "@clausewise/review";

/** A failure whose message was written to be shown to the user as it is. */
export class CliError extends Error {
  override name = "CliError";
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The command line itself was wrong, so the usage hint is shown after the message. */
export class UsageError extends CliError {
  override name = "UsageError";
}

// The packages below promise messages that are safe to print: they name the problem and never
// quote the contract.
const SAFE_ERRORS = [
  DocxError,
  PlaybookError,
  LlmConfigError,
  ReviewError,
  ModelRequestError,
  ModelRefusalError,
  ModelOutputError,
];

const SAFE_NAME = /^[\w.]{1,64}$/;

/**
 * The text to show for an error that is not a CliError. Anything the packages above did not throw
 * is reported by its name alone: the message of an unknown error can hold contract text.
 */
export function describeError(error: unknown): string {
  if (SAFE_ERRORS.some((type) => error instanceof type)) return (error as Error).message;
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "Error";
  return (
    `Unexpected error (${name}). This is a bug in Clausewise. Its details are not shown because ` +
    "they can contain contract text."
  );
}
