import type { DocxParagraph } from "@clausewise/docx";
import type { Clause, ClauseParagraph } from "./types.js";

/**
 * Splits a contract into the units the model is shown and can cite. The rules read what Word
 * knows about a paragraph (its list level, the number it prints, its style) before they fall
 * back to what is typed, and each one errs towards making a paragraph a clause: a wrongly kept
 * paragraph costs a line of prompt, a wrongly dropped one can never be reviewed or edited.
 */

// Headings are never clauses, so a false positive hides a paragraph from the review. These
// limits keep long numbered sentences such as "1. This Agreement is made on ..." out.
const MAX_HEADING_CHARS = 80;
const MAX_HEADING_WORDS = 10;
// "N/A" and "IV" on their own are cell values and list labels, not section titles.
const MIN_CAPS_LETTERS = 3;
// Signature blocks sit at the end of a contract, so that is where a label line outside a table is
// taken for one.
const SIGNATURE_TAIL_PARAGRAPHS = 15;
const MAX_SIGNATURE_LINE_CHARS = 80;
// A clause number is a short token. Anything longer is a sentence that happens to be numbered.
const MAX_NUMBER_CHARS = 24;
// Word caps a label at 255 characters, and the patterns that read one should never see more than
// a number and the words around it.
const MAX_LABEL_CHARS = 64;

const HEADING_STYLE_ID = /^(?:heading\s*\d|title)$/i;
// Table headers, contents lists and their titles are named "heading" too, and are not sections.
// A "Heading 1 Char" style formats characters and is never the style of a paragraph.
const NOT_A_SECTION_STYLE = /\b(?:table|toc|contents|char)\b/;
const SIGNATURE_LABEL = /^(?:by|name|title|date|signature|signed)\s*:/i;
// The en and em dashes are escaped because they are common in signature lines pasted from PDFs.
const RULE_LINE = /^[\s_\-\u2013\u2014]+$/;

const HEADING_NUMBER = /^\d{1,3}[.)]?$/;
const HEADING_LABEL = /^(?:section|article|clause|schedule|part|annex|annexure|exhibit|appendix)$/i;
const HEADING_LABEL_NUMBER = /^(?:\d{1,3}|[IVXLC]{1,6}|[A-Z])[.:]?$/;
const SIGN_START = /^[\u00a7\u00b6]+/u;
const TRAILING_STOP = /[.;,]$/;
const TITLE_END = /[.;,:]$/;
const LEADING_SYMBOLS = /^[^\p{L}\p{N}]+/u;
const EDGE_PUNCTUATION = /^[^\p{L}]+|[^\p{L}]+$/gu;
const UPPERCASE_START = /^\p{Lu}/u;
const DIGIT_START = /^\p{N}/u;
const LOWERCASE_LETTER = /\p{Ll}/u;
const UPPERCASE_LETTERS = /\p{Lu}/gu;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

// Words that make a line a sentence rather than a title, so "Limitation of Liability" is a title
// and "Customer shall pay the Fees" is not, whatever style the paragraph carries.
const SENTENCE_WORDS = new Set([
  "agree",
  "agrees",
  "acknowledge",
  "acknowledges",
  "are",
  "be",
  "been",
  "being",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "hereby",
  "includes",
  "is",
  "may",
  "means",
  "might",
  "must",
  "represents",
  "shall",
  "should",
  "undertakes",
  "warrants",
  "was",
  "were",
  "will",
  "would",
]);

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
// Section, Article and Clause carry a number; Schedule, Part, Annex and Exhibit name a part of the
// contract and are headings only, so "Schedule 1" is never mistaken for clause 1.
const LABELLED_NUMBER =
  /^(?:(?:section|article|clause)\s+|[\u00a7\u00b6]\s*)(\d{1,4}(?:\.\d{1,4}){0,5})[.)]?(?=\s|$)/i;
const LABELLED_ONLY =
  /^(?:(?:section|article|clause|schedule|part|annex|annexure|exhibit|appendix)\s+(?:\d{1,4}(?:\.\d{1,4}){0,5}|[ivxlc]{1,6}|[a-z])|[\u00a7\u00b6]\s*\d{1,4}(?:\.\d{1,4}){0,5})[.:]?$/i;

const PAREN_MARKER = /^(?:\(([a-z0-9]{1,6})\)|\[([a-z0-9]{1,6})\])/i;
// A bare digit with a closing bracket is a clause number ("4)"), so this form is letters only.
const BARE_MARKER = /^([a-z]{1,6})\)(?=\s|$)/i;
const SINGLE_LETTER = /^[a-z]$/i;
const REPEATED_LETTER = /^([a-z])\1{1,2}$/i;
const DIGITS = /^\d{1,3}$/;
// Well-formed numerals only, so a word in brackets is rarely mistaken for a list marker.
const ROMAN = /^m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

const LABEL_PREFIX = /^(?:(?:section|article|clause)\s+|[\u00a7\u00b6]\s*)/i;
const BRACKETED_LABEL = /^[([]/;
const OPEN_BRACKET = /[([]/;
const BRACKETS = /[()[\]]/g;
const NAMED_PART = /^(?:schedule|part|annex|annexure|exhibit|appendix)$/i;
const DIGIT = /\d/;
// Labels that are list markers rather than headings or clause numbers: "(a)", "iv.", "b)".
const MARKER_LABEL = /^(?:[a-z]{1,6}[.)]|[([][a-z0-9]{1,6}[)\]])$/;

/** What one table cell hands to the next: the number a row-per-clause layout keeps in its own cell. */
interface Lead {
  /** The paragraph that held the number: its list and style apply to the row's text. */
  p: DocxParagraph;
  /** The number as typed, when the cell held it as text. */
  typed: string | undefined;
  /** The number Word prints, when the cell held an empty numbered paragraph. */
  label: string | undefined;
}

interface Leads {
  consumed: Set<number>;
  byTarget: Map<number, Lead>;
}

/** A paragraph that survived the skip rules, with everything the clause rules need to know. */
interface Item {
  id: string;
  raw: string;
  text: string;
  /** The text the heading rules read: a number from another cell comes first. */
  headProbe: string;
  /** What precedes a heading in the section label, so it reads as the lawyer sees it. */
  headLead: string | undefined;
  /** True when the number came from a neighbouring table cell. */
  handed: boolean;
  /** The number as the lawyer sees it, normalised. */
  number: string | undefined;
  /** True when the number is typed into the text, which always opens a clause. */
  typedNumber: boolean;
  marker: boolean;
  list: string | undefined;
  level: number | undefined;
  bullet: boolean;
  /** True when Word prints a number or letter before the paragraph. */
  labelled: boolean;
  /** A bracketed or lettered label: a sub-item, however deep the list says it is. */
  itemLabel: boolean;
  inTable: boolean;
  /** Style or outline level says heading; the short title shape is checked separately. */
  styled: boolean;
  outlined: boolean;
  short: boolean;
  capital: boolean;
  /** A numbered level 0 paragraph with the shape of a title. */
  candidate: boolean;
}

interface Draft {
  number: string | undefined;
  heading: string | undefined;
  paragraphs: ClauseParagraph[];
  /** The list the opening paragraph belongs to, and its level there. */
  list: string | undefined;
  level: number | undefined;
  /** Other lists whose items have been merged into this clause. */
  itemLists: Set<string> | undefined;
  /** The text of the last paragraph, which tells whether the clause is waiting for items. */
  last: string;
}

export function segment(paragraphs: DocxParagraph[]): Clause[] {
  const items = collect(paragraphs);
  const drafts: Draft[] = [];
  // Lists that have been seen holding the sub-items of clauses from another list, as python-docx
  // "List Number 2" does: its items carry the same level as the clauses they belong to.
  const itemLists = new Set<string>();
  let heading: string | undefined;
  // The clause a sub-item may join. A heading ends it: items never attach across sections.
  let open: Draft | undefined;
  // The list level at which a numbered paragraph opens a clause in this section, taken from the
  // first numbered paragraph after the heading. Deeper levels are items of the open clause.
  let clauseLevel: number | undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (isHeading(item, items[i - 1], items[i + 1])) {
      heading = headingText(item);
      open = undefined;
      clauseLevel = undefined;
      continue;
    }

    const piece: ClauseParagraph = { id: item.id, text: item.raw };
    if (open !== undefined && joins(open, item, clauseLevel, itemLists)) {
      open.paragraphs.push(piece);
      open.last = item.text;
      continue;
    }

    open = {
      number: item.number,
      heading,
      paragraphs: [piece],
      list: item.list,
      level: item.level,
      itemLists: undefined,
      last: item.text,
    };
    drafts.push(open);
    if (item.level !== undefined && item.labelled && !item.bullet) {
      clauseLevel = clauseLevel === undefined ? item.level : Math.min(clauseLevel, item.level);
    }
  }

  return drafts.map((draft, i) => ({
    id: `c${i + 1}`,
    number: draft.number,
    heading: draft.heading,
    paragraphs: draft.paragraphs,
    text: draft.paragraphs.map((part) => part.text).join("\n"),
  }));
}

/** Drops what is never a clause and attaches each table row's separate number cell to its text. */
function collect(paragraphs: readonly DocxParagraph[]): Item[] {
  const leads = findLeads(paragraphs);
  const tailStart = paragraphs.length - SIGNATURE_TAIL_PARAGRAPHS;
  const items: Item[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    if (leads.consumed.has(i) || p.isTocEntry === true) continue;
    const text = p.text.trim();
    if (text === "" || isSignatureNoise(p, text, i >= tailStart)) continue;
    items.push(buildItem(p, text, leads.byTarget.get(i)));
  }
  return items;
}

// Signature tables repeat label lines and blanks that carry no obligations and would otherwise
// become clauses the model could cite. Outside tables the same words are ordinary prose, so
// there only a short line near the end of the document that reads as a label is dropped.
function isSignatureNoise(p: DocxParagraph, text: string, inTail: boolean): boolean {
  if (RULE_LINE.test(text)) return true;
  if (!SIGNATURE_LABEL.test(text)) return false;
  return p.inTable || (inTail && isLabelLine(text));
}

function isLabelLine(text: string): boolean {
  return text.length <= MAX_SIGNATURE_LINE_CHARS && !hasSentenceWord(text.split(/\s+/));
}

/**
 * Finds the rows laid out one clause per row, with the number in a cell of its own. The first
 * paragraph of a row that is only a number, or an empty paragraph that Word numbers, hands that
 * number to the first text of the same row and is dropped itself.
 */
function findLeads(paragraphs: readonly DocxParagraph[]): Leads {
  const consumed = new Set<number>();
  const byTarget = new Map<number, Lead>();
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i]!;
    const row = p.tableRow;
    if (row === undefined || p.isTocEntry === true) continue;
    if (i > 0 && paragraphs[i - 1]!.tableRow === row) continue;
    const lead = leadOf(p);
    if (lead === undefined) continue;
    const target = textInRow(paragraphs, i, row);
    if (target === undefined) continue;
    consumed.add(i);
    byTarget.set(target, lead);
  }
  return { consumed, byTarget };
}

function leadOf(p: DocxParagraph): Lead | undefined {
  const text = p.text.trim();
  if (text === "") {
    return p.label === undefined ? undefined : { p, typed: undefined, label: p.label };
  }
  return isNumberOnly(text) ? { p, typed: text, label: undefined } : undefined;
}

/** The first text after `from` in the same row, unless it has a number of its own or is noise. */
function textInRow(
  paragraphs: readonly DocxParagraph[],
  from: number,
  row: number,
): number | undefined {
  for (let j = from + 1; j < paragraphs.length; j++) {
    const q = paragraphs[j]!;
    if (q.tableRow !== row) return undefined;
    const text = q.text.trim();
    if (text === "") continue;
    const own =
      q.isTocEntry === true ||
      q.label !== undefined ||
      typedNumber(text) !== undefined ||
      isNumberOnly(text) ||
      RULE_LINE.test(text) ||
      SIGNATURE_LABEL.test(text);
    return own ? undefined : j;
  }
  return undefined;
}

function isNumberOnly(text: string): boolean {
  if (text.length > MAX_NUMBER_CHARS) return false;
  if (LABELLED_ONLY.test(text)) return true;
  const typed = TYPED_NUMBER.exec(text) ?? LABELLED_NUMBER.exec(text);
  if (typed !== null) return text.length === typed[0].length;
  const marker = PAREN_MARKER.exec(text) ?? BARE_MARKER.exec(text);
  return marker !== null && marker[0].length === text.length && hasListMarker(text);
}

function buildItem(p: DocxParagraph, text: string, lead: Lead | undefined): Item {
  // A number handed over from another cell brings its list position and style with it.
  const source = lead !== undefined && lead.p.numbering !== undefined ? lead.p : p;
  const label = lead?.label ?? p.label;
  const level = source.numbering?.level ?? source.level;
  const bullet = source.isBullet === true;
  const typedText = lead?.typed !== undefined ? `${lead.typed} ${text}` : text;
  const typed = typedNumber(typedText);
  const handedLead = lead?.typed ?? lead?.label;

  const styled = isHeadingStyle(p) || (lead !== undefined && isHeadingStyle(lead.p));
  const outlined = hasOutline(p) || (lead !== undefined && hasOutline(lead.p));
  const short = isShortTitle(text);
  const capital = startsCapital(text.slice(0, MAX_HEADING_CHARS + 1));
  const labelled = label !== undefined;

  return {
    id: p.id,
    raw: p.text,
    text,
    headProbe: handedLead === undefined ? text : `${handedLead} ${text}`,
    headLead: handedLead ?? (typedNumber(text) === undefined ? label : undefined),
    handed: lead !== undefined,
    number: typed ?? labelNumber(label),
    typedNumber: typed !== undefined,
    marker: hasListMarker(typedText),
    list: source.numbering?.id ?? (level === undefined ? undefined : ""),
    level,
    bullet,
    labelled,
    itemLabel: label !== undefined && (BRACKETED_LABEL.test(label) || MARKER_LABEL.test(label)),
    inTable: p.inTable,
    styled,
    outlined: outlined && !bullet,
    short,
    capital,
    candidate:
      !styled &&
      !outlined &&
      level === 0 &&
      !bullet &&
      label !== undefined &&
      !BRACKETED_LABEL.test(label) &&
      !MARKER_LABEL.test(label) &&
      short &&
      capital,
  };
}

function isHeading(item: Item, previous: Item | undefined, next: Item | undefined): boolean {
  // A style or an outline level only says "heading" for something that reads as a title: law-firm
  // templates give whole sentences a heading style, and those are the clauses.
  if (item.styled && item.short) return true;
  if (item.outlined && item.short && item.capital) return true;
  // A run of short numbered lines is a list of items ("1. Evaluation", "2. Negotiation").
  if (item.candidate && previous?.candidate !== true && next?.candidate !== true) return true;
  // Table cells hold party names and column titles that look like headings but are content, unless
  // a number in the cell beside them marks the row as a title. A list marker is checked first so
  // that "(A) PARTIES" is an item, not a title in capitals.
  return (!item.inTable || item.handed) && !item.marker && looksLikeHeading(item.headProbe);
}

function headingText(item: Item): string {
  const lead = item.headLead;
  if (lead === undefined) return item.text;
  return item.text.toLowerCase().startsWith(lead.toLowerCase())
    ? item.text
    : `${lead} ${item.text}`;
}

/** Whether a paragraph that is not a heading belongs to the clause that is open. */
function joins(
  open: Draft,
  item: Item,
  clauseLevel: number | undefined,
  itemLists: Set<string>,
): boolean {
  if (item.marker) return true;
  // A typed number always opens a clause, even inside an indented auto-numbered list.
  const level = item.level;
  if (item.typedNumber || level === undefined) return false;
  if (open.list !== undefined && item.list === open.list && open.level !== undefined) {
    return level > open.level;
  }
  return joinsAnotherList(open, item, level, clauseLevel, itemLists);
}

/**
 * Items that come from another list than the clause that is open: the bullets under a lead-in
 * sentence, python-docx "List Number 2" under "List Number", lettered items under a typed number.
 * A list's levels mean nothing across lists, so the evidence is the sentence that introduces them.
 */
function joinsAnotherList(
  open: Draft,
  item: Item,
  level: number,
  clauseLevel: number | undefined,
  itemLists: Set<string>,
): boolean {
  const numbered = open.number !== undefined;
  const list = item.list;
  if (list !== undefined) {
    if (open.itemLists?.has(list) === true) return true;
    if (numbered && !item.bullet && itemLists.has(list)) return true;
  }
  if (endsLeadIn(open.last) && (numbered || item.bullet || item.itemLabel)) {
    if (list !== undefined) {
      (open.itemLists ??= new Set()).add(list);
      itemLists.add(list);
    }
    return true;
  }
  if (clauseLevel !== undefined) return level > clauseLevel;
  return numbered && level > 0;
}

// A colon, or the dash British drafting uses instead, announces the items that follow.
function endsLeadIn(text: string): boolean {
  const last = text.charAt(text.length - 1);
  return last === ":" || last === "\uff1a" || last === "\u2014" || last === "\u2013";
}

function isHeadingStyle(p: DocxParagraph): boolean {
  if (p.style !== undefined && HEADING_STYLE_ID.test(p.style)) return true;
  // Word writes its built-in style names in English whatever the language of the installation, so
  // a localised style id still says "heading 1" here. Other producers capitalise the name.
  const name = p.styleName?.trim().toLowerCase();
  if (name === undefined) return false;
  return name === "title" || (name.includes("heading") && !NOT_A_SECTION_STYLE.test(name));
}

function hasOutline(p: DocxParagraph): boolean {
  return p.outlineLevel !== undefined && p.outlineLevel >= 0 && p.outlineLevel <= 8;
}

function startsCapital(text: string): boolean {
  const core = text.replace(LEADING_SYMBOLS, "");
  return UPPERCASE_START.test(core) || DIGIT_START.test(core);
}

/** A line short enough, and without a verb, to be a title rather than a sentence. */
function isShortTitle(text: string): boolean {
  if (text.length > MAX_HEADING_CHARS || TITLE_END.test(text) || text.includes(";")) return false;
  const words = text.split(/\s+/);
  if (words.length >= MAX_HEADING_WORDS || hasSentenceWord(words)) return false;
  const last = words[words.length - 1]?.toLowerCase();
  return last !== "and" && last !== "or";
}

function hasSentenceWord(words: string[]): boolean {
  return words.some((word) => SENTENCE_WORDS.has(word.toLowerCase().replace(EDGE_PUNCTUATION, "")));
}

function looksLikeHeading(text: string): boolean {
  if (text.length > MAX_HEADING_CHARS || TRAILING_STOP.test(text)) return false;
  const words = text.split(/\s+/);
  if (words.length >= MAX_HEADING_WORDS) return false;
  return isAllCaps(text) || isNumberedTitle(words) || isLabelledTitle(spellOutSign(words));
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
  if (!HEADING_LABEL.test(label) || !HEADING_LABEL_NUMBER.test(number)) return false;
  return title.length === 0 || isTitleCase(title);
}

/** A paragraph sign before the number reads as the word Section. */
function spellOutSign(words: string[]): string[] {
  const [first, ...rest] = words;
  if (first === undefined || !SIGN_START.test(first)) return words;
  const tail = first.replace(SIGN_START, "");
  return tail === "" ? ["Section", ...rest] : ["Section", tail, ...rest];
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

function typedNumber(text: string): string | undefined {
  return (TYPED_NUMBER.exec(text) ?? LABELLED_NUMBER.exec(text))?.[1];
}

/**
 * The number Word prints, as a bare token: "Section 1.01" is "1.01", "ARTICLE IV" is "IV", "3.1."
 * is "3.1" and "(a)" stays "(a)". A label that is not a number or a letter, or too long to be
 * one, is no number at all, and neither is a word such as "First".
 */
function labelNumber(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const trimmed = label.trim();
  if (trimmed.length > MAX_LABEL_CHARS) return undefined;
  const bare = trimmed.replace(LABEL_PREFIX, "");
  // A closing bracket belongs to the number when an opening one does: "1.1.1(a)", not "4)".
  const trailing = OPEN_BRACKET.test(bare) ? /[.:]+$/ : /[.:)\]]+$/;
  const number = bare.replace(trailing, "").trim();
  return isPlausibleNumber(number) ? number : undefined;
}

function isPlausibleNumber(number: string): boolean {
  if (number.length > MAX_NUMBER_CHARS || !HAS_LETTER_OR_DIGIT.test(number)) return false;
  const words = number.split(/\s+/);
  if (words.length > 2 || (words.length === 2 && !NAMED_PART.test(words[0] ?? ""))) return false;
  const last = words[words.length - 1] ?? "";
  const core = last.replace(BRACKETS, "").toLowerCase();
  return DIGIT.test(last) || (core !== "" && isMarkerLabel(core));
}
