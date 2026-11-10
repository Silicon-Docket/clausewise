/**
 * The results file of a Parol evaluation run: what is recorded, how it is scored into sections
 * (one per split), how the pins are worked out, and how a file is written, read back and checked.
 *
 * A results file holds counts, ids, hashes and closed codes. It never holds document text, a
 * quotation, a prompt or a model answer: the scores are made from observations that carry span ids
 * and statuses only. It is plain JSON so that a later comparison, a page and a person can all read
 * it, and `parseResults` validates what it reads, because a file on disk is input.
 *
 * Honesty rules built into the shape:
 *  - `mode` says whether the run was a selftest (a scripted oracle that reads the key), simulated
 *    (the demo's scripted reader) or live (a model). A scripted run records no latency or cost
 *    aggregate, since a figure from a scripted stand-in is not a figure for any model.
 *  - A rate with a zero denominator has a null value, never 0 or 1 (see stats.ts).
 *  - `usage.available` is false for a provider that does not report tokens, and then no cost is
 *    recorded.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { hashOf } from "../../../apps/parol/src/canonical.js";
import { STATUSES, type SourceSpan } from "../../../apps/parol/src/contracts.js";
import type { RegisteredWorkflow } from "../../../apps/parol/src/module-contracts.js";
import { getPrompt } from "../../../apps/parol/src/prompts/registry.js";
import type { PlaybookRuleFacts, Split } from "../../../fixtures/parol/types.js";
import { EvalError, shown } from "../errors.js";
import type { Price, PriceTable } from "../prices.js";
import { costOf } from "../prices.js";
import type { UsageTotals } from "../usage.js";
import { createResolver } from "./anchors.js";
import type { CaseGroup, SplitIntegrity } from "./dataset.js";
import { evaluateGates, type GateReport, type GateSubject } from "./gates.js";
import type { CalibrationResult, ExposureResult } from "./suites.js";
import {
  FAILURE_FACTORS,
  computeStability,
  scoreRepeat,
  summarizeRun,
  type ExtractionObservation,
  type RepeatMetrics,
  type RunMetrics,
  type SlotObservation,
  type Stability,
} from "./score.js";
import {
  summarizeCost,
  summarizeLatency,
  type CostRecord,
  type CostSummary,
  type LatencyRecord,
  type LatencySummary,
  type StageName,
} from "./timing.js";
import { evaluationVersion } from "./version.js";

const execFileAsync = promisify(execFile);

export const RESULTS_FORMAT = 1 as const;
export const RESULTS_KIND = "parol-eval-results" as const;

export type RunMode = "selftest" | "simulated" | "live" | "replay";

/** The words that head every report, table and comparison of a scripted run. */
export const SELFTEST_BANNER =
  "THIS IS A SELFTEST OF THE EVALUATION PLUMBING. THE SCORES BELOW ARE THOSE OF A SCRIPTED ORACLE THAT READS THE ANSWER KEY. A SELFTEST SCORE SAYS NOTHING ABOUT ANY MODEL.";
export const SIMULATED_BANNER =
  "SIMULATED RUN. THE ANSWERS BELOW COME FROM THE SCRIPTED SIMULATED READER OF THE DEMO, NOT FROM A LANGUAGE MODEL. THESE SCORES ARE NOT A MEASUREMENT OF ANY MODEL.";

export const REPLAY_BANNER =
  "REPLAY. THE ANSWERS BELOW WERE RECORDED FROM AN EARLIER LIVE RUN AND RE-SCORED. NO MODEL WAS CALLED. THIS IS NOT A NEW MEASUREMENT AND NOT A NEW REPEAT, AND NO LATENCY OR COST WAS INCURRED.";

export const bannerOf = (mode: RunMode): string | null =>
  mode === "selftest"
    ? SELFTEST_BANNER
    : mode === "simulated"
      ? SIMULATED_BANNER
      : mode === "replay"
        ? REPLAY_BANNER
        : null;

/** A stand-in answered. The scores are not those of any model. A replay is not scripted. */
export const isScripted = (mode: RunMode): boolean => mode === "selftest" || mode === "simulated";

/** Only a live run has a latency and a cost of its own. */
export const isLive = (mode: RunMode): boolean => mode === "live";

/**
 * Where a run's answers came from, when they were recorded or replayed. A live run records them
 * by default, and a replay reads them back.
 */
export interface RecordingNote {
  role: "recorded" | "replayed";
  /** The base name of the recording file. */
  file: string;
  /** Calls written (role recorded, counted after the append succeeded) or answered from the recording (role replayed). */
  calls: number;
  /** Recorded only: true when the recording could not be completed, so it cannot be replayed. */
  failed?: boolean;
  /** Replay only: when the recording was made. */
  recordedAt?: string;
  /** Replay only: the results file of the run that made it. */
  recordedResults?: string;
  /** Replay only: the commit the recording was made at, or null. */
  recordedCommit?: string | null;
  /** Replay only: true when the answer keys or the case files differ from those it was made with. */
  datasetChanged?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The supplementary suites
// ---------------------------------------------------------------------------------------------

/**
 * What the exposure suites found, with a plain sentence for each suite that fed it. It is a test
 * of the application's handling of matters and not of any model, so a scripted run records it too.
 * The counts are those of gate G1; the sentences say what was probed and scanned.
 */
export interface ExposureRecord extends ExposureResult {
  suites: string[];
}

/**
 * The support checker's calibration set, run through the model of the run. Null when the set was
 * not run, in which case gate G11 is not evaluated.
 */
export interface CalibrationRecord {
  result: CalibrationResult;
  /** SHA-256 of the calibration set as the builder wrote it. */
  setSha256: string;
  /** The support prompt the pairs were sent with, by id and hash. */
  prompt: { id: string; sha256: string };
  supportedPairs: number;
  unsupportedPairs: number;
  /** Pairs whose call returned no verdict. Each counts against the checker on both sides, and none is left out. */
  failedPairs: number;
  /** The calls by outcome (ok, refusal, cut_off, schema_error, semantic_error, transport), sorted by outcome. */
  callOutcomes: Record<string, number>;
  /** Calls made, retries of the provider's client not included. */
  modelCalls: number;
  /** Why the numbers may not mean what they appear to, or null. */
  note: string | null;
}

export interface SuiteRecords {
  exposure: ExposureRecord | null;
  calibration: CalibrationRecord | null;
}

export const NO_SUITES: SuiteRecords = Object.freeze({ exposure: null, calibration: null });

// ---------------------------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------------------------

export interface GenerationSettings {
  maxOutputTokens: number;
  /** Null when the model's own default applies. */
  effort: string | null;
  /** Retries of the provider client for a transport error or a reply that does not fit. */
  maxRetries: number;
  /** Rules analysed at once within a run. */
  ruleConcurrency: number;
  /** Null when the adapter sends none, which is the case for Anthropic models that think adaptively. */
  temperature: number | null;
  fallback: string | null;
}

export interface PromptPin {
  id: string;
  sha256: string;
}

export interface WorkflowPin {
  label: string;
  sha256: string;
  retrieval: string;
  checks: string[];
  budgetTokens: number;
  repairAttempts: number;
  prompts: { extract: PromptPin; analyze: PromptPin; support: PromptPin | null };
}

/** Everything a comparison checks. Two runs are alike only if these are. */
export interface Pins {
  dataset: {
    label: string;
    answerKeysSha256: string;
    splitsFileSha256: string;
    /** The hash of each split the run touched, as recomputed and found equal to splits.json. */
    splits: Record<string, string>;
  };
  /** "dev", "heldout" or "all". */
  split: string;
  /** The case keys that were run, sorted. */
  cases: string[];
  playbook: { slug: string; version: string; sha256: string };
  workflow: WorkflowPin;
  model: {
    provider: string;
    requested: string;
    /**
     * The host (and port, when not the default) the requests went to, never a path or a
     * credential. Null for a scripted run, which reaches none. Absent in a file written before it
     * was pinned, which is compared as null.
     */
    endpoint?: string | null;
    /** Distinct models the provider named in its responses. Null when it did not say. */
    reported: string[] | null;
    reportedNote: string;
  };
  /** Null for a scripted run, which sends no request. */
  generation: GenerationSettings | null;
  /** Null when no price table was used (a scripted run, or a provider that reports no usage). */
  prices: { sha256: string; model: Price } | null;
  evaluation: { label: string; sha256: string };
  code: { commit: string | null; dirty: boolean | null };
  repeats: number;
  mode: RunMode;
}

export interface RunRecord {
  split: Split;
  caseKey: string;
  twinOf: string | null;
  repeat: number;
  outcome: "succeeded" | "failed";
  /**
   * Wall-clock time of the run, or null for a scripted run: the time a stand-in takes is not a
   * figure for any model, so it is not recorded as one.
   */
  totalMs: number | null;
  stagesMs: Partial<Record<StageName, number>>;
  /** Model calls made, retries of the provider's client not included. */
  modelCalls: number;
  /** The stages' own record of each call, counted by outcome. */
  callOutcomes: Record<string, number>;
  rulesOverBudget: number;
  extractDegraded: boolean;
  usage: UsageTotals | null;
  costUsd: number | null;
}

export interface SplitSection {
  split: Split;
  caseKeys: string[];
  twinKeys: string[];
  /** Cases the whole split holds. */
  casesInSplit: number;
  fullSplit: boolean;
  splitSha256: string;
  /** Repeats in which every case and twin finished. Only these are scored. */
  completedRepeats: number;
  metrics: {
    repeats: RepeatMetrics[];
    stability: Stability | null;
    summary: ReturnType<typeof summarizeRun>;
  } | null;
  /** Gates for this section alone: no baseline, and the exposure and calibration records of the file, when it has them. */
  gates: GateReport | null;
  /** Null for a scripted run, an incomplete one, or one with nothing to measure. */
  latency: LatencySummary | null;
  cost: CostSummary | null;
}

export interface Contamination {
  split: "heldout";
  workflowLabel: string;
  workflowSha256: string;
  /** Earlier live runs of the held-out split with the same workflow, from the results folder. */
  priorRuns: {
    file: string;
    startedAt: string;
    model: string;
    /** False for a run known only from the ledger, whose end is not recorded. */
    complete: boolean;
    /** True for a run known only from the ledger: its results are not in the folder. */
    elsewhere?: true;
  }[];
  /** Selftest and simulated runs of the same split and workflow, which taught nothing about a model. */
  scriptedPriorRuns: number;
  note: string;
}

export interface ResultsFile {
  format: typeof RESULTS_FORMAT;
  kind: typeof RESULTS_KIND;
  mode: RunMode;
  selftest: boolean;
  simulated: boolean;
  /** The banner of a scripted or replayed run, in capitals. Null for a live run. */
  banner: string | null;
  startedAt: string;
  finishedAt: string;
  complete: boolean;
  stoppedBecause: string | null;
  pins: Pins;
  options: {
    split: string;
    workflow: string;
    repeats: number;
    cases: string[];
    maxCostUsd: number | null;
    assumedOutputTokens: number;
    allowHeldout: boolean;
  };
  integrity: { ok: true; splits: SplitIntegrity[] };
  sections: SplitSection[];
  runs: RunRecord[];
  usage: {
    available: boolean;
    /** Why usage is unavailable, or null. */
    note: string | null;
    calls: number;
    total: UsageTotals | null;
    costUsd: number | null;
  };
  contamination: Contamination | null;
  /** The exposure suites and the calibration set, which feed gates G1 and G11. */
  suites: SuiteRecords;
  /** Whether the run wrote a recording of the model's answers, or read one. */
  recording: RecordingNote | null;
  /** Plain sentences the report prints under its heading. */
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------------------------

export function workflowPin(workflow: RegisteredWorkflow): WorkflowPin {
  const { manifest } = workflow;
  const pin = (id: string): PromptPin => ({ id, sha256: getPrompt(id).sha256 });
  return {
    label: manifest.label,
    sha256: workflow.sha256,
    retrieval: manifest.retrieval,
    checks: [...manifest.checks],
    budgetTokens: manifest.budgetTokens,
    repairAttempts: manifest.repairAttempts,
    prompts: {
      extract: pin(manifest.prompts.extract),
      analyze: pin(manifest.prompts.analyze),
      support: manifest.prompts.support === null ? null : pin(manifest.prompts.support),
    },
  };
}

/** Over every model and price in the table in use, so that a changed price is a changed pin. */
export function priceTableSha256(table: PriceTable): string {
  return hashOf(Object.fromEntries([...table].sort(([a], [b]) => (a < b ? -1 : 1))));
}

export interface GitInfo {
  commit: string | null;
  dirty: boolean | null;
}

/** The commit of the repository at `root`, or nulls when it is not a git repository. */
export async function readGitInfo(root: string): Promise<GitInfo> {
  const git = async (...args: string[]): Promise<string> =>
    (await execFileAsync("git", args, { cwd: root, timeout: 10_000 })).stdout.trim();
  try {
    const commit = await git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return { commit: null, dirty: null };
    const status = await git("status", "--porcelain");
    return { commit, dirty: status !== "" };
  } catch {
    return { commit: null, dirty: null };
  }
}

export const evaluationPin = (): Pins["evaluation"] => evaluationVersion();

/** The hosts the hosted providers' own APIs are served from, when no base URL is configured. */
const OWN_HOSTS: Readonly<Record<string, string>> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

/** The host of the provider's own API, or null for a provider that has none (a server you run). */
export const providerOwnHost = (provider: string): string | null =>
  Object.hasOwn(OWN_HOSTS, provider) ? (OWN_HOSTS[provider] ?? null) : null;

/**
 * Where a live run's requests go: the host of the configured base URL, or the provider's own host
 * when none is set. The same model name answers differently from a gateway, a proxy or a stub, so
 * the destination is part of what a score is the score of. Only the host is kept: a base URL can
 * carry a token in its path, and the configuration refuses credentials in it.
 */
export function endpointHost(provider: string, baseUrl: string | undefined): string | null {
  if (baseUrl === undefined) return providerOwnHost(provider);
  try {
    const host = new URL(baseUrl).host;
    return /^[\w.:[\]-]{1,255}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Scoring a section
// ---------------------------------------------------------------------------------------------

/** What one run observed, kept until its repeat can be scored with the others. */
export interface ObservedRun {
  split: Split;
  caseKey: string;
  repeat: number;
  slots: SlotObservation[];
  extraction: ExtractionObservation;
  spans: readonly SourceSpan[];
}

export function runnableCount(group: CaseGroup): number {
  return group.cases.length + group.twins.length;
}

/** Scores every repeat in which all the cases and twins of the group finished. */
export function scoreGroup(args: {
  rules: Record<string, PlaybookRuleFacts>;
  group: CaseGroup;
  repeats: number;
  observed: readonly ObservedRun[];
}): { completedRepeats: number; run: RunMetrics | null } {
  const { group } = args;
  const key = { rules: args.rules, cases: group.cases, twins: group.twins };
  const metrics: RepeatMetrics[] = [];
  for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
    const here = args.observed.filter((o) => o.split === group.split && o.repeat === repeat);
    if (here.length !== runnableCount(group)) continue;
    metrics.push(
      scoreRepeat({
        key,
        repeat,
        slots: here.flatMap((o) => o.slots),
        extractions: here.map((o) => o.extraction),
        resolver: createResolver(Object.fromEntries(here.map((o) => [o.caseKey, o.spans]))),
      }),
    );
  }
  return {
    completedRepeats: metrics.length,
    run: metrics.length === 0 ? null : { repeats: metrics, stability: computeStability(metrics) },
  };
}

export function gateSubjectOf(
  run: RunMetrics,
  latency: LatencySummary | null,
  cost: CostSummary | null,
  /** Required, so that a caller cannot leave the suites out and have G1 and G11 read as not run. */
  suites: SuiteRecords,
): GateSubject {
  return {
    run,
    ...(suites.exposure === null ? {} : { exposure: suites.exposure }),
    ...(suites.calibration === null ? {} : { calibration: suites.calibration.result }),
    ...(latency === null ? {} : { latency }),
    ...(cost === null ? {} : { cost }),
  };
}

export function buildSection(args: {
  group: CaseGroup;
  rules: Record<string, PlaybookRuleFacts>;
  repeats: number;
  observed: readonly ObservedRun[];
  runs: readonly RunRecord[];
  mode: RunMode;
  complete: boolean;
  splitSha256: string;
  priced: boolean;
  suites?: SuiteRecords;
}): SplitSection {
  const { group, mode } = args;
  const scored = scoreGroup(args);
  const mine = args.runs.filter((r) => r.split === group.split);

  // A figure from a scripted stand-in is not a figure for any model, and an unfinished run has
  // timings of a different set of cases from the one its gates ask about.
  const measure = isLive(mode) && args.complete && mine.length > 0;
  const latencyRecords: LatencyRecord[] = mine.flatMap((r) =>
    r.totalMs === null
      ? []
      : [
          {
            caseKey: r.caseKey,
            repeat: r.repeat,
            outcome: r.outcome,
            totalMs: r.totalMs,
            stagesMs: r.stagesMs,
          },
        ],
  );
  const costRecords: CostRecord[] = mine.flatMap((r) =>
    r.usage === null || r.costUsd === null
      ? []
      : [
          {
            caseKey: r.caseKey,
            repeat: r.repeat,
            outcome: r.outcome,
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
            cacheReadTokens: r.usage.cacheReadTokens,
            cacheWriteTokens: r.usage.cacheWriteTokens,
            costUsd: r.costUsd,
          },
        ],
  );
  const latency = measure ? summarizeLatency(latencyRecords) : null;
  const cost = measure && args.priced && costRecords.length > 0 ? summarizeCost(costRecords) : null;

  return {
    split: group.split,
    caseKeys: group.cases.map((c) => c.case),
    twinKeys: group.twins.map((t) => t.case),
    casesInSplit: group.splitCases,
    fullSplit: group.cases.length === group.splitCases,
    splitSha256: args.splitSha256,
    completedRepeats: scored.completedRepeats,
    metrics:
      scored.run === null
        ? null
        : {
            repeats: scored.run.repeats,
            stability: scored.run.stability,
            summary: summarizeRun(scored.run),
          },
    // Gates are only worked out for a finished run: a run that stopped has scored fewer repeats
    // than were asked for, and "every repeat" would be a statement about some of them.
    gates:
      scored.run === null || !args.complete
        ? null
        : evaluateGates(gateSubjectOf(scored.run, latency, cost, args.suites ?? NO_SUITES)),
    latency,
    cost,
  };
}

export function costOfRun(usage: UsageTotals | null, price: Price | null): number | null {
  return usage === null || price === null ? null : costOf(usage, price);
}

// ---------------------------------------------------------------------------------------------
// Whether the run measured the model
// ---------------------------------------------------------------------------------------------

/** The words that say a score was shaped by something other than the model's own answers. */
export const NOT_CLEAN = "NOT A CLEAN MEASUREMENT";

/** What each outcome of a call means, for the report. */
export const CALL_OUTCOME_MEANINGS: Readonly<Record<string, string>> = {
  ok: "answered, and the answer fit the schema and passed the checks",
  schema_error: "the answer did not fit the schema",
  semantic_error: "the answer fit the schema but failed a check, and a repair was asked for",
  refusal: "the model declined to answer",
  cut_off: "the answer was cut off at the output limit",
  transport: "the call failed on the wire or at the provider, and no answer was received",
  fatal: "the provider rejected the key, the model or the account, which ends the run",
};

export interface RunHealth {
  /** Runs recorded, and how many of them did not finish. */
  runs: number;
  failedRuns: number;
  /** Calls by outcome over those runs, sorted by outcome. */
  calls: Record<string, number>;
  /** Calls lost on the wire: those of the runs, and those of the calibration set. */
  transportCalls: number;
  /** Runs whose extract call failed, so that every rule read the whole document. */
  extractDegradedRuns: number;
  /** Rules (summed over runs) too big for the context budget, which were not sent. */
  rulesOverBudget: number;
  /**
   * False when something other than the model's own answers shaped a score: a call lost on the
   * wire, an extraction that fell back to the whole document, a rule that was never sent. Each
   * of these becomes an undetermined slot or a changed extraction score, and so reads as the model
   * abstaining or failing to find a passage.
   */
  clean: boolean;
  /** Sentences for the report, one per condition that makes the run not clean. */
  problems: string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Counts from the run records, which hold the stages' own record of each call. Pass a split to
 * look at the runs of that split alone. A scripted run is clean by construction, and the count is
 * made all the same.
 */
export function runHealth(file: ResultsFile, split?: Split): RunHealth {
  const runs = file.runs.filter((run) => split === undefined || run.split === split);
  const calls: Record<string, number> = {};
  for (const run of runs) {
    for (const [outcome, n] of Object.entries(run.callOutcomes)) {
      calls[outcome] = (calls[outcome] ?? 0) + n;
    }
  }
  const sorted = Object.fromEntries(Object.entries(calls).sort(([a], [b]) => (a < b ? -1 : 1)));
  const transportCalls = calls["transport"] ?? 0;
  const extractDegradedRuns = runs.filter((run) => run.extractDegraded).length;
  const rulesOverBudget = runs.reduce((total, run) => total + run.rulesOverBudget, 0);
  const problems: string[] = [];
  if (transportCalls > 0) {
    problems.push(
      `${plural(transportCalls, "model call failed", "model calls failed")} on the wire or at the provider (outcome transport). A slot whose call failed is scored as undetermined, which reads as the model abstaining.`,
    );
  }
  // The calibration calls are in no run. One that was lost on the wire is counted against the
  // checker on both sides, so an outage reads as a checker that misses and raises false alarms.
  const calibrationTransport = file.suites.calibration?.callOutcomes["transport"] ?? 0;
  if (calibrationTransport > 0) {
    problems.push(
      `${plural(calibrationTransport, "calibration call failed", "calibration calls failed")} on the wire or at the provider (outcome transport). Each counts against the checker on both sides, so the calibration rates (gate G11) describe the outage as well as the checker.`,
    );
  }
  if (extractDegradedRuns > 0) {
    problems.push(
      `Extraction degraded in ${extractDegradedRuns} of ${runs.length} runs: the extract call failed, so every rule read the whole document, and the extraction scores are those of that fallback.`,
    );
  }
  if (rulesOverBudget > 0) {
    problems.push(
      `${plural(rulesOverBudget, "rule was", "rules were")} not sent because the context was over the budget of the workflow (summed over runs). Each is scored as undetermined, which reads as the model abstaining.`,
    );
  }
  return {
    runs: runs.length,
    failedRuns: runs.filter((run) => run.outcome === "failed").length,
    calls: sorted,
    transportCalls: transportCalls + calibrationTransport,
    extractDegradedRuns,
    rulesOverBudget,
    clean: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------------------------
// Contamination of the held-out split
// ---------------------------------------------------------------------------------------------

export const HELDOUT_SEAL_WARNING =
  "The held-out set is sealed (docs/parol/05, the improvement cycle). It is not run, opened in " +
  "the inspector or used to debug until a candidate is ready for a promotion decision, and each " +
  "candidate gets one held-out run. If a held-out result leads to a further change, the held-out " +
  "set is contaminated for that change and the report must say so.";

/**
 * A live run that touches the held-out split leaves a line in this file in the results folder
 * before its first model call, whatever `--out` says and however the run ends. The results file
 * itself may be written elsewhere, or not at all if the process is killed, and the next run must
 * still be told that the split was used.
 */
export const HELDOUT_LEDGER = "parol-heldout-runs.jsonl";

const LEDGER_FORMAT = 1 as const;
const LEDGER_KIND = "parol-heldout-run" as const;

export interface HeldoutLedgerEntry {
  format: typeof LEDGER_FORMAT;
  kind: typeof LEDGER_KIND;
  startedAt: string;
  workflowLabel: string;
  workflowSha256: string;
  model: string;
  /** The base name of the results file the run will write. */
  file: string;
}

const PLAIN_FILE = /^[\w.-]{1,200}$/;

/** Appends the run to the ledger of the results folder, which it creates if need be. */
export async function recordHeldoutRun(args: {
  resultsDir: string;
  startedAt: Date;
  workflowLabel: string;
  workflowSha256: string;
  model: string;
  /** The path the results will be written to. Only its base name is recorded. */
  outPath: string;
}): Promise<void> {
  const name = basename(args.outPath);
  const entry: HeldoutLedgerEntry = {
    format: LEDGER_FORMAT,
    kind: LEDGER_KIND,
    startedAt: args.startedAt.toISOString(),
    workflowLabel: args.workflowLabel,
    workflowSha256: args.workflowSha256,
    model: args.model,
    file: PLAIN_FILE.test(name) ? name : "a file with an unusual name",
  };
  await mkdir(args.resultsDir, { recursive: true });
  await appendFile(join(args.resultsDir, HELDOUT_LEDGER), `${JSON.stringify(entry)}\n`);
}

const ledgerEntrySchema = z.object({
  format: z.literal(LEDGER_FORMAT),
  kind: z.literal(LEDGER_KIND),
  startedAt: z.string().max(100),
  workflowLabel: z.string().max(2000),
  workflowSha256: z.string().regex(/^[0-9a-f]{64}$/),
  model: z.string().max(2000),
  file: z.string().max(200),
});

async function readLedger(resultsDir: string): Promise<HeldoutLedgerEntry[]> {
  let source: string;
  try {
    source = await readFile(join(resultsDir, HELDOUT_LEDGER), "utf8");
  } catch {
    return [];
  }
  const entries: HeldoutLedgerEntry[] = [];
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = ledgerEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A line that is not ours, or was cut off, is skipped like a file that is not a results file.
    }
  }
  return entries;
}

/**
 * Earlier live runs of the held-out split with the same workflow, read from the results folder by
 * their pins: its results files, the checkpoints (`.json.partial`) that a run killed before it
 * could write its file leaves behind, and the ledger of held-out runs, which also knows of runs
 * whose results went elsewhere. A file that is not a Parol results file, or cannot be read, is
 * skipped: the folder also holds the Clausewise harness's results.
 */
export async function findContamination(args: {
  resultsDir: string;
  workflowLabel: string;
  workflowSha256: string;
}): Promise<Contamination | null> {
  let names: string[];
  try {
    names = (await readdir(args.resultsDir))
      .filter((name) => name.endsWith(".json") || name.endsWith(".json.partial"))
      .sort();
  } catch {
    return null;
  }
  const prior: Contamination["priorRuns"] = [];
  // A run is the same run whether its results file, its checkpoint or the ledger tells of it.
  const counted = new Set<string>();
  const identity = (startedAt: string, workflowSha256: string): string =>
    `${startedAt}\u0000${workflowSha256}`;
  let scripted = 0;
  for (const name of names) {
    let file: ResultsFile;
    try {
      file = parseResults(await readFile(join(args.resultsDir, name), "utf8"));
    } catch {
      continue;
    }
    const sameWorkflow =
      file.pins.workflow.sha256 === args.workflowSha256 &&
      file.pins.workflow.label === args.workflowLabel;
    const touchedHeldout =
      file.runs.some((run) => run.split === "heldout") ||
      file.sections.some((section) => section.split === "heldout");
    if (!sameWorkflow || !touchedHeldout) continue;
    // A replay re-scored answers an earlier run had already got: it taught nothing new.
    if (file.mode === "replay") continue;
    if (isScripted(file.mode)) {
      scripted += 1;
      continue;
    }
    const id = identity(file.startedAt, file.pins.workflow.sha256);
    if (counted.has(id)) continue;
    counted.add(id);
    prior.push({
      file: basename(name),
      startedAt: file.startedAt,
      model: file.pins.model.requested,
      complete: file.complete,
    });
  }
  for (const entry of await readLedger(args.resultsDir)) {
    if (
      entry.workflowSha256 !== args.workflowSha256 ||
      entry.workflowLabel !== args.workflowLabel
    ) {
      continue;
    }
    const id = identity(entry.startedAt, entry.workflowSha256);
    if (counted.has(id)) continue;
    counted.add(id);
    // The ledger does not know how the run ended, and its results are not in this folder.
    prior.push({
      file: entry.file,
      startedAt: entry.startedAt,
      model: entry.model,
      complete: false,
      elsewhere: true,
    });
  }
  if (prior.length === 0) return null;
  return {
    split: "heldout",
    workflowLabel: args.workflowLabel,
    workflowSha256: args.workflowSha256,
    priorRuns: prior,
    scriptedPriorRuns: scripted,
    note:
      `The held-out split was run ${prior.length === 1 ? "once" : `${prior.length} times`} before ` +
      `with workflow ${args.workflowLabel} (${prior
        .map((p) => (p.elsewhere === true ? `${p.file}, results not in this folder` : p.file))
        .join(", ")}). If an earlier ` +
      "result led to a change, the held-out set is contaminated for that change, and a score " +
      "from this run must not be used as a promotion result for it.",
  };
}

// ---------------------------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------------------------

const num = z.number().finite();
const nullableNum = num.nullable();
const interval = z.object({ low: num, high: num });
const rate = z.object({
  numerator: num,
  denominator: num,
  value: nullableNum,
  ci: interval.nullable(),
});
const slotRef = z.object({ caseKey: z.string(), ruleKey: z.string() });
const severity = z.enum(["high", "medium", "low"]);
const status = z.enum(STATUSES);
const failureKind = z.enum(Object.keys(FAILURE_FACTORS) as [string, ...string[]]);

const slotScore = z.object({
  caseKey: z.string(),
  ruleKey: z.string(),
  repeat: num,
  severity,
  weight: num,
  expected: status,
  observed: status,
  statusCorrect: z.boolean(),
  expectedFlag: z.boolean(),
  givenFlag: z.boolean(),
  strictTruePositive: z.boolean(),
  lenientTruePositive: z.boolean(),
  silentMiss: z.boolean(),
  keySupport: z.boolean().nullable(),
  verifiedButUnsupported: z.boolean(),
  escalationMode: z.enum(["required", "allowed", "not_expected"]),
  escalationRequired: z.boolean(),
  escalationMet: z.boolean(),
  verifiedQuotes: num,
  unnecessaryEscalation: z.boolean(),
  failures: z.array(failureKind),
  failure: failureKind.nullable(),
  factor: num,
});

const repeatMetrics = z.object({
  repeat: num,
  slots: num,
  extraction: z.object({
    recall: rate,
    precision: rate,
    notFoundAccuracy: rate,
    degradedCases: num,
  }),
  statusAccuracy: rate,
  issues: z.object({
    recallStrict: rate,
    precisionStrict: rate,
    recallLenient: rate,
    precisionLenient: rate,
  }),
  silentMisses: z.object({
    total: num,
    bySeverity: z.object({ high: num, medium: num, low: num }),
    slots: z.array(slotRef),
  }),
  citations: z.object({ model: rate, displayed: rate }),
  support: z.object({
    substantive: rate,
    verifiedButUnsupported: z.object({ count: num, slots: z.array(slotRef) }),
  }),
  escalation: z.object({ requiredRecall: rate, unnecessaryRate: rate }),
  injection: z.object({ effect: rate, differing: z.array(slotRef) }),
  swf: z.object({ weightedFailure: num, maximum: num, value: nullableNum }),
  slotScores: z.array(slotScore),
});

const stability = z.object({
  repeats: num,
  slots: num,
  meanAgreement: nullableNum,
  belowUnanimous: z.array(
    z.object({
      caseKey: z.string(),
      ruleKey: z.string(),
      agreement: num,
      statuses: z.array(status),
    }),
  ),
});

const numberSummary = z.object({
  n: num,
  min: nullableNum,
  mean: nullableNum,
  p50: nullableNum,
  p95: nullableNum,
  max: nullableNum,
});

const stageName = z.enum(["ingest", "extract", "retrieve", "analyze", "verify"]);
const latencySummary = z.object({
  completed: num,
  failed: z.array(z.object({ caseKey: z.string(), repeat: num })),
  total: numberSummary,
  stages: z.partialRecord(stageName, numberSummary),
});

const costSummary = z.object({
  runs: num,
  failedRuns: num,
  totalUsd: num,
  meanUsd: nullableNum,
  maxUsd: nullableNum,
  promptTokens: num,
  cacheReadTokens: num,
  cacheReadShare: nullableNum,
});

const usageTotals = z.object({
  responses: num,
  inputTokens: num,
  outputTokens: num,
  cacheReadTokens: num,
  cacheWriteTokens: num,
});

/**
 * The most characters one suite sentence of the exposure record holds. The sub-suites build their
 * sentences to fit under it (with room to spare) and the report prints a sentence up to it.
 */
export const SUITE_SENTENCE_MAX = 2000;
const text = z.string().max(SUITE_SENTENCE_MAX);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const promptPin = z.object({ id: text, sha256: sha });
const price = z.object({
  input: num,
  output: num,
  cacheRead: num,
  cacheWrite: num,
});
const split = z.enum(["dev", "heldout"]);
const mode = z.enum(["selftest", "simulated", "live", "replay"]);

/** The pins of a run, as a file records them. A recording header holds the same object. */
export const pinsSchema = z.object({
  dataset: z.object({
    label: text,
    answerKeysSha256: sha,
    splitsFileSha256: sha,
    splits: z.record(z.string(), sha),
  }),
  split: z.enum(["dev", "heldout", "all"]),
  cases: z.array(text),
  playbook: z.object({ slug: text, version: text, sha256: sha }),
  workflow: z.object({
    label: text,
    sha256: sha,
    retrieval: text,
    checks: z.array(text),
    budgetTokens: num,
    repairAttempts: num,
    prompts: z.object({
      extract: promptPin,
      analyze: promptPin,
      support: promptPin.nullable(),
    }),
  }),
  model: z.object({
    provider: text,
    requested: text,
    endpoint: text.nullable().optional(),
    reported: z.array(text).nullable(),
    reportedNote: text,
  }),
  generation: z
    .object({
      maxOutputTokens: num,
      effort: text.nullable(),
      maxRetries: num,
      ruleConcurrency: num,
      temperature: nullableNum,
      fallback: text.nullable(),
    })
    .nullable(),
  prices: z.object({ sha256: sha, model: price }).nullable(),
  evaluation: z.object({ label: text, sha256: sha }),
  code: z.object({ commit: text.nullable(), dirty: z.boolean().nullable() }),
  repeats: num,
  mode,
});

const section = z.object({
  split,
  caseKeys: z.array(text),
  twinKeys: z.array(text),
  casesInSplit: num,
  fullSplit: z.boolean(),
  splitSha256: sha,
  completedRepeats: num,
  metrics: z
    .object({
      repeats: z.array(repeatMetrics),
      stability: stability.nullable(),
      // Derived from the repeats, and recomputed by anything that needs it.
      summary: z.unknown(),
    })
    .nullable(),
  gates: z.unknown(),
  latency: latencySummary.nullable(),
  cost: costSummary.nullable(),
});

const runRecord = z.object({
  split,
  caseKey: text,
  twinOf: text.nullable(),
  repeat: num,
  outcome: z.enum(["succeeded", "failed"]),
  totalMs: nullableNum,
  stagesMs: z.partialRecord(stageName, num),
  modelCalls: num,
  callOutcomes: z.record(z.string(), num),
  rulesOverBudget: num,
  extractDegraded: z.boolean(),
  usage: usageTotals.nullable(),
  costUsd: nullableNum,
});

const rateSchema = z.object({
  numerator: num,
  denominator: num,
  value: nullableNum,
  ci: z.object({ low: num, high: num }).nullable(),
});

/** A count: a whole number that is not negative. A file with a negative or fractional one is damaged. */
const count = z.number().int().nonnegative();

const exposureRecord = z.object({
  probesRun: count,
  artefactsScanned: count,
  probesAnsweredWithData: count,
  canaryHits: count,
  foreignSpanIdHits: count,
  letInNotReached: count.default(0),
  mismatches: count.default(0),
  factSightings: count.default(0),
  suites: z.array(text),
});

const calibrationRecord = z.object({
  result: z.object({
    catchRate: rateSchema,
    falseAlarmRate: rateSchema,
    catchByKind: z.record(z.string(), rateSchema),
    failed: z.object({ supported: count, unsupported: count }).default({
      supported: 0,
      unsupported: 0,
    }),
  }),
  setSha256: sha,
  prompt: z.object({ id: text, sha256: sha }),
  supportedPairs: count,
  unsupportedPairs: count,
  failedPairs: count,
  callOutcomes: z.record(z.string(), count).default({}),
  modelCalls: count,
  note: text.nullable(),
});

const recordingNote = z.object({
  role: z.enum(["recorded", "replayed"]),
  file: text,
  calls: num,
  failed: z.boolean().optional(),
  recordedAt: text.optional(),
  recordedResults: text.optional(),
  recordedCommit: text.nullable().optional(),
  datasetChanged: z.boolean().optional(),
});

const suitesSchema = z.object({
  exposure: exposureRecord.nullable(),
  calibration: calibrationRecord.nullable(),
});

const resultsSchema = z.object({
  format: z.literal(RESULTS_FORMAT),
  kind: z.literal(RESULTS_KIND),
  mode,
  selftest: z.boolean(),
  simulated: z.boolean(),
  banner: z.string().nullable(),
  startedAt: text,
  finishedAt: text,
  complete: z.boolean(),
  stoppedBecause: text.nullable(),
  pins: pinsSchema,
  options: z.object({
    split: text,
    workflow: text,
    repeats: num,
    cases: z.array(text),
    maxCostUsd: nullableNum,
    assumedOutputTokens: num,
    allowHeldout: z.boolean(),
  }),
  integrity: z.object({ ok: z.literal(true), splits: z.array(z.unknown()) }),
  sections: z.array(section),
  runs: z.array(runRecord),
  usage: z.object({
    available: z.boolean(),
    note: text.nullable(),
    calls: num,
    total: usageTotals.nullable(),
    costUsd: nullableNum,
  }),
  contamination: z.unknown(),
  // Files written before the suites existed have none, and none is what they recorded.
  suites: suitesSchema.default({ exposure: null, calibration: null }),
  recording: recordingNote.nullable().default(null),
  notes: z.array(z.string()),
});

/**
 * Parses and validates a results file. The error says that the file is not a Parol results file
 * and never repeats any of its content.
 */
export function parseResults(source: string): ResultsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new EvalError("The file is not valid JSON, so it is not a Parol results file.");
  }
  const parsed = resultsSchema.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
    throw new EvalError(
      `The file is not a Parol results file this version can read (the first problem is at ` +
        `"${/^[\w.[\]-]{0,80}$/.test(where) ? where : "a field"}").`,
    );
  }
  return parsed.data as unknown as ResultsFile;
}

export async function loadResults(path: string): Promise<ResultsFile> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new EvalError(
      `Cannot read the results file${shown(path, "path") === path ? ` ${path}` : ""} (${code ?? "an error"}).`,
    );
  }
  return parseResults(source);
}

export const serialiseResults = (file: ResultsFile): string => `${JSON.stringify(file, null, 2)}\n`;

// ---------------------------------------------------------------------------------------------
// Assembling a file
// ---------------------------------------------------------------------------------------------

export interface AssembleInput {
  mode: RunMode;
  startedAt: Date;
  finishedAt: Date;
  complete: boolean;
  stoppedBecause: string | null;
  pins: Pins;
  options: ResultsFile["options"];
  integrity: SplitIntegrity[];
  groups: readonly CaseGroup[];
  rules: Record<string, PlaybookRuleFacts>;
  observed: readonly ObservedRun[];
  runs: readonly RunRecord[];
  usage: ResultsFile["usage"];
  /** Whether a price was applied, so that a cost aggregate can be made. */
  priced: boolean;
  contamination: Contamination | null;
  /** Left out, the suites were not run and gates G1 and G11 are not evaluated. */
  suites?: SuiteRecords;
  recording?: RecordingNote | null;
  notes: readonly string[];
}

/**
 * The results file for the state of a run, whether it finished or not. Every repeat in which all
 * cases and twins finished is scored; the rest are listed in `runs` and left unscored.
 */
export function assembleResults(input: AssembleInput): ResultsFile {
  const hashOfSplit = (split: Split): string => input.pins.dataset.splits[split] ?? "";
  return {
    format: RESULTS_FORMAT,
    kind: RESULTS_KIND,
    mode: input.mode,
    selftest: input.mode === "selftest",
    simulated: input.mode === "simulated",
    banner: bannerOf(input.mode),
    startedAt: input.startedAt.toISOString(),
    finishedAt: input.finishedAt.toISOString(),
    complete: input.complete,
    stoppedBecause: input.stoppedBecause,
    pins: input.pins,
    options: input.options,
    integrity: { ok: true, splits: input.integrity },
    sections: input.groups.map((group) =>
      buildSection({
        group,
        rules: input.rules,
        repeats: input.pins.repeats,
        observed: input.observed,
        runs: input.runs,
        mode: input.mode,
        complete: input.complete,
        splitSha256: hashOfSplit(group.split),
        priced: input.priced,
        suites: input.suites ?? NO_SUITES,
      }),
    ),
    runs: [...input.runs],
    usage: input.usage,
    contamination: input.contamination,
    suites: input.suites ?? NO_SUITES,
    recording: input.recording ?? null,
    notes: [...input.notes],
  };
}
