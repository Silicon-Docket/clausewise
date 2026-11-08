/**
 * Latency and cost records, and their aggregates. A live run supplies the records (a scripted run
 * records none, because the speed of a stand-in is not a figure for any model), and the functions
 * turn a list of them into the p50, p95, mean and maximum that document 5 and gate G13 ask for.
 */
import { summarizeNumbers, type NumberSummary } from "./stats.js";

/** The stages of a run, in order, as the run status names them. */
export const STAGES = ["ingest", "extract", "retrieve", "analyze", "verify"] as const;
export type StageName = (typeof STAGES)[number];

/** Wall-clock time of one run, from `queued` to `succeeded` or to the failure. */
export interface LatencyRecord {
  caseKey: string;
  repeat: number;
  outcome: "succeeded" | "failed";
  totalMs: number;
  stagesMs: Partial<Record<StageName, number>>;
}

/** What one run spent, retries and failed attempts included, priced with the pinned table. */
export interface CostRecord {
  caseKey: string;
  repeat: number;
  outcome: "succeeded" | "failed";
  /** Input tokens that were not read from or written to the cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface LatencySummary {
  /** Completed runs, the denominator. */
  completed: number;
  /** Failed runs, listed apart from the percentiles. */
  failed: { caseKey: string; repeat: number }[];
  /** Over completed runs. */
  total: NumberSummary;
  stages: Partial<Record<StageName, NumberSummary>>;
}

export function summarizeLatency(records: readonly LatencyRecord[]): LatencySummary {
  const completed = records.filter((r) => r.outcome === "succeeded");
  const stages: LatencySummary["stages"] = {};
  for (const stage of STAGES) {
    const values = completed.flatMap((r) => {
      const ms = r.stagesMs[stage];
      return ms === undefined ? [] : [ms];
    });
    if (values.length > 0) stages[stage] = summarizeNumbers(values);
  }
  return {
    completed: completed.length,
    failed: records
      .filter((r) => r.outcome === "failed")
      .map((r) => ({ caseKey: r.caseKey, repeat: r.repeat })),
    total: summarizeNumbers(completed.map((r) => r.totalMs)),
    stages,
  };
}

export interface CostSummary {
  /** Runs started, failed ones included: the cost of a failed run stays in the total. */
  runs: number;
  failedRuns: number;
  totalUsd: number;
  /** Over runs started. Null when there are none. */
  meanUsd: number | null;
  maxUsd: number | null;
  /** Input plus cache read plus cache write tokens. */
  promptTokens: number;
  cacheReadTokens: number;
  /** The share of prompt tokens read from the cache. Null when there were no prompt tokens. */
  cacheReadShare: number | null;
}

export function summarizeCost(records: readonly CostRecord[]): CostSummary {
  let totalUsd = 0;
  let promptTokens = 0;
  let cacheReadTokens = 0;
  for (const r of records) {
    totalUsd += r.costUsd;
    promptTokens += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
    cacheReadTokens += r.cacheReadTokens;
  }
  const costs = records.map((r) => r.costUsd);
  return {
    runs: records.length,
    failedRuns: records.filter((r) => r.outcome === "failed").length,
    totalUsd,
    meanUsd: records.length === 0 ? null : totalUsd / records.length,
    maxUsd: costs.length === 0 ? null : Math.max(...costs),
    promptTokens,
    cacheReadTokens,
    cacheReadShare: promptTokens === 0 ? null : cacheReadTokens / promptTokens,
  };
}
