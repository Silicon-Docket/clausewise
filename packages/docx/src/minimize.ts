const TOKEN = /\s+|\S+/g;

// Each fold maps one UTF-16 unit to one unit, so offsets in folded text are offsets in the
// original. The sets match the ones the anchoring step folds, so a quote it found is a quote the
// trimming also treats as the same.
const SINGLE_QUOTES = /[\u2018-\u201B\u2039\u203A\u02BC\u2032\u2035\uFF07]/g;
const DOUBLE_QUOTES = /[\u201C-\u201F\u00AB\u00BB\u2033\u2036\uFF02]/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Makes curly and straight quotes, the dashes and the no-break spaces compare equal. Word turns
 * quotes curly on its own, and a model writing a replacement usually types straight ones.
 */
export function foldTypography(text: string): string {
  return text
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(SPACES, " ");
}

/**
 * Trims the words an edit leaves unchanged off both ends, so a redline shows
 * "three (3)" struck and "two (2)" inserted instead of the whole sentence replaced.
 * `offset` is how far the trimmed edit starts after the original start. Words that differ only
 * in typography count as unchanged and stay as the document has them.
 */
export function trimEdit(
  original: string,
  replacement: string,
): { offset: number; removed: string; inserted: string } {
  const a = original.match(TOKEN) ?? [];
  const b = replacement.match(TOKEN) ?? [];
  const fa = a.map(foldTypography);
  const fb = b.map(foldTypography);
  let head = 0;
  while (head < a.length && head < b.length && fa[head] === fb[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    fa[a.length - 1 - tail] === fb[b.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    offset: a.slice(0, head).join("").length,
    removed: a.slice(head, a.length - tail).join(""),
    inserted: b.slice(head, b.length - tail).join(""),
  };
}

/** True when the text has curly quotes, which is how Word writes them unless autocorrect is off. */
export function usesTypographicQuotes(text: string): boolean {
  return /[\u2018\u2019\u201C\u201D]/.test(text);
}

// What may stand just before an opening quote: nothing, a space, an opening bracket, a dash or
// another opening quote.
const OPENS_QUOTE = /^$|[\s([{<\u2013\u2014\u2018\u201C]$/;

function lastCodePoint(text: string): string {
  const tail = text.slice(-2);
  return /^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(tail) ? tail : tail.slice(-1);
}

/**
 * Turns straight quotes and apostrophes in inserted text into curly ones. `before` is the text
 * that precedes the insertion, which decides whether the first quote opens or closes.
 */
export function curlyQuotes(inserted: string, before: string): string {
  let out = "";
  let prev = lastCodePoint(before);
  for (const ch of inserted) {
    let next = ch;
    if (ch === "'") {
      if (/[\p{L}\p{N}]$/u.test(prev)) next = "\u2019";
      else next = OPENS_QUOTE.test(prev) ? "\u2018" : "\u2019";
    } else if (ch === '"') {
      next = OPENS_QUOTE.test(prev) ? "\u201C" : "\u201D";
    }
    out += next;
    prev = next;
  }
  return out;
}

/** Writes the inserted text in the quote style of the paragraph it goes into. */
export function matchQuoteStyle(inserted: string, paragraph: string, at: number): string {
  if (!/['"]/.test(inserted) || !usesTypographicQuotes(paragraph)) return inserted;
  return curlyQuotes(inserted, paragraph.slice(0, at));
}
