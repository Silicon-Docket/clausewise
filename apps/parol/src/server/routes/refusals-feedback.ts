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
 * the general sentence of its status. The later slices (a missed issue, a note, the rating) add
 * their codes to this fragment below these.
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
  },
  todo: {
    reason_code_required: "Choose a reason code.",
    reason_code_not_allowed: "Leave the reason code unchosen, or choose Edit or Reject.",
    bad_reason_code: "Choose one from the list.",
    minor_edit_not_allowed: "Clear the box, or choose Edit.",
    minor_edit_status: "Clear the box, or leave the status as it is.",
  },
  jump: {
    reason_code_required: { href: "#decision-reason-code", label: "Go to the reason code" },
    reason_code_not_allowed: { href: "#decision-reason-code", label: "Go to the reason code" },
    bad_reason_code: { href: "#decision-reason-code", label: "Go to the reason code" },
    minor_edit_not_allowed: { href: "#edit-minor", label: "Go to the minor-edit box" },
    minor_edit_status: { href: "#edit-minor", label: "Go to the minor-edit box" },
  },
  notices: {},
} as const satisfies RefusalFragment;
