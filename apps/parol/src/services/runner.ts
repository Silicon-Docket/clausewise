import { hashOf } from "../canonical.js";
import type {
  CallRecord,
  DraftFinding,
  ExtractOutput,
  IngestOutput,
  PlaybookRuleRecord,
  RunStatus,
  VerifiedFinding,
} from "../contracts.js";
import { getPrompt } from "../prompts/registry.js";
import { runAnalyze } from "../stages/analyze.js";
import { runExtract } from "../stages/extract.js";
import { buildBundles } from "../stages/retrieve.js";
import { makeUndetermined, verifyFinding } from "../stages/verify.js";
import {
  ConflictError,
  NotFoundError,
  StaleRunError,
  StoreError,
  isActiveRunStatus,
  toSourceSpans,
  type RunRow,
  type StoredRule,
} from "../store/index.js";
import { DEFAULT_MAX_CONCURRENT_RUNS, type ServiceDeps } from "./deps.js";
import {
  ProviderFailure,
  RunStopped,
  mapLimited,
  watchGenerator,
  type RunErrorKind,
  type StopReason,
} from "./run-support.js";
import { createSupportChecker } from "./support-checker.js";
import type { RunProgress } from "./views.js";

/** How many rules are analysed, and then verified, at once within one run. */
export const RULE_CONCURRENCY = 3;

/** What analyze made of one rule, kept as the stage's output so a resumed run does not repeat it. */
type AnalysisOutcome =
  | { outcome: "draft"; draft: DraftFinding }
  | { outcome: "failed"; code: "output_invalid" | "context_over_budget"; detail: string };

interface Job {
  matterId: string;
  runId: string;
  controller: AbortController;
  /** Why the run is being stopped from outside (a cancel, a changed document). */
  stopReason: StopReason | null;
  /** Set by the watched generator when the provider rejects the key, the model or the account. */
  fatal: RunErrorKind | null;
}

/** A rule as the stages read it: the playbook's fields, without the store's ids. */
const plainRule = (rule: StoredRule): PlaybookRuleRecord => ({
  key: rule.key,
  category: rule.category,
  title: rule.title,
  severity: rule.severity,
  required: rule.required,
  kind: rule.kind,
  standard: rule.standard,
  fallback: rule.fallback,
  unacceptable: rule.unacceptable,
  guidance: rule.guidance,
  fallbackLanguage: rule.fallbackLanguage,
  escalateWhen: rule.escalateWhen,
  // The topics of keyword hint that matter to the rule. Dropping them makes every hint of the
  // category count for every rule, which is the defect topics remove (see hint-topics-runner.test).
  ...(rule.hintTopics === undefined ? {} : { hintTopics: rule.hintTopics }),
});

const isAbort = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  (error as { name: unknown }).name === "AbortError";

/**
 * A write the store refused because the run is over: its inputs changed (`StaleRunError`) or it is
 * no longer in flight. Both mean "stop quietly", and neither is a failure of the run.
 */
function stoppedFrom(error: unknown): RunStopped | undefined {
  if (error instanceof RunStopped) return error;
  if (error instanceof StaleRunError) return new RunStopped("superseded");
  if (error instanceof ConflictError && error.code === "run_not_active")
    return new RunStopped("ended");
  // The matter or the run is gone (deleted while the run was waiting). Another missing row is a bug.
  if (error instanceof NotFoundError && (error.entity === "run" || error.entity === "matter"))
    return new RunStopped("ended");
  return undefined;
}

/**
 * The in-process runner: a bounded queue of runs, and the stage graph each one walks (ingest,
 * extract, retrieve, then analyze and verify per rule).
 *
 * Every write is checked against the run's state first, in the same synchronous step as the write
 * (the store is synchronous, so nothing can change between the check and the write). A document
 * can change at any moment, so "is the run still mine" is asked at every write and not once at the
 * start. A run whose inputs changed, or that was cancelled, stops quietly and writes nothing more.
 *
 * Nothing here logs, stores or throws text from a document, a model or a provider. Log lines are
 * ids, stage names and closed codes.
 */
export function createRunEngine(deps: ServiceDeps) {
  const { repo } = deps;
  const maxConcurrent = deps.config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1)
    throw new RangeError("maxConcurrentRuns must be a whole number of at least 1");

  const all = new Set<Job>();
  const byRun = new Map<string, Job>();
  const pending: Job[] = [];
  const progress = new Map<string, RunProgress>();
  let running = 0;
  let pumpScheduled = false;
  let idleWaiters: (() => void)[] = [];

  const settleIdle = (): void => {
    if (all.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  // --- the queue ------------------------------------------------------------------------------

  function enqueue(matterId: string, runId: string): void {
    const job: Job = {
      matterId,
      runId,
      controller: new AbortController(),
      stopReason: null,
      fatal: null,
    };
    all.add(job);
    byRun.set(runId, job);
    pending.push(job);
    // The caller gets its answer (status `queued`) before the run moves.
    if (!pumpScheduled) {
      pumpScheduled = true;
      queueMicrotask(() => {
        pumpScheduled = false;
        pump();
      });
    }
  }

  function pump(): void {
    while (running < maxConcurrent && pending.length > 0) {
      const job = pending.shift() as Job;
      running += 1;
      void runJob(job).finally(() => {
        running -= 1;
        all.delete(job);
        if (byRun.get(job.runId) === job) {
          byRun.delete(job.runId);
          progress.delete(job.runId);
        }
        settleIdle();
        pump();
      });
    }
  }

  /**
   * Stops the work of a run in this process. The status in the store is the caller's to set: a
   * cancel sets `cancelled` first, and a changed document has already set `superseded`.
   */
  function stop(runId: string, reason: StopReason): void {
    const job = byRun.get(runId);
    if (job === undefined) return;
    job.stopReason ??= reason;
    const queued = pending.indexOf(job);
    if (queued >= 0) {
      pending.splice(queued, 1);
      all.delete(job);
      byRun.delete(runId);
      settleIdle();
      return;
    }
    job.controller.abort(new RunStopped(reason));
  }

  /** After an input changed: stops this matter's run if the store has superseded it. */
  function supersedeMatter(matterId: string): void {
    for (const job of [...all]) {
      if (job.matterId !== matterId) continue;
      if (repo.getRun(matterId, job.runId)?.status === "superseded") stop(job.runId, "superseded");
    }
  }

  function idle(): Promise<void> {
    if (all.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  // --- one run --------------------------------------------------------------------------------

  async function runJob(job: Job): Promise<void> {
    const say = (event: string): void =>
      deps.log(`run ${job.runId} (matter ${job.matterId}): ${event}`);
    try {
      const run = repo.getRun(job.matterId, job.runId);
      if (run === undefined || run.status !== "queued") {
        say("not started, it is no longer queued");
        return;
      }
      await execute(job, run, say);
      say("succeeded");
    } catch (error) {
      try {
        end(job, error, say);
      } catch (inner) {
        // Settling the run's end failed too. Nothing here may escape as an unhandled rejection.
        say(`could not be settled (${inner instanceof Error ? inner.name : "unknown error"})`);
      }
    }
  }

  /** Settles what a run's end means, from the store's state and the reason it stopped. */
  function end(job: Job, error: unknown, say: (event: string) => void): void {
    if (job.fatal !== null) return markFailed(job, job.fatal, say);
    const stopped = stoppedFrom(error);
    if (stopped !== undefined && stopped.reason !== "failed") {
      const reason =
        stopped.reason === "ended" && job.stopReason !== null ? job.stopReason : stopped.reason;
      if (reason === "cancelled") markCancelled(job, say);
      else say(`stopped quietly (${reason})`);
      return;
    }
    if (isAbort(error) && job.stopReason !== null) {
      if (job.stopReason === "cancelled") markCancelled(job, say);
      else say(`stopped quietly (${job.stopReason})`);
      return;
    }
    // Only the kind of the error is logged: a message can carry what the stage was reading.
    const code = error instanceof StoreError ? ` ${error.code}` : "";
    const name = error instanceof Error ? error.name : "unknown error";
    say(`failed, internal (${name}${code})`);
    markFailed(job, "internal", say);
  }

  function markFailed(job: Job, kind: RunErrorKind, say: (event: string) => void): void {
    try {
      repo.updateRunStatus(job.matterId, job.runId, "failed", { errorKind: kind, actorId: null });
      say(`failed (${kind})`);
    } catch (error) {
      // The run ended some other way while it was failing (cancelled, or its inputs changed).
      if (stoppedFrom(error) === undefined && !(error instanceof StoreError)) throw error;
      say(`could not be marked failed (${kind}), it had already ended`);
    }
  }

  function markCancelled(job: Job, say: (event: string) => void): void {
    try {
      const current = repo.getRun(job.matterId, job.runId);
      if (current !== undefined && isActiveRunStatus(current.status))
        repo.updateRunStatus(job.matterId, job.runId, "cancelled", { actorId: null });
      say("cancelled");
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      say("cancelled (already ended)");
    }
  }

  async function execute(job: Job, start: RunRow, say: (event: string) => void): Promise<void> {
    const { matterId, runId } = job;
    const signal = job.controller.signal;
    const generator = watchGenerator(deps.generator, (kind) => {
      // Noted only. The stages turn the error into a recorded call and return, and the unit that
      // met it stops the run once that record is saved; aborting here would drop the record.
      job.fatal ??= kind;
    });

    const workflow = repo.getWorkflowVersion(start.workflowVersionId);
    if (workflow === undefined) throw new NotFoundError("workflow version");
    const wm = workflow.manifest;
    const prompts = {
      extract: getPrompt(wm.prompts.extract),
      analyze: getPrompt(wm.prompts.analyze),
      support: wm.prompts.support === null ? null : getPrompt(wm.prompts.support),
    };
    const supportChecker =
      prompts.support === null
        ? undefined
        : (deps.supportChecker ?? createSupportChecker(prompts.support));
    const rules = repo.listRules(start.playbookVersionId).map(plainRule);
    const manifest = start.manifest;
    const manifestSha256 = start.inputManifestSha256;

    // --- guards and writes ---

    /** The run as the store has it, or a stop. Called immediately before every write. */
    const live = (): RunRow => {
      const current = repo.getRun(matterId, runId);
      if (current === undefined) throw new RunStopped("ended");
      if (current.status === "superseded") throw new RunStopped("superseded");
      if (!isActiveRunStatus(current.status))
        throw new RunStopped(job.stopReason === "cancelled" ? "cancelled" : "ended");
      return current;
    };
    const commit = <T>(write: () => T): T => {
      live();
      try {
        return repo.transaction(write);
      } catch (error) {
        throw stoppedFrom(error) ?? error;
      }
    };
    const advance = (to: RunStatus): void => {
      commit(() => repo.updateRunStatus(matterId, runId, to, { actorId: null }));
    };
    const setProgress = (stage: RunProgress["stage"], done: number, total: number): void => {
      progress.set(runId, { stage, done, total });
    };
    const reusable = (stage: string, unit: string, inputSha256: string) =>
      repo.findReusableStage(matterId, runId, stage, unit, inputSha256);
    const begin = (stage: string, unit: string, inputSha256: string) =>
      commit(() => repo.recordStageStart(matterId, runId, { stage, unit, inputSha256 }));
    /** Calls and the unit's result are written together, so a unit is never half recorded. */
    const finishUnit = (
      stage: string,
      unit: string,
      attempt: number,
      calls: readonly CallRecord[],
      result:
        { status: "succeeded"; output: unknown } | { status: "failed"; errorKind: RunErrorKind },
    ): void => {
      commit(() => {
        if (calls.length > 0) repo.insertModelCalls(matterId, runId, calls);
        repo.recordStageResult(matterId, runId, {
          stage,
          unit,
          attempt,
          status: result.status,
          ...(result.status === "succeeded"
            ? { output: result.output }
            : { errorKind: result.errorKind }),
        });
      });
    };
    /**
     * A stage call that gives up the moment the run is stopped. A provider that ignores the abort
     * signal would otherwise hold a queue slot, and a cancel would not free it, until its reply
     * came. The call is left to finish on its own; nothing is waiting for it.
     */
    const abortable = async <T>(work: Promise<T>): Promise<T> => {
      if (signal.aborted) {
        work.catch(() => undefined);
        throw signal.reason;
      }
      let onAbort: (() => void) | undefined;
      const stopped = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([work, stopped]);
      } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      }
    };
    /**
     * Once the run is being stopped from outside, or because a unit failed for its own reasons,
     * whatever a unit got back is not an answer to keep: a sibling that was cut short may look like
     * a failed answer, and saved as one it would never be asked again. A provider's refusal is not
     * such a stop (see `onFail`): the units already being answered finish, and their answers are
     * real and paid for.
     */
    const stillMine = (): void => {
      signal.throwIfAborted();
    };
    const onFail = (error: unknown): void => {
      // A provider's refusal starts nothing new (`mapLimited` stops handing out units) but does not
      // cut short the units already in flight: their calls are made and paid for, and a completed
      // unit is kept, with its calls on record, so that a resume does not pay for it twice. A unit
      // that fails for its own reasons stops the others from spending. A stop that came from
      // outside has aborted the signal already.
      if (error instanceof RunStopped || error instanceof ProviderFailure) return;
      job.controller.abort(new RunStopped("failed"));
    };

    // --- ingest: read back what the upload stored; nothing is parsed again ---
    advance("ingesting");
    setProgress("ingest", 0, 1);
    const versionIds = manifest.documents.map((d) => d.documentVersionId);
    const ingest: IngestOutput = {
      spans: toSourceSpans(repo.listSpans(matterId, versionIds)),
      annotations: repo.listAnnotations(matterId, versionIds),
      warnings: [],
    };
    if (ingest.spans.length === 0) throw new Error("the run's documents have no stored spans");
    const ingestInput = hashOf({ stage: "ingest", manifest: manifestSha256 });
    if (reusable("ingest", "*", ingestInput) === undefined) {
      const started = begin("ingest", "*", ingestInput);
      finishUnit("ingest", "*", started.attempt, [], {
        status: "succeeded",
        output: { spans: ingest.spans.length, annotations: ingest.annotations.length },
      });
    }
    setProgress("ingest", 1, 1);

    // --- extract ---
    advance("extracting");
    setProgress("extract", 0, 1);
    const extractInput = hashOf({
      stage: "extract",
      manifest: manifestSha256,
      prompt: prompts.extract.sha256,
    });
    let extract: ExtractOutput;
    const savedExtract = reusable("extract", "*", extractInput);
    if (savedExtract !== undefined) {
      extract = savedExtract.output as ExtractOutput;
    } else {
      const started = begin("extract", "*", extractInput);
      const result = await abortable(
        runExtract({ generator, ingest, manifest, prompt: prompts.extract, signal }),
      );
      extract = result.output;
      const fatalCall = result.calls.some((c) => c.outcome === "fatal");
      if (fatalCall && job.fatal !== null) {
        finishUnit("extract", "*", started.attempt, result.calls, {
          status: "failed",
          errorKind: job.fatal,
        });
        throw new ProviderFailure(job.fatal);
      }
      stillMine();
      finishUnit("extract", "*", started.attempt, result.calls, {
        status: "succeeded",
        output: extract,
      });
    }
    setProgress("extract", 1, 1);

    // --- retrieve ---
    advance("retrieving");
    setProgress("retrieve", 0, 1);
    const bundles = buildBundles({
      ingest,
      extract,
      rules,
      policy: wm.retrieval,
      budgetTokens: wm.budgetTokens,
    });
    const retrieveInput = hashOf({
      stage: "retrieve",
      manifest: manifestSha256,
      extract: hashOf(extract),
      policy: wm.retrieval,
      budget: wm.budgetTokens,
    });
    if (reusable("retrieve", "*", retrieveInput) === undefined) {
      const started = begin("retrieve", "*", retrieveInput);
      finishUnit("retrieve", "*", started.attempt, [], {
        status: "succeeded",
        output: {
          bundles: bundles.map((b) => ({
            ruleKey: b.ruleKey,
            spans: b.spans.length,
            estimatedTokens: b.estimatedTokens,
            overBudget: b.overBudget,
            fullDocument: b.fullDocument,
          })),
        },
      });
    }
    setProgress("retrieve", 1, 1);

    const warmUp = generator.cachesSharedPrefix === true;

    // --- analyze: one model answer per rule, at most RULE_CONCURRENCY at a time ---
    advance("analyzing");
    let analysed = 0;
    setProgress("analyze", 0, bundles.length);
    const analyses = await mapLimited(
      bundles,
      RULE_CONCURRENCY,
      async (bundle): Promise<AnalysisOutcome> => {
        const input = hashOf({
          stage: "analyze",
          manifest: manifestSha256,
          prompt: prompts.analyze.sha256,
          repairAttempts: wm.repairAttempts,
          bundle: hashOf(bundle),
        });
        const saved = reusable("analyze", bundle.ruleKey, input);
        if (saved !== undefined) {
          setProgress("analyze", ++analysed, bundles.length);
          return saved.output as AnalysisOutcome;
        }
        const started = begin("analyze", bundle.ruleKey, input);
        let outcome: AnalysisOutcome;
        let calls: CallRecord[] = [];
        if (bundle.overBudget) {
          // Nothing is truncated and nothing is sent: the rule is undetermined, and says why.
          outcome = {
            outcome: "failed",
            code: "context_over_budget",
            detail: `context_over_budget: about ${bundle.estimatedTokens} tokens against a budget of ${bundle.budgetTokens}`,
          };
        } else {
          const result = await abortable(
            runAnalyze({
              generator,
              bundle,
              ingest,
              manifest,
              prompt: prompts.analyze,
              repairAttempts: wm.repairAttempts,
              signal,
            }),
          );
          calls = result.calls;
          if (result.calls.some((c) => c.outcome === "fatal") && job.fatal !== null) {
            // The provider rejected the request itself. This unit is not an answer, so it is not
            // saved as one, and a resumed run asks again.
            finishUnit("analyze", bundle.ruleKey, started.attempt, calls, {
              status: "failed",
              errorKind: job.fatal,
            });
            throw new ProviderFailure(job.fatal);
          }
          outcome = result.ok
            ? { outcome: "draft", draft: result.draft }
            : { outcome: "failed", code: "output_invalid", detail: result.detail };
        }
        stillMine();
        finishUnit("analyze", bundle.ruleKey, started.attempt, calls, {
          status: "succeeded",
          output: outcome,
        });
        setProgress("analyze", ++analysed, bundles.length);
        return outcome;
      },
      { warmUp, onFail },
    );

    // --- verify: checks over each draft, and the support check when the workflow has one ---
    advance("verifying");
    let verified = 0;
    setProgress("verify", 0, bundles.length);
    const findings = await mapLimited(
      bundles,
      RULE_CONCURRENCY,
      async (bundle, index): Promise<VerifiedFinding> => {
        const analysis = analyses[index] as AnalysisOutcome;
        const input = hashOf({
          stage: "verify",
          manifest: manifestSha256,
          analysis: hashOf(analysis),
          bundle: hashOf(bundle),
          checks: wm.checks,
          support: prompts.support?.sha256 ?? null,
        });
        const saved = reusable("verify", bundle.ruleKey, input);
        if (saved !== undefined) {
          setProgress("verify", ++verified, bundles.length);
          return saved.output as VerifiedFinding;
        }
        const started = begin("verify", bundle.ruleKey, input);
        let finding: VerifiedFinding;
        let calls: CallRecord[] = [];
        if (analysis.outcome === "failed") {
          finding = makeUndetermined({
            rule: bundle.rule,
            code: analysis.code,
            detail: analysis.detail,
          });
        } else {
          const result = await abortable(
            verifyFinding({
              draft: analysis.draft,
              bundle,
              rule: bundle.rule,
              ingest,
              manifest,
              enabledChecks: wm.checks,
              ...(supportChecker === undefined ? {} : { supportChecker }),
              generator,
              signal,
            }),
          );
          finding = result.finding;
          calls = result.calls;
          if (calls.some((c) => c.outcome === "fatal") && job.fatal !== null) {
            finishUnit("verify", bundle.ruleKey, started.attempt, calls, {
              status: "failed",
              errorKind: job.fatal,
            });
            throw new ProviderFailure(job.fatal);
          }
        }
        stillMine();
        finishUnit("verify", bundle.ruleKey, started.attempt, calls, {
          status: "succeeded",
          output: finding,
        });
        setProgress("verify", ++verified, bundles.length);
        return finding;
      },
      { warmUp: false, onFail },
    );

    // --- save: the findings and the end of the run together, or neither ---
    commit(() => {
      repo.saveFindings(matterId, runId, findings, { actorId: start.startedBy });
      repo.updateRunStatus(matterId, runId, "succeeded", { actorId: null });
    });
    say(`saved ${findings.length} findings`);
  }

  return {
    enqueue,
    stop,
    supersedeMatter,
    idle,
    progressOf: (runId: string): RunProgress | undefined => progress.get(runId),
  };
}

export type RunEngine = ReturnType<typeof createRunEngine>;
