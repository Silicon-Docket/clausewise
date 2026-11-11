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
 */
export const REFUSALS_RETENTION = {
  phrases: {
    matter_residue:
      "The matter could not be deleted, because some of its data is kept where this version cannot remove it. Nothing was deleted and the matter is as it was. Ask the operator to look at it.",
  },
  todo: {
    matter_residue: "Ask the operator to look at it.",
  },
  jump: {},
  notices: {},
} as const satisfies RefusalFragment;
