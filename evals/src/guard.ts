import { PRICE_WARNING, type Price } from "./prices.js";
import type { Limits, Plan } from "./plan.js";

// Model ids and file names come from the environment and the command line, so control codes are
// stripped before they reach the terminal.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
export const plain = (value: string): string =>
  value.replace(CONTROL, " ").replace(/\s+/g, " ").trim();

export const int = (value: number): string => value.toLocaleString("en-US");
export const usd = (value: number): string => `$${value.toFixed(4)}`;

export interface PlanContext {
  provider: string;
  model: string;
  selftest: boolean;
  limits: Limits;
  price: Price | null;
  upperBoundUsd: number | null;
  /** The bound if every call needed all of its retries. */
  retryWorstCaseUsd: number | null;
  maxRetries: number | null;
  /** The most the plan can cost, whatever the model does. See costCeiling. */
  ceilingUsd: number | null;
  maxOutputTokens: number | null;
  maxCostUsd: number;
  /** True when a request the model declines is rerun on another model. */
  fallback: boolean;
}

function row(cells: string[], widths: number[]): string {
  return `  ${cells.map((text, i) => (i === 0 ? text.padEnd(widths[i] ?? 0) : text.padStart(widths[i] ?? 0))).join("  ")}`;
}

/** The plan as plain text for stderr. It is printed before anything is sent. */
export function describePlan(plan: Plan, context: PlanContext): string {
  const header = ["Fixture", "Rules", "Clauses", "Windows", "Calls per review"];
  const body = plan.fixtures.map((item) => [
    plain(item.fixture),
    String(item.rules),
    String(item.clauses),
    String(item.windows),
    String(item.callsPerRun),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );

  const lines = [
    context.selftest
      ? "Selftest plan (no model will be called)"
      : "Evaluation plan (nothing has been sent yet)",
    `  Model: ${plain(context.model)} (${plain(context.provider)})`,
    `  Prompt size: ${
      context.limits.maxContextTokens === undefined
        ? "the whole contract goes into every call"
        : `windows of at most ${int(context.limits.maxContextTokens)} estimated tokens`
    }`,
    `  Reviews: ${plan.fixtures.length} ${plan.fixtures.length === 1 ? "fixture" : "fixtures"}, ${plan.runs} ${plan.runs === 1 ? "review" : "reviews"} of each`,
    "",
    row(header, widths),
    ...body.map((cells) => row(cells, widths)),
    "",
    `  Model calls in total: ${int(plan.calls)}`,
  ];
  if (context.selftest) return `${lines.join("\n")}\n`;

  lines.push(
    `  Input tokens, upper bound: ${int(plan.inputTokens)} (1 token per 3 characters of every prompt and of the response schema, no caching, one attempt per call)`,
    `  Output tokens, upper bound: ${int(plan.outputTokens)} (${int(plan.calls)} calls x ${int(plan.assumedOutputTokens)} tokens assumed per call. Thinking counts as output, so raise it for a model that thinks at length, with --assumed-output-tokens)`,
  );
  if (context.price !== null && context.upperBoundUsd !== null) {
    const { price } = context;
    lines.push(
      `  Prices per million tokens: ${price.input} input, ${price.output} output (from the price table)`,
      `  Cost upper bound: ${usd(context.upperBoundUsd)}`,
    );
    if (
      context.retryWorstCaseUsd !== null &&
      context.maxRetries !== null &&
      context.maxRetries > 0
    ) {
      lines.push(
        `  If every call used all ${context.maxRetries} of its retries the bound would be ${usd(context.retryWorstCaseUsd)}`,
      );
    }
  }
  if (context.ceilingUsd !== null && context.maxOutputTokens !== null) {
    lines.push(
      `  Hard ceiling: ${usd(context.ceilingUsd)} if every attempt of every call generated all ${int(context.maxOutputTokens)} output tokens it is allowed (CLAUSEWISE_MAX_OUTPUT_TOKENS). The cost upper bound above assumes far less, so the run is also held to --max-cost request by request.`,
    );
  }
  if (context.fallback) {
    lines.push(
      "  CLAUSEWISE_FALLBACK is on: a request the model declines is rerun on another model, which the price table does not cover.",
    );
  }
  lines.push(`  Spend limit (--max-cost): ${usd(context.maxCostUsd)}`, `  ${PRICE_WARNING}`);
  return `${lines.join("\n")}\n`;
}

export type Decision = { go: true } | { go: false; message: string };

/**
 * Decides whether a real run may start. A refusal has called nothing. The bound must be at or
 * under the limit, so a limit set to exactly the bound is accepted.
 */
export function decide(args: {
  yes: boolean;
  calls: number;
  upperBoundUsd: number;
  maxCostUsd: number;
  /** A request the model declines is rerun on another model, which the price table does not cover. */
  fallback: boolean;
}): Decision {
  const { upperBoundUsd, maxCostUsd } = args;
  const over = upperBoundUsd > maxCostUsd;
  const raise = "Raise the limit with --max-cost <usd>, or do less with --fixture or --runs.";
  if (!args.yes) {
    return {
      go: false,
      message:
        `Nothing was sent. This evaluation would make ${int(args.calls)} model calls and cost at ` +
        `most ${usd(upperBoundUsd)}.` +
        (over
          ? ` That is above the current limit of ${usd(maxCostUsd)}. ${raise} Then add --yes to run it.`
          : " Add --yes to run it."),
    };
  }
  if (args.fallback) {
    return {
      go: false,
      message:
        "Refusing to run: CLAUSEWISE_FALLBACK is on, so a request the model declines is rerun on " +
        "another model whose price this table does not hold, and the spend guard cannot hold " +
        "--max-cost. Unset CLAUSEWISE_FALLBACK for an evaluation. Nothing was sent.",
    };
  }
  if (over) {
    return {
      go: false,
      message:
        `Refusing to run: the cost upper bound of ${usd(upperBoundUsd)} is above --max-cost ` +
        `${usd(maxCostUsd)}. ${raise} Nothing was sent.`,
    };
  }
  return { go: true };
}
