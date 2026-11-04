/**
 * Maps the anchors of an answer key to the spans of a run. A key names a passage by document
 * label, clause number and a few words; a run has span ids of its own, new for every matter. The
 * words must occur exactly once in the named clause, as the builder checked when it made the
 * key, and a run whose documents no longer agree fails loudly and does not score as a miss.
 *
 * Errors name the document, the clause and a count. They never repeat the anchor or any span
 * text, so an evaluation log holds ids and numbers only.
 */
import type { SourceSpan, SpanId } from "../../../apps/parol/src/contracts.js";
import { countOccurrences } from "../../../fixtures/parol/anchors.js";
import type { AnchorRef } from "../../../fixtures/parol/types.js";

export class AnchorResolutionError extends Error {
  override name = "AnchorResolutionError";
}

export type AnchorFound =
  | { ok: true; span: SourceSpan }
  | {
      ok: false;
      reason: "no_document" | "no_clause" | "not_found" | "ambiguous";
      occurrences: number;
    };

/**
 * Finds the span an anchor names. A span is in the clause when its document label and its clause
 * number equal the anchor's (a null clause number matches a null one: a title, a preamble, a
 * heading or a signature line). Occurrences are counted over all spans of the clause.
 */
export function findAnchor(spans: readonly SourceSpan[], ref: AnchorRef): AnchorFound {
  const ofDocument = spans.filter((span) => span.docLabel === ref.doc);
  if (ofDocument.length === 0) return { ok: false, reason: "no_document", occurrences: 0 };
  const inClause = ofDocument.filter((span) => span.clauseNumber === ref.clause);
  if (inClause.length === 0) return { ok: false, reason: "no_clause", occurrences: 0 };
  let total = 0;
  let found: SourceSpan | undefined;
  for (const span of inClause) {
    const n = countOccurrences(span.text, ref.anchor);
    if (n > 0) found = span;
    total += n;
  }
  if (total === 0 || found === undefined) return { ok: false, reason: "not_found", occurrences: 0 };
  if (total > 1) return { ok: false, reason: "ambiguous", occurrences: total };
  return { ok: true, span: found };
}

/** The id of the one span the anchor names. Throws `AnchorResolutionError` otherwise. */
export function resolveAnchor(spans: readonly SourceSpan[], ref: AnchorRef, context = ""): SpanId {
  const found = findAnchor(spans, ref);
  if (found.ok) return found.span.id;
  const where = `${context === "" ? "" : `${context} `}${ref.doc} ${ref.clause === null ? "outside any numbered clause" : `clause ${ref.clause}`}`;
  switch (found.reason) {
    case "no_document":
      throw new AnchorResolutionError(`anchor in ${where}: the run has no such document`);
    case "no_clause":
      throw new AnchorResolutionError(`anchor in ${where}: the run has no span there`);
    case "not_found":
      throw new AnchorResolutionError(`anchor in ${where}: it occurs 0 times, expected once`);
    case "ambiguous":
      throw new AnchorResolutionError(
        `anchor in ${where}: it occurs ${found.occurrences} times, expected once`,
      );
  }
}

/** What the scorer asks for: the span id of an anchor in a case, for the run being scored. */
export type AnchorResolver = (caseKey: string, ref: AnchorRef) => SpanId;

/**
 * A resolver over the spans of each case of one run. The runner builds `spansByCase` from the
 * ingest output of that case's matter; a repeat that re-ingests the documents has span ids of its
 * own, so a resolver belongs to one repeat.
 */
export function createResolver(
  spansByCase: Readonly<Record<string, readonly SourceSpan[]>>,
): AnchorResolver {
  return (caseKey, ref) => {
    const spans = spansByCase[caseKey];
    if (spans === undefined) {
      throw new AnchorResolutionError(`anchor in ${caseKey}: the run has no spans for the case`);
    }
    return resolveAnchor(spans, ref, caseKey);
  };
}
