import { normalizeForAnchor } from "@clausewise/review";
import type { FallbackBasis, PlaybookRuleRecord } from "../../contracts.js";
import { extractFacts } from "./facts.js";
import { dice, ratio, wordTokens } from "./text.js";

/** How alike two texts must be, by `dice`, for one to count as the other adapted. */
export const ADAPTED_THRESHOLD = 0.6;

/** Past this the texts are not compared: nothing this long is an adaptation of a clause. */
const COMPARE_LIMIT = 20_000;

export interface FallbackBasisResult {
  basis: FallbackBasis;
  /** Present when the two texts were compared. */
  similarity: number | null;
  /** A figure the language names that the approved text does not, which makes it new text. */
  changedFigures: boolean;
}

/**
 * Where the suggested fallback language comes from, by comparison with the playbook's approved
 * text for the rule. The comparison is code and does not ask the model.
 *
 *  - `none`: the finding offers no language.
 *  - `approved_verbatim`: the same words once quotes, dashes and spacing are normalised.
 *  - `approved_adapted`: at least `ADAPTED_THRESHOLD` (0.6) of the words are shared with the
 *    approved text, measured as the Dice coefficient of the two word multisets (twice the shared
 *    words over the words in both), and every duration, percentage, amount and jurisdiction in
 *    the language is one the approved text names. Defined terms and clause numbers change when
 *    approved text is adapted to a document; a changed figure is a change of position, and the
 *    label must not call a position the playbook never approved an approved one.
 *  - `generated`: anything else, and every suggestion for a rule with no approved text. A
 *    template with [placeholders] to fill usually lands here, which only asks for a closer look.
 */
export function fallbackBasis(
  language: string | null,
  rule: PlaybookRuleRecord,
): FallbackBasisResult {
  if (language === null) return { basis: "none", similarity: null, changedFigures: false };
  const approved = rule.fallbackLanguage;
  if (approved === null || approved.trim() === "") {
    return { basis: "generated", similarity: null, changedFigures: false };
  }
  if (normalizeForAnchor(language).trim() === normalizeForAnchor(approved).trim()) {
    return { basis: "approved_verbatim", similarity: 1, changedFigures: false };
  }
  if (language.length > COMPARE_LIMIT || approved.length > COMPARE_LIMIT) {
    return { basis: "generated", similarity: null, changedFigures: false };
  }
  const similarity = dice(wordTokens(language), wordTokens(approved));
  const known = new Set(extractFacts(approved, { expand: true }).map((f) => f.key));
  const changedFigures = extractFacts(language).some((f) => !known.has(f.key));
  const adapted = similarity >= ADAPTED_THRESHOLD && !changedFigures;
  return { basis: adapted ? "approved_adapted" : "generated", similarity, changedFigures };
}

export const describeBasis = (result: FallbackBasisResult): string =>
  result.similarity === null
    ? result.basis
    : `${result.basis}, similarity ${ratio(result.similarity)} against ${ratio(ADAPTED_THRESHOLD)}${result.changedFigures ? ", a figure differs from the approved text" : ""}`;
