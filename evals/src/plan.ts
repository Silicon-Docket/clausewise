import { createScriptedGenerator } from "@clausewise/llm/testing";
import { RuleCheckSchema, estimateTokens, reviewContract } from "@clausewise/review";
import { toJSONSchema } from "zod";
import type { Fixture } from "./fixtures.js";
import { costOf, type Price } from "./prices.js";

/**
 * The pipeline's estimate is one token per three UTF-16 units, which suits a script that needs one
 * byte per character. A script that needs three bytes (Chinese, Japanese, Korean) also needs about
 * one token per character, three times as many, so the bound takes the larger of the estimate and
 * a third of the UTF-8 bytes.
 */
export function boundTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text) / 3));
}

export interface Limits {
  concurrency: number;
  maxContextTokens: number | undefined;
}

export interface FixturePlan {
  fixture: string;
  playbook: string;
  rules: number;
  clauses: number;
  windows: number;
  /** Model calls in one review: one per rule and window. */
  callsPerRun: number;
  /** Upper bound on the input tokens of one review. */
  inputTokensPerRun: number;
}

export interface Plan {
  runs: number;
  assumedOutputTokens: number;
  fixtures: FixturePlan[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

// Any valid answer will do. The pipeline never builds a prompt from an earlier answer, so the
// requests of a dry run are the requests of a real one.
const DRY_ANSWER = {
  status: "not_applicable",
  clauseIds: [],
  explanation: "",
  comment: "",
  edit: null,
  suggestedClause: null,
};

// The API puts the response schema in front of the model as well. The wire form drops some
// keywords, so the full JSON Schema is a safe over-estimate of what is sent.
const SCHEMA_TOKENS = boundTokens(JSON.stringify(toJSONSchema(RuleCheckSchema)));

/**
 * Works out what a review of each fixture will ask of the model by running the real pipeline once
 * against a generator that answers at once and sends nothing. The windows, the prompts and the
 * number of calls are therefore the pipeline's own, not a copy of its rules.
 *
 * The input bound counts every prompt in full with estimateTokens, which errs high, and assumes
 * no caching. It does not include retries, which the adapter makes when a reply does not fit the
 * schema, so it is a bound for one attempt per call.
 */
export async function buildPlan(
  fixtures: readonly Fixture[],
  args: { runs: number; assumedOutputTokens: number; limits: Limits },
): Promise<Plan> {
  const { limits } = args;
  const planned: FixturePlan[] = [];
  for (const fixture of fixtures) {
    const generator = createScriptedGenerator(() => DRY_ANSWER);
    const { report } = await reviewContract(
      { docx: fixture.docx, playbook: fixture.playbook, fileName: fixture.name },
      generator,
      {
        concurrency: limits.concurrency,
        ...(limits.maxContextTokens === undefined
          ? {}
          : { maxContextTokens: limits.maxContextTokens }),
      },
    );
    const inputTokensPerRun = generator.calls.reduce(
      (sum, call) => sum + boundTokens(call.system) + boundTokens(call.prompt) + SCHEMA_TOKENS,
      0,
    );
    planned.push({
      fixture: fixture.name,
      playbook: fixture.playbookPath,
      rules: fixture.playbook.rules.length,
      clauses: report.stats.clauses,
      windows: report.stats.windows,
      callsPerRun: generator.calls.length,
      inputTokensPerRun,
    });
  }

  const callsPerRun = planned.reduce((sum, item) => sum + item.callsPerRun, 0);
  const calls = callsPerRun * args.runs;
  return {
    runs: args.runs,
    assumedOutputTokens: args.assumedOutputTokens,
    fixtures: planned,
    calls,
    inputTokens: planned.reduce((sum, item) => sum + item.inputTokensPerRun, 0) * args.runs,
    outputTokens: calls * args.assumedOutputTokens,
  };
}

/**
 * What the plan can cost if the model behaves as assumed: every token at the full price, nothing
 * cached, one attempt per call and the output the plan assumes. It is an estimate and not a
 * ceiling. Use costCeiling for that.
 */
export function costUpperBound(plan: Plan, price: Price): number {
  return costOf(
    {
      inputTokens: plan.inputTokens,
      outputTokens: plan.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    price,
  );
}

/**
 * The most the plan can cost whatever the model does: every attempt of every call generates all the
 * output it is allowed, the prompts are as large as estimated, and each prompt token is billed at
 * the dearer of the plain and the cache-write rate. Thinking is output and the model decides how
 * much of it to use, so nothing but the token limit bounds it.
 */
export function costCeiling(
  plan: Plan,
  price: Price,
  args: { maxOutputTokens: number; maxRetries: number },
): number {
  const attempts = args.maxRetries + 1;
  return costOf(
    {
      inputTokens: plan.inputTokens * attempts,
      outputTokens: plan.calls * attempts * args.maxOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    { ...price, input: Math.max(price.input, price.cacheWrite) },
  );
}
