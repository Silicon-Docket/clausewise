import type { Rule } from "@clausewise/playbook";
import { renderClauses } from "./prompt.js";
import type { Clause, RuleCheck } from "./types.js";

// Latin, with its accents and extended blocks, ends below this code point. From here on come
// Greek, Cyrillic, Hebrew, Arabic, the Indic scripts, Thai, Chinese, Japanese, Korean and emoji,
// which tokenisers split into about one token per character.
const FIRST_WIDE_CODE_POINT = 0x250;

/**
 * Over-estimates on purpose. English prose runs near four characters per token, but contracts are
 * full of numbers, section references and defined terms, so Latin text is counted at one token per
 * three characters. Text in other scripts costs about a token per character, so each code point
 * from U+0250 up counts as a whole token. Undercounting overflows the model's context window and
 * fails the call, while overcounting only costs an extra window. An astral character is one code
 * point here, though it is two UTF-16 units, so it is not counted twice.
 */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < FIRST_WIDE_CODE_POINT) {
      narrow += 1;
      continue;
    }
    wide += 1;
    // A high surrogate and the low surrogate after it are one code point.
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
  }
  return wide + Math.ceil(narrow / 3);
}

/**
 * Splits clauses into consecutive windows that each fit in `maxTokens` once the playbook rule and
 * instructions are included. Adjacent windows overlap by `overlap` clauses. A clause is never cut;
 * one that is too big on its own gets a window to itself. Clauses are costed one by one, so the
 * two characters of blank line between them are not counted; the rounding up of each clause's cost
 * makes up for them.
 */
export function windowClauses(
  clauses: Clause[],
  args: { maxTokens: number; reservedTokens: number; overlap?: number },
): Clause[][] {
  const count = clauses.length;
  if (count === 0) return [];

  const budget = args.maxTokens - args.reservedTokens;
  const wanted = args.overlap ?? 1;
  const overlap = Number.isNaN(wanted) ? 0 : Math.max(0, Math.floor(wanted));

  // Cost of clauses[a..b) is cumulative[b] - cumulative[a].
  const cumulative = [0];
  for (const clause of clauses) {
    cumulative.push((cumulative.at(-1) ?? 0) + estimateTokens(renderClauses([clause])));
  }
  const cost = (from: number, to: number): number =>
    (cumulative[to] ?? 0) - (cumulative[from] ?? 0);

  const windows: Clause[][] = [];
  let start = 0;
  while (start < count) {
    // A window always takes its first clause, however big, so an oversize clause stands alone.
    let end = start + 1;
    while (end < count && cost(start, end + 1) <= budget) end += 1;
    windows.push(clauses.slice(start, end));
    if (end >= count) break;

    // The next window must reach a clause this one did not, so the overlap is trimmed until the
    // carried clauses and the first new clause fit together. Otherwise windows could repeat, and
    // an oversize clause never rides along as overlap. The max keeps an unbounded overlap from
    // sending the start back before the window it follows.
    start = Math.max(end - overlap, start + 1);
    while (start < end && cost(start, end + 1) > budget) start += 1;
  }
  return windows;
}

const unique = (values: string[]): string[] => [...new Set(values)];

/**
 * Combines one rule's answers from several windows into a single answer. A window that cannot see
 * a clause reports missing or not_applicable, which says nothing about the rest of the contract,
 * so any clause-level finding outweighs those: a deviation first, then compliance.
 *
 * The wording of the answer, its comment and its edit always come from one check. They describe
 * the same clause, and mixing them would put one window's tracked change under another window's
 * comment. Among deviations the base is the first one that proposes an edit, since an edit is
 * what the lawyer can act on, and otherwise the first deviation. The clause ids still name every
 * deviating clause, so the report lists them all.
 */
export function mergeWindowChecks(rule: Rule, checks: RuleCheck[]): RuleCheck {
  const first = checks[0];
  if (first === undefined) {
    throw new Error(`no window checks to merge for rule "${rule.id}"`);
  }

  const deviations = checks.filter((check) => check.status === "deviation");
  const baseDeviation = deviations.find((check) => check.edit !== null) ?? deviations[0];
  if (baseDeviation !== undefined) {
    return {
      status: "deviation",
      clauseIds: unique(deviations.flatMap((check) => check.clauseIds)),
      explanation: baseDeviation.explanation,
      comment: baseDeviation.comment,
      edit: baseDeviation.edit === null ? null : { ...baseDeviation.edit },
      suggestedClause: null,
    };
  }

  const compliant = checks.filter((check) => check.status === "compliant");
  const baseCompliant = compliant[0];
  if (baseCompliant !== undefined) {
    return {
      status: "compliant",
      clauseIds: unique(compliant.flatMap((check) => check.clauseIds)),
      explanation: baseCompliant.explanation,
      comment: "",
      edit: null,
      suggestedClause: null,
    };
  }

  const status = rule.required ? "missing" : "not_applicable";
  // An empty string is the model's way of saying it has no wording, and null is the schema's.
  const hasWording = (check: RuleCheck): boolean => (check.suggestedClause ?? "").trim() !== "";
  const ofStatus = checks.filter((check) => check.status === status);
  const pool = ofStatus.length > 0 ? ofStatus : checks;
  // For a missing clause the base is the check that brought wording, so the suggested clause is
  // never paired with another window's explanation.
  const base = (status === "missing" ? pool.find(hasWording) : undefined) ?? pool[0] ?? first;
  return {
    status,
    clauseIds: [],
    explanation: base.explanation,
    comment: status === "missing" ? base.comment : "",
    edit: null,
    suggestedClause: status === "missing" && hasWording(base) ? base.suggestedClause : null,
  };
}
