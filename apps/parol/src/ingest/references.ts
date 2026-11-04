import { lowerBound, pairQuotes, sentenceCuts } from "./view.js";

/**
 * Cross-references to clauses, with the verb an amendment applies to them.
 *
 * What this catches, on a normalized view: a label (Section, Sections, Sec., Clause, Article,
 * Paragraph, Subsection, section and paragraph signs) followed by a clause number, with its list:
 * Section 6.1, Sections 4, 5 and 8, Clause 3, Article II, paragraph 2, Section 7.2(a), Section 4A.
 * One annotation comes out per number. A sub-item such as (a) is dropped, because the clause
 * numbers a document is cut into do not carry it, so Section 7.2(a) refers to clause 7.2. A range
 * of whole numbers or of dotted numbers that differ only in the last part ("Sections 4 through 6",
 * "Sections 6.1 to 6.3", "Sections 4-6") gives every clause in it, up to 100 between the ends; a
 * range that cannot be expanded (different prefixes, backwards, too long, roman numerals) gives
 * its two ends.
 *
 * What it misses: a reference by name ("the Term clause", "the preceding Section"), a number with
 * no label ("see 6.1"), a lettered target ("Section A", "Schedule 2" are not clause numbers), and
 * the interior of a range it cannot expand. It cannot tell a section of this agreement from a
 * section of a statute ("Section 5 of the Securities Act"): both are reported, and an extra
 * reference only widens what the analysis may look at.
 *
 * The verb comes only from words in the same part of the same sentence as the reference, and only
 * for a document that is an amendment. A sentence ends at . ! ? ; or :, because the text after "to
 * read as follows:" is new wording and not an operation on the clause. Within a sentence, a part
 * ("segment") ends where "but", "however", "whereas" and the like begin, and before a reference
 * that follows another one after "and", "or", "nor" or a comma: "Section 6.1 shall be amended and
 * Section 7.2 shall be deleted" is two parts, and each reference takes the operation of its own.
 * A part that is only a reference ("Section 4" in "Section 4 and Section 5 are deleted") takes
 * the operation of its neighbour: the one that follows it if there is one, else the one before.
 *
 * Operation words are participles and gerunds ("is deleted", "by replacing"), the third person
 * ("this Amendment deletes"), and the bare verb when its object is a clause reference ("Delete
 * Section 6.1", "agree to remove Section 5", but not "agrees to remove all copies ... in
 * accordance with Section 7.2"), plus the phrases "of no further force or effect" and "null and
 * void". They cover delete, remove, omit, strike, revoke, repeal, rescind, cancel, withdraw,
 * replace, restate, substitute, supersede, amend, modify, supplement, revise, change, extend,
 * shorten and lengthen. An operation that is negated is not read: "Nothing in this Amendment
 * deletes Section 6.1", "do not intend to delete", "Neither Section 6.1 nor Section 6.2 is
 * deleted", "is not deleted but ...", and "as amended" / "except as amended", which describe a
 * clause and do not operate on it. A reference that is itself being edited ("amended by deleting
 * the reference to Section 6.1") is only mentioned, and a reference in quoted wording is too.
 *
 * What the verbs miss: an operation worded in a way not listed ("Section 6.1 ceases to apply"
 * is not, "of no further force or effect" is), an operation on part of a clause that names no
 * part ("In Section 6.1, delete the word ten"), which comes out as "refers", and a negation more
 * than five words before its verb or across a comma. The wrong answer in each case is "refers",
 * or an operation word read for a clause that only sits near it; both widen or narrow a hint,
 * and neither sets a status: precedence is decided later, from the text of the clauses.
 * Spans of the NDA itself always get "refers": an NDA that says "Section 6.1 is deleted" is
 * describing its own drafting, and the amendment rules (who governs whom) apply only to documents
 * that amend.
 */

export type ReferenceVerb = "replaces" | "amends" | "deletes" | "refers";

export interface CrossReference {
  target: string;
  verb: ReferenceVerb;
}

const MAX_TARGETS_PER_SPAN = 200;
const MAX_REFERENCES_PER_SPAN = 5000;
// Clauses between the two ends of a range that are expanded. "Sections 1 through 999" is far more
// likely a typo or a defined block than a deletion of nine hundred clauses, so it names its ends.
const MAX_RANGE_MEMBERS = 100;

const LABEL =
  /(?<![\p{L}\p{N}])(?:(?:sections?|secs?\.?|clauses?|articles?|paragraphs?|paras?\.?|sub-?sections?|sub-?clauses?|sub-?paragraphs?)(?![\p{L}\p{N}])|§§?|¶¶?)\s*/giu;

// Up to four digits for the first number, three for the ones that follow it in a list, so a year
// after a comma ("Section 4, 2026") is not read as a clause.
const FIRST_NUMBER = /(\d{1,4}(?:\.\d{1,4}){0,5}(?:[A-Z](?![\p{L}\p{N}]))?)(?![\p{L}\p{N}])/uy;
const LATER_NUMBER = /(\d{1,3}(?:\.\d{1,4}){0,5}(?:[A-Z](?![\p{L}\p{N}]))?)(?![\p{L}\p{N}])/uy;
const ROMAN = /([IVXLC]{1,6})(?![\p{L}\p{N}])/uy;
const SUB_ITEMS = /(?:\([a-zA-Z0-9]{1,4}\))+/y;
const SEPARATOR =
  /(?:\s*,\s*(?:(?:and\/or|and|or)\s+)?|\s+(?:and\/or|and|or|through|thru|to)\s+|\s*&\s*|\s*-\s*)/y;
const RANGE_SEPARATOR = /^\s*(?:through|thru|to|-)\s*$/i;
// "Section 4, 30 days after notice": the 30 is a period and not a clause.
const UNIT_AFTER =
  /\s+(?:days?|months?|years?|weeks?|hours?|business|calendar|percent|per|times?|copies|pages?|usd|dollars?)\b/iy;
const PLAIN_NUMBER = /^\d+(?:\.\d+)*$/;

interface Reference {
  start: number;
  end: number;
  targets: string[];
}

function sticky(pattern: RegExp, view: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(view);
}

// Roman numerals are read only where the list began with one, so "Sections 3 and I" (a pronoun)
// does not name Section I.
function readToken(
  view: string,
  at: number,
  later: boolean,
  romanAllowed: boolean,
): { target: string; end: number } | undefined {
  const match =
    sticky(later ? LATER_NUMBER : FIRST_NUMBER, view, at) ??
    (romanAllowed ? sticky(ROMAN, view, at) : null);
  if (match === null) return undefined;
  let end = at + match[0].length;
  const sub = sticky(SUB_ITEMS, view, end);
  if (sub !== null) end += sub[0].length;
  return { target: match[1]!, end };
}

/**
 * The numbers strictly between the two ends of a range, or undefined when the range cannot be
 * expanded: not plain numbers, a different number of parts, a different prefix, backwards, no
 * room between the ends, or too many. "6.1" to "6.4" gives 6.2 and 6.3.
 */
function interiorOfRange(from: string, to: string): string[] | undefined {
  if (!PLAIN_NUMBER.test(from) || !PLAIN_NUMBER.test(to)) return undefined;
  const a = from.split(".");
  const b = to.split(".");
  if (a.length !== b.length) return undefined;
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return undefined;
  const lowText = a[a.length - 1]!;
  const highText = b[b.length - 1]!;
  const low = Number(lowText);
  const high = Number(highText);
  // Leading zeros ("6.01") would not come back as the same text.
  if (String(low) !== lowText || String(high) !== highText) return undefined;
  if (high - low < 2 || high - low - 1 > MAX_RANGE_MEMBERS) return undefined;
  const prefix = a.length > 1 ? `${a.slice(0, -1).join(".")}.` : "";
  const members: string[] = [];
  for (let n = low + 1; n < high; n++) members.push(`${prefix}${n}`);
  return members;
}

function scanReferences(view: string): Reference[] {
  const references: Reference[] = [];
  LABEL.lastIndex = 0;
  for (
    let label = LABEL.exec(view);
    label !== null && references.length < MAX_REFERENCES_PER_SPAN;
    label = LABEL.exec(view)
  ) {
    const first = readToken(view, label.index + label[0].length, false, true);
    if (first === undefined) {
      // Do not rescan the characters after the label as another label's start.
      LABEL.lastIndex = label.index + label[0].length;
      continue;
    }
    const targets = [first.target];
    const romanList = /^[IVXLC]+$/.test(first.target);
    let previous = first.target;
    let end = first.end;
    while (targets.length < MAX_TARGETS_PER_SPAN) {
      const separator = sticky(SEPARATOR, view, end);
      if (separator === null) break;
      const token = readToken(view, end + separator[0].length, true, romanList);
      if (token === undefined) break;
      if (sticky(UNIT_AFTER, view, token.end) !== null) break;
      if (RANGE_SEPARATOR.test(separator[0])) {
        targets.push(...(interiorOfRange(previous, token.target) ?? []));
      }
      targets.push(token.target);
      previous = token.target;
      end = token.end;
    }
    references.push({ start: label.index, end, targets });
    LABEL.lastIndex = end;
  }
  return references;
}

// ---------------------------------------------------------------------------------------------
// Operation words
// ---------------------------------------------------------------------------------------------

type Operation = "deletes" | "replaces" | "amends";
interface Operative {
  start: number;
  end: number;
  verb: Operation;
}

const toMap = (entries: Record<string, Operation>): ReadonlyMap<string, Operation> =>
  new Map(Object.entries(entries));

// Participles and gerunds: "is deleted", "by deleting". They need no object, because they describe
// what happens to a clause named before them or after them in the same part.
const PARTICIPLES = toMap({
  deleted: "deletes",
  deleting: "deletes",
  removed: "deletes",
  removing: "deletes",
  omitted: "deletes",
  omitting: "deletes",
  struck: "deletes",
  stricken: "deletes",
  striking: "deletes",
  revoked: "deletes",
  revoking: "deletes",
  repealed: "deletes",
  repealing: "deletes",
  rescinded: "deletes",
  rescinding: "deletes",
  cancelled: "deletes",
  canceled: "deletes",
  cancelling: "deletes",
  canceling: "deletes",
  withdrawn: "deletes",
  withdrawing: "deletes",
  annulled: "deletes",
  annulling: "deletes",
  abrogated: "deletes",
  abrogating: "deletes",
  replaced: "replaces",
  replacing: "replaces",
  restated: "replaces",
  restating: "replaces",
  substituted: "replaces",
  substituting: "replaces",
  superseded: "replaces",
  superseding: "replaces",
  amended: "amends",
  amending: "amends",
  modified: "amends",
  modifying: "amends",
  supplemented: "amends",
  supplementing: "amends",
  revised: "amends",
  revising: "amends",
  changed: "amends",
  changing: "amends",
  extended: "amends",
  extending: "amends",
  shortened: "amends",
  shortening: "amends",
  lengthened: "amends",
  lengthening: "amends",
});
// The bare verb and the third person count only when the next thing is a clause reference
// ("Delete Section 6.1", "This Amendment deletes Section 3"). "the Receiving Party shall delete
// all copies as required by Section 7.2" says nothing about a clause: the verb has another object.
const BARE_FORMS = toMap({
  delete: "deletes",
  remove: "deletes",
  omit: "deletes",
  strike: "deletes",
  revoke: "deletes",
  repeal: "deletes",
  rescind: "deletes",
  cancel: "deletes",
  withdraw: "deletes",
  annul: "deletes",
  abrogate: "deletes",
  replace: "replaces",
  restate: "replaces",
  substitute: "replaces",
  supersede: "replaces",
  amend: "amends",
  modify: "amends",
  supplement: "amends",
  revise: "amends",
  change: "amends",
  extend: "amends",
  shorten: "amends",
  lengthen: "amends",
});
const THIRD_PERSON = toMap({
  deletes: "deletes",
  removes: "deletes",
  omits: "deletes",
  strikes: "deletes",
  revokes: "deletes",
  repeals: "deletes",
  rescinds: "deletes",
  cancels: "deletes",
  withdraws: "deletes",
  annuls: "deletes",
  abrogates: "deletes",
  replaces: "replaces",
  restates: "replaces",
  substitutes: "replaces",
  supersedes: "replaces",
  amends: "amends",
  modifies: "amends",
  supplements: "amends",
  revises: "amends",
  changes: "amends",
  extends: "amends",
  shortens: "amends",
  lengthens: "amends",
});
// Phrases that end a clause without a verb from the lists.
const PHRASE_OPERATIONS: RegExp[] = [
  /\bof\s+no\s+(?:further\s+|longer\s+)?(?:force|effect)\b/gi,
  /\bnull\s+and\s+void\b/gi,
  /\bceases?\s+to\s+(?:have\s+)?(?:any\s+)?(?:force|effect)\b/gi,
];

// Maps and not plain objects: a document is free to contain the words "constructor" and
// "__proto__", and an object lookup would answer for them.
const isOperationWord = (word: string): boolean =>
  PARTICIPLES.has(word) || THIRD_PERSON.has(word) || BARE_FORMS.has(word);
const PRIORITY: Record<Operation, number> = { deletes: 3, replaces: 2, amends: 1 };
const STRENGTH: Record<ReferenceVerb, number> = { deletes: 4, replaces: 3, amends: 2, refers: 1 };

// Words that say an operation is not being performed.
const NEGATORS = new Set([
  "not",
  "never",
  "no",
  "nothing",
  "none",
  "neither",
  "nor",
  "cannot",
  "nobody",
]);
// "as amended", "except as amended", "unless amended", "if deleted", "without amending": these
// describe a clause or set a condition, they do not operate on it. Read in the two words before.
const QUALIFIERS = new Set(["as", "except", "unless", "if", "until", "without"]);
const MAX_OBJECT_GAP = 100;
const NEGATION_REACH = 5;
const QUALIFIER_REACH = 2;
const LOOKBACK_CHARS = 100;

// Words that may stand between a bare verb and the reference that is its object.
const OBJECT_FILLER = new Set([
  "the",
  "all",
  "each",
  "any",
  "of",
  "said",
  "such",
  "in",
  "its",
  "their",
  "entirety",
  "entirely",
  "hereby",
  "expressly",
  "also",
  "and",
  "or",
  "following",
  "provision",
  "provisions",
  "text",
  "wording",
  "language",
]);

// A part that holds nothing but a reference and these words has no verb of its own.
const REFERENCE_ONLY_FILLER = new Set([
  "and",
  "or",
  "nor",
  "neither",
  "both",
  "either",
  "of",
  "the",
  "this",
  "that",
  "said",
  "such",
  "original",
  "existing",
  "agreement",
  "nda",
  "contract",
  "hereof",
  "thereof",
  "hereto",
  "in",
  "its",
  "their",
  "entirety",
  "each",
  "all",
  "any",
  "those",
  "these",
  "other",
  "also",
  "further",
  "hereby",
  "e",
  "g",
  "i",
]);

const WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
// Words that open a new part whatever follows them.
const CONTRAST = /\b(?:but|however|whereas|while|although|though|yet|except|provided\s+that)\b/gi;
// What stands just before a reference that follows another one in the same sentence.
const COORDINATION_BEFORE = /(?:,\s*)?\b(?:and\/or|and|or|nor)\s+$|,\s*$/i;
// "deleting the reference to Section 6.1": the clause is mentioned, the reference is what changes.
const REFERENCE_OBJECT =
  /\b(?:cross-?)?references?\s+(?:to|in)\s+(?:(?:the|a|an|any|each|such|said|all)\s+)*$/i;
const COORDINATED_GAP = /^[\s,]*(?:(?:and\/or|and|or|nor)[\s,]*)?$/i;

interface Word {
  word: string;
  start: number;
  end: number;
}

/** Quoted wording is the text being changed or inserted, never an operation: blank it out. */
function withoutQuotes(view: string): { blanked: string; quoted: [number, number][] } {
  const quoted: [number, number][] = [];
  let blanked = "";
  let done = 0;
  for (const run of pairQuotes(view, (inner) => inner.length <= 600)) {
    quoted.push([run.start, run.end]);
    blanked += view.slice(done, run.start) + " ".repeat(run.end - run.start);
    done = run.end;
  }
  return { blanked: blanked + view.slice(done), quoted };
}

/**
 * Brackets that hold no reference are asides ("(but not 6.3)", "(which does not apply to
 * Affiliates)", "(a)"): their words are blanked so that a negation or a conjunction inside them
 * does not reach the operation outside. A bracket that holds a reference is kept, because
 * "(by deleting Section 7.2)" is an operation.
 */
function withoutAsides(text: string, references: Reference[]): string {
  const starts = references.map((reference) => reference.start);
  let out = "";
  let done = 0;
  for (const match of text.matchAll(/\([^()]{0,200}\)/g)) {
    const at = lowerBound(starts, match.index);
    if (at < starts.length && starts[at]! < match.index + match[0].length) continue;
    out += text.slice(done, match.index) + " ".repeat(match[0].length);
    done = match.index + match[0].length;
  }
  return done === 0 ? text : out + text.slice(done);
}

function tokenise(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(WORD)) {
    words.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return words;
}

/**
 * Whether a clause reference follows closely enough to be the object of the verb that ends at
 * `end`: only filler words, commas and other operation words ("deletes or replaces") between.
 */
function objectFollows(text: string, end: number, referenceStarts: number[]): boolean {
  const at = lowerBound(referenceStarts, end);
  if (at >= referenceStarts.length || referenceStarts[at]! - end > MAX_OBJECT_GAP) return false;
  const gap = text.slice(end, referenceStarts[at]!);
  for (const match of gap.matchAll(WORD)) {
    const word = match[0].toLowerCase();
    if (!OBJECT_FILLER.has(word) && !isOperationWord(word)) return false;
  }
  return true;
}

function operatives(blanked: string, words: Word[], referenceStarts: number[]): Operative[] {
  const found: Operative[] = [];
  for (let i = 0; i < words.length; i++) {
    const { word, start, end } = words[i]!;
    // "amended and restated" is one operation, and it is a replacement.
    const and = words[i + 1];
    const restated = words[i + 2];
    if (
      (word === "amended" || word === "amending") &&
      and?.word === "and" &&
      (restated?.word === "restated" || restated?.word === "restating")
    ) {
      found.push({ start, end: restated.end, verb: "replaces" });
      i += 2;
      continue;
    }
    const direct = PARTICIPLES.get(word);
    if (direct !== undefined) {
      found.push({ start, end, verb: direct });
      continue;
    }
    const other = BARE_FORMS.get(word) ?? THIRD_PERSON.get(word);
    if (other !== undefined && objectFollows(blanked, end, referenceStarts)) {
      found.push({ start, end, verb: other });
    }
  }
  for (const pattern of PHRASE_OPERATIONS) {
    pattern.lastIndex = 0;
    for (const match of blanked.matchAll(pattern)) {
      found.push({
        start: match.index,
        end: match.index + match[0].length,
        verb: "deletes",
      });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Whether the words just before an operation, in its own part, say it is not being performed. */
function isNegated(blanked: string, partStart: number, operationStart: number): boolean {
  let before = blanked.slice(Math.max(partStart, operationStart - LOOKBACK_CHARS), operationStart);
  // A comma, a colon or a bracket ends the reach of a negation: "Section 6.1, which shall not
  // apply to Affiliates, is deleted" deletes.
  const cut = Math.max(
    before.lastIndexOf(","),
    before.lastIndexOf(";"),
    before.lastIndexOf(":"),
    before.lastIndexOf("("),
    before.lastIndexOf(")"),
  );
  if (cut !== -1) before = before.slice(cut + 1);
  // "Amendment No. 1" is a number, not a "no".
  before = before.replace(/\bnos?\.\s*\d/gi, " ");
  const words = tokenise(before).map((w) => w.word);
  return (
    words.slice(-NEGATION_REACH).some((w) => NEGATORS.has(w) || w.endsWith("n't")) ||
    words.slice(-QUALIFIER_REACH).some((w) => QUALIFIERS.has(w))
  );
}

interface Cut {
  /** Where the next part starts. */
  at: number;
  /** "sentence" and "contrast" separate parts that do not share an operation. */
  kind: "sentence" | "contrast" | "coordination";
}

const CUT_RANK = { sentence: 3, contrast: 2, coordination: 1 } as const;

/**
 * The parts of the text that each hold their own operations. Hard cuts are the ends of sentences
 * and the words "but", "however" and the like. A coordination cut goes before a reference that
 * follows another one in the same sentence after "and", "or", "nor" or a comma.
 */
function cutsFor(view: string, blanked: string, references: Reference[]): Cut[] {
  const hard: Cut[] = sentenceCuts(view).map((at) => ({ at: at + 1, kind: "sentence" }));
  CONTRAST.lastIndex = 0;
  for (const match of blanked.matchAll(CONTRAST)) {
    hard.push({ at: match.index, kind: "contrast" });
  }
  const hardAt = hard.map((cut) => cut.at).sort((a, b) => a - b);
  const cuts = [...hard];
  for (let i = 1; i < references.length; i++) {
    const previous = references[i - 1]!;
    const reference = references[i]!;
    // Only when no hard cut lies between the two references.
    if (lowerBound(hardAt, previous.end) < lowerBound(hardAt, reference.start)) continue;
    const lead = blanked.slice(Math.max(previous.end, reference.start - 16), reference.start);
    const match = COORDINATION_BEFORE.exec(lead);
    if (match !== null) {
      cuts.push({ at: reference.start - lead.length + match.index, kind: "coordination" });
    }
  }
  // Sorted, with one cut per place and the strongest kind where two coincide.
  cuts.sort((a, b) => a.at - b.at || CUT_RANK[b.kind] - CUT_RANK[a.kind]);
  return cuts.filter((cut, i) => cut.at > 0 && (i === 0 || cuts[i - 1]!.at !== cut.at));
}

/** The verb for each reference, by the rules in the comment at the top of the file. */
function verbsFor(view: string, references: Reference[]): ReferenceVerb[] {
  const { blanked: unquoted, quoted } = withoutQuotes(view);
  const blanked = withoutAsides(unquoted, references);
  const referenceStarts = references.map((reference) => reference.start);
  const words = tokenise(blanked);

  const cuts = cutsFor(view, blanked, references);
  const cutAt = cuts.map((cut) => cut.at);
  // Part p runs from partStart(p) to partEnd(p); the cut that starts part p has index p - 1.
  const partOf = (position: number): number => {
    // The number of cuts at or before the position.
    let low = 0;
    let high = cutAt.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (cutAt[mid]! <= position) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const partStart = (part: number): number => (part === 0 ? 0 : cutAt[part - 1]!);
  const partEnd = (part: number): number => (part < cutAt.length ? cutAt[part]! : view.length);
  const parts = cuts.length + 1;

  // Operations, with the negated ones dropped. A verb coordinated with a negated one ("shall not be
  // amended or deleted") is negated with it.
  const valid: Operative[] = [];
  let previousNegated: boolean = false;
  let previous: Operative | undefined;
  for (const operation of operatives(blanked, words, referenceStarts)) {
    const part = partOf(operation.start);
    const coordinated: boolean =
      previous !== undefined &&
      previousNegated &&
      partOf(previous.start) === part &&
      operation.start - previous.end <= 40 &&
      COORDINATED_GAP.test(blanked.slice(previous.end, operation.start));
    const negated: boolean = coordinated || isNegated(blanked, partStart(part), operation.start);
    previous = operation;
    previousNegated = negated;
    if (!negated) valid.push(operation);
  }
  const operationStarts = valid.map((operation) => operation.start);
  // For each operation, the first replacement at or after it.
  const nextReplacement: number[] = new Array<number>(valid.length + 1).fill(-1);
  for (let i = valid.length - 1; i >= 0; i--) {
    const operation = valid[i]!;
    const counts =
      operation.verb === "replaces" && !objectFollows(blanked, operation.end, referenceStarts);
    nextReplacement[i] = counts ? i : nextReplacement[i + 1]!;
  }

  // Which references can take an operation at all.
  const eligible = references.map((reference) => {
    let q = 0;
    while (q < quoted.length && quoted[q]![1] <= reference.start) q++;
    if (q < quoted.length && quoted[q]![0] <= reference.start) return false;
    return !REFERENCE_OBJECT.test(
      blanked.slice(Math.max(0, reference.start - 48), reference.start),
    );
  });

  // Parts that hold a reference and nothing else, apart from the filler words above.
  const hasOwnWords: boolean[] = new Array<boolean>(parts).fill(false);
  let r = 0;
  for (const { word, start } of words) {
    while (r < references.length && references[r]!.end <= start) r++;
    const insideReference = r < references.length && references[r]!.start <= start;
    if (!insideReference && !REFERENCE_ONLY_FILLER.has(word)) hasOwnWords[partOf(start)] = true;
  }

  const verbs: (ReferenceVerb | undefined)[] = references.map(() => undefined);
  const refsOfPart: number[][] = Array.from({ length: parts }, () => []);
  references.forEach((reference, index) => {
    if (!eligible[index]) {
      verbs[index] = "refers";
      return;
    }
    refsOfPart[partOf(reference.start)]!.push(index);
  });

  // References in a part with words of its own take the nearest operation in that part.
  for (let part = 0; part < parts; part++) {
    if (!hasOwnWords[part]) continue;
    const from = partStart(part);
    const to = partEnd(part);
    for (const index of refsOfPart[part]!) {
      const reference = references[index]!;
      const after = lowerBound(operationStarts, reference.end);
      const next = valid[after];
      const before = valid[after - 1];
      const candidates: { operation: Operative; distance: number }[] = [];
      if (before !== undefined && before.start >= from && before.end <= reference.start) {
        candidates.push({ operation: before, distance: reference.start - before.end });
      }
      if (next !== undefined && next.start < to) {
        candidates.push({ operation: next, distance: next.start - reference.end });
      }
      if (candidates.length === 0) {
        verbs[index] = "refers";
        continue;
      }
      candidates.sort(
        (a, b) =>
          a.distance - b.distance || PRIORITY[b.operation.verb] - PRIORITY[a.operation.verb],
      );
      const chosen = candidates[0]!.operation;
      if (chosen.verb !== "deletes") {
        verbs[index] = chosen.verb;
        continue;
      }
      // "deleting Section 7.2 and substituting the following" replaces the clause, but "deleting
      // Section 7.2 and replacing Section 8" does not: that replacement belongs to Section 8.
      const followingReference = references[index + 1];
      const limit =
        followingReference !== undefined && followingReference.start < to
          ? followingReference.start
          : to;
      const replacement = nextReplacement[after] ?? -1;
      verbs[index] =
        replacement !== -1 && valid[replacement]!.start < limit ? "replaces" : "deletes";
    }
  }

  // A part that is only a reference takes the verb of the part after it when the two are joined by
  // "and", "or", "nor" or a comma ("Section 4 and Section 5 are deleted"), else of the part before
  // ("Delete Section 4 and Section 5").
  const joinedBefore = (part: number): boolean =>
    part > 0 && cuts[part - 1]!.kind === "coordination";
  for (let part = parts - 1; part >= 0; part--) {
    if (hasOwnWords[part] || refsOfPart[part]!.length === 0) continue;
    const following = refsOfPart[part + 1]?.[0];
    const adopted =
      part + 1 < parts && joinedBefore(part + 1) && following !== undefined
        ? verbs[following]
        : undefined;
    for (const index of refsOfPart[part]!) verbs[index] = adopted;
  }
  for (let part = 0; part < parts; part++) {
    for (const index of refsOfPart[part]!) {
      if (verbs[index] !== undefined) continue;
      const before = part > 0 && joinedBefore(part) ? refsOfPart[part - 1]!.at(-1) : undefined;
      verbs[index] = before !== undefined ? (verbs[before] ?? "refers") : "refers";
    }
  }
  return verbs.map((verb) => verb ?? "refers");
}

/**
 * The clause references in a span, one per target. When a target is named more than once the
 * strongest verb wins (deletes, replaces, amends, refers), so a clause that is both mentioned
 * and deleted in one span is reported as deleted.
 */
export function findCrossReferences(
  view: string,
  options: { amendment: boolean },
): CrossReference[] {
  const references = scanReferences(view);
  if (references.length === 0) return [];
  const verbs = options.amendment
    ? verbsFor(view, references)
    : references.map(() => "refers" as const);
  const byTarget = new Map<string, ReferenceVerb>();
  for (let i = 0; i < references.length; i++) {
    for (const target of references[i]!.targets) {
      const verb = verbs[i]!;
      const seen = byTarget.get(target);
      if (seen === undefined) {
        if (byTarget.size >= MAX_TARGETS_PER_SPAN) continue;
        byTarget.set(target, verb);
      } else if (STRENGTH[verb] > STRENGTH[seen]) {
        byTarget.set(target, verb);
      }
    }
  }
  return [...byTarget].map(([target, verb]) => ({ target, verb }));
}
