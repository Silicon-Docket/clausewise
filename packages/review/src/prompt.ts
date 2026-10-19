import type { Playbook, Rule } from "@clausewise/playbook";
import type { Clause, RuleCheck } from "./types.js";

// STUBS: replaced by the prompt workstream.

/** Rough token estimate used to size windows. Errs high. */
export function estimateTokens(_text: string): number {
  throw new Error("not implemented");
}

/** The contract as it is shown to the model, one clause per entry, each tagged with its id. */
export function renderClauses(_clauses: Clause[]): string {
  throw new Error("not implemented");
}

export function buildRulePrompt(_args: { playbook: Playbook; rule: Rule; clauses: Clause[] }): {
  system: string;
  prompt: string;
} {
  throw new Error("not implemented");
}

/**
 * Splits clauses into consecutive windows that each fit in `maxTokens` once the playbook rule and
 * instructions are included. Adjacent windows overlap by `overlap` clauses. A clause is never cut;
 * one that is too big on its own gets a window to itself.
 */
export function windowClauses(
  _clauses: Clause[],
  _args: { maxTokens: number; reservedTokens: number; overlap?: number },
): Clause[][] {
  throw new Error("not implemented");
}

/** Combines one rule's answers from several windows into a single answer. */
export function mergeWindowChecks(_rule: Rule, _checks: RuleCheck[]): RuleCheck {
  throw new Error("not implemented");
}
