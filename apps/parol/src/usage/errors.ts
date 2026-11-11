import { formatUsd } from "./summary.js";

/**
 * The errors of the spend guard. Every message and every sentence a person reads is fixed text and
 * numbers (USD figures the operator's own limits and the planned bound gave): never an id, a name,
 * a document, a prompt or a model answer.
 */

/** Why a review was refused before it began. A closed set: the response checks it. */
export const SPEND_REFUSAL_CODES = ["spend_over_review_limit", "spend_over_daily_limit"] as const;
export type SpendRefusalCode = (typeof SPEND_REFUSAL_CODES)[number];

export interface SpendFigures {
  /** The most the review (or the rest of it) could cost, planned from the stored documents. */
  boundUsd: number;
  /** The limit that the bound would pass. */
  limitUsd: number;
  /** What is already used: by this review (a resume), or by all reviews today. */
  usedUsd: number;
  /** What reviews in progress may still spend. Zero for the limit of one review. */
  heldUsd: number;
}

/**
 * A review was refused because its planned bound would pass a limit. Nothing was created, so the
 * matter and any earlier results are as they were. The message is fixed; the words for a person
 * are `userText()`.
 */
export class SpendRefusedError extends Error {
  override name = "SpendRefusedError";
  constructor(
    readonly code: SpendRefusalCode,
    readonly figures: SpendFigures,
    /** A resume refuses with different words: the work already done is not paid for again. */
    readonly kind: "start" | "resume" = "start",
  ) {
    super("the review was refused by the spend limit");
  }

  /**
   * The words for a person: what the guard planned, and what to do about it. `todoText()` is the
   * part of them that says what to do, so a page can show it apart.
   */
  userText(): string {
    const bound = formatUsd(this.figures.boundUsd);
    const limit = formatUsd(this.figures.limitUsd);
    const todo = this.todoText();
    if (this.code === "spend_over_daily_limit") {
      const used = formatUsd(this.figures.usedUsd + this.figures.heldUsd);
      return (
        `Today's limit of ${limit} would be passed: ${used} is used or set aside for reviews in ` +
        `progress, and this review could cost up to ${bound}. ${todo}`
      );
    }
    if (this.kind === "resume")
      return (
        `The rest of this review could cost up to ${bound} and it has already used ` +
        `${formatUsd(this.figures.usedUsd)}, and the limit for one review is ${limit}. ${todo}`
      );
    return (
      `This review could cost up to ${bound}, and the limit for one review is ${limit}. ${todo} ` +
      `The ${bound} is an upper bound planned from the documents, not a price quote.`
    );
  }

  /** What to do about it. A sentence that occurs, as it is, inside `userText()`. */
  todoText(): string {
    if (this.code === "spend_over_daily_limit")
      return (
        "Try again after midnight UTC, wait for a review in progress to finish, or ask whoever " +
        "runs this server to raise the limit (PAROL_MAX_DAILY_COST_USD)."
      );
    if (this.kind === "resume")
      return (
        "Ask whoever runs this server to raise the limit (PAROL_MAX_REVIEW_COST_USD), then " +
        "resume: the work already done is not paid for again."
      );
    return (
      "Remove a document you do not need, or ask whoever runs this server to raise the limit " +
      "(PAROL_MAX_REVIEW_COST_USD)."
    );
  }
}

/** Why a request was held back while a review ran. `review_limit` and `daily_limit` have run error kinds of their own. */
export type SpendStopKind =
  "review_limit" | "daily_limit" | "unsizable_request" | "no_run_scope" | "ledger_unreadable";

/**
 * Thrown from the guarded `fetch` instead of sending a request that could take the recorded spend
 * past a limit, and used as the reason the run's signal is aborted with. The message is fixed.
 */
export class SpendStop extends Error {
  override name = "SpendStop";
  constructor(readonly kind: SpendStopKind) {
    super("the review was stopped by the spend limit");
  }
}

/** The spend settings cannot be used. Raised while the server starts; `main.ts` rethrows it as a `ConfigError`. */
export class SpendConfigError extends Error {
  override name = "SpendConfigError";
}
