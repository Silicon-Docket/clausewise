import { MemoError, type BuildMemo } from "../module-contracts.js";
import { MemoGateError } from "./errors.js";
import { pinTimestamps } from "./package.js";
import { planMemo } from "./plan.js";
import { renderMemo } from "./render.js";

export { MemoGateError, type MemoGate } from "./errors.js";
export { MEMO_PAGE_BANNER, MEMO_TITLE, SHORT_HASH_LENGTH } from "./labels.js";
export { MAX_QUOTE_CHARS } from "./sanitize.js";

// An error from a library can echo what it was given. Only its name is kept, so a failure part way
// through can never carry document text into a log or a response.
const kindOf = (error: unknown): string => (error instanceof Error ? error.name : "unknown error");

/**
 * The memo for a reviewed run, as a Word file. Every export gate is enforced here as well as in
 * the service: a finding with no decision, a quotation that no longer verifies against the stored
 * text, an empty list of findings, a rule with two findings or a rule with none all refuse with a
 * `MemoError` before any file is built. Nothing else escapes: input that is not shaped as the
 * contract says, and a failure while writing the file, are also `MemoError`s whose messages name
 * no text. The output depends only on the input, so exporting the same reviewed run twice gives
 * the same bytes.
 */
export const buildMemo: BuildMemo = async (input) => {
  let plan: ReturnType<typeof planMemo>;
  try {
    plan = planMemo(input);
  } catch (error) {
    if (error instanceof MemoError) throw error;
    throw new MemoGateError("invalid_input", `The memo input is malformed (${kindOf(error)}).`);
  }
  try {
    return await pinTimestamps(await renderMemo(plan), plan.exportedAt);
  } catch (error) {
    throw new MemoGateError(
      "write_failed",
      `The memo file could not be written (${kindOf(error)}).`,
    );
  }
};
