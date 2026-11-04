import { normalizeForAnchor } from "@clausewise/review";

/**
 * The text every annotation pattern reads. It is the same normalization that decides whether a
 * quote occurs in a span (@clausewise/review `normalizeForAnchor`): zero-width characters and soft
 * hyphens are deleted, runs of white space become one space, and typographic quotes and dashes
 * become straight ones. Matching on it means "Confi\u200bdential Information" and a document with
 * curly quotes are annotated like their plain forms, and a zero-width character inserted to split
 * an instruction-like phrase does not hide it. Case is kept, because defined terms are matched
 * case-sensitively.
 *
 * Annotations carry no offsets, so nothing needs to map a match back to the stored text.
 */
export const matchView = (text: string): string => normalizeForAnchor(text);

const WORD_CHAR = /^[\p{L}\p{N}_]$/u;

/** The code point that ends at `end`, which may be a surrogate pair. */
function codePointEndingAt(text: string, end: number): string {
  if (end <= 0) return "";
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(end - 2, end);
  }
  return text.charAt(end - 1);
}

function codePointAt(text: string, start: number): string {
  const point = text.codePointAt(start);
  return point === undefined ? "" : String.fromCodePoint(point);
}

/** Whether `term` occurs in `text` bounded by non-word characters on both sides. Case-sensitive. */
export function containsWholeWord(text: string, term: string): boolean {
  if (term === "") return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const before = codePointEndingAt(text, at);
    const after = codePointAt(text, at + term.length);
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = at + 1;
  }
}

export interface QuotedRun {
  /** What is between the quotes. */
  inner: string;
  /** Index of the opening quote. */
  start: number;
  /** Index just after the closing quote. */
  end: number;
}

/**
 * Pairs the straight quotes of a normalized view into quoted runs. A document may hold a stray
 * quote (an inch mark, a typo), and pairing blindly from the left would then shift every pair
 * after it. So a quote is paired with the next one only when what lies between passes `accept`;
 * otherwise it is treated as stray and the scan moves on by one quote. One pass, no backtracking.
 */
export function pairQuotes(view: string, accept: (inner: string) => boolean): QuotedRun[] {
  const positions: number[] = [];
  for (let i = view.indexOf('"'); i !== -1; i = view.indexOf('"', i + 1)) positions.push(i);
  const runs: QuotedRun[] = [];
  for (let k = 0; k < positions.length;) {
    const start = positions[k]!;
    const next = positions[k + 1];
    if (next !== undefined) {
      const inner = view.slice(start + 1, next);
      if (accept(inner)) {
        runs.push({ inner, start, end: next + 1 });
        k += 2;
        continue;
      }
    }
    k += 1;
  }
  return runs;
}

// Words that end in a full stop without ending the sentence. "e.g." and "i.e." are caught by the
// single-letter rule below.
const ABBREVIATIONS = new Set([
  "no",
  "nos",
  "inc",
  "ltd",
  "co",
  "corp",
  "sec",
  "secs",
  "art",
  "arts",
  "para",
  "paras",
  "cl",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "approx",
  "dept",
  "fig",
  "cf",
  "jr",
  "sr",
]);
const LETTER = /\p{L}/u;
const LOWERCASE = /\p{Ll}/u;

function endsSentence(view: string, dot: number): boolean {
  let after = dot + 1;
  // A full stop inside closing quotes or brackets, as in `... deleted."`, still ends the sentence.
  while (after < view.length && "\"')]".includes(view.charAt(after))) after++;
  if (after < view.length && view.charAt(after) !== " ") return false;
  let next = after;
  while (next < view.length && view.charAt(next) === " ") next++;
  // A sentence starts with a capital, a digit, a quote or a bracket. "Inc. and" goes on.
  if (next < view.length && LOWERCASE.test(view.charAt(next))) return false;
  let wordStart = dot;
  while (wordStart > 0 && LETTER.test(view.charAt(wordStart - 1))) wordStart--;
  const word = view.slice(wordStart, dot);
  if (word.length === 1) return false;
  return !ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Indexes of the characters that end a sentence for the purpose of reading amendment wording.
 * Semicolons and colons count: "Section 3 is deleted; Section 4 is replaced" has two operations,
 * and the text after "to read as follows:" is new wording, not a description of the operation.
 */
export function sentenceCuts(view: string): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < view.length; i++) {
    switch (view.charCodeAt(i)) {
      case 59: // ;
      case 58: // :
      case 33: // !
      case 63: // ?
        cuts.push(i);
        break;
      case 46: // .
        if (endsSentence(view, i)) cuts.push(i);
        break;
    }
  }
  return cuts;
}

/** The first index in the sorted `values` that is at least `target`. */
export function lowerBound(values: readonly number[], target: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid]! < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The half-open range of the sentence that holds `position`. */
export function sentenceAround(
  cuts: readonly number[],
  position: number,
  length: number,
): { start: number; end: number } {
  const at = lowerBound(cuts, position);
  return { start: at === 0 ? 0 : cuts[at - 1]! + 1, end: at < cuts.length ? cuts[at]! : length };
}
