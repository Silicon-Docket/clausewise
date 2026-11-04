import { lowerBound, pairQuotes, sentenceAround, sentenceCuts } from "./view.js";

/**
 * Cross-references to clauses, with the verb an amendment applies to them.
 *
 * What this catches, on a normalized view: a label (Section, Sections, Sec., Clause, Article,
 * Paragraph, Subsection, section and paragraph signs) followed by a clause number, with its list:
 * Section 6.1, Sections 4, 5 and 8, Clause 3, Article II, paragraph 2, Section 7.2(a), Section 4A.
 * One annotation comes out per number. A sub-item such as (a) is dropped, because the clause
 * numbers a document is cut into do not carry it, so Section 7.2(a) refers to clause 7.2. The ends
 * of a range ("Sections 4 through 6") are both returned and the numbers between them are not.
 *
 * What it misses: a reference by name ("the Term clause", "the preceding Section"), a number with
 * no label ("see 6.1"), a lettered target ("Section A", "Schedule 2" are not clause numbers), and
 * the interior of a range. It cannot tell a section of this agreement from a section of a statute
 * ("Section 5 of the Securities Act"): both are reported, and an extra reference only widens what
 * the analysis may look at.
 *
 * The verb comes only from words in the same sentence as the reference, and only for a document
 * that is an amendment. A sentence here ends at . ! ? ; or :, because the text after "to read as
 * follows:" is new wording and not an operation on the clause. Spans of the NDA itself always get
 * "refers": an NDA that says "Section 6.1 is deleted" is describing its own drafting, and the
 * amendment rules (who governs whom) apply only to documents that amend.
 */

export type ReferenceVerb = "replaces" | "amends" | "deletes" | "refers";

export interface CrossReference {
  target: string;
  verb: ReferenceVerb;
}

const MAX_TARGETS_PER_SPAN = 200;
const MAX_REFERENCES_PER_SPAN = 5000;

const LABEL =
  /(?<![\p{L}\p{N}])(?:(?:sections?|secs?\.?|clauses?|articles?|paragraphs?|paras?\.?|sub-?sections?|sub-?clauses?|sub-?paragraphs?)(?![\p{L}\p{N}])|\u00a7\u00a7?|\u00b6\u00b6?)\s*/giu;

// Up to four digits for the first number, three for the ones that follow it in a list, so a year
// after a comma ("Section 4, 2026") is not read as a clause.
const FIRST_NUMBER = /(\d{1,4}(?:\.\d{1,4}){0,5}(?:[A-Z](?![\p{L}\p{N}]))?)(?![\p{L}\p{N}])/uy;
const LATER_NUMBER = /(\d{1,3}(?:\.\d{1,4}){0,5}(?:[A-Z](?![\p{L}\p{N}]))?)(?![\p{L}\p{N}])/uy;
const ROMAN = /([IVXLC]{1,6})(?![\p{L}\p{N}])/uy;
const SUB_ITEMS = /(?:\([a-zA-Z0-9]{1,4}\))+/y;
const SEPARATOR =
  /(?:\s*,\s*(?:(?:and\/or|and|or)\s+)?|\s+(?:and\/or|and|or|through|to)\s+|\s*&\s*|\s*-\s*)/y;
// "Section 4, 30 days after notice": the 30 is a period and not a clause.
const UNIT_AFTER =
  /\s+(?:days?|months?|years?|weeks?|hours?|business|calendar|percent|per|times?|copies|pages?|usd|dollars?)\b/iy;

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
    let end = first.end;
    for (;;) {
      const separator = sticky(SEPARATOR, view, end);
      if (separator === null) break;
      const token = readToken(view, end + separator[0].length, true, romanList);
      if (token === undefined) break;
      if (sticky(UNIT_AFTER, view, token.end) !== null) break;
      targets.push(token.target);
      end = token.end;
    }
    references.push({ start: label.index, end, targets });
    LABEL.lastIndex = end;
  }
  return references;
}

// ---------------------------------------------------------------------------------------------
// Verbs
// ---------------------------------------------------------------------------------------------

type Operation = "deletes" | "replaces" | "amends";
interface Operative {
  start: number;
  end: number;
  verb: Operation;
}

// Participles and gerunds: "is deleted", "by deleting". The bare verb is not listed because "the
// Receiving Party shall delete the copies" says nothing about a clause; it is accepted only after
// "to" or "hereby" ("the parties agree to delete Section 3").
const PARTICIPLES: ReadonlyMap<string, Operation> = new Map(
  Object.entries({
    deleted: "deletes",
    deleting: "deletes",
    removed: "deletes",
    removing: "deletes",
    omitted: "deletes",
    omitting: "deletes",
    struck: "deletes",
    stricken: "deletes",
    striking: "deletes",
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
  }) as [string, Operation][],
);
const BARE_FORMS: ReadonlyMap<string, Operation> = new Map(
  Object.entries({
    delete: "deletes",
    remove: "deletes",
    omit: "deletes",
    strike: "deletes",
    replace: "replaces",
    restate: "replaces",
    substitute: "replaces",
    supersede: "replaces",
    amend: "amends",
    modify: "amends",
    supplement: "amends",
    revise: "amends",
  }) as [string, Operation][],
);
// "This Amendment deletes Section 3" names its subject, which "the Receiving Party shall delete"
// does not need to, so the third person is accepted anywhere.
const THIRD_PERSON: ReadonlyMap<string, Operation> = new Map(
  Object.entries({
    deletes: "deletes",
    removes: "deletes",
    omits: "deletes",
    strikes: "deletes",
    replaces: "replaces",
    restates: "replaces",
    substitutes: "replaces",
    supersedes: "replaces",
    amends: "amends",
    modifies: "amends",
    supplements: "amends",
    revises: "amends",
  }) as [string, Operation][],
);
// "Except as amended by this Amendment, Section 4 remains in effect", "as hereby amended" and
// "shall not be amended" describe a clause, they do not operate on it.
const NOT_AN_OPERATION_AFTER = new Set([
  "as",
  "except",
  "unless",
  "not",
  "never",
  "without",
  "if",
  "until",
  "nor",
]);
const WORD = /[A-Za-z]+/g;
// Maps and not plain objects: a document is free to contain the words "constructor" and
// "__proto__", and an object lookup would answer for them.
const isOperationWord = (word: string): boolean =>
  PARTICIPLES.has(word) || THIRD_PERSON.has(word) || BARE_FORMS.has(word);
const PRIORITY: Record<Operation, number> = { deletes: 3, replaces: 2, amends: 1 };
const STRENGTH: Record<ReferenceVerb, number> = { deletes: 4, replaces: 3, amends: 2, refers: 1 };

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

function operatives(blanked: string): Operative[] {
  const words: { word: string; start: number; end: number }[] = [];
  for (const match of blanked.matchAll(WORD)) {
    words.push({
      word: match[0].toLowerCase(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  const found: Operative[] = [];
  // Words left out because of what precedes them, so a coordinated verb is left out with them:
  // in "shall not be amended or deleted" the deletion is as forbidden as the amendment.
  const skipped = new Set<number>();
  const COORDINATORS = new Set(["and", "or", "nor"]);
  for (let i = 0; i < words.length; i++) {
    const { word, start, end } = words[i]!;
    const before = [words[i - 1]?.word, words[i - 2]?.word];
    const coordinated =
      skipped.has(i - 1) || (COORDINATORS.has(words[i - 1]?.word ?? "") && skipped.has(i - 2));
    if (coordinated || before.some((w) => w !== undefined && NOT_AN_OPERATION_AFTER.has(w))) {
      // Only an operation word can pass the exclusion on to the next one.
      if (isOperationWord(word)) skipped.add(i);
      continue;
    }
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
    const bare = BARE_FORMS.get(word);
    const lead = words[i - 1]?.word;
    if (bare !== undefined && (lead === "to" || lead === "hereby")) {
      found.push({ start, end, verb: bare });
      continue;
    }
    const third = THIRD_PERSON.get(word);
    if (third !== undefined) found.push({ start, end, verb: third });
  }
  return found;
}

/**
 * The verb for each reference: the operation word nearest to it in its sentence, so that in
 * "Section 7.2 is amended by replacing the words" the clause is amended and the words replaced.
 * One refinement: a deletion followed by a replacement before the next reference ("deleting
 * Section 7.2 and substituting the following") replaces the clause.
 */
function verbsFor(view: string, references: Reference[]): ReferenceVerb[] {
  const { blanked, quoted } = withoutQuotes(view);
  const ops = operatives(blanked);
  if (ops.length === 0) return references.map(() => "refers");
  const cuts = sentenceCuts(view);
  const opStarts = ops.map((op) => op.start);
  // For each operation, the nearest replacement at or after it.
  const nextReplacement: number[] = new Array<number>(ops.length + 1).fill(-1);
  for (let i = ops.length - 1; i >= 0; i--) {
    nextReplacement[i] = ops[i]!.verb === "replaces" ? i : nextReplacement[i + 1]!;
  }

  let quote = 0;
  return references.map((reference, index): ReferenceVerb => {
    while (quote < quoted.length && quoted[quote]![1] <= reference.start) quote++;
    const inside = quote < quoted.length && quoted[quote]![0] <= reference.start;
    if (inside) return "refers";

    const sentence = sentenceAround(cuts, reference.start, view.length);
    const after = lowerBound(opStarts, reference.end);
    const next = ops[after];
    const previous = ops[after - 1];
    const candidates: { op: Operative; distance: number; index: number }[] = [];
    if (previous !== undefined && previous.start >= sentence.start) {
      candidates.push({ op: previous, distance: reference.start - previous.end, index: after - 1 });
    }
    if (next !== undefined && next.start < sentence.end) {
      candidates.push({ op: next, distance: next.start - reference.end, index: after });
    }
    if (candidates.length === 0) return "refers";
    candidates.sort((a, b) => a.distance - b.distance || PRIORITY[b.op.verb] - PRIORITY[a.op.verb]);
    const chosen = candidates[0]!;
    if (chosen.op.verb !== "deletes") return chosen.op.verb;

    const limit = Math.min(sentence.end, references[index + 1]?.start ?? sentence.end);
    const replacement = nextReplacement[after] ?? -1;
    return replacement !== -1 && ops[replacement]!.start < limit ? "replaces" : "deletes";
  });
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
