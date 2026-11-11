import type { ReasonCode } from "../../contracts.js";

/**
 * The words the feedback panes use (package W2.6a): the reason codes and the minor-edit mark on a
 * decision. They are project-authored guidance, not a quotation of the pilot documents, and the
 * wording is to be agreed with the reviewing attorneys before a pilot: a change of wording during a
 * pilot changes what the counts mean.
 *
 * Each table is a complete record of its vocabulary, so a code added to `REASON_CODES` does not
 * compile until it has a label and a meaning. A code that arrives from the database is looked up
 * with `Object.hasOwn`, so one this build does not know gets a fixed phrase and never an inherited
 * property.
 */

export const REASON_CODE_LABEL: Record<ReasonCode, string> = {
  wrong_status: "Wrong status",
  wrong_evidence: "Wrong evidence",
  missed_context: "Missed context",
  bad_fallback: "Bad fallback language",
  unclear: "Unclear",
  other: "Other",
};

export const REASON_CODE_MEANING: Record<ReasonCode, string> = {
  wrong_status: "The status is not the one the playbook gives for these documents.",
  wrong_evidence: "A cited passage is wrong, or the passage that governs is not cited.",
  missed_context:
    "Something elsewhere in the documents, such as an amendment or a definition, changes the answer.",
  bad_fallback: "The suggested wording cannot be used as written.",
  unclear: "The explanation is too vague or confusing to act on.",
  other: "None of these. Say what in the reason.",
};

/** The label of a reason code, or a fixed phrase for a value this build does not know. */
export function reasonCodeLabel(code: string): string {
  return Object.hasOwn(REASON_CODE_LABEL, code)
    ? REASON_CODE_LABEL[code as ReasonCode]
    : "A reason code this version does not know";
}

/** The words of the minor-edit mark, on the form and in the history. */
export const MINOR_EDIT_LABEL = "This is a minor edit";
export const MINOR_EDIT_HINT =
  "Tick it when the finding was right in substance and you corrected a detail or changed wording. A change of status is never minor. Used only when you choose Edit.";
/** Said in the history of an edit that was marked minor. */
export const MINOR_EDIT_MARKED = "Marked as a minor edit.";
