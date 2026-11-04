import type { SourceSpan } from "../contracts.js";
import type { StoredSpan } from "./types.js";

/**
 * The spans of a run as the stages read them, rebuilt from the store.
 *
 * `buildIngest` gives each span a model label, `c<N>` with N counting from 1 across the spans of
 * all the run's documents in the order D1, D2, D3. The store keeps no label because the label
 * depends on which versions the run uses. `listSpans` returns the spans in exactly that order
 * (document ordinal, version, paragraph), so numbering them as they come reproduces the labels
 * `buildIngest` assigned when the same versions were ingested. Nothing else about a span differs:
 * a `StoredSpan` is a `SourceSpan` without its model label, plus where it sits.
 *
 * Pass the spans of the operative version of every document of the run, and only those. A span
 * list in any other order, or with a document missing, would number the spans differently from
 * the ingest the run was started with, so the order is checked and a list that is out of order is
 * refused.
 */
export function toSourceSpans(stored: readonly StoredSpan[]): SourceSpan[] {
  let previous: StoredSpan | undefined;
  return stored.map((span, index) => {
    if (previous !== undefined) {
      const sameDocument = previous.docLabel === span.docLabel;
      const inOrder = sameDocument
        ? span.paragraphIndex > previous.paragraphIndex
        : span.docLabel > previous.docLabel;
      if (!inOrder) throw new Error("toSourceSpans: spans are not in document and paragraph order");
    }
    previous = span;
    return {
      id: span.id,
      label: span.label,
      modelLabel: `c${index + 1}`,
      documentVersionId: span.documentVersionId,
      docLabel: span.docLabel,
      paragraphIndex: span.paragraphIndex,
      clauseId: span.clauseId,
      clauseNumber: span.clauseNumber,
      heading: span.heading,
      text: span.text,
      textSha256: span.textSha256,
    };
  });
}
