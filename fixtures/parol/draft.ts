/**
 * Small constructors for writing cases, so that a case reads as the document and its answer and
 * not as plumbing. Nothing here has behaviour that a case could depend on without seeing it: each
 * helper returns plain data in the shapes of types.ts.
 */
import type { DocLabel, EscalationCode } from "../../apps/parol/src/contracts.js";
import type {
  AnchorRef,
  EscalationExpectation,
  RuleExpectationSpec,
  SourceParagraph,
} from "./types.js";

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export const title = (text: string): SourceParagraph => ({ kind: "title", text });
export const heading = (text: string): SourceParagraph => ({ kind: "heading", text });
export const text = (value: string): SourceParagraph => ({ kind: "text", text: value });
export const clause = (number: string, value: string): SourceParagraph => ({
  kind: "clause",
  number,
  text: value,
});
export const item = (marker: string, value: string): SourceParagraph => ({
  kind: "item",
  marker,
  text: value,
});
export const signature = (first: string, second: string): SourceParagraph => ({
  kind: "signature",
  parties: [first, second],
});

/**
 * Marks a paragraph as the injected instruction. The builder removes it to make the twin, so no
 * anchor may point into it.
 */
export const injected = (paragraph: SourceParagraph): SourceParagraph => ({
  ...paragraph,
  injected: true,
});

/** A section: its heading without a number, then its clauses without numbers. */
export type SectionSpec = readonly [title: string, clauses: readonly (string | null)[]];

/**
 * Numbers sections from 1 and the clauses in each from 1, so that a variant that leaves a clause
 * or a whole section out renumbers itself and the surrounding text stays consistent. A `null`
 * clause is skipped, and a section with no clause left is skipped with its heading.
 */
export function numbered(sections: readonly SectionSpec[]): SourceParagraph[] {
  const out: SourceParagraph[] = [];
  let section = 0;
  for (const [name, clauses] of sections) {
    const kept = clauses.filter((value): value is string => value !== null);
    if (kept.length === 0) continue;
    section += 1;
    out.push(heading(`${section}. ${name}`));
    kept.forEach((value, i) => out.push(clause(`${section}.${i + 1}`, value)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------

export const at = (doc: DocLabel, clauseNumber: string | null, anchor: string): AnchorRef => ({
  doc,
  clause: clauseNumber,
  anchor,
});

export const NOT_EXPECTED: EscalationExpectation = { mode: "not_expected", codes: [] };
export const required = (...codes: EscalationCode[]): EscalationExpectation => ({
  mode: "required",
  codes,
});
export const allowed = (...codes: EscalationCode[]): EscalationExpectation => ({
  mode: "allowed",
  codes,
});

type WithoutStatus = Omit<RuleExpectationSpec, "status">;

export const compliant = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "compliant",
  ...spec,
});
export const deviation = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "deviation",
  ...spec,
});
export const missing = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "missing",
  ...spec,
});
export const notApplicable = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "not_applicable",
  ...spec,
});
export const undetermined = (spec: WithoutStatus): RuleExpectationSpec => ({
  status: "undetermined",
  ...spec,
});
