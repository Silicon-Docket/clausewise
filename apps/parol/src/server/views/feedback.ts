import type { ReasonCode } from "../../contracts.js";

/**
 * The words the feedback panes use (package W2.6a): the reason codes and the minor-edit mark on a
 * decision, the report of a missed issue and the rating of a matter. They are project-authored
 * guidance, not a quotation of the pilot documents, and the wording is to be agreed with the
 * reviewing attorneys before a pilot: a change of wording during a pilot changes what the counts
 * mean.
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

// ---------------------------------------------------------------------------------------------
// Report a missed issue (slice B)
// ---------------------------------------------------------------------------------------------

export const MISSED_ISSUE_HEADING = "Report a missed issue";
export const MISSED_ISSUE_INTRO =
  "Tell us about something in these documents that the review should have flagged and did not. A report does not change any finding or decision. Do not paste long passages; say where they are.";
/** The last choice of the rule list, for a miss that no rule of the playbook covers. */
export const NOT_COVERED_LABEL = "Not covered by any rule";
export const MISSED_ISSUE_RULE_LABEL = "Rule";
export const MISSED_ISSUE_RULE_HINT =
  "The rule of the playbook that should have flagged it, or Not covered by any rule.";
export const MISSED_ISSUE_RULE_PLACEHOLDER = "Choose a rule";
export const MISSED_ISSUE_LOCATION_LABEL = "Location";
export const MISSED_ISSUE_LOCATION_HINT =
  "Where in the documents, for example NDA Section 6.1 or D2-p3. Leave it empty if the issue is something that is missing.";
export const MISSED_ISSUE_NOTE_LABEL = "Note";
export const MISSED_ISSUE_NOTE_HINT = "What the review should have flagged, in your own words.";
export const MISSED_ISSUE_BUTTON = "Report missed issue";
export const MISSED_ISSUE_LIST_HEADING = "Missed issues reported on this review";
export const MISSED_ISSUE_EMPTY = "Nobody has reported a missed issue on this review.";
/** Shown in place of the form for a review that produced no findings. */
export const MISSED_ISSUE_NO_FINDINGS =
  "This review has no findings, so there is nothing to report a miss against.";
/** The link at the top of the review page that leads to the report. */
export const MISSED_ISSUE_JUMP = "Report a missed issue";
/** The cell of a report that gave no location. */
export const MISSED_ISSUE_NO_LOCATION = "Not given";

/** The text of one rule in the list: its key, then its title in the playbook. */
export const ruleChoiceLabel = (ruleKey: string, title: string): string => `${ruleKey}, ${title}`;

// ---------------------------------------------------------------------------------------------
// Rate the matter (slice C)
// ---------------------------------------------------------------------------------------------

/** The five marks of the scale, the lowest first. */
export const RATING_MARKS = [1, 2, 3, 4, 5] as const;
export type RatingMark = (typeof RATING_MARKS)[number];

export const RATING_HEADING = "Rate this matter";
/** The statement that is rated, and the legend of the five choices. */
export const RATING_QUESTION = "I would use this for my next NDA";
export const RATING_LABEL: Record<RatingMark, string> = {
  1: "Strongly disagree",
  2: "Disagree",
  3: "Neither agree nor disagree",
  4: "Agree",
  5: "Strongly agree",
};
/** The words of one choice, as the radio is labelled: its mark, then its meaning. */
export const ratingChoiceLabel = (mark: RatingMark): string => `${mark} ${RATING_LABEL[mark]}`;
export const RATING_SCALE_HINT = "Choose from 1, strongly disagree, to 5, strongly agree.";
export const RATING_COMMENT_LABEL = "Comment";
export const RATING_COMMENT_HINT =
  "Optional. Say why, in your own words. Do not paste text from the documents.";
export const RATING_BUTTON = "Save rating";
/** Said under the form: where the rating is kept, who sees it, that it is final, and what it is not. */
export const RATING_FORM_HINT =
  "Your rating is stored with this matter and deleted with it. Other people on this matter cannot see it, and it cannot be changed once it is saved. In this demonstration every matter is synthetic, so a rating given here is not a pilot result.";
/** Shown in place of the form while the matter has no memo. */
export const RATING_NO_MEMO = "You can rate the matter once a memo has been exported.";
/** The words that follow the link to the report of a missed issue, under the rating. */
export const RATING_MISSED_ISSUE_LINK = "Anything Parol missed? Report a missed issue";
/** The label of a mark that this build does not know (the database does not let one in). */
const UNKNOWN_MARK = "A rating this version does not know";

/** The meaning of a mark, or a fixed phrase for a value that is not one of the five. */
export function ratingLabel(mark: number): string {
  return RATING_MARKS.find((known) => known === mark) === undefined
    ? UNKNOWN_MARK
    : RATING_LABEL[mark as RatingMark];
}
