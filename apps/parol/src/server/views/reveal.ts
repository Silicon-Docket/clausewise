import { hasNoVisibleText } from "../../ingest/invisible.js";

/**
 * Document text can hold characters a reader cannot see: zero-width spaces that split a word,
 * and direction overrides that make later text read in a different order. A reviewer deciding
 * whether a quote is really in the document should be able to see that they are there, so pages
 * print each one as a visible marker instead of passing it through.
 *
 * A run of the same invisible character is one marker with a count, and a text can carry only
 * `MAX_MARKERS` markers. A hostile file can hold a million zero-width characters in a few
 * kilobytes once it is compressed, and printing each one would turn a page for one finding into
 * tens of megabytes of markup.
 */
export type Piece =
  | { kind: "text"; text: string }
  | {
      kind: "invisible";
      marker: string;
      name: string;
      /** How many characters this marker stands for. Left out when it is one. */
      count?: number;
    };

/** The most markers one text prints. Beyond it the rest are counted in a single closing marker. */
export const MAX_MARKERS = 200;

const NAMES: Record<number, string> = {
  0x00ad: "soft hyphen",
  0x200b: "zero-width space",
  0x200c: "zero-width non-joiner",
  0x200d: "zero-width joiner",
  0x200e: "left-to-right mark",
  0x200f: "right-to-left mark",
  0x202a: "left-to-right embedding",
  0x202b: "right-to-left embedding",
  0x202c: "pop directional formatting",
  0x202d: "left-to-right override",
  0x202e: "right-to-left override",
  0x2060: "word joiner",
  0x2066: "left-to-right isolate",
  0x2067: "right-to-left isolate",
  0x2068: "first strong isolate",
  0x2069: "pop directional isolate",
  0xfeff: "zero-width no-break space",
};

/**
 * Characters that print as a gap, so a reader sees them as one. JavaScript's `\s` also counts the
 * byte order mark (U+FEFF) as white space, but it prints as nothing, so it is not in this list.
 */
const GAPS: readonly (readonly [number, number])[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];

const isGap = (codePoint: number): boolean =>
  GAPS.some(([from, to]) => codePoint >= from && codePoint <= to);

const isInvisible = (char: string): boolean =>
  !isGap(char.codePointAt(0) ?? 0) && hasNoVisibleText(char);

/** `[U+202E]`, with at least four hex digits, or `[U+200B x 5]` for a run of five. */
export const markerOf = (codePoint: number, count = 1): string =>
  `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}${count > 1 ? ` x ${count}` : ""}]`;

export const nameOf = (codePoint: number): string => NAMES[codePoint] ?? "invisible character";

/**
 * The text as pieces: runs of ordinary text, and one piece for each run of one invisible
 * character. Joining the `text` pieces and the original invisible characters, repeated by their
 * counts, in order gives back the input, unless the text held more than `MAX_MARKERS` runs: then
 * the last piece counts the characters that were left out.
 */
export function revealInvisible(text: string): Piece[] {
  const pieces: Piece[] = [];
  const codePoints = new Map<Piece, number>();
  let run = "";
  let markers = 0;
  let omitted = 0;
  // The marker just printed, while nothing but more of the same character has followed it.
  let open: (Piece & { kind: "invisible" }) | null = null;

  for (const char of text) {
    if (!isInvisible(char)) {
      run += char;
      open = null;
      continue;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (open !== null && codePoints.get(open) === codePoint) {
      open.count = (open.count ?? 1) + 1;
      continue;
    }
    if (markers >= MAX_MARKERS) {
      omitted += 1;
      open = null;
      continue;
    }
    if (run !== "") pieces.push({ kind: "text", text: run });
    run = "";
    open = { kind: "invisible", marker: markerOf(codePoint), name: nameOf(codePoint) };
    codePoints.set(open, codePoint);
    pieces.push(open);
    markers += 1;
  }
  if (run !== "") pieces.push({ kind: "text", text: run });

  for (const piece of pieces) {
    const codePoint = codePoints.get(piece);
    if (piece.kind === "invisible" && piece.count !== undefined && codePoint !== undefined) {
      piece.marker = markerOf(codePoint, piece.count);
    }
  }
  if (omitted > 0) {
    pieces.push({
      kind: "invisible",
      marker: `[+${omitted} more invisible characters]`,
      name: "the remainder, not listed one by one",
      count: omitted,
    });
  }
  return pieces;
}

/**
 * The text with every invisible character shown as its marker, as one string. For places that can
 * hold text and nothing else, such as a page title or the text of an option.
 */
export function revealToString(text: string): string {
  return revealInvisible(text)
    .map((piece) => (piece.kind === "text" ? piece.text : piece.marker))
    .join("");
}
