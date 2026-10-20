/** A failure whose message was written to be shown to the user as it is. */
export class EvalError extends Error {
  override name = "EvalError";
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** The command line itself was wrong, so the usage hint is shown after the message. */
export class UsageError extends EvalError {
  override name = "UsageError";
}

// The workspace packages promise messages that name the problem and never quote the contract.
// They are matched by name because this package depends on only some of them.
const SAFE_NAMES = new Set([
  "DocxError",
  "PlaybookError",
  "LlmConfigError",
  "ReviewError",
  "ModelRequestError",
  "ModelRefusalError",
  "ModelOutputError",
]);

const SAFE_NAME = /^[\w.]{1,64}$/;

/**
 * The text to show for an error. Anything not thrown by this package or by one of the packages
 * above is reported by its name alone: the message of an unknown error can hold contract text.
 */
export function describeError(error: unknown): string {
  if (error instanceof EvalError) return error.message;
  if (error instanceof Error && SAFE_NAMES.has(error.name)) return error.message;
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "Error";
  return (
    `Unexpected error (${name}). This is a bug in the evaluation harness. Its details are not ` +
    "shown because they can contain contract text."
  );
}

// A model id or a fixture name comes from the environment or the command line, where a mistyped
// variable can hold an API key and a pasted line can hold terminal control codes. Only a value that
// reads as a plain identifier is repeated.
const IDENTIFIER = /^[A-Za-z0-9][\w.:/-]{0,63}$/;
const LOOKS_SECRET = /^sk-|secret|token|password|key/i;

/** The value itself when it reads as a plain name, otherwise a sentence that says it is withheld. */
export function shown(value: string, what: string): string {
  return IDENTIFIER.test(value) && !LOOKS_SECRET.test(value)
    ? value
    : `the ${what} you gave (not repeated here because it does not look like a plain name)`;
}

export function quoted(value: string, what: string): string {
  const text = shown(value, what);
  return text === value ? `"${value}"` : text;
}
