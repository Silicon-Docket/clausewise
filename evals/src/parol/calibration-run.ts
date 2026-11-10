/**
 * Runs the support checker's calibration set (fixtures/parol/calibration.json, forty pairs, twenty
 * of each label) through the model of the run, for gate G11.
 *
 * A pair is a claim a finding makes and the one passage it cites. The checker is shown exactly what
 * it is shown in a review: the rule, the claimed status, the discrepancy and the cited paragraph,
 * and nothing else (apps/parol/src/services/support-checker.ts). The author's label says whether
 * the passage backs the claim. The checker catches an unsupported pair when it answers
 * `not_supported` or `insufficient`, and raises a false alarm on a supported pair when it answers
 * anything but `supported`.
 *
 * This measures the checker, and nothing else about the workflow. It is run once per evaluation
 * run, not once per repeat: the pairs are fixed, so repeating them measures the model's noise on
 * forty requests and not anything about the data. With a recording (see replay.ts) the answers are
 * recorded and replayed like any other.
 *
 * Nothing here logs or throws text from a document or a model.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectGenerator } from "@clausewise/llm";
import { canonicalJson, sha256Hex } from "../../../apps/parol/src/canonical.js";
import type {
  DraftFinding,
  PlaybookRuleRecord,
  SourceSpan,
} from "../../../apps/parol/src/contracts.js";
import type {
  LoadedPlaybook,
  RegisteredPrompt,
  RegisteredWorkflow,
} from "../../../apps/parol/src/module-contracts.js";
import {
  ProviderFailure,
  mapLimited,
  watchGenerator,
  type RunErrorKind,
} from "../../../apps/parol/src/services/run-support.js";
import { createSupportChecker } from "../../../apps/parol/src/services/support-checker.js";
import type { CalibrationFile, CalibrationKeyPair } from "../../../fixtures/parol/types.js";
import { findAnchor } from "./anchors.js";
import type { Dataset } from "./dataset.js";
import type { CalibrationRecord } from "./results.js";
import {
  EvaluationProviderFailure,
  RULE_CONCURRENCY,
  prepareCase,
  runnableCases,
  type ParsedFiles,
  type PreparedCase,
} from "./runner.js";
import { scoreCalibration, type CalibrationPair, type CheckerVerdict } from "./suites.js";

/** Where the set is, under the repository root. */
export const CALIBRATION_FILE = join("fixtures", "parol", "calibration.json");

export interface CalibrationSet {
  file: CalibrationFile;
  /** SHA-256 of the file as canonical JSON, which splits.json records and this load checked. */
  sha256: string;
}

export type CalibrationLoad =
  | { ok: true; set: CalibrationSet }
  /** The dataset has no calibration set: splits.json records none. */
  | { ok: false; reason: "absent" }
  /** It has one that does not agree with what splits.json records, or cannot be read. */
  | { ok: false; reason: "integrity"; problems: string[] };

/**
 * Reads the calibration set and checks it against what splits.json records for it: the hash of the
 * file, the counts, and the playbook it was written for. A set that was edited after it was
 * recorded is not the set the gate's threshold was written for.
 */
export async function loadCalibrationSet(dataset: Dataset): Promise<CalibrationLoad> {
  const entry = dataset.splits.calibration;
  if (entry === undefined) return { ok: false, reason: "absent" };
  const problems: string[] = [];
  let file: CalibrationFile | undefined;
  try {
    file = JSON.parse(
      await readFile(join(dataset.root, CALIBRATION_FILE), "utf8"),
    ) as CalibrationFile;
  } catch {
    problems.push(
      "calibration.json cannot be read, although splits.json records a calibration set",
    );
  }
  if (file === undefined) return { ok: false, reason: "integrity", problems };
  const sha256 = sha256Hex(canonicalJson(file));
  if (sha256 !== entry.sha256) {
    problems.push(
      `calibration.json hashes to ${sha256.slice(0, 12)} and splits.json records ${entry.sha256.slice(0, 12)}`,
    );
  }
  if (file.pairs.length !== entry.pairs) {
    problems.push(
      `calibration.json holds ${file.pairs.length} pairs and splits.json records ${entry.pairs}`,
    );
  }
  if (file.playbook.sha256 !== dataset.keys.playbook.sha256) {
    problems.push("the calibration set was written for another version of the playbook");
  }
  return problems.length > 0
    ? { ok: false, reason: "integrity", problems }
    : { ok: true, set: { file, sha256 } };
}

// ---------------------------------------------------------------------------------------------
// Preparing the pairs
// ---------------------------------------------------------------------------------------------

export interface PreparedPair {
  pair: CalibrationKeyPair;
  rule: PlaybookRuleRecord;
  draft: DraftFinding;
  /** The paragraph the claim cites, as the run reads the document. */
  span: SourceSpan;
  /** The case the pair was built from, as the run reads it. */
  prepared: PreparedCase;
}

/** A pair that does not resolve in the documents as this version of the code reads them. */
export class CalibrationSetError extends Error {
  override name = "CalibrationSetError";
}

/**
 * Reads the case of each pair as an upload would and finds the cited paragraph in it, the way an
 * answer key's anchor is found. A pair whose quote is not in exactly one paragraph of its clause
 * fails loudly; it is not scored as a miss. Messages name the pair and the case and never quote.
 */
export async function prepareCalibration(args: {
  set: CalibrationSet;
  dataset: Dataset;
  playbook: LoadedPlaybook;
  workflow: RegisteredWorkflow;
}): Promise<PreparedPair[]> {
  const { set, dataset, playbook, workflow } = args;
  const parsed: ParsedFiles = new Map();
  const caseOf = new Map<string, PreparedCase>();
  const prepared: PreparedPair[] = [];
  for (const pair of set.file.pairs) {
    let ready = caseOf.get(pair.case);
    if (ready === undefined) {
      const entry = dataset.keys.cases.find((c) => c.case === pair.case);
      if (entry === undefined) {
        throw new CalibrationSetError(
          `calibration pair ${pair.id}: the case ${pair.case} is not in the answer keys`,
        );
      }
      const [runnable] = runnableCases({ cases: [entry], twins: [] });
      ready = await prepareCase({
        dataset,
        runnable: runnable!,
        repeat: 1,
        playbook,
        workflow,
        parsed,
      });
      caseOf.set(pair.case, ready);
    }
    const found = findAnchor(ready.ingest.spans, {
      doc: pair.evidence.doc,
      clause: pair.evidence.clause,
      anchor: pair.evidence.quote,
    });
    if (!found.ok) {
      throw new CalibrationSetError(
        `calibration pair ${pair.id} (${pair.case}): its quote does not resolve to one paragraph (${found.reason.replace("_", " ")}, ${found.occurrences} occurrences)`,
      );
    }
    const rule = playbook.rules.find((r) => r.key === pair.rule);
    if (rule === undefined) {
      throw new CalibrationSetError(
        `calibration pair ${pair.id}: the rule ${pair.rule} is not in the playbook`,
      );
    }
    prepared.push({
      pair,
      rule,
      span: found.span,
      prepared: ready,
      draft: {
        ruleKey: rule.key,
        status: pair.claim.status,
        evidence: [{ spanId: found.span.id, quote: pair.evidence.quote, role: "governing" }],
        discrepancy: pair.claim.discrepancy,
        explanation: pair.claim.explanation,
        fallbackLanguage: null,
        escalateWhenMatched: [],
        conflict: null,
        abstainReason: null,
      },
    });
  }
  return prepared;
}

// ---------------------------------------------------------------------------------------------
// Running them
// ---------------------------------------------------------------------------------------------

/**
 * Sends every pair to the support checker and scores the verdicts. A provider error that every
 * further call would meet ends the run by throwing `EvaluationProviderFailure`; an abort ends it;
 * a call that fails for its own reasons is a pair with no verdict, counted against the checker.
 */
export async function runCalibration(args: {
  set: CalibrationSet;
  prepared: readonly PreparedPair[];
  prompt: RegisteredPrompt;
  generator: ObjectGenerator;
  signal: AbortSignal;
}): Promise<CalibrationRecord> {
  let fatal: RunErrorKind | null = null;
  const generator = watchGenerator(args.generator, (kind) => {
    fatal ??= kind;
  });
  const check = createSupportChecker(args.prompt);
  const controller = new AbortController();
  const relay = (): void => controller.abort(args.signal.reason);
  if (args.signal.aborted) relay();
  else args.signal.addEventListener("abort", relay, { once: true });
  const onFail = (error: unknown): void => {
    if (error instanceof ProviderFailure || error instanceof EvaluationProviderFailure) return;
    controller.abort(error);
  };
  try {
    const verdicts = await mapLimited(
      args.prepared,
      RULE_CONCURRENCY,
      async (item): Promise<CheckerVerdict> => {
        controller.signal.throwIfAborted();
        const { answer, call } = await check({
          generator,
          signal: controller.signal,
          rule: item.rule,
          draft: item.draft,
          citedSpans: [item.span],
        });
        if (fatal !== null && call.outcome === "fatal") throw new EvaluationProviderFailure(fatal);
        controller.signal.throwIfAborted();
        return call.outcome === "ok" ? answer.verdict : "failed";
      },
      { onFail },
    );
    const pairs: CalibrationPair[] = args.prepared.map((item, index) => ({
      label: item.pair.label,
      verdict: verdicts[index] as CheckerVerdict,
      ...(item.pair.kind === undefined ? {} : { kind: item.pair.kind }),
    }));
    const failedPairs = verdicts.filter((v) => v === "failed").length;
    return {
      result: scoreCalibration(pairs),
      setSha256: args.set.sha256,
      prompt: { id: args.prompt.definition.id, sha256: args.prompt.sha256 },
      supportedPairs: pairs.filter((p) => p.label === "supported").length,
      unsupportedPairs: pairs.filter((p) => p.label === "unsupported").length,
      failedPairs,
      modelCalls: args.prepared.length,
      note:
        failedPairs > 0
          ? `${failedPairs} of ${pairs.length} calls returned no verdict. Each counts against the checker on both sides, so the rates are lower bounds on what the checker would do if every call had answered.`
          : null,
    };
  } finally {
    args.signal.removeEventListener("abort", relay);
  }
}
