import type { DocxParagraph } from "@clausewise/docx";
import type { Clause, ClauseParagraph } from "./types.js";

/**
 * Splits a contract into the units the model is shown and can cite. Everything here is a
 * heuristic over typed text plus a little Word metadata, so each rule errs towards making a
 * paragraph a clause: a wrongly kept paragraph costs a line of prompt, a wrongly dropped one
 * can never be reviewed or edited.
 */

// Headings are never clauses, so a false positive hides a paragraph from the review. These
// limits keep long numbered sentences such as "1. This Agreement is made on ..." out.
const MAX_HEADING_CHARS = 80;
const MAX_HEADING_WORDS = 10;
// "N/A" and "IV" on their own are cell values and list labels, not section titles.
const MIN_CAPS_LETTERS = 3;

const HEADING_STYLE = /^(heading\s*\d|title)$/i;
const SIGNATURE_LABEL = /^(?:by|name|title|date|signature|signed)\s*:/i;
// The en and em dashes are escaped because they are common in signature lines pasted from PDFs.
const RULE_LINE = /^[\s_\-\u2013\u2014]+$/;

const HEADING_NUMBER = /^\d{1,3}[.)]?$/;
const HEADING_LABEL = /^(?:section|article)$/i;
const HEADING_LABEL_NUMBER = /^(?:\d{1,3}|[IVXLC]{1,6})[.:]?$/;
const TRAILING_STOP = /[.;,]$/;
const LEADING_SYMBOLS = /^[^\p{L}\p{N}]+/u;
const UPPERCASE_START = /^\p{Lu}/u;
const DIGIT_START = /^\p{N}/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const UPPERCASE_LETTERS = /\p{Lu}/gu;

// Words that stay lowercase in a title, so "Limitation of Liability" still reads as one while
// "Recipient shall comply" does not.
const TITLE_CONNECTORS = new Set([
  "a",
  "an",
  "and",
  "and/or",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "under",
  "upon",
  "with",
]);

// A bare integer ("30 days' notice") is not a clause number, so single-level numbers need a
// trailing point or bracket. Digit runs are bounded so matching stays constant time per paragraph.
const TYPED_NUMBER = /^(\d{1,4}(?:\.\d{1,4}){1,5}|\d{1,4}(?=[.)]))[.)]?(?=\s|$)/;
const LABELLED_NUMBER = /^(?:section|article)\s+(\d{1,4}(?:\.\d{1,4}){0,5})[.)]?(?=\s|$)/i;

const PAREN_MARKER = /^(?:\(([a-z0-9]{1,6})\)|\[([a-z0-9]{1,6})\])/i;
// A bare digit with a closing bracket is a clause number ("4)"), so this form is letters only.
const BARE_MARKER = /^([a-z]{1,6})\)(?=\s|$)/i;
const SINGLE_LETTER = /^[a-z]$/i;
const REPEATED_LETTER = /^([a-z])\1{1,2}$/i;
const DIGITS = /^\d{1,3}$/;
// Well-formed numerals only, so a word in brackets is rarely mistaken for a list marker.
const ROMAN = /^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

interface Draft {
  number: string | undefined;
  heading: string | undefined;
  paragraphs: ClauseParagraph[];
}

export function segment(paragraphs: DocxParagraph[]): Clause[] {
  const drafts: Draft[] = [];
  let heading: string | undefined;
  // The clause a sub-item may join. A heading ends it: items never attach across sections.
  let open: Draft | undefined;

  for (const p of paragraphs) {
    const text = p.text.trim();
    if (text === "" || isSignatureNoise(p, text)) continue;

    const marker = hasListMarker(text);
    if (isHeading(p, text, marker)) {
      heading = text;
      open = undefined;
      continue;
    }

    const number = clauseNumber(text);
    const piece: ClauseParagraph = { id: p.id, text: p.text };
    // A typed number always opens a clause, even inside an indented auto-numbered list.
    const isSubItem = marker || (number === undefined && isNested(p));
    if (open !== undefined && isSubItem) {
      open.paragraphs.push(piece);
      continue;
    }

    open = { number, heading, paragraphs: [piece] };
    drafts.push(open);
  }

  return drafts.map((draft, i) => ({
    id: `c${i + 1}`,
    number: draft.number,
    heading: draft.heading,
    paragraphs: draft.paragraphs,
    text: draft.paragraphs.map((part) => part.text).join("\n"),
  }));
}

// Signature tables repeat label lines and blanks that carry no obligations and would otherwise
// become clauses the model could cite. Outside tables the same words are ordinary prose.
function isSignatureNoise(p: DocxParagraph, text: string): boolean {
  return RULE_LINE.test(text) || (p.inTable && SIGNATURE_LABEL.test(text));
}

function isNested(p: DocxParagraph): boolean {
  return p.numbering !== undefined && p.numbering.level > 0;
}

function isHeading(p: DocxParagraph, text: string, marker: boolean): boolean {
  if (p.style !== undefined && HEADING_STYLE.test(p.style)) return true;
  // Table cells hold party names and column titles that look like headings but are content.
  // A list marker is checked first so that "(A) PARTIES" is an item, not a title in capitals.
  return !p.inTable && !marker && looksLikeHeading(text);
}

function looksLikeHeading(text: string): boolean {
  if (text.length > MAX_HEADING_CHARS || TRAILING_STOP.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length >= MAX_HEADING_WORDS) return false;
  return isAllCaps(text) || isNumberedTitle(words) || isLabelledTitle(words);
}

function isAllCaps(text: string): boolean {
  if (LOWERCASE_LETTER.test(text)) return false;
  return (text.match(UPPERCASE_LETTERS)?.length ?? 0) >= MIN_CAPS_LETTERS;
}

// Single-level numbers only: "1.1 Definitions" is usually a clause that goes on to say more.
function isNumberedTitle(words: string[]): boolean {
  const [number, ...title] = words;
  return number !== undefined && HEADING_NUMBER.test(number) && isTitleCase(title);
}

function isLabelledTitle(words: string[]): boolean {
  const [label, number, ...title] = words;
  if (label === undefined || number === undefined) return false;
  return HEADING_LABEL.test(label) && HEADING_LABEL_NUMBER.test(number) && isTitleCase(title);
}

function isTitleCase(words: string[]): boolean {
  let sawWord = false;
  for (const word of words) {
    const core = word.replace(LEADING_SYMBOLS, "");
    // A bare "&", or the dash in "Section 5 - Remedies", says nothing either way.
    if (core === "") continue;
    const capitalised = UPPERCASE_START.test(core);
    if (!sawWord && !capitalised) return false;
    if (!capitalised && !DIGIT_START.test(core) && !TITLE_CONNECTORS.has(core.toLowerCase())) {
      return false;
    }
    sawWord = true;
  }
  return sawWord;
}

function hasListMarker(text: string): boolean {
  const bracketed = PAREN_MARKER.exec(text);
  if (bracketed !== null) return isMarkerLabel(bracketed[1] ?? bracketed[2] ?? "");
  const bare = BARE_MARKER.exec(text);
  return bare !== null && isMarkerLabel(bare[1] ?? "");
}

function isMarkerLabel(label: string): boolean {
  return (
    DIGITS.test(label) ||
    SINGLE_LETTER.test(label) ||
    REPEATED_LETTER.test(label) ||
    ROMAN.test(label.toLowerCase())
  );
}

function clauseNumber(text: string): string | undefined {
  return (TYPED_NUMBER.exec(text) ?? LABELLED_NUMBER.exec(text))?.[1];
}
