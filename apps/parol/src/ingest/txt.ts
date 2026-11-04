import type { DocxParagraph } from "@clausewise/docx";
import { UploadError } from "../module-contracts.js";
import { hasNoVisibleText } from "./invisible.js";

/** A plain text file is a contract typed into an editor, never anything larger than a few pages. */
export const MAX_TXT_BYTES = 2 * 1024 * 1024;
/**
 * Spans, annotations and model context all grow with the paragraph count, so the cap is on
 * paragraphs and not only on bytes: 2 MB of one-letter lines would otherwise be a million spans.
 */
export const MAX_PARAGRAPHS = 20_000;

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

// Words that cannot end a sentence: articles, prepositions, auxiliaries and the words that open a
// subordinate clause. A line that ends with one of them is a wrapped line, whatever the next line
// starts with. "and" and "or" are left out on purpose: "(a) keep it secret; and" ends a list item.
const CANNOT_END_A_SENTENCE = new Set(
  (
    "a an the of in to by with under for from at on per upon within between pursuant into about " +
    "after before during through without than as that which whose whom where when whether if " +
    "unless such any each every all its their his her our your this these those other both " +
    "either neither shall will may must should would could can is are be been being was were " +
    "has have had do does see via"
  ).split(" "),
);

// Only the end of a line is read. A pattern anchored at the end would be tried from every
// position of a very long line, so the tail is cut off first.
const TAIL_CHARS = 80;
const LAST_WORD = /([\p{L}]+)$/u;

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    thirteen: 13,
    fourteen: 14,
    fifteen: 15,
    sixteen: 16,
    seventeen: 17,
    eighteen: 18,
    nineteen: 19,
    twenty: 20,
    thirty: 30,
    forty: 40,
    fifty: 50,
    sixty: 60,
    seventy: 70,
    eighty: 80,
    ninety: 90,
  }),
);

/**
 * The number a line ends with when it is written out in words ("five", "twenty-four", "one
 * hundred", "two thousand"), or undefined. At most five words are read.
 */
function trailingNumberInWords(line: string): number | undefined {
  const tokens = line
    .slice(-TAIL_CHARS)
    .toLowerCase()
    .split(/[\s-]+/)
    // A quote or bracket in front of the word ('"ten') is not part of it.
    .map((token) => token.replace(/^[^\p{L}\p{N}]+/u, ""))
    .slice(-5);
  let total = 0;
  let current = 0;
  let seen = false;
  // Read from the end only as far as the words are number words, then evaluate left to right.
  let first = tokens.length;
  while (first > 0) {
    const token = tokens[first - 1]!;
    if (NUMBER_WORDS.has(token) || token === "hundred" || token === "thousand") first--;
    else if (token === "and" && first < tokens.length && first > 1) first--;
    else break;
  }
  for (const token of tokens.slice(first)) {
    const value = NUMBER_WORDS.get(token);
    if (value !== undefined) {
      current += value;
      seen = true;
    } else if (token === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
      seen = true;
    } else if (token === "thousand") {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      seen = true;
    }
  }
  return seen ? total + current : undefined;
}

// (5)  (10)  (1,000): the figures that follow a number written out in words, "five (5) years".
const FIGURES_IN_BRACKETS = /^\((\d{1,3}(?:,\d{3})*|\d{1,9})\)(?=\s|$)/;
// Labelled references and decimals that turn up in the middle of a sentence.
const LABELLED_REFERENCE =
  /^(?:(?:section|article|clause)\s+|[\u00a7\u00b6]\s*)\d{1,4}(?:\.\d{1,4}){0,5}[.)]?(?=\s|$)/i;
const DECIMAL_WITH_UNIT =
  /^\d{1,4}\.\d{1,4}\s+(?:percent|per|times|days?|months?|years?|weeks?|hours?|business|calendar|usd|dollars?)\b/i;

/**
 * Whether a line that begins like a clause number is, in fact, the continuation of the line
 * above. Three cases, all narrow, because a wrong join loses a clause boundary:
 *  - "five" then "(5) years": the figures repeat the number the line above ends with,
 *  - "set out in" then "Section 4.2 of": a labelled reference after a word that cannot end a
 *    sentence, and likewise a decimal with a unit ("a rate of" then "1.5 percent"),
 *  - nothing else. A bracketed letter or a bare "1." after such a word is left to open a
 *    paragraph, because a lead-in without a colon followed by "(a)" is how lists are often typed.
 */
function continuesSentence(previous: string, line: string): boolean {
  const figures = FIGURES_IN_BRACKETS.exec(line);
  if (figures !== null) {
    const written = trailingNumberInWords(previous);
    return written !== undefined && written === Number((figures[1] ?? "").replace(/,/g, ""));
  }
  if (!LABELLED_REFERENCE.test(line) && !DECIMAL_WITH_UNIT.test(line)) return false;
  const last = LAST_WORD.exec(previous.slice(-TAIL_CHARS));
  return last !== null && CANNOT_END_A_SENTENCE.has((last[1] ?? "").toLowerCase());
}

const MAX_HEADING_CHARS = 80;
const HAS_LOWERCASE = /\p{Ll}/u;
const OPENS_A_SENTENCE = /^[\p{Lu}\p{N}"'(\[\u2018\u201c]/u;

/**
 * The paragraph rule for plain text, in one place because every later stage depends on it:
 *
 * - A blank line (nothing but white space or invisible characters) separates paragraphs.
 * - Inside a block, a line that starts with a typed clause number ("2.", "6.1", "(a)",
 *   "Section 4.") starts a new paragraph, except where the line above plainly goes on (see
 *   continuesSentence): "five" then "(5) years", or "set out in" then "Section 4.2".
 * - Inside a block, a line made of lower-case-free text of at most 80 characters that does not
 *   end in a comma or semicolon is a heading, and the next line that opens like a sentence
 *   starts a new paragraph: "1. DEFINITIONS" then '"Confidential Information" means'. A
 *   wrapped paragraph typed in capitals is not split, because its next line has no lower case.
 * - Any other single line break is a hard wrap, joined to the previous line with one space.
 * - Each line is trimmed first, so indentation never hides a number and never reaches the text.
 *
 * A hard-wrapped line that happens to begin like a clause number ("2. years from...") is read as
 * a new clause. Text carries no styling to tell the two apart, and the same line in a Word file
 * would be a clause to segment() as well, so the two media types stay consistent. The exceptions
 * above are the cases where the words around the line settle it.
 */
export function splitTxtParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  // The open paragraph is built by appending, which keeps it a cheap rope; the rules below read
  // only the last line, its length and whether it is all capitals, never the whole text.
  let open: string | undefined;
  let lastLine = "";
  let openLength = 0;
  let openAllCapitals = false;
  const close = (): void => {
    if (open === undefined) return;
    paragraphs.push(open);
    open = undefined;
    if (paragraphs.length > MAX_PARAGRAPHS) throw tooManyParagraphs();
  };
  const begin = (line: string, capitals: boolean): void => {
    open = line;
    lastLine = line;
    openLength = line.length;
    openAllCapitals = capitals;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || hasNoVisibleText(line)) {
      close();
      continue;
    }
    const lowerCase = HAS_LOWERCASE.test(line);
    if (open === undefined) {
      begin(line, !lowerCase);
      continue;
    }
    const heading =
      openAllCapitals &&
      openLength <= MAX_HEADING_CHARS &&
      !/[,;]$/.test(lastLine) &&
      /\p{L}/u.test(lastLine);
    const opens = startsWithClauseNumber(line)
      ? !continuesSentence(lastLine, line)
      : heading && lowerCase && OPENS_A_SENTENCE.test(line);
    if (opens) {
      close();
      begin(line, !lowerCase);
    } else {
      open += ` ${line}`;
      lastLine = line;
      openLength += line.length + 1;
      openAllCapitals = openAllCapitals && !lowerCase;
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
