import { locateQuote } from "@clausewise/review";
import type { QuoteCheck } from "./contracts.js";

export interface QuoteVerification {
  check: QuoteCheck;
  /** Set only for a unique, verified quote: offsets into the span text as stored. */
  offsets: { start: number; end: number } | null;
  /** How many times the quote occurs in the span. Zero when it is not found. */
  occurrences: number;
}

/**
 * Quotation validity: does this quote occur in this span, word for word, once the fixed
 * normalization has been applied to both? It says nothing about whether the quote supports a
 * conclusion; that is a separate check. A quote that occurs more than once is `ambiguous`: it is
 * in the document, but it does not identify one place, so it has no offsets.
 */
export function verifyQuote(spanText: string, quote: string): QuoteVerification {
  const at = locateQuote(spanText, quote);
  switch (at.found) {
    case "one":
      return { check: "verified", offsets: { start: at.start, end: at.end }, occurrences: 1 };
    case "many":
      return { check: "ambiguous", offsets: null, occurrences: at.count };
    case "none":
      return { check: "not_found", offsets: null, occurrences: 0 };
  }
}
