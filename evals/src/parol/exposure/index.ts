/**
 * The exposure suite of the Parol evaluation: the one function that feeds gate G1, "unauthorized
 * data exposure" (threshold 0), docs/parol/05-evaluation.md.
 *
 * Three sub-suites, each over the application running in process, and none of them sends anything
 * to a model or a network (the model is a scripted oracle that answers from the answer key; it is
 * not a language model and the suite says so wherever it names it):
 *
 *  1. Authorization probes (authorization.ts): every route that names a matter, as seven callers, in
 *     two modes. Counts `probesRun` and `probesAnsweredWithData`.
 *  2. Canary scan (canary.ts): a canary matter in the same store as a case, the case reviewed,
 *     decided, exported and every GET route of the application read as the case's associate,
 *     reviewer and viewer, the canary matter's associate and reviewer, the global administrator,
 *     the legal engineer and an anonymous client, and every prompt, model answer, response body,
 *     memo and stored row searched for the canary strings and the ids of the other matter. Counts
 *     `artefactsScanned`, `canaryHits`, `foreignSpanIdHits` and `factSightings` (the last is
 *     reported and is not a count of G1).
 *  3. Upload replay (uploads.ts): the upload steps of the cases that have them, played through the
 *     application's upload service. It counts nothing for G1; a step that does not do what the key
 *     says stops the run with `UploadReplayMismatch`.
 *
 * Zero hits out of nothing run is impossible: a sub-suite that cannot run throws, and the scanner
 * has to find its own planted control before a count is reported.
 *
 * Determinism: the counts do not depend on time, ids or ordering. Nothing printed, thrown or
 * returned holds document text, a prompt, a model answer or a canary string.
 */
import type { LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import type { Split } from "../../../../fixtures/parol/types.js";
import { EvalError } from "../../errors.js";
import type { Dataset } from "../dataset.js";
import type { ExposureRecord } from "../results.js";
import { runAuthorizationProbes, type AuthorizationResult } from "./authorization.js";
import { runCanaryScan, type CanaryHooks, type CanaryResult } from "./canary.js";
import type { SiteHooks } from "./site.js";
import { runUploadReplay, type UploadReplayResult } from "./uploads.js";

export interface ExposureArgs {
  /** The repository root; the dataset is at `<root>/fixtures/parol`. */
  root: string;
  /** Already loaded and integrity checked. */
  dataset: Dataset;
  /** Already loaded. */
  playbook: LoadedPlaybook;
  signal: AbortSignal;
  /**
   * The splits whose cases are scanned and replayed. Default: development only. The held-out split
   * is touched only when it is named here; the seal on it is the caller's business.
   */
  splits?: Split[];
}

/**
 * For the suite's own tests: faults a test plants to show that the suite can fail. The evaluation
 * command never passes this.
 */
export interface ExposureFaults {
  authorization?: SiteHooks;
  canary?: CanaryHooks;
}

/** The record of the three sub-suites. Throws if nothing at all was checked. */
export function composeExposureRecord(parts: {
  authorization: Pick<
    AuthorizationResult,
    "probesRun" | "probesAnsweredWithData" | "letInNotReached" | "mismatches" | "sentence"
  >;
  canary: Pick<
    CanaryResult,
    "artefactsScanned" | "canaryHits" | "foreignSpanIdHits" | "factSightings" | "sentence"
  >;
  uploads: Pick<UploadReplayResult, "sentence">;
}): ExposureRecord {
  const { authorization, canary, uploads } = parts;
  if (authorization.probesRun + canary.artefactsScanned === 0)
    throw new EvalError("The exposure suite checked nothing, so it has no result to report.");
  return {
    probesRun: authorization.probesRun,
    artefactsScanned: canary.artefactsScanned,
    probesAnsweredWithData: authorization.probesAnsweredWithData,
    canaryHits: canary.canaryHits,
    foreignSpanIdHits: canary.foreignSpanIdHits,
    letInNotReached: authorization.letInNotReached,
    mismatches: authorization.mismatches,
    factSightings: canary.factSightings,
    suites: [authorization.sentence, canary.sentence, uploads.sentence],
  };
}

export async function runExposureSuite(
  args: ExposureArgs,
  faults: ExposureFaults = {},
): Promise<ExposureRecord> {
  const { root, dataset, playbook, signal } = args;
  const splits = args.splits ?? (["dev"] as Split[]);
  const authorization = await runAuthorizationProbes({
    dataset,
    root,
    playbook,
    signal,
    ...(faults.authorization === undefined ? {} : { hooks: faults.authorization }),
  });
  const canary = await runCanaryScan({
    dataset,
    root,
    playbook,
    signal,
    splits,
    ...(faults.canary === undefined ? {} : { hooks: faults.canary }),
  });
  const uploads = await runUploadReplay({ dataset, root, playbook, signal, splits });
  return composeExposureRecord({ authorization, canary, uploads });
}

export { runAuthorizationProbes, runCanaryScan, runUploadReplay };
export type { AuthorizationResult, CanaryResult, UploadReplayResult };
export {
  UploadReplayMismatch,
  ExposureControlFailure,
  ExposureSuiteUnavailable,
} from "./errors.js";
