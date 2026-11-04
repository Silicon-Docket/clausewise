import type { SourceSpan } from "../contracts.js";

/**
 * Which clause numbers a span answers to when an amendment refers to one. Retrieval (R2 puts the
 * amendment in front of the model) and verification (C1 `precedence_labels`, C2
 * `superseded_evidence` check that the model took the amendment into account) must read an
 * amendment's target the same way. If they did not, the model would be shown an amendment and
 * the check that its citation respects it would pass over the very clause it changes, or the
 * reverse. Both read targets through this file.
 *
 * Targets are the bare numbers an amendment writes ("6.1", "4", "II"). A span's number is the full
 * one ("6.1", "4.2").
 */

/**
 * A reference to clause N changes N and everything under it: "Section 6" reaches 6.1 and 6.2, and
 * "Section 6.1" reaches 6.1.2 but not 6. Roman numerals and lettered numbers compare
 * case-insensitively.
 */
export function targetsClause(target: string, clauseNumber: string): boolean {
  const t = target.trim().toLowerCase();
  const c = clauseNumber.trim().toLowerCase();
  return t !== "" && (c === t || c.startsWith(`${t}.`));
}

// A Roman numeral up to 39 (enough for the articles of an NDA), at least one letter long.
const ROMAN = "(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3})";
const KEYWORD = /^(?:section|article|clause|paragraph|part)\s+/i;
const ARABIC_AT_START = new RegExp(`^(\\d+(?:\\.\\d+)*)(?=[.):\\s\\u2013\\u2014-]|$)`);
const ROMAN_AFTER_KEYWORD = new RegExp(`^(${ROMAN})(?=[.):\\s\\u2013\\u2014-]|$)`, "i");
const BARE_ROMAN = new RegExp(`^(${ROMAN})(?=[.)]|$)`, "i");

/**
 * The section number a heading starts with: "2. Term" gives 2, "Section 6.1 Duration" gives 6.1,
 * "ARTICLE II - TERM" and "II. Term" give II. A heading without one gives null.
 */
export function headingNumber(heading: string | null): string | null {
  if (heading === null) return null;
  const text = heading.trim();
  const keyword = KEYWORD.exec(text);
  const rest = keyword === null ? text : text.slice(keyword[0].length);
  const arabic = ARABIC_AT_START.exec(rest);
  if (arabic !== null) return arabic[1]!;
  const roman = (keyword === null ? BARE_ROMAN : ROMAN_AFTER_KEYWORD).exec(rest);
  return roman === null ? null : roman[1]!;
}

/**
 * The numbers by which an amendment can refer to a span. A span answers to its own clause number,
 * and to the number its heading starts with, because an NDA does not always number the clause
 * itself:
 *  - the section number may sit in the heading and leave the body paragraph unnumbered ("2. Term"
 *    over "The obligations ... two years"), and a reference to Section 2 means that paragraph;
 *  - an article may be numbered in Roman numerals over clauses numbered 2.01 and 2.02, and a
 *    reference to Article II means them.
 * The heading's number is the section's, so a reference to clause 6.1 does not reach a clause
 * that is only under the heading "6. Term" (6.2, say), and a heading paragraph answers to
 * Section 6 and not to 6.1. A paragraph that follows the last clause of a section, a signature
 * block say, sits under that heading as well and answers to it; the cost of that is one span.
 */
export function referenceNumbers(span: Pick<SourceSpan, "clauseNumber" | "heading">): string[] {
  return [span.clauseNumber, headingNumber(span.heading)].filter(
    (n): n is string => n !== null && n.trim() !== "",
  );
}

/** Whether a reference to `target` reaches the span, by its own number or its heading's. */
export const targetsSpan = (
  target: string,
  span: Pick<SourceSpan, "clauseNumber" | "heading">,
): boolean => referenceNumbers(span).some((number) => targetsClause(target, number));

/**
 * How a person names the clause a span answers to in a message: its own number, else the number
 * of its section, else a question mark.
 */
export const clauseNameOf = (span: Pick<SourceSpan, "clauseNumber" | "heading">): string =>
  referenceNumbers(span)[0] ?? "?";
