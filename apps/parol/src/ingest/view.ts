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

/** Whether the code point is a letter, a digit or an underscore. ASCII is answered without a call. */
function isWordPoint(point: number): boolean {
  if (point < 128) {
    return (
      (point >= 48 && point <= 57) ||
      (point >= 65 && point <= 90) ||
      (point >= 97 && point <= 122) ||
      point === 95
    );
  }
  return WORD_CHAR.test(String.fromCodePoint(point));
}

/** The code point that ends at `end`, which may be a surrogate pair, or -1 at the start. */
function pointBefore(text: string, end: number): number {
  if (end <= 0) return -1;
  const low = text.charCodeAt(end - 1);
  if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
    const high = text.charCodeAt(end - 2);
    if (high >= 0xd800 && high <= 0xdbff) return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
  }
  return low;
}

/** The code point that starts at `start`, or -1 at the end. */
function pointAt(text: string, start: number): number {
  return start >= text.length ? -1 : (text.codePointAt(start) ?? -1);
}

/** The first index at or after `from` whose preceding character is not a word character. */
function nextWordBoundary(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const unit = text.charCodeAt(at - 1);
    // A half of a surrogate pair is not tested whole, so it counts as a boundary. That is the
    // safe side: it can only make the caller look at one more position, never skip a match.
    if (unit < 128 ? !isWordPoint(unit) : !WORD_CHAR.test(text.charAt(at - 1))) return at;
    at++;
  }
  return text.length;
}

/**
 * Whether `term` occurs in `text` bounded by non-word characters on both sides. Case-sensitive.
 *
 * A term starts with a word character (see termShape), so a match can only begin where the
 * character before is not one, and after a failed match the search jumps to the next such
 * place. Without that, a term such as "aa" in a paragraph of "aaaa..." fails at every one of a
 * million positions, once per term; with it, the cost is one pass over the text per term.
 */
export function containsWholeWord(text: string, term: string): boolean {
  if (term === "") return false;
  const startsWithWord = isWordPoint(term.codePointAt(0)!);
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return false;
    const before = pointBefore(text, at);
    if (before >= 0 && isWordPoint(before)) {
      from = startsWithWord ? nextWordBoundary(text, at + 1) : at + 1;
      continue;
    }
    const after = pointAt(text, at + term.length);
    if (after < 0 || !isWordPoint(after)) return true;
    from = startsWithWord ? nextWordBoundary(text, at + 1) : at + 1;
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
// single-letter rule below. Months are here because a date written "Sept. 1, 2025" has a digit
// after the full stop, which looks like the start of a sentence; the cost is that a sentence that
// really ends with an abbreviated month and starts a new one is not cut. Company forms from other
// jurisdictions (Pty, Pte, Bhd, Sdn, Ltda) are here for the same reason as Inc and Ltd.
const ABBREVIATIONS = new Set([
  "no",
  "nos",
  "inc",
  "ltd",
  "co",
  "corp",
  "pty",
  "pte",
  "bhd",
  "sdn",
  "ltda",
  "cie",
  "mfg",
  "assn",
  "bros",
  "esq",
  "prof",
  "hon",
  "rev",
  "gen",
  "gov",
  "sen",
  "rep",
  "lt",
  "col",
  "capt",
  "sgt",
  "messrs",
  "mme",
  "sec",
  "secs",
  "art",
  "arts",
  "para",
  "paras",
  "cl",
  "subsec",
  "sched",
  "exh",
  "ref",
  "vol",
  "pt",
  "ch",
  "pp",
  "ss",
  "al",
  "viz",
  "amt",
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "ste",
  "ave",
  "blvd",
  "rd",
  "bldg",
  "apt",
  "vs",
  "approx",
  "dept",
  "fig",
  "cf",
  "jr",
  "sr",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
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
