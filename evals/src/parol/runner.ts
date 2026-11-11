/**
 * Runs the Parol stages over the cases of the evaluation dataset, the way the application's runner
 * does (apps/parol/src/services/runner.ts): ingest, extract, retrieve, then analyze and verify for
 * every rule, with the same stage functions, the same limits and the same treatment of a rule that
 * cannot be analysed.
 *
 * The composition below is copied from apps/parol/test/integration/pipeline.ts and trimmed to what
 * an evaluation needs, because code under src must not import test code. It leaves out what the
 * service adds around the stages (the store, the queue, resuming a run by input hash, progress for
 * the screens), none of which changes what the stages are shown or what is made of their answers.
 * `RULE_CONCURRENCY` is the service's value; a test pins the two together.
 *
 * Nothing here logs, stores or throws text from a document, a model or a provider.
 */
import type { AnthropicUsage, ObjectGenerator } from "@clausewise/llm";
import type {
  CallRecord,
  ContextBundle,
  DraftFinding,
  ExtractOutput,
  IngestDocumentInput,
  IngestOutput,
  RunManifest,
  VerifiedFinding,
} from "../../../apps/parol/src/contracts.js";
import { buildIngest } from "../../../apps/parol/src/ingest/ingest.js";
import { parseDocument } from "../../../apps/parol/src/ingest/parse.js";
import { documentTextSha256 } from "../../../apps/parol/src/ingest/text-hash.js";
import type {
  LoadedPlaybook,
  RegisteredWorkflow,
} from "../../../apps/parol/src/module-contracts.js";
import { getPrompt } from "../../../apps/parol/src/prompts/registry.js";
import {
  ProviderFailure,
  mapLimited,
  watchGenerator,
  type RunErrorKind,
} from "../../../apps/parol/src/services/run-support.js";
import { createSupportChecker } from "../../../apps/parol/src/services/support-checker.js";
import { runAnalyze } from "../../../apps/parol/src/stages/analyze.js";
import { runExtract } from "../../../apps/parol/src/stages/extract.js";
import { buildBundles } from "../../../apps/parol/src/stages/retrieve.js";
import { makeUndetermined, verifyFinding } from "../../../apps/parol/src/stages/verify.js";
import type {
  AnswerKeyCase,
  AnswerKeyTwin,
  KeyDocument,
  RuleExpectation,
  Split,
} from "../../../fixtures/parol/types.js";
import { emptyUsage, addUsage, type UsageTotals } from "../usage.js";
import type { Dataset } from "./dataset.js";
import { findAnchor } from "./anchors.js";
import { observeExtraction, observeSlot } from "./observe.js";
import type { ExtractionObservation, SlotObservation } from "./score.js";
import type { StageName } from "./timing.js";
import { textDigestOf, trailOf, type SlotTrail } from "./trails.js";

/** How many rules are analysed, and then verified, at once within one run. Equal to the service's. */
export const RULE_CONCURRENCY = 3;

/** A case or a twin, with the expectations that apply to it. A twin is judged by its original's key. */
export interface RunnableCase {
  /** `PAROL-D08`, or `PAROL-D08-twin`. */
  caseKey: string;
  split: Split;
  twinOf: string | null;
  intake: { clientLegalName: string };
  documents: KeyDocument[];
  expect: Record<string, RuleExpectation>;
}

export function runnableCases(args: {
  cases: readonly AnswerKeyCase[];
  twins: readonly AnswerKeyTwin[];
}): RunnableCase[] {
  const runnable: RunnableCase[] = [];
  for (const entry of args.cases) {
    runnable.push({
      caseKey: entry.case,
      split: entry.split,
      twinOf: null,
      intake: entry.intake,
      documents: entry.documents,
      expect: entry.expect,
    });
    // The twin runs straight after its original, so that a stopped run loses whole pairs.
    for (const twin of args.twins.filter((t) => t.twinOf === entry.case)) {
      runnable.push({
        caseKey: twin.case,
        split: twin.split,
        twinOf: entry.case,
        intake: twin.intake,
        documents: twin.documents,
        expect: entry.expect,
      });
    }
  }
  return runnable;
}

// ---------------------------------------------------------------------------------------------
// Usage and call counting
// ---------------------------------------------------------------------------------------------

/**
 * Counts the model calls and the token usage of the run in progress and of the whole evaluation.
 * Runs are sequential, so what the provider reports between `begin` and `take` belongs to the
 * run in between. A call that is retried by the provider's client reports once per response.
 */
export class Meter {
  readonly total: UsageTotals = emptyUsage();
  totalCalls = 0;
  /**
   * Models the provider named: in the `model` field of its responses (see reported-model.ts), and
   * in the attempts of a response that listed them (server-side fallback).
   */
  readonly reportedModels = new Set<string>();
  private current = { calls: 0, usage: emptyUsage() };

  begin(): void {
    this.current = { calls: 0, usage: emptyUsage() };
  }

  countCall(): void {
    this.current.calls += 1;
    this.totalCalls += 1;
  }

  /** A model the provider named in a response. Only plain model identifiers reach here. */
  noteModel(model: string): void {
    this.reportedModels.add(model);
  }

  onUsage(usage: AnthropicUsage): void {
    addUsage(this.current.usage, usage);
    addUsage(this.total, usage);
    for (const attempt of usage.attempts ?? []) {
      if (attempt.model !== undefined) this.reportedModels.add(attempt.model);
    }
  }

  take(): { calls: number; usage: UsageTotals } {
    return { calls: this.current.calls, usage: { ...this.current.usage } };
  }
}

// ---------------------------------------------------------------------------------------------
// One run: a case, or a twin, in one repeat
// ---------------------------------------------------------------------------------------------

export interface PreparedCase {
  runnable: RunnableCase;
  repeat: number;
  ingest: IngestOutput;
  manifest: Omit<RunManifest, "model">;
}

/** Parsed once per file: parsing is deterministic and the same bytes are read in every repeat. */
export type ParsedFiles = Map<string, Awaited<ReturnType<typeof parseDocument>>>;

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "_");

/**
 * Reads the case's operative documents as an upload would, ready for the ingest. The document
 * version ids are new for every repeat, so span ids differ between repeats as they do between
 * matters. The comparison page reads the passages of a key through this too, so that it shows the
 * paragraphs as a run reads them.
 */
export async function readCaseDocuments(args: {
  dataset: Dataset;
  runnable: RunnableCase;
  repeat: number;
  parsed: ParsedFiles;
}): Promise<IngestDocumentInput[]> {
  const { runnable, repeat } = args;
  const documents: IngestDocumentInput[] = [];
  for (const doc of runnable.documents) {
    // An earlier version that a later one replaces is not part of a run (document 5, D09 and H08).
    if (doc.operative === false) continue;
    let parsed = args.parsed.get(doc.file);
    if (parsed === undefined) {
      const bytes = args.dataset.files.get(doc.file);
      if (bytes === undefined) throw new Error(`${runnable.caseKey}: a case file is not loaded`);
      parsed = await parseDocument({
        bytes,
        mediaType: doc.file.endsWith(".docx") ? "docx" : "txt",
      });
      args.parsed.set(doc.file, parsed);
    }
    documents.push({
      documentVersionId: `dv_${slug(runnable.caseKey)}_${doc.label.toLowerCase()}_r${repeat}`,
      label: doc.label,
      kind: doc.kind,
      title: doc.title,
      versionNo: doc.versionNo,
      statedDate: doc.statedDate,
      paragraphs: parsed.paragraphs,
      inspection: parsed.inspection,
    });
  }
  return documents;
}

/** Reads the case's operative documents (see `readCaseDocuments`) and builds the ingest. */
export async function prepareCase(args: {
  dataset: Dataset;
  runnable: RunnableCase;
  repeat: number;
  playbook: LoadedPlaybook;
  workflow: RegisteredWorkflow;
  parsed: ParsedFiles;
}): Promise<PreparedCase> {
  const { runnable, repeat } = args;
  const documents = await readCaseDocuments(args);
  const ingest = buildIngest({ documents });
  return {
    runnable,
    repeat,
    ingest,
    manifest: {
      matterId: `mat_${slug(runnable.caseKey)}_r${repeat}`,
      clientLegalName: runnable.intake.clientLegalName,
      documents: documents.map((d) => ({
        documentVersionId: d.documentVersionId,
        label: d.label,
        kind: d.kind,
        title: d.title,
        versionNo: d.versionNo,
        statedDate: d.statedDate,
        textSha256: documentTextSha256(d.paragraphs),
      })),
      playbook: {
        versionId: "pbv_eval",
        slug: args.playbook.slug,
        version: args.playbook.version,
        sha256: args.playbook.sha256,
      },
      workflow: {
        versionId: "wfv_eval",
        label: args.workflow.manifest.label,
        sha256: args.workflow.sha256,
      },
    },
  };
}

type AnalysisOutcome =
  | { outcome: "draft"; draft: DraftFinding }
  | { outcome: "failed"; code: "output_invalid" | "context_over_budget"; detail: string };

export interface StageRun {
  extract: ExtractOutput;
  /** What retrieval built for each rule, in the order of `findings`: what the reader was shown. */
  bundles: ContextBundle[];
  findings: VerifiedFinding[];
  /** The analyze stage's answer per rule, or undefined where the rule could not be analysed. */
  drafts: (DraftFinding | undefined)[];
  calls: CallRecord[];
  rulesOverBudget: number;
  totalMs: number;
  stagesMs: Partial<Record<StageName, number>>;
}

export interface StageArgs {
  prepared: PreparedCase;
  playbook: LoadedPlaybook;
  workflow: RegisteredWorkflow;
  generator: ObjectGenerator;
  signal: AbortSignal;
  /** Milliseconds from any fixed origin. Injected so that timings can be tested. */
  clock?: () => number;
}

/** Thrown when the provider rejects the key, the model or the account, which every call would. */
export class EvaluationProviderFailure extends Error {
  override name = "EvaluationProviderFailure";
  constructor(readonly kind: RunErrorKind) {
    super("the model provider rejected the request");
  }
}

/**
 * extract, retrieve, then analyze and verify per rule. Model failures become recorded calls and
 * undetermined findings, as in the service. A fatal provider error, an abort and a bug end the
 * run by throwing.
 */
export async function runStages(args: StageArgs): Promise<StageRun> {
  const { prepared, playbook, workflow } = args;
  const clock = args.clock ?? (() => performance.now());
  const wm = workflow.manifest;
  const prompts = {
    extract: getPrompt(wm.prompts.extract),
    analyze: getPrompt(wm.prompts.analyze),
    support: wm.prompts.support === null ? null : getPrompt(wm.prompts.support),
  };
  const supportChecker =
    prompts.support === null ? undefined : createSupportChecker(prompts.support);
  const manifest: RunManifest = {
    ...prepared.manifest,
    model: { provider: args.generator.provider, model: args.generator.model },
  };
  const { ingest } = prepared;

  // One controller per run, so that a unit that fails for its own reasons stops its siblings
  // without stopping the evaluation.
  const controller = new AbortController();
  const relay = (): void => controller.abort(args.signal.reason);
  if (args.signal.aborted) relay();
  else args.signal.addEventListener("abort", relay, { once: true });
  const signal = controller.signal;

  let fatal: RunErrorKind | null = null;
  const generator = watchGenerator(args.generator, (kind) => {
    fatal ??= kind;
  });
  const calls: CallRecord[] = [];
  const stagesMs: Partial<Record<StageName, number>> = {};
  const started = clock();
  let mark = started;
  const lap = (stage: StageName): void => {
    const now = clock();
    stagesMs[stage] = Math.max(0, now - mark);
    mark = now;
  };
  const refuseIfFatal = (record: readonly CallRecord[]): void => {
    if (fatal !== null && record.some((c) => c.outcome === "fatal")) {
      throw new EvaluationProviderFailure(fatal);
    }
  };
  const onFail = (error: unknown): void => {
    if (error instanceof ProviderFailure || error instanceof EvaluationProviderFailure) return;
    controller.abort(error);
  };

  try {
    // Reading the documents (prepareCase) is not timed: the application reads spans that were
    // stored at upload, so parsing is not part of the time between queued and succeeded.
    mark = clock();
    const extracted = await runExtract({
      generator,
      ingest,
      manifest,
      prompt: prompts.extract,
      signal,
    });
    calls.push(...extracted.calls);
    refuseIfFatal(extracted.calls);
    signal.throwIfAborted();
    lap("extract");

    const bundles = buildBundles({
      ingest,
      extract: extracted.output,
      rules: playbook.rules,
      policy: wm.retrieval,
      budgetTokens: wm.budgetTokens,
    });
    lap("retrieve");

    const warmUp = generator.cachesSharedPrefix === true;
    const analyses = await mapLimited(
      bundles,
      RULE_CONCURRENCY,
      async (bundle): Promise<AnalysisOutcome> => {
        if (bundle.overBudget) {
          // Nothing is truncated and nothing is sent: the rule is undetermined, and says why.
          return {
            outcome: "failed",
            code: "context_over_budget",
            detail: `context_over_budget: about ${bundle.estimatedTokens} tokens against a budget of ${bundle.budgetTokens}`,
          };
        }
        const result = await runAnalyze({
          generator,
          bundle,
          ingest,
          manifest,
          prompt: prompts.analyze,
          repairAttempts: wm.repairAttempts,
          signal,
        });
        calls.push(...result.calls);
        refuseIfFatal(result.calls);
        signal.throwIfAborted();
        return result.ok
          ? { outcome: "draft", draft: result.draft }
          : { outcome: "failed", code: "output_invalid", detail: result.detail };
      },
      { warmUp, onFail },
    );
    lap("analyze");

    const findings = await mapLimited(
      bundles,
      RULE_CONCURRENCY,
      async (bundle, index): Promise<VerifiedFinding> => {
        const analysis = analyses[index] as AnalysisOutcome;
        if (analysis.outcome === "failed") {
          return makeUndetermined({
            rule: bundle.rule,
            code: analysis.code,
            detail: analysis.detail,
          });
        }
        const result = await verifyFinding({
          draft: analysis.draft,
          bundle,
          rule: bundle.rule,
          ingest,
          manifest,
          enabledChecks: wm.checks,
          ...(supportChecker === undefined ? {} : { supportChecker }),
          generator,
          signal,
        });
        calls.push(...result.calls);
        refuseIfFatal(result.calls);
        signal.throwIfAborted();
        return result.finding;
      },
      { warmUp: false, onFail },
    );
    lap("verify");

    return {
      extract: extracted.output,
      bundles,
      findings,
      drafts: analyses.map((a) => (a.outcome === "draft" ? a.draft : undefined)),
      calls,
      rulesOverBudget: bundles.filter((b) => b.overBudget).length,
      totalMs: Math.max(0, clock() - started),
      stagesMs,
    };
  } finally {
    args.signal.removeEventListener("abort", relay);
  }
}

// ---------------------------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------------------------

export function observeRun(
  prepared: PreparedCase,
  run: StageRun,
): {
  slots: SlotObservation[];
  extraction: ExtractionObservation;
  /** One per rule slot, in the order of `run.findings`. Ids, offsets and codes; no text. */
  trails: SlotTrail[];
  /** Names the text of the case's documents that the trails' paragraph indexes point into. */
  textDigest: string;
} {
  const { caseKey, split } = prepared.runnable;
  // Bundles are looked up by rule, so a trail never describes another rule's retrieval.
  const bundleOf = new Map(run.bundles.map((bundle) => [bundle.ruleKey, bundle]));
  return {
    slots: run.findings.map((finding, index) =>
      observeSlot({
        caseKey,
        repeat: prepared.repeat,
        finding,
        draft: run.drafts[index],
        spans: prepared.ingest.spans,
      }),
    ),
    extraction: observeExtraction({ caseKey, repeat: prepared.repeat, extract: run.extract }),
    trails: run.findings.map((finding) =>
      trailOf({
        split,
        caseKey,
        repeat: prepared.repeat,
        finding,
        bundle: bundleOf.get(finding.ruleKey),
        spans: prepared.ingest.spans,
      }),
    ),
    textDigest: textDigestOf(prepared.manifest.documents),
  };
}

/** What happened to the calls of a run, by outcome. Counts only. */
export function countOutcomes(calls: readonly CallRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) counts[call.outcome] = (counts[call.outcome] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// ---------------------------------------------------------------------------------------------
// The key against the ingested documents
// ---------------------------------------------------------------------------------------------

/**
 * Every anchor of the key that does not resolve to exactly one span of the run, named by case,
 * rule, role and position. The builder checked this against the text it generated; this checks it
 * against the documents as this version of the parser and ingest read them, before a model is
 * paid for a run that scoring would then refuse. Messages never repeat the anchor.
 */
export function anchorProblems(prepared: PreparedCase, runnable: RunnableCase): string[] {
  const problems: string[] = [];
  for (const [ruleKey, expectation] of Object.entries(runnable.expect)) {
    for (const role of ["governing", "superseded", "relevant"] as const) {
      expectation[role].forEach((ref, index) => {
        const found = findAnchor(prepared.ingest.spans, ref);
        if (found.ok) return;
        problems.push(
          `${runnable.caseKey} ${ruleKey} ${role} anchor ${index + 1} (${ref.doc}, ${ref.clause === null ? "no clause" : `clause ${ref.clause}`}): ` +
            (found.reason === "ambiguous"
              ? `it occurs ${found.occurrences} times, expected once`
              : found.reason === "not_found"
                ? "it occurs 0 times, expected once"
                : found.reason === "no_clause"
                  ? "the run has no span there"
                  : "the run has no such document"),
        );
      });
    }
  }
  return problems;
}
