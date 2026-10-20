import type { Rule } from "@clausewise/playbook";
import { renderClauses } from "./prompt.js";
import type { Clause, RuleCheck } from "./types.js";

/**
 * Over-estimates on purpose. English prose runs near four characters per token, but contracts are
 * full of numbers, section references and defined terms, and other languages tokenise worse.
 * Undercounting overflows the model's context window and fails the call, while overcounting only
 * costs an extra window. UTF-16 length counts an astral character twice, which also errs high.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Splits clauses into consecutive windows that each fit in `maxTokens` once the playbook rule and
 * instructions are included. Adjacent windows overlap by `overlap` clauses. A clause is never cut;
 * one that is too big on its own gets a window to itself. Clauses are costed one by one, so the
 * blank line between them is not counted; the headroom in estimateTokens covers it.
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
 */
export function mergeWindowChecks(rule: Rule, checks: RuleCheck[]): RuleCheck {
  const first = checks[0];
  if (first === undefined) {
    throw new Error(`no window checks to merge for rule "${rule.id}"`);
  }

  const deviations = checks.filter((check) => check.status === "deviation");
  const baseDeviation = deviations[0];
  if (baseDeviation !== undefined) {
    const edit =
      baseDeviation.edit ?? deviations.find((check) => check.edit !== null)?.edit ?? null;
    return {
      status: "deviation",
      clauseIds: unique(deviations.flatMap((check) => check.clauseIds)),
      explanation: baseDeviation.explanation,
      comment: baseDeviation.comment,
      edit: edit === null ? null : { ...edit },
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
  const base = checks.find((check) => check.status === status) ?? first;
  // An empty string is the model's way of saying it has no wording, and null is the schema's.
  const suggestedClause =
    status === "missing"
      ? (checks.find((check) => (check.suggestedClause ?? "").trim() !== "")?.suggestedClause ??
        null)
      : null;
  return {
    status,
    clauseIds: [],
    explanation: base.explanation,
    comment: status === "missing" ? base.comment : "",
    edit: null,
    suggestedClause,
  };
}
