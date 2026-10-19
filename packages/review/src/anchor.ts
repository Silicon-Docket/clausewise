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
      replacement: string;
    }
  | { ok: false; reason: string };

// A model-proposed edit may change the contract only when its quote provably names one span.
// The comparison is exact apart from the fixed normalization below, which absorbs the ways a
// model and a Word file legitimately disagree about how the same characters are written. There
// is deliberately no tolerance beyond it: a quote that is almost right must fail, because an
// edit written over the wrong words is worse than no edit.

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

interface Hit {
  paragraph: ClauseParagraph;
  start: number;
  end: number;
}

function scan(paragraph: ClauseParagraph, quote: string): { count: number; first?: Hit } {
  // An empty needle matches at every offset, which would never end the search below. And
  // normalizing never lengthens text, so a shorter paragraph cannot contain the quote.
  if (quote === "" || paragraph.text.length < quote.length) return { count: 0 };
  const norm = normalize(paragraph.text);
  let count = 0;
  let first: Hit | undefined;
  // Each search resumes one unit after the last hit, so overlapping occurrences count.
  for (let at = norm.text.indexOf(quote); at !== -1; at = norm.text.indexOf(quote, at + 1)) {
    // A quote is trimmed, so it starts and ends on a character that maps to exactly one source
    // unit, and any gap inside the match is covered whole by the offsets at its two ends.
    const start = norm.origin[at]!;
    const end = norm.origin[at + quote.length - 1]! + 1;
    if (splitsPair(paragraph.text, start) || splitsPair(paragraph.text, end)) continue;
    count++;
    first ??= { paragraph, start, end };
  }
  return first ? { count, first } : { count };
}

const fail = (reason: string): AnchorResult => ({ ok: false, reason });

/**
 * Decides whether a proposed edit may change the document. It may only if its quote occurs
 * exactly once across the clause's paragraphs, after one fixed normalization applied to both
 * sides: whitespace runs collapse to a space, typographic quotes and dashes become straight
 * ones, and zero-width characters and soft hyphens are removed. Case, wording and punctuation
 * otherwise have to match exactly. Reasons never repeat the quote or any document text, so they
 * are safe to log and to show.
 */
export function anchorEdit(clauses: Clause[], proposed: ProposedEdit): AnchorResult {
  const clause = clauses.find((c) => c.id === proposed.clauseId);
  if (!clause) return fail("the clause id does not match any clause in the document");

  const quote = trimSpace(normalize(proposed.quote).text);
  if (quote === "") return fail("the quote is empty");
  // Trimmed on both sides: the quote lost its edge whitespace, so a replacement that keeps it
  // is the same text, and applying it would only insert a stray space.
  if (quote === trimSpace(normalize(proposed.replacement).text)) {
    return fail("the replacement is identical to the quote, so there is nothing to change");
  }

  let count = 0;
  let hit: Hit | undefined;
  for (const paragraph of clause.paragraphs) {
    const found = scan(paragraph, quote);
    count += found.count;
    hit ??= found.first;
  }

  if (count > 1) {
    return fail(
      `the quote is ambiguous: it occurs ${count} times in the clause, so it does not identify one span`,
    );
  }
  if (count === 0 || !hit) {
    return fail("the quote was not found within a single paragraph of the clause");
  }
  return {
    ok: true,
    paragraphId: hit.paragraph.id,
    start: hit.start,
    end: hit.end,
    original: hit.paragraph.text.slice(hit.start, hit.end),
    replacement: proposed.replacement,
  };
}
