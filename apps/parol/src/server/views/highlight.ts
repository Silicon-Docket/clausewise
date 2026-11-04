/**
 * Splits a paragraph at the offsets of a verified quote so a page can wrap the quote in `<mark>`.
 *
 * The offsets come from the verify stage, but this function does not rely on that: it is the last
 * step before text reaches a reader, so it treats every offset as untrusted. Whatever it is given,
 * the segments joined together are exactly `text`, none is empty, and a highlighted segment never
 * covers text outside the paragraph.
 */
export interface Offsets {
  /** UTF-16 code unit index of the first highlighted character. */
  start: number;
  /** UTF-16 code unit index just after the last highlighted character. */
  end: number;
}

export interface Segment {
  text: string;
  highlighted: boolean;
}

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * One offset pair, made safe, or null when it is not usable.
 *
 * Rejected: anything that is not a pair of whole numbers, a reversed or empty range, and a range
 * that lies wholly outside the text. A range that only overhangs the text is clamped to it. A
 * boundary that would fall between the two halves of a surrogate pair moves outward to the whole
 * character, because two lone halves would each print as a replacement character.
 */
function sanitize(text: string, raw: unknown): [number, number] | null {
  if (typeof raw !== "object" || raw === null) return null;
  // Own properties only, so a polluted prototype cannot supply an offset.
  if (!Object.hasOwn(raw, "start") || !Object.hasOwn(raw, "end")) return null;
  const { start, end } = raw as { start: unknown; end: unknown };
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (end <= start) return null;
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from >= to) return null;
  if (from > 0 && isLow(text.charCodeAt(from)) && isHigh(text.charCodeAt(from - 1))) from -= 1;
  if (to < text.length && isLow(text.charCodeAt(to)) && isHigh(text.charCodeAt(to - 1))) to += 1;
  return [from, to];
}

export function splitByOffsets(
  text: string,
  offsets: Offsets | readonly Offsets[] | null | undefined,
): Segment[] {
  if (text === "") return [];
  const list: readonly unknown[] =
    offsets === null || offsets === undefined ? [] : Array.isArray(offsets) ? offsets : [offsets];

  const ranges: [number, number][] = [];
  for (const raw of list) {
    const range = sanitize(text, raw);
    if (range !== null) ranges.push(range);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Overlapping and touching ranges become one, so the output never has two highlighted
  // segments in a row.
  const merged: [number, number][] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const [from, to] of merged) {
    if (from > cursor) segments.push({ text: text.slice(cursor, from), highlighted: false });
    segments.push({ text: text.slice(from, to), highlighted: true });
    cursor = to;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
  return segments;
}

// ---------------------------------------------------------------------------------------------
// Does the range hold the quote?
// ---------------------------------------------------------------------------------------------

/** Dropped from both sides before a quote is compared: invisible in Word, and often lost in copying. */
const isDeleted = (c: number): boolean =>
  (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff || c === 0x00ad;

/** The Unicode White_Space set, which collapses to one space. Zero-width characters are not in it. */
const isSpace = (c: number): boolean =>
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
  c === 0x3000;

/** Typographic quotes and dashes become straight ones. Every target is one UTF-16 unit. */
function fold(c: number): number {
  if ([0x2018, 0x2019, 0x201a, 0x201b, 0x2039, 0x203a, 0x02bc, 0xff07].includes(c)) return 0x27;
  if ([0x201c, 0x201d, 0x201e, 0x201f, 0x00ab, 0x00bb, 0xff02].includes(c)) return 0x22;
  if ((c >= 0x2010 && c <= 0x2015) || c === 0x2212) return 0x2d;
  return c;
}

/**
 * The form in which the verify stage compares a quote with a paragraph: zero-width characters and
 * soft hyphens removed, runs of white space made one space, typographic quotes and dashes made
 * straight, and one space trimmed from each end. It is the same fixed normalization as
 * `normalizeForAnchor` in the review package, written out here because a page may not depend on
 * the review engine; a test compares the two.
 */
export function normalizeQuote(text: string): string {
  let out = "";
  let inSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (isDeleted(c)) continue;
    if (isSpace(c)) {
      if (!inSpace) out += " ";
      inSpace = true;
      continue;
    }
    inSpace = false;
    out += String.fromCharCode(fold(c));
  }
  return out.replace(/^ /, "").replace(/ $/, "");
}

/**
 * The range to highlight for a verified quote, or null when the paragraph does not bear it out.
 * The offsets are made safe as `splitByOffsets` makes them, and the text they cover must be the
 * quote under the verifier's normalization. A range that is out of bounds, empty, or on other
 * words gives null, so a page never marks words the quote does not say.
 */
export function confirmedRange(text: string, offsets: unknown, quote: string): Offsets | null {
  const range = sanitize(text, offsets);
  if (range === null) return null;
  const needle = normalizeQuote(quote);
  if (needle === "") return null;
  if (normalizeQuote(text.slice(range[0], range[1])) !== needle) return null;
  return { start: range[0], end: range[1] };
}
