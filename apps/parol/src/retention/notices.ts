import type { Repository } from "../store/index.js";

/**
 * The start-up notices about retention (package W2.7, slice D): a warning when the audit log does
 * not verify, a notice when matters are past their retention date. Counts and a fixed reason code
 * only; nothing is deleted and nothing is changed.
 *
 * Contract commit CC1: `main.ts` calls this once, after the orphan sweep, and is not edited again
 * for it. W2.7 fills the body and may widen `RetentionNoticeDeps`, which `main.ts` fills from
 * what `start` already holds.
 */
export interface RetentionNoticeDeps {
  repo: Repository;
  /** The clock, for the retention dates. */
  now: () => Date;
  /** One line to the operator, as `start` prints its other start-up notices. */
  notice: (line: string) => void;
}

export function reportRetentionNotices(_deps: RetentionNoticeDeps): void {
  // STUB(W2.7): returns without doing anything. W2.7 prints the two notices here.
}
