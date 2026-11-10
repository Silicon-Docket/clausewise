import type { RefusalFragment } from "./notices.js";

/**
 * The refusal phrases, notices and guidance of package W2.8 (training matter and quickstart).
 * Empty until that package fills it. `routes/notices.ts` merges it with the core fragment and the
 * other three, and refuses a code that two fragments define.
 *
 * Write each code once, with its phrase, the sentence inside the phrase that says what to do
 * (`todo`) and, if there is a place on the page to fix it, a `jump` to `#id`. Keep the
 * `as const satisfies RefusalFragment`: it is how a notice code written here becomes a
 * `NoticeCode` with no edit to `notices.ts`.
 */
export const REFUSALS_TRAINING = {
  phrases: {},
  todo: {},
  jump: {},
  notices: {},
} as const satisfies RefusalFragment;
