import { MAX_RETAIN_DAYS } from "../../store/index.js";
import type { RefusalFragment } from "./notices.js";

/**
 * The refusal phrases, notices and guidance of package W2.7 (retention and audit).
 * `routes/notices.ts` merges it with the core fragment and the other three, and refuses a code that
 * two fragments define.
 *
 * Write each code once, with its phrase, the sentence inside the phrase that says what to do
 * (`todo`) and, if there is a place on the page to fix it, a `jump` to `#id`. Keep the
 * `as const satisfies RefusalFragment`: it is how a notice code written here becomes a
 * `NoticeCode` with no edit to `notices.ts`.
 *
 * `matter_residue` is the store's refusal to delete a matter while a table of the database still
 * holds a row of it (`deleteMatter`, docs/parol/06). The person cannot fix it: a table was added
 * that deletion was not taught about, and only the operator can find which. So the phrase says
 * that nothing was deleted and who to ask, and there is no place on the page to jump to.
 *
 * `retention_days` is the refusal of a number of days that is not a whole number from 1 to the
 * ceiling (`MAX_RETAIN_DAYS`), by the new-matter form and by the form that changes the date. The
 * person fixes it in the field, so it jumps to `#retention`: on the matter page that is the section
 * of the retention date, and on the list of matters the wrapper of the field in the new-matter
 * form. The number in the words is the store's own, so the phrase cannot say one ceiling while the
 * store holds another. `retention-saved` is the notice after the date was changed.
 */
export const REFUSALS_RETENTION = {
  phrases: {
    matter_residue:
      "The matter could not be deleted, because some of its data is kept where this version cannot remove it. Nothing was deleted and the matter is as it was. Ask the operator to look at it.",
    retention_days: `That is not a number of days a matter can be kept for. Enter a whole number of days from 1 to ${MAX_RETAIN_DAYS}.`,
  },
  todo: {
    matter_residue: "Ask the operator to look at it.",
    retention_days: `Enter a whole number of days from 1 to ${MAX_RETAIN_DAYS}.`,
  },
  jump: {
    retention_days: { href: "#retention", label: "Go to the retention field" },
  },
  notices: {
    "retention-saved": "The retention date was changed.",
  },
} as const satisfies RefusalFragment;
