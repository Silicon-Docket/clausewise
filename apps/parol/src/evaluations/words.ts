import type {
  ChangeKind,
  DecisionOutcome,
  FailureKind,
  GateOutcome,
  PageProblem,
  RunMode,
} from "./document.js";

/**
 * The fixed words of the evaluation comparison page. They belong to the application and not to the
 * file: a document carries no banner and no label, only the mode of each run and codes, and the page
 * looks the words up here. Editing the text of a banner inside a document therefore changes nothing
 * on the page (and breaks its fingerprint).
 *
 * Several of these are copies of sentences that the evaluation command prints (the banners of a
 * scripted run, the labels of the decision rule, the sentence that a gate result is not a
 * recommendation). They are copied and not imported, because the application imports nothing from
 * `evals/`; `test/evaluations/pins.test.ts` fails when either side changes without the other.
 */

/** The words that head every table and report of a scripted or replayed run, character for character. */
export const MODE_WORDS: Readonly<Record<"selftest" | "simulated" | "replay", string>> = {
  selftest:
    "THIS IS A SELFTEST OF THE EVALUATION PLUMBING. THE SCORES BELOW ARE THOSE OF A SCRIPTED ORACLE THAT READS THE ANSWER KEY. A SELFTEST SCORE SAYS NOTHING ABOUT ANY MODEL.",
  simulated:
    "SIMULATED RUN. THE ANSWERS BELOW COME FROM THE SCRIPTED SIMULATED READER OF THE DEMO, NOT FROM A LANGUAGE MODEL. THESE SCORES ARE NOT A MEASUREMENT OF ANY MODEL.",
  replay:
    "REPLAY. THE ANSWERS BELOW WERE RECORDED FROM AN EARLIER LIVE RUN AND RE-SCORED. NO MODEL WAS CALLED. THIS IS NOT A NEW MEASUREMENT AND NOT A NEW REPEAT, AND NO LATENCY OR COST WAS INCURRED.",
};

const SCRIPTED_ORDER = ["selftest", "simulated", "replay"] as const;

/** The mode as a short word for a chip: capitals for a run that is scripted or replayed. */
export const MODE_LABEL: Readonly<Record<RunMode, string>> = {
  selftest: "SELFTEST",
  simulated: "SIMULATED",
  live: "Live",
  replay: "REPLAY",
};

/** The distinct scripted or replayed modes among `modes`, in the order selftest, simulated, replay. */
export function scriptedModesIn(
  modes: readonly RunMode[],
): ("selftest" | "simulated" | "replay")[] {
  return SCRIPTED_ORDER.filter((mode) => modes.includes(mode));
}

/**
 * One sentence for each distinct scripted or replayed mode among `modes`, in the order selftest,
 * simulated, replay. A live run has none: the page cannot know that a model was called, and says so
 * in its footer.
 */
export function warningsFor(modes: readonly RunMode[]): string[] {
  return scriptedModesIn(modes).map((mode) => MODE_WORDS[mode]);
}

/** The sentence that follows every outcome of the decision rule. */
export const NOT_A_RECOMMENDATION =
  "This is the result of the gates and not a recommendation. Promotion is decided in a promotion record signed off by the legal engineer (and, for a real pilot, the supervising attorney); nothing here ships a version.";

/** The outcome of the decision rule, always worded as a gate result. */
export const DECISION_LABEL: Readonly<Record<DecisionOutcome, string>> = {
  promote: "PROMOTE TO PILOT, as a gate result",
  promote_with_conditions: "PROMOTE WITH CONDITIONS, as a gate result",
  do_not_promote: "DO NOT PROMOTE, as a gate result",
};

/** The words that say a score was shaped by something other than the model's own answers. */
export const NOT_CLEAN = "NOT A CLEAN MEASUREMENT";

export const GATE_OUTCOME_LABEL: Readonly<Record<GateOutcome, string>> = {
  pass: "Pass",
  fail: "Fail",
  not_evaluated: "Not evaluated",
};

export const CHANGE_KIND_LABEL: Readonly<Record<ChangeKind, string>> = {
  regression: "Regression",
  improvement: "Improvement",
  changed: "Changed",
};

/** What each way a slot can fail is called, in plain words. */
export const FAILURE_LABEL: Readonly<Record<FailureKind, string>> = {
  silent_miss: "Missed an issue and raised no flag",
  verified_unsupported: "Showed a verified quote that does not support the status",
  determined_where_undetermined_required: "Stated a status where the key requires undetermined",
  required_escalation_missing: "Right status, but did not raise the escalation the key requires",
  false_alarm: "Flagged a clause that was acceptable",
  wrong_flag: "Flagged as a deviation where missing was right, or the reverse",
  evidence_failed: "Right status, but the evidence failed the key's test",
  wrong_status: "Stated a wrong status",
  undetermined_where_determinable: "Declined to state a status that could be determined",
  unnecessary_escalation: "Raised an escalation the key does not expect",
};

/** Why a side of a trail is not shown. */
export const WHY_NOT_LABEL: Readonly<Record<"not_recorded" | "case_changed", string>> = {
  not_recorded: "The results file of this version did not record where it looked or what it cited.",
  case_changed:
    "The case documents on disk are not the ones this run read, so what it was shown is not shown here.",
};

/** What a person does about a file in the folder that is not a usable page. */
export const PROBLEM_ACTION: Readonly<Record<PageProblem, string>> = {
  too_large:
    "The file is larger than this page accepts. Narrow the comparison with --case and publish it again.",
  unreadable:
    "The file could not be read here, or is not a plain file. Write it again with --publish.",
  not_json: "The file is not JSON. Write it again with --publish.",
  not_a_comparison:
    "The file is not a comparison page of this version. Write it again with --publish.",
  fingerprint_mismatch: "The file was changed after it was written. Write it again with --publish.",
  name_mismatch: "The file name does not match its content. Write it again with --publish.",
};

/** The problem in a few words, for a row of the list. */
export const PROBLEM_LABEL: Readonly<Record<PageProblem, string>> = {
  too_large: "File too large",
  unreadable: "File not readable",
  not_json: "Not JSON",
  not_a_comparison: "Not a comparison page",
  fingerprint_mismatch: "Changed after it was written",
  name_mismatch: "File name does not match",
};

/** Said on a comparison whose document carries the evidence trails of the held-out split. */
export const HELDOUT_OPENED =
  "THE HELD-OUT SET WAS OPENED FOR THIS PAGE. Its evidence trails are in the file, so a workflow changed in response to them can no longer be judged on that set.";

/** Said once in the trail pane: what a trail is, and what it is not. */
export const TRAIL_NOT_SHOWN =
  "This page shows where each version looked and what it cited. It does not show what it wrote.";

/** Where the answers of a run are, by the mode of the run. */
export const ANSWERS_BY_MODE: Readonly<Record<RunMode, string>> = {
  live: "The answers of that run are in its recording, if one was written.",
  replay: "The answers of that run are in its recording, if one was written.",
  simulated:
    "The simulated reader answers only the worked example (PAROL-D05); to read its finding, run the same workflow on the case files in the application with PAROL_SCRIPTED=1. It declines every other document.",
  selftest: "The selftest oracle writes no answer; it reads the key.",
};
