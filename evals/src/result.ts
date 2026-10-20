import type { LlmConfig } from "@clausewise/llm";
import { costUpperBound, type Plan } from "./plan.js";
import { costOf, type Price } from "./prices.js";
import { computeScore, type RunRecord, type Score } from "./score.js";
import type { Fixture } from "./fixtures.js";
import { cacheStats, sumUsage, type CacheStats, type UsageTotals } from "./usage.js";

export interface UsageReport {
  /** False for a provider that does not report usage, and for a selftest. */
  available: boolean;
  /** Why it is not available, when it is not. */
  note: string | null;
  totalCalls: number;
  total: UsageTotals | null;
  byFixture: { fixture: string; runs: number; calls: number; usage: UsageTotals | null }[];
  cache: CacheStats | null;
}

export interface CostReport {
  /** USD per million tokens, or null when no price applies. */
  price: Price | null;
  /** Worked out from the recorded usage with the price table. */
  actualUsd: number | null;
  upperBoundUsd: number | null;
  /** The bound if every call needed all of its retries. */
  retryWorstCaseUsd: number | null;
}

/** What is written to the results file. It holds nothing the pipeline's own reports do not. */
export interface EvalResult {
  schemaVersion: 1;
  /** False when the run stopped before every review finished. */
  complete: boolean;
  stoppedBecause: string | null;
  selftest: boolean;
  startedAt: string;
  finishedAt: string;
  model: { provider: string; model: string; disclosure: string };
  /** The settings that shape a review. The key and the base URL are left out. */
  config: {
    maxOutputTokens: number;
    effort: string | null;
    concurrency: number;
    maxContextTokens: number | null;
    maxRetries: number;
    fallback: string | null;
  } | null;
  options: {
    fixtures: string[];
    runs: number;
    assumedOutputTokens: number;
    maxCostUsd: number | null;
  };
  plan: Plan;
  score: Score;
  runs: RunRecord[];
  usage: UsageReport;
  cost: CostReport;
}

export function summariseConfig(config: LlmConfig): NonNullable<EvalResult["config"]> {
  return {
    maxOutputTokens: config.maxOutputTokens,
    effort: config.effort ?? null,
    concurrency: config.concurrency,
    maxContextTokens: config.maxContextTokens ?? null,
    maxRetries: config.maxRetries,
    fallback: config.fallback ?? null,
  };
}

export function buildResult(args: {
  fixtures: readonly Fixture[];
  records: readonly RunRecord[];
  plan: Plan;
  price: Price | null;
  selftest: boolean;
  usageAvailable: boolean;
  /** Why usage is not available, for the report. */
  usageNote: string | null;
  /** Calls the generator saw, including those of a review that did not finish. */
  totalCalls: number;
  /** Everything recorded so far, including a review that did not finish. */
  spent: UsageTotals | null;
  model: EvalResult["model"];
  config: EvalResult["config"];
  options: EvalResult["options"];
  maxRetries: number | null;
  startedAt: Date;
  finishedAt: Date;
  stoppedBecause: string | null;
}): EvalResult {
  const { records, price, spent } = args;
  const score = computeScore(args.fixtures, records);
  const upperBoundUsd = price === null ? null : costUpperBound(args.plan, price);

  const byFixture = args.fixtures
    .map((fixture) => {
      const own = records.filter((record) => record.fixture === fixture.name);
      return {
        fixture: fixture.name,
        runs: own.length,
        calls: own.reduce((sum, record) => sum + record.calls, 0),
        usage: args.usageAvailable
          ? sumUsage(own.flatMap((record) => (record.usage === null ? [] : [record.usage])))
          : null,
      };
    })
    .filter((item) => item.runs > 0);

  return {
    schemaVersion: 1,
    complete: args.stoppedBecause === null,
    stoppedBecause: args.stoppedBecause,
    selftest: args.selftest,
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
    model: args.model,
    config: args.config,
    options: args.options,
    plan: args.plan,
    score,
    runs: [...records],
    usage: {
      available: args.usageAvailable,
      note: args.usageNote,
      totalCalls: args.totalCalls,
      total: args.usageAvailable ? spent : null,
      byFixture,
      cache:
        args.usageAvailable && price !== null && spent !== null ? cacheStats(spent, price) : null,
    },
    cost: {
      price,
      actualUsd:
        args.usageAvailable && price !== null && spent !== null ? costOf(spent, price) : null,
      upperBoundUsd,
      retryWorstCaseUsd:
        upperBoundUsd === null || args.maxRetries === null
          ? null
          : upperBoundUsd * (1 + args.maxRetries),
    },
  };
}
