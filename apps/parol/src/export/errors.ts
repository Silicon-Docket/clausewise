import { MemoError } from "../module-contracts.js";

/**
 * Which export gate refused. The message says what to fix in ids and counts only: it never holds a
 * quotation, a clause or any other document text.
 */
export type MemoGate =
  | "no_findings"
  | "missing_finding"
  | "duplicate_rule"
  | "unreviewed"
  | "unverified_quote"
  | "invalid_input"
  | "write_failed";

/**
 * A `MemoError` that also says which gate refused, so a caller can answer a missing decision and a
 * quotation that no longer verifies differently without reading the message. It is still a
 * `MemoError`, with the same name, for every caller that only knows the contract.
 */
export class MemoGateError extends MemoError {
  constructor(
    readonly gate: MemoGate,
    message: string,
    /** Rule keys the refusal is about, where it is about rules. */
    readonly ruleKeys: readonly string[] = [],
  ) {
    super(message);
  }
}
