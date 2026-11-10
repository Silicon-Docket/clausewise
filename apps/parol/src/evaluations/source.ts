/**
 * Where the comparison pages come from: a folder of files that the evaluation tooling publishes
 * and the application only reads. This is the seam between the two. The service layer is given a
 * `ComparisonSource` and never a path or a repository, so it can be tested with a list in memory.
 *
 * Contract commit CC1 (package W2.5): the types below are the design's, section 3.4; `EMPTY_SOURCE`
 * is real; `createComparisonSource` returns it until W2.5 reads the folder.
 */

/**
 * The reasons a file in the folder is not a usable page, as fixed codes. The list is the design's
 * (W2.5 section 3.3); W2.5 moves it to `document.ts` with the page type and imports it back here.
 */
export type PageProblem =
  | "too_large"
  | "unreadable"
  | "not_json"
  | "not_a_comparison"
  | "fingerprint_mismatch"
  | "name_mismatch";

/** A placeholder for the page document of W2.5 section 3.3. STUB(W2.5): replace by the import from `./document.js`. */
export interface ComparisonPage {
  /** "cmp_" and the first 16 hex digits of the fingerprint. */
  readonly id: string;
}

export type SourceEntry =
  | { ok: true; id: string; publishedAt: string; page: ComparisonPage }
  | { ok: false; name: string; problem: PageProblem };

export interface ComparisonSource {
  /** Newest first (file modification time, then id), at most `maxFiles` entries. */
  list(): { entries: SourceEntry[]; truncated: boolean };
  /** Null for an id that is malformed, unknown or whose file is unreadable. Never touches the disk for a malformed id. */
  get(id: string): { page: ComparisonPage; publishedAt: string } | null;
}

/** A source with nothing in it: the default when none is given, and what a missing folder reads as. */
export const EMPTY_SOURCE: ComparisonSource = Object.freeze({
  list: () => ({ entries: [], truncated: false }),
  get: () => null,
});

export interface ComparisonSourceOptions {
  maxBytes?: number;
  maxFiles?: number;
}

/**
 * The source over the folder `dir`. STUB(W2.5): it returns the empty source for now, whatever the
 * folder holds, so the wiring in `main.ts` and the service factory are final and only this body
 * changes. It does not touch the disk.
 */
export function createComparisonSource(
  _dir: string,
  _options: ComparisonSourceOptions = {},
): ComparisonSource {
  return EMPTY_SOURCE;
}
