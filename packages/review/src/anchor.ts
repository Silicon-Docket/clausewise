import type { Clause, ClauseParagraph, ProposedEdit } from "./types.js";

export type AnchorResult =
  | {
      ok: true;
      paragraphId: string;
      /** Offsets into the paragraph's text as it appears in the document, not the normalized form. */
      start: number;
      end: number;
      /** The exact document text at [start, end). */
      original: string;
      /** As proposed, less the edge whitespace that the quote lost when it was trimmed. */
      replacement: string;
    }
  | { ok: false; reason: string };

// A model-proposed edit may change the contract only when its quote provably names one span.
// The comparison is exact apart from the fixed normalization below, which absorbs the ways a
// model and a Word file legitimately disagree about how the same characters are written. There
// is deliberately no tolerance beyond it: a quote that is almost right must fail, because an
// edit written over the wrong words is worse than no edit. The span must also start and end on
// word boundaries, since a redline that cuts a word in half is wrong however exact the text is.

// Invisible in Word, and routinely dropped or added when a model copies text.
function isDeleted(c: number): boolean {
  return (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff || c === 0x00ad;
}

// The Unicode White_Space set. Zero-width characters are not in it: they are invisible, so they
// must not create a gap between two words.
function isSpace(c: number): boolean {
  return (
    (c >= 0x09 && c <= 0x0d) ||
    c === 0x20 ||
    c === 0x85 ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000
  );
}

// Word autocorrects straight quotes and dashes to typographic ones, and models hand them back
// either way. Every target is one UTF-16 unit, so folding never moves an offset.
function fold(c: number): number {
  switch (c) {
    case 0x2018:
    case 0x2019:
    case 0x201a:
    case 0x201b:
    case 0x2039:
    case 0x203a:
    case 0x02bc:
    case 0xff07:
      return 0x27;
    case 0x201c:
    case 0x201d:
    case 0x201e:
    case 0x201f:
    case 0x00ab:
    case 0x00bb:
    case 0xff02:
      return 0x22;
    case 0x2010:
    case 0x2011:
    case 0x2012:
    case 0x2013:
    case 0x2014:
    case 0x2015:
    case 0x2212:
      return 0x2d;
    default:
      return c;
  }
}

interface Normalized {
  text: string;
  /**
   * For each UTF-16 unit of `text`, the source offset of the character it came from, or of the
   * first character of the gap it stands for.
   */
  origin: Int32Array;
}

// Spreading a long typed array into one call overflows the argument limit.
const CHUNK = 8192;

function normalize(source: string): Normalized {
  const length = source.length;
  const codes = new Uint16Array(length);
  const origin = new Int32Array(length);
  let n = 0;
  let inSpace = false;
  for (let i = 0; i < length; i++) {
    const c = source.charCodeAt(i);
    // A deleted character leaves the whitespace state alone, so a space, a zero-width space and
    // another space are one gap.
    if (isDeleted(c)) continue;
    if (isSpace(c)) {
      if (!inSpace) {
        codes[n] = 0x20;
        origin[n] = i;
        n++;
        inSpace = true;
      }
      continue;
    }
    inSpace = false;
    codes[n] = fold(c);
    origin[n] = i;
    n++;
  }
  let text = "";
  for (let i = 0; i < n; i += CHUNK) {
    text += String.fromCharCode(...codes.subarray(i, Math.min(i + CHUNK, n)));
  }
  return { text, origin };
}

/** The form in which quotes and paragraphs are compared, before a quote is trimmed. */
export function normalizeForAnchor(text: string): string {
  return normalize(text).text;
}

// Collapsed whitespace leaves at most one space at either end.
function trimSpace(text: string): string {
  const start = text.charCodeAt(0) === 0x20 ? 1 : 0;
  const end = text.length > start && text.charCodeAt(text.length - 1) === 0x20 ? -1 : undefined;
  return text.slice(start, end);
}

// A cut between the halves of a surrogate pair corrupts the character, and the docx engine
// refuses it. Only a quote holding a lone surrogate can ask for one, and it must not match.
function splitsPair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const at = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

// Letters, digits and the combining marks that belong to a letter, so a span never separates an
// accent from its base. A character that normalization folds to punctuation counts as that
// punctuation, which keeps every apostrophe in "Recipient's" a word boundary, whichever one the
// document uses.
const WORD_CHAR = /^[\p{L}\p{N}\p{M}]$/u;

function isWordChar(codePoint: number): boolean {
  return WORD_CHAR.test(String.fromCodePoint(fold(codePoint)));
}

// The character that ends at `offset`: a surrogate pair when the two units before it form one.
function codePointBefore(text: string, offset: number): number {
  const pair = offset >= 2 ? (text.codePointAt(offset - 2) ?? 0) : 0;
  return pair > 0xffff ? pair : text.charCodeAt(offset - 1);
}

// The neighbours of a span skip the characters normalization deletes, because the letters on
// either side of a zero-width character or a soft hyphen are one word as far as the quote can
// tell. Each skip stops at the first character that is not deleted, so a paragraph is walked at
// most once per side however many hits there are.
function wordCharBefore(text: string, offset: number): boolean {
  let i = offset;
  while (i > 0 && isDeleted(text.charCodeAt(i - 1))) i--;
  return i > 0 && isWordChar(codePointBefore(text, i));
}

function wordCharAfter(text: string, offset: number): boolean {
  let i = offset;
  while (i < text.length && isDeleted(text.charCodeAt(i))) i++;
  return i < text.length && isWordChar(text.codePointAt(i) ?? 0);
}

// A side that starts or ends on punctuation is not constrained: only a span edge that is itself
// part of a word can cut that word. A hyphen is such punctuation, so "non" anchors in
// "non-disclosure".
function cutsWord(text: string, start: number, end: number): boolean {
  return (
    (isWordChar(text.codePointAt(start) ?? 0) && wordCharBefore(text, start)) ||
    (isWordChar(codePointBefore(text, end)) && wordCharAfter(text, end))
  );
}

interface Hit {
  paragraph: ClauseParagraph;
  start: number;
  end: number;
}

interface Scan {
  /** Occurrences that identify a span: they are in the paragraph and do not cut a word. */
  count: number;
  /** Occurrences of the text that were left out because they start or end inside a word. */
  inWord: number;
  first?: Hit;
}

function scan(paragraph: ClauseParagraph, quote: string): Scan {
  // An empty needle matches at every offset, which would never end the search below. And
  // normalizing never lengthens text, so a shorter paragraph cannot contain the quote.
  if (quote === "" || paragraph.text.length < quote.length) return { count: 0, inWord: 0 };
  const norm = normalize(paragraph.text);
  let count = 0;
  let inWord = 0;
  let first: Hit | undefined;
  // Each search resumes one unit after the last hit, so overlapping occurrences count.
  for (let at = norm.text.indexOf(quote); at !== -1; at = norm.text.indexOf(quote, at + 1)) {
    // A quote is trimmed, so it starts and ends on a character that maps to exactly one source
    // unit, and any gap inside the match is covered whole by the offsets at its two ends.
    const start = norm.origin[at]!;
    const end = norm.origin[at + quote.length - 1]! + 1;
    if (splitsPair(paragraph.text, start) || splitsPair(paragraph.text, end)) continue;
    // Judged on the document's own characters. A hit inside a word is not an occurrence of the
    // quote as the model meant it, so it must not make a unique quote look ambiguous.
    if (cutsWord(paragraph.text, start, end)) {
      inWord++;
      continue;
    }
    count++;
    first ??= { paragraph, start, end };
  }
  return first ? { count, inWord, first } : { count, inWord };
}

// Removes whitespace from the sides where the quote lost it, and nothing else.
export function trimEdges(text: string, leading: boolean, trailing: boolean): string {
  let start = 0;
  let end = text.length;
  while (leading && start < end && isSpace(text.charCodeAt(start))) start++;
  while (trailing && end > start && isSpace(text.charCodeAt(end - 1))) end--;
  return text.slice(start, end);
}

const fail = (reason: string): AnchorResult => ({ ok: false, reason });

/**
 * Decides whether a proposed edit may change the document. It may only if its quote occurs
 * exactly once across the clause's paragraphs, after one fixed normalization applied to both
 * sides: whitespace runs collapse to a space, typographic quotes and dashes become straight
 * ones, and zero-width characters and soft hyphens are removed. Case, wording and punctuation
 * otherwise have to match exactly. A hit counts only if it does not cut a word: where the quote
 * starts or ends on a letter, digit or combining mark, the document character beside that edge
 * must not be one. The quote's edge whitespace is trimmed, and the replacement loses the same on
 * those sides.
 * Reasons never repeat the quote or any document text, so they are safe to log and to show.
 */
export function anchorEdit(clauses: Clause[], proposed: ProposedEdit): AnchorResult {
  const clause = clauses.find((c) => c.id === proposed.clauseId);
  if (!clause) return fail("the clause id does not match any clause in the document");

  const spaced = normalize(proposed.quote).text;
  const quote = trimSpace(spaced);
  if (quote === "") return fail("the quote is empty");
  // Trimmed on both sides: the quote lost its edge whitespace, so a replacement that keeps it
  // is the same text, and applying it would only insert a stray space.
  if (quote === trimSpace(normalize(proposed.replacement).text)) {
    return fail("the replacement is identical to the quote, so there is nothing to change");
  }

  let count = 0;
  let inWord = 0;
  let hit: Hit | undefined;
  for (const paragraph of clause.paragraphs) {
    const found = scan(paragraph, quote);
    count += found.count;
    inWord += found.inWord;
    hit ??= found.first;
  }

  if (count > 1) {
    return fail(
      `the quote is ambiguous: it occurs ${count} times in the clause, so it does not identify one span`,
    );
  }
  if (count === 0 || !hit) {
    return fail(
      inWord > 0
        ? "the quote was not found as whole words within a single paragraph of the clause"
        : "the quote was not found within a single paragraph of the clause",
    );
  }
  return {
    ok: true,
    paragraphId: hit.paragraph.id,
    start: hit.start,
    end: hit.end,
    original: hit.paragraph.text.slice(hit.start, hit.end),
    // The span excludes the whitespace the quote was trimmed of, so a replacement that kept it
    // would double the space that stays in the document.
    replacement: trimEdges(
      proposed.replacement,
      spaced.charCodeAt(0) === 0x20,
      spaced.charCodeAt(spaced.length - 1) === 0x20,
    ),
  };
}
