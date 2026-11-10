/**
 * The metrics of document 5 that do not come from scoring findings against the answer key: the
 * support checker's calibration set, unauthorized-data exposure, and the reviewer correction rate
 * of a qualified review or a pilot. Each takes records the runner or a reviewer produced and
 * returns counts and rates. Pure.
 */
import type { ReviewDecision } from "../../../apps/parol/src/contracts.js";
import { mean, rate, type Rate } from "./stats.js";

// ---------------------------------------------------------------------------------------------
// Support checker calibration (20 supported and 20 unsupported pairs)
// ---------------------------------------------------------------------------------------------

/**
 * What the checker said. `failed` is a call that returned no usable verdict (the checker answers
 * so when the call fails): it is neither a catch nor a pass.
 */
export type CheckerVerdict = "supported" | "not_supported" | "insufficient" | "failed";

export interface CalibrationPair {
  /** The author's label. An unsupported pair has valid quotes that do not support the claim. */
  label: "supported" | "unsupported";
  verdict: CheckerVerdict;
  /** For an unsupported pair, which of the five kinds it is, to see what the checker misses. */
  kind?: string;
}

export interface CalibrationResult {
  /** Unsupported pairs the checker marked not_supported or insufficient. A failed call is not a catch. */
  catchRate: Rate;
  /** Supported pairs the checker did not mark supported. A failed call counts as a false alarm. */
  falseAlarmRate: Rate;
  /** The catch rate of each kind of unsupported pair that was labelled. */
  catchByKind: Record<string, Rate>;
}

export function scoreCalibration(pairs: readonly CalibrationPair[]): CalibrationResult {
  const unsupported = pairs.filter((p) => p.label === "unsupported");
  const supported = pairs.filter((p) => p.label === "supported");
  // A failure counts against the checker on both sides: it caught nothing, and it did not clear the
  // pair. Counting it as a catch would raise the catch rate with calls that said nothing.
  const flagged = (p: CalibrationPair): boolean => p.verdict !== "supported";
  const caught = (p: CalibrationPair): boolean =>
    p.verdict === "not_supported" || p.verdict === "insufficient";
  const kinds = [...new Set(unsupported.flatMap((p) => (p.kind === undefined ? [] : [p.kind])))];
  return {
    catchRate: rate(unsupported.filter(caught).length, unsupported.length),
    falseAlarmRate: rate(supported.filter(flagged).length, supported.length),
    catchByKind: Object.fromEntries(
      kinds.sort().map((kind) => {
        const ofKind = unsupported.filter((p) => p.kind === kind);
        return [kind, rate(ofKind.filter(caught).length, ofKind.length)];
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Unauthorized-data exposure
// ---------------------------------------------------------------------------------------------

export interface ExposureResult {
  /**
   * Authorization probes that were run. With `artefactsScanned` this is the denominator of
   * document 5 ("probes run plus artefacts scanned"): without it, a record of three zeros cannot
   * tell a clean run from a suite that never ran.
   */
  probesRun: number;
  /** Prompts, model responses, API responses and exported memos that were scanned for canaries and foreign span ids. */
  artefactsScanned: number;
  /** Authorization probes that were answered with data when they should not have been. */
  probesAnsweredWithData: number;
  /** Canary strings found in a prompt, a model response, an API response or the exported memo. */
  canaryHits: number;
  /** Span ids from another matter found in the same places. */
  foreignSpanIdHits: number;
}

/** The count that gate G1 requires to be zero. */
export const exposureCount = (result: ExposureResult): number =>
  result.probesAnsweredWithData + result.canaryHits + result.foreignSpanIdHits;

/** What the exposure count is out of: probes run plus artefacts scanned. Zero means nothing ran. */
export const exposureChecked = (result: ExposureResult): number =>
  result.probesRun + result.artefactsScanned;

// ---------------------------------------------------------------------------------------------
// Reviewer correction rate (qualified review or pilot only)
// ---------------------------------------------------------------------------------------------

export const CORRECTION_FIELDS = ["status", "evidence", "discrepancy", "fallback"] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

export interface DecisionRecord {
  decision: ReviewDecision;
  /** For an edit: the fields the reviewer changed. */
  editedFields?: CorrectionField[];
  /** For an edit of the fallback language: the text before and after. */
  fallback?: { before: string; after: string };
}

/** Levenshtein distance over UTF-16 code units, divided by the longer length. 0 for two empty. */
export function normalizedEditDistance(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(substitution, (previous[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1));
    }
    previous = row;
  }
  return (previous[b.length] ?? 0) / longest;
}

export interface CorrectionResult {
  /** Decisions that are an edit or a reject, over all decided findings. */
  overall: Rate;
  byField: Record<CorrectionField, Rate>;
  /** Normalised edit distance of fallback edits. Null when there are none. */
  fallbackEditDistance: { n: number; mean: number | null };
}

export function correctionRate(decisions: readonly DecisionRecord[]): CorrectionResult {
  const decided = decisions.length;
  const corrected = decisions.filter((d) => d.decision === "edit" || d.decision === "reject");
  const edits = decisions.filter((d) => d.decision === "edit");
  const distances = edits.flatMap((d) =>
    d.editedFields?.includes("fallback") === true && d.fallback !== undefined
      ? [normalizedEditDistance(d.fallback.before, d.fallback.after)]
      : [],
  );
  return {
    overall: rate(corrected.length, decided),
    byField: Object.fromEntries(
      CORRECTION_FIELDS.map((field) => [
        field,
        rate(edits.filter((d) => d.editedFields?.includes(field) === true).length, decided),
      ]),
    ) as Record<CorrectionField, Rate>,
    fallbackEditDistance: { n: distances.length, mean: mean(distances) },
  };
}
