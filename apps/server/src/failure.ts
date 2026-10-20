import { DocxError } from "@clausewise/docx";
import {
  LlmConfigError,
  ModelOutputError,
  ModelRefusalError,
  ModelRequestError,
} from "@clausewise/llm";
import { PlaybookError } from "@clausewise/playbook";
import { ReviewError, type ReviewReport } from "@clausewise/review";

export const RESTART_MESSAGE =
  "The server restarted while this review was running. Start it again.";

// The packages promise messages that are safe to show: they name the problem and never quote the
// contract. The command line relies on the same promise. Anything else is reported by its name.
const SAFE_ERRORS = [
  ReviewError,
  PlaybookError,
  LlmConfigError,
  ModelRequestError,
  ModelRefusalError,
  ModelOutputError,
];

const SAFE_NAME = /^[\w.]{1,64}$/;

/**
 * What to tell the lawyer when a review stops with an error, and whether the error is one the
 * packages raise on purpose. The same errors the command line reports are worded the same way: a
 * rejected key, a quota error and a model that cannot be found arrive here as a ReviewError with
 * the advice already written. An error that is not one of theirs is a bug in Clausewise, and the
 * caller should log its kind and call stack.
 */
export function describeReviewFailure(error: unknown): { message: string; expected: boolean } {
  if (error instanceof DocxError) {
    return { message: `The document could not be read. ${error.message}`, expected: true };
  }
  if (SAFE_ERRORS.some((type) => error instanceof type)) {
    return { message: (error as Error).message, expected: true };
  }
  const name = error instanceof Error && SAFE_NAME.test(error.name) ? error.name : "Error";
  return {
    message: `The review stopped because of an unexpected error (${name}). This is a bug in Clausewise. The details are in the server log, not here, because they can contain contract text. Start the review again.`,
    expected: false,
  };
}

const MOST_REASONS = 5;

/**
 * A review in which no rule ran says nothing about the contract, and a screen that showed it as
 * finished would read as "reviewed, nothing to change". The reasons are grouped, because a
 * provider that is down gives the same one for every rule.
 */
export function nothingChecked(report: ReviewReport): string {
  const reasons = new Map<string, number>();
  for (const result of report.results) {
    const reason = (result.error ?? "The rule was not checked.").replace(/\s+/g, " ").trim();
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const listed = [...reasons].slice(0, MOST_REASONS);
  const more = reasons.size - listed.length;
  return [
    "No rule could be checked, so nothing was reviewed.",
    ...listed.map(([reason, rules]) => `${rules} ${rules === 1 ? "rule" : "rules"}: ${reason}`),
    ...(more > 0 ? [`and ${more} other ${more === 1 ? "reason" : "reasons"}`] : []),
    "Check the model settings and the state of the provider, then start the review again.",
  ].join("\n");
}

export function allRulesFailed(report: ReviewReport): boolean {
  return report.results.length > 0 && report.results.every((result) => result.status === "error");
}
