import type { RefusalFragment } from "./notices.js";

/**
 * The refusal phrases, notices and guidance of package W2.6a (feedback capture).
 * `routes/notices.ts` merges it with the core fragment and the other three, and refuses a code that
 * two fragments define.
 *
 * Write each code once, with its phrase, the sentence inside the phrase that says what to do
 * (`todo`) and, if there is a place on the page to fix it, a `jump` to `#id`. Keep the
 * `as const satisfies RefusalFragment`: it is how a notice code written here becomes a
 * `NoticeCode` with no edit to `notices.ts`.
 *
 * Slice A (the reason code and the minor-edit mark of a decision). The five codes are the store's
 * refusals of a decision (`recordReview`) and of the decision form. The person fixes each one in a
 * control of the decision form, so each jumps to it: `#decision-reason-code` is the list of reason
 * codes and `#edit-minor` is the minor-edit box. The form leaves a code off an accept or an
 * escalate and a box off anything but an edit, so `reason_code_not_allowed` and
 * `minor_edit_not_allowed` reach a person only through the JSON API; they are written here for the
 * page all the same, so a form that is ever changed to post them is answered in words and not with
 * the general sentence of its status.
 *
 * Slice B (a missed issue). Each code that belongs to one field of the report form jumps to that
 * field: `#missed-issue-rule` is the rule list, `#missed-issue-location` the place and
 * `#missed-issue-note` the note. A jump leads to one field of one form, so a code that more than one
 * form can raise has none: `unknown_rule` (the reference list of the pilot measures raises it too,
 * by decision R10 of the plan, and its page has no such list) and `feedback_limit` (a note has a
 * cap of its own). The note on a finding and the comment of the rating take codes of their own, so
 * that each of their jumps leads to their own control and none dangles on a page that has no such
 * control; `note_required` and `note_too_long` here are the report form's.
 *
 * `rule_required`, `note_required`, `note_too_long` and `location_too_long` are raised by the
 * parsers of the report form and the JSON body (routes/feedback.ts); `unknown_rule` by the store
 * when the rule is not one of the run's playbook (and by the parser when what was posted cannot be a
 * rule key at all); `run_has_no_findings` and `feedback_limit` by the service and the store, as
 * conflicts. The store has three more guards that no route can reach (`run_required`,
 * `finding_not_allowed`, `field_not_allowed`): the service gives the run from the path and
 * nothing else, so they are written for code that calls the store another way and have no phrase.
 */
export const REFUSALS_FEEDBACK = {
  phrases: {
    reason_code_required: "Choose a reason code. An edit or a reject needs one.",
    reason_code_not_allowed:
      "Only an edit or a reject carries a reason code. Leave the reason code unchosen, or choose Edit or Reject.",
    bad_reason_code: "That is not one of the listed reason codes. Choose one from the list.",
    minor_edit_not_allowed:
      "Only an edit can be marked as a minor edit. Clear the box, or choose Edit.",
    minor_edit_status:
      "An edit that changes the status is not a minor edit. Clear the box, or leave the status as it is.",
    rule_required:
      "No rule was chosen. Choose the rule the review should have applied, or Not covered by any rule.",
    unknown_rule: "That rule is not in the playbook of this matter. Choose one from the list.",
    note_required: "The note is empty. Say what the review should have flagged.",
    note_too_long: "The note is longer than 4,000 characters. Shorten it.",
    location_too_long: "The location is longer than 200 characters. Shorten it.",
    run_has_no_findings:
      "This review has no findings, so there is nothing to report a miss against. Open a review that has findings.",
    feedback_limit:
      "The most that can be added here has been added. Raise anything more with the people running the pilot.",
  },
  todo: {
    reason_code_required: "Choose a reason code.",
    reason_code_not_allowed: "Leave the reason code unchosen, or choose Edit or Reject.",
    bad_reason_code: "Choose one from the list.",
    minor_edit_not_allowed: "Clear the box, or choose Edit.",
    minor_edit_status: "Clear the box, or leave the status as it is.",
    rule_required: "Choose the rule the review should have applied, or Not covered by any rule.",
    unknown_rule: "Choose one from the list.",
    note_required: "Say what the review should have flagged.",
    note_too_long: "Shorten it.",
    location_too_long: "Shorten it.",
    run_has_no_findings: "Open a review that has findings.",
    feedback_limit: "Raise anything more with the people running the pilot.",
  },
  jump: {
    reason_code_required: { href: "#decision-reason-code", label: "Go to the reason code" },
    reason_code_not_allowed: { href: "#decision-reason-code", label: "Go to the reason code" },
    bad_reason_code: { href: "#decision-reason-code", label: "Go to the reason code" },
    minor_edit_not_allowed: { href: "#edit-minor", label: "Go to the minor-edit box" },
    minor_edit_status: { href: "#edit-minor", label: "Go to the minor-edit box" },
    rule_required: { href: "#missed-issue-rule", label: "Go to the rule list" },
    note_required: { href: "#missed-issue-note", label: "Go to the note" },
    note_too_long: { href: "#missed-issue-note", label: "Go to the note" },
    location_too_long: { href: "#missed-issue-location", label: "Go to the location" },
  },
  notices: {
    "missed-issue-saved": "Your report was saved. It does not change any finding or decision.",
  },
} as const satisfies RefusalFragment;
