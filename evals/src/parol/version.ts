/**
 * The evaluation version: the metrics, severity weights, failure factors and gates that a score
 * was computed with. A run records it, and `compare` refuses to compare scores made with
 * different ones, because changing a weight or a threshold changes what a number means. Old runs
 * are re-scored under a new version, not compared across versions.
 */
import { canonicalJson, sha256Hex } from "../../../apps/parol/src/canonical.js";
import { GATES, THRESHOLDS } from "./gates.js";
import { FAILURE_FACTORS, MAX_FACTOR, RATE_METRICS, SEVERITY_WEIGHTS } from "./score.js";

/** Bump when a definition in score.ts or a gate in gates.ts changes meaning. */
export const EVALUATION_LABEL = "parol-eval v1";

export interface EvaluationVersion {
  label: string;
  sha256: string;
}

export function evaluationVersion(): EvaluationVersion {
  return {
    label: EVALUATION_LABEL,
    sha256: sha256Hex(
      canonicalJson({
        label: EVALUATION_LABEL,
        metrics: Object.keys(RATE_METRICS).sort(),
        severityWeights: SEVERITY_WEIGHTS,
        failureFactors: FAILURE_FACTORS,
        maxFactor: MAX_FACTOR,
        gates: GATES,
        thresholds: THRESHOLDS,
      }),
    ),
  };
}
