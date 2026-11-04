import type { DocxParagraph } from "@clausewise/docx";
import { UploadError } from "../module-contracts.js";

/** A plain text file is a contract typed into an editor, never anything larger than a few pages. */
export const MAX_TXT_BYTES = 2 * 1024 * 1024;
/**
 * Spans, annotations and model context all grow with the paragraph count, so the cap is on
 * paragraphs and not only on bytes: 2 MB of one-letter lines would otherwise be a million spans.
 */
export const MAX_PARAGRAPHS = 20_000;

// Characters Word shows as nothing. A line made only of them separates paragraphs, as an empty
// line does. This is the set the quote anchor in @clausewise/review deletes, so the two agree on
// what is invisible.
const INVISIBLE = /^[\s\u200b-\u200d\u2060\ufeff\u00ad]*$/;

// The patterns below follow the typed-number rules of segment() in @clausewise/review, which
// decides clause boundaries for a Word file. A line that segment would open a clause with must
// open a paragraph here, or the same text would be cut differently depending on the file type.
// The rules are copied rather than imported because segment keeps them private, and a test cuts
// the same text as TXT and as DOCX to catch the two drifting apart.

// 6.1  6.1.2  6.1.  (a bare integer needs a point or bracket, so "30 days" is not a number)
const DOTTED_NUMBER = /^\d{1,4}(?:\.\d{1,4}){1,5}[.)]?(?=\s|$)/;
const SINGLE_NUMBER = /^\d{1,4}[.)](?=\s|$)/;
// Section 4.  Article 2  Clause 3.1  \u00a7 5
const LABELLED_NUMBER =
  /^(?:(?:section|article|clause)\s+|[\u00a7\u00b6]\s*)\d{1,4}(?:\.\d{1,4}){0,5}[.)]?(?=\s|$)/i;
// A line that is only a label ("Schedule 1", "ARTICLE IV") is a heading on its own.
const LABEL_ONLY =
  /^(?:(?:section|article|clause|schedule|part|annex|annexure|exhibit|appendix)\s+(?:\d{1,4}(?:\.\d{1,4}){0,5}|[ivxlc]{1,6}|[a-z])|[\u00a7\u00b6]\s*\d{1,4}(?:\.\d{1,4}){0,5})[.:]?$/i;
// (a)  (iv)  (3)  [b]  a)
const PAREN_MARKER = /^(?:\(([a-z0-9]{1,6})\)|\[([a-z0-9]{1,6})\])/i;
const BARE_MARKER = /^([a-z]{1,6})\)(?=\s|$)/i;

const DIGITS = /^\d{1,3}$/;
const SINGLE_LETTER = /^[a-z]$/i;
const REPEATED_LETTER = /^([a-z])\1{1,2}$/i;
const ROMAN = /^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

// Well-formed markers only, so a bracketed word such as "[c1]" or "(see below)" is not one.
function isMarkerLabel(label: string): boolean {
  return (
    DIGITS.test(label) ||
    SINGLE_LETTER.test(label) ||
    REPEATED_LETTER.test(label) ||
    ROMAN.test(label.toLowerCase())
  );
}

/** Whether a trimmed line opens with a typed clause number or list marker. */
export function startsWithClauseNumber(line: string): boolean {
  if (
    DOTTED_NUMBER.test(line) ||
    SINGLE_NUMBER.test(line) ||
    LABELLED_NUMBER.test(line) ||
    LABEL_ONLY.test(line)
  ) {
    return true;
  }
  const bracketed = PAREN_MARKER.exec(line);
  if (bracketed !== null) return isMarkerLabel(bracketed[1] ?? bracketed[2] ?? "");
  const bare = BARE_MARKER.exec(line);
  return bare !== null && isMarkerLabel(bare[1] ?? "");
}

/**
 * The paragraph rule for plain text, in one place because every later stage depends on it:
 *
 * - A blank line (nothing but white space or invisible characters) separates paragraphs.
 * - Inside a block, a line that starts with a typed clause number ("2.", "6.1", "(a)",
 *   "Section 4.") starts a new paragraph.
 * - Any other single line break is a hard wrap, joined to the previous line with one space.
 * - Each line is trimmed first, so indentation never hides a number and never reaches the text.
 *
 * A hard-wrapped line that happens to begin like a clause number ("2. years from...") is read as
 * a new clause. Text carries no styling to tell the two apart, and the same line in a Word file
 * would be a clause to segment() as well, so the two media types stay consistent.
 */
export function splitTxtParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let open: string | undefined;
  const close = (): void => {
    if (open === undefined) return;
    paragraphs.push(open);
    open = undefined;
    if (paragraphs.length > MAX_PARAGRAPHS) throw tooManyParagraphs();
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || INVISIBLE.test(line)) {
      close();
    } else if (open === undefined) {
      open = line;
    } else if (startsWithClauseNumber(line)) {
      close();
      open = line;
    } else {
      open += ` ${line}`;
    }
  }
  close();
  return paragraphs;
}

const tooManyParagraphs = (): UploadError =>
  new UploadError(
    `This text file has more than ${MAX_PARAGRAPHS} paragraphs, which is more than a contract has. ` +
      "Check that it is the right file.",
  );

/**
 * Reads a plain text contract into the paragraph shape segment() expects. Nothing is trusted:
 * the bytes are decoded strictly, so a damaged or mislabelled file is refused and not silently
 * repaired into different words.
 */
export function parseTxt(bytes: Uint8Array): DocxParagraph[] {
  if (bytes.length > MAX_TXT_BYTES) {
    throw new UploadError(
      `This text file is over the ${MAX_TXT_BYTES / (1024 * 1024)} MB limit. ` +
        "Check that it is the right file.",
    );
  }
  // UTF-16 text is full of NUL bytes, so it would be refused below; say what is wrong instead.
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  ) {
    throw new UploadError("This text file is UTF-16. Save it as UTF-8 text and upload it again.");
  }
  if (bytes.indexOf(0) !== -1) {
    throw new UploadError(
      "This file contains NUL bytes, so it is not plain text. Check that it is the right file.",
    );
  }
  let decoded: string;
  try {
    // ignoreBOM keeps the mark in the output so that it is removed here, in one visible place.
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new UploadError(
      "This text file is not valid UTF-8. Save it as UTF-8 text and upload it again.",
    );
  }
  if (decoded.charCodeAt(0) === 0xfeff) decoded = decoded.slice(1);

  return splitTxtParagraphs(decoded.replace(/\r\n?/g, "\n")).map((text, index): DocxParagraph => ({
    id: `p:${index}`,
    index,
    text,
    style: undefined,
    numbering: undefined,
    inTable: false,
    tableRow: undefined,
    label: undefined,
    level: undefined,
    isBullet: false,
    styleName: undefined,
    outlineLevel: undefined,
    isTocEntry: false,
  }));
}
