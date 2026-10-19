import type { Clause, ProposedEdit } from "./types.js";

export type AnchorResult =
  | {
      ok: true;
      paragraphId: string;
      /** Offsets into the paragraph's text as it appears in the document, not the normalized form. */
      start: number;
      end: number;
      /** The exact document text at [start, end). */
      original: string;
      replacement: string;
    }
  | { ok: false; reason: string };

// STUB: replaced by the anchor workstream.
export function anchorEdit(_clauses: Clause[], _proposed: ProposedEdit): AnchorResult {
  throw new Error("not implemented");
}
