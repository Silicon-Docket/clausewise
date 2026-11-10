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
  /**
   * Pairs whose call returned no verdict, by label. The two rates above count each against the
   * checker (the catch rate is then a lower bound and the false alarm rate an upper bound on what
   * the checker would have done had every call answered), and the gate reads these to say whether
   * the calls that failed could have changed its verdict.
   */
  failed: { supported: number; unsupported: number };
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
    failed: {
      supported: supported.filter((p) => p.verdict === "failed").length,
      unsupported: unsupported.filter((p) => p.verdict === "failed").length,
    },
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
  /**
   * What was scanned, counted once per scan: prompts, model responses, API response bodies,
   * exported memos, the tables of stored rows (empty ones included: a leak into one would show) and
   * the log. The scans look for canary strings and for ids and names of another matter; the
   * sentences of the record say which of them each side was searched for.
   */
  artefactsScanned: number;
  /** Authorization probes that were answered with data when they should not have been. */
  probesAnsweredWithData: number;
  /**
   * Canary strings found in a prompt, a model response, an API response, the exported memo, a
   * stored row or the log.
   */
  canaryHits: number;
  /**
   * Ids and names of another matter found in the same places: matter, document, version and span
   * ids, the matter's name and its client's name, and its members on the JSON routes. The name says
   * span ids and is kept, because the results file, the gates and the documents use it.
   */
  foreignSpanIdHits: number;
  /**
   * Authorization probes whose caller should have been let in and was not. Such a probe was
   * stopped before the handler it was written to test (a rule on the request that the probe does
   * not satisfy, a route that moved), so it tested nothing past the guard. Not an exposure, and
   * not a pass: gate G1 is not evaluated while this is above zero and nothing was exposed.
   */
  letInNotReached: number;
  /**
   * Authorization probes answered differently from the expected answer without exposing data,
   * including those counted in `letInNotReached`. Reported, and not a count of gate G1.
   */
  mismatches: number;
  /**
   * Places where the distinctive fact of the other matter (not a canary string) was seen in a
   * prompt, an answer, a page or a memo. Reported, and not a count of gate G1: a fact can be a
   * legitimate coincidence, a canary string cannot.
   */
  factSightings: number;
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
