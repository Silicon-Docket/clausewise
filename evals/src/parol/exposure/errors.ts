/**
 * The failures of the exposure suite that have a name of their own. Every message names a case, a
 * step, a field, an id or a count. None repeats document text, a prompt, a model answer or a
 * canary string, because the message of an `EvalError` is printed as it is.
 */
import { EvalError } from "../../errors.js";

/** Exit code of a run that could not be trusted: the same code as an integrity failure. */
export const EXIT_UNTRUSTED = 2;

/**
 * The application did something else with an uploaded file than the answer key says it should. It
 * is not an exposure, so it is not counted in gate G1: the replay cannot be trusted, and the run
 * stops with an integrity style exit code (2).
 */
export class UploadReplayMismatch extends EvalError {
  override name = "UploadReplayMismatch";
  constructor(message: string) {
    super(message, EXIT_UNTRUSTED);
  }
}

/**
 * The scanner did not find the canary that the suite planted for it in a planted artefact (or
 * found one in a clean artefact). A scan that cannot find its own control would report zero for
 * anything, so no count may be reported.
 */
export class ExposureControlFailure extends EvalError {
  override name = "ExposureControlFailure";
  constructor(message: string) {
    super(message, EXIT_UNTRUSTED);
  }
}

/** A sub-suite that cannot run (a case the dataset lacks, an empty matrix) and so has nothing to report. */
export class ExposureSuiteUnavailable extends EvalError {
  override name = "ExposureSuiteUnavailable";
}
