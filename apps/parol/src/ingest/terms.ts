import { pairQuotes, type QuotedRun } from "./view.js";

/**
 * Defined terms, found with patterns and no judgment. Terms matter downstream because a clause
 * that says "the Receiving Party shall..." cannot be applied without the clause that says who the
 * Receiving Party is, and an amendment may use a term only the NDA defines.
 *
 * What this catches, on a normalized view (straight quotes):
 *  - a quoted term in brackets after definitional words: (the "Receiving Party"), ("Agreement"),
 *    (each a "Party" and together the "Parties"), (hereinafter the "Company"),
 *  - a quoted term after "is the", "are the", "referred to as", "called", "hereinafter":
 *    a party that receives it is the "Receiving Party",
 *  - a quoted term followed by "means", "shall mean", "has the meaning", "refers to", "includes"
 *    or "is defined as": "Confidential Information" means ..., and a chain of them:
 *    "Party" or "Parties" means ...
 *
 * What it misses: a term defined in bold or capitals without quotes, a term in single quotes
 * (indistinguishable from an apostrophe), a definition that sits in a table cell apart from its
 * term, and a term introduced by words that are not in the lists below. It also takes a quoted
 * term after "is the" for a definition when it is only a label, which costs one extra annotation.
 * Each miss leaves the model with less context for that term, never with wrong context.
 */

const MAX_TERM_CHARS = 80;
const MAX_TERM_WORDS = 8;
// Only a bounded stretch around a quote is read for its introduction, so a hostile paragraph of
// nothing but quoted pairs costs a bounded amount per pair.
const LOOKBEHIND = 120;
const LOOKAHEAD = 100;
// , . ; :
const TRAILING_PUNCTUATION: ReadonlySet<number> = new Set([44, 46, 59, 58]);

/**
 * The term inside the quotes, tidied, or undefined when the text is not shaped like a term.
 *
 * The trailing punctuation is trimmed with a loop and not with a regular expression: a
 * pattern such as /[,.;:]+$/ retries from every position of a long run of those characters that
 * does not reach the end of the text, which is quadratic, and the text between two quotes is as
 * long as the document allows.
 */
function termShape(inner: string): string | undefined {
  // American style puts the comma or full stop inside the quotes: (the "Company,")
  let end = inner.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(inner.charCodeAt(end - 1))) end--;
  const term = end === inner.length ? inner : inner.slice(0, end);
  if (term.length < 2 || term.length > MAX_TERM_CHARS) return undefined;
  if (term !== term.trim() || !/^[\p{L}\p{N}]/u.test(term) || !/\p{L}/u.test(term)) {
    return undefined;
  }
  if (term.split(" ").length > MAX_TERM_WORDS) return undefined;
  return term;
}

// Words that may stand between an opening bracket and a defined term. A bracket that holds any
// other word first, such as (see "Schedule 2"), is not a definition. The list is closed so that
// a cross-reference in quotes is never taken for one.
const LEAD_WORDS =
  "the|a|an|each|either|both|together|collectively|jointly|individually|severally|hereinafter|herein|hereafter|referred|to|as|and|or|also|called|known|defined|termed|designated|being|such|this|that|these|those|respectively";
// Each token is followed by its own white space and the pattern starts with a single \s*, so the
// split between neighbouring tokens is never ambiguous and matching stays linear.
const BRACKET_LEAD = new RegExp(`^\\s*(?:(?:(?:${LEAD_WORDS})\\b|"[^"]{1,80}"|[,;])\\s*)*$`, "i");

const OUTSIDE_LEADS = [
  /\b(?:hereinafter|herein|hereafter)\s+(?:(?:referred\s+to\s+as|called|the|a|an)\s+)*$/i,
  /\b(?:referred\s+to\s+as|called|known\s+as|defined\s+as|designated\s+as|termed)\s+(?:(?:the|a|an|each|collectively)\s+)?$/i,
  /\b(?:is|are|shall\s+be|will\s+be)\s+(?:(?:each|collectively|together|jointly|individually)\s+)*(?:the|a|an)\s+$/i,
];

const MEANS_AFTER =
  /^,?\s*(?:\([^()]{0,60}\)\s*)?(?:(?:(?:shall|will|hereby)\s+)?(?:mean|means|include|includes|refer\s+to|refers\s+to|have\s+the\s+meaning|has\s+the\s+meaning)|(?:is|are)\s+(?:hereby\s+)?defined\s+(?:as|to\s+mean))\b/i;
const CHAIN_GAP = /^\s*,?\s*(?:(?:and|or)\s*)?$/i;

function introducedBefore(view: string, run: QuotedRun): boolean {
  const before = view.slice(Math.max(0, run.start - LOOKBEHIND), run.start);
  const open = before.lastIndexOf("(");
  if (
    open !== -1 &&
    before.indexOf(")", open) === -1 &&
    BRACKET_LEAD.test(before.slice(open + 1))
  ) {
    return true;
  }
  return OUTSIDE_LEADS.some((pattern) => pattern.test(before));
}

/**
 * The terms a span defines, in order of appearance, without repeats. `view` is the span's
 * normalized text (see matchView).
 */
export function findDefinedTerms(view: string): string[] {
  if (!view.includes('"')) return [];
  const runs = pairQuotes(view, (inner) => termShape(inner) !== undefined);
  // A chain such as "Party" or "Parties" means ... is defined by the verb after its last member,
  // so the verdicts are settled from the end.
  const defined: boolean[] = new Array<boolean>(runs.length).fill(false);
  for (let k = runs.length - 1; k >= 0; k--) {
    const run = runs[k]!;
    const next = runs[k + 1];
    const chained = next !== undefined && CHAIN_GAP.test(view.slice(run.end, next.start));
    defined[k] =
      introducedBefore(view, run) ||
      MEANS_AFTER.test(view.slice(run.end, run.end + LOOKAHEAD)) ||
      (chained && defined[k + 1] === true);
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  runs.forEach((run, k) => {
    const term = defined[k] ? termShape(run.inner) : undefined;
    if (term !== undefined && !seen.has(term)) {
      seen.add(term);
      terms.push(term);
    }
  });
  return terms;
}
