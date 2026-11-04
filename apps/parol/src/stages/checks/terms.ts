import { normalizeForAnchor } from "@clausewise/review";
import { JURISDICTIONS } from "./facts.js";
import { fold } from "./text.js";

/**
 * A conservative guess at which capitalised phrases in a quote are defined terms, used to find
 * the ones that no span of the run defines.
 *
 * What it reads as a defined term: a run of Capitalised words that ends in one of the words in
 * `HEADS` (Information, Materials, Data, Property, Party, Parties, Representatives, Affiliates,
 * Purpose, Agreement, Disclosure, Records and a few like them), such as "Proprietary Information"
 * or "Receiving Party". It is not read as one when
 *  - the run is a single word that opens a sentence, because the capital is only position;
 *  - the run opens a sentence with a word such as Each, The or Any, which is dropped from it;
 *  - the run is the whole of a segment, which is a heading or a bare term and says nothing about use;
 *  - it names a section ("Section Data"), a place on the jurisdiction list, or a party: the run is
 *    part of the client's name or is followed by Inc, LLC, Ltd, Corp, Limited and the like;
 *  - the word that ends the run is possessive ("Disclosing Party's" ends the run at Party).
 *
 * A term counts as defined when some defines_term annotation anywhere in the run names it, in
 * singular or plural, or names a longer term that it ends (the defined term "Confidential
 * Information" defines "Information" when it stands alone). Nothing about what the definition
 * says is judged: two conflicting definitions of the same term are not found here.
 *
 * What it misses: a defined term that does not end in one of the heads ("the Services", "the
 * Effective Date", "the Transaction"); terms written in capitals or with hyphens, since a hyphen
 * ends a run; a lower-case use of a defined term; a term that is defined but not where the text
 * uses it; and a run that is the whole of a short quote. A party name that is neither the
 * client's nor followed by a company suffix may be read as a term. Every miss lets a finding
 * through without this escalation and never adds one.
 */

const HEADS: ReadonlySet<string> = new Set([
  "Information",
  "Materials",
  "Material",
  "Data",
  "Property",
  "Party",
  "Parties",
  "Representatives",
  "Affiliates",
  "Affiliate",
  "Purpose",
  "Agreement",
  "Disclosure",
  "Records",
  "Recipient",
  "Discloser",
]);

/** Words that open a sentence and are capitalised only for that. */
const OPENERS: ReadonlySet<string> = new Set([
  "A",
  "After",
  "All",
  "An",
  "Any",
  "At",
  "Before",
  "Both",
  "By",
  "During",
  "Each",
  "Either",
  "Except",
  "Following",
  "For",
  "If",
  "In",
  "Neither",
  "No",
  "Nor",
  "Notwithstanding",
  "Nothing",
  "On",
  "Other",
  "Provided",
  "Pursuant",
  "Subject",
  "Such",
  "That",
  "The",
  "These",
  "This",
  "Those",
  "To",
  "Under",
  "Unless",
  "Upon",
  "When",
  "Where",
  "With",
  "Within",
  "Without",
]);

const REFERENCE_WORDS: ReadonlySet<string> = new Set([
  "Section",
  "Sections",
  "Article",
  "Articles",
  "Clause",
  "Clauses",
  "Schedule",
  "Schedules",
  "Exhibit",
  "Annex",
  "Appendix",
  "Paragraph",
]);

const COMPANY_SUFFIX =
  /^[\s,]*(?:inc|llc|ltd|limited|corp|corporation|llp|lp|gmbh|plc|co|company|ag|sa|nv|bv)\b/i;

const PLACES: readonly string[] = JURISDICTIONS.map((name) => name.toLowerCase());

// A word, with any hyphenated parts and an apostrophe-s. A hyphenated word is never capitalised
// for this purpose, so it ends a run.
const WORD = /[A-Za-z][A-Za-z]*(?:-[A-Za-z]+)*(?:'s)?/g;
const CAPITALISED = /^[A-Z][a-z]+$/;
const SEGMENT_END = /[.!?;:]/g;
// What may stand before the first word of a sentence without making the word a mid-sentence one:
// white space, a list marker such as (a) or (iv), and a clause number. The digits are matched one
// at a time on purpose: a quantifier on a group that already repeats (`\d+` inside `(...)*`) can
// split a run of digits in exponentially many ways, and a quote that opens with a few dozen digits
// and then a comma would stall the process. Each alternative here starts with a different
// character, so a failed match is decided in one pass.
const BEFORE_SENTENCE = /^(?:\s|\(\w{1,4}\)|\d)*$/;
// Nothing but those, and punctuation, around a run: the run is the whole segment.
const BARE = /^(?:\s|[.!?;:]|\(\w{1,4}\)|\d)*$/;

export interface TermUse {
  /** Where the run starts and ends in the text that was read. Never the run itself. */
  start: number;
  end: number;
  /** The run, folded. Used to look the term up, and kept out of every detail. */
  folded: string;
}

interface Word {
  text: string;
  base: string;
  start: number;
  end: number;
  capitalised: boolean;
  possessive: boolean;
}

function wordsOf(segment: string, offset: number): Word[] {
  const out: Word[] = [];
  for (const match of segment.matchAll(WORD)) {
    const text = match[0];
    const possessive = text.endsWith("'s");
    const base = possessive ? text.slice(0, -2) : text;
    out.push({
      text,
      base,
      start: offset + match.index,
      end: offset + match.index + text.length,
      capitalised: CAPITALISED.test(base),
      possessive,
    });
  }
  return out;
}

/**
 * The capitalised phrases in `text` that look like defined terms and are not excluded above. The
 * text is read as a model quoted it, so it is normalised first.
 */
export function findTermUses(rawText: string, clientName: string): TermUse[] {
  const text = normalizeForAnchor(rawText);
  const client = fold(clientName);
  const uses: TermUse[] = [];

  const cuts: number[] = [];
  for (const match of text.matchAll(SEGMENT_END)) cuts.push(match.index + 1);
  cuts.push(text.length);

  let segmentStart = 0;
  for (const segmentEnd of cuts) {
    const words = wordsOf(text.slice(segmentStart, segmentEnd), segmentStart);
    const from = segmentStart;
    segmentStart = segmentEnd;

    let at = 0;
    while (at < words.length) {
      if (!words[at]!.capitalised) {
        at++;
        continue;
      }
      // A run: capitalised words one space apart, ended by a possessive.
      let end = at;
      while (
        !words[end]!.possessive &&
        end + 1 < words.length &&
        words[end + 1]!.capitalised &&
        text.slice(words[end]!.end, words[end + 1]!.start) === " "
      ) {
        end++;
      }
      const run = words.slice(at, end + 1);
      at = end + 1;

      const startsSentence = BEFORE_SENTENCE.test(text.slice(from, run[0]!.start));
      let first = 0;
      if (startsSentence) {
        while (first < run.length - 1 && OPENERS.has(run[first]!.base)) first++;
        if (first === 0 && run.length === 1) continue;
      }
      const kept = run.slice(first);
      const head = kept[kept.length - 1]!;
      if (!HEADS.has(head.base) || REFERENCE_WORDS.has(kept[0]!.base)) continue;

      const startAt = kept[0]!.start;
      const endAt = head.start + head.base.length;
      const folded = kept
        .map((w) => w.base)
        .join(" ")
        .toLowerCase();

      // The whole of the segment is a heading or a bare term, and says nothing about use.
      const around = text.slice(from, startAt) + text.slice(endAt, segmentEnd);
      if (BARE.test(around)) continue;

      if (PLACES.some((place) => folded.includes(place))) continue;
      if (client !== "" && client.includes(folded)) continue;
      if (COMPANY_SUFFIX.test(text.slice(endAt, endAt + 16))) continue;

      uses.push({ start: startAt, end: endAt, folded });
    }
  }
  return uses;
}

// Plural to singular, enough for the heads above: Parties/Party, Materials/Material.
function stem(word: string): string {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) return word.slice(0, -1);
  return word;
}

const stemPhrase = (phrase: string): string => phrase.split(" ").map(stem).join(" ");

/** The defined terms in the form `isDefinedStemmed` compares, computed once per run. */
export const stemTerms = (definedTerms: readonly string[]): string[] =>
  definedTerms.map(stemPhrase);

/**
 * Whether some defined term covers the phrase: it is the phrase, it is a term the phrase ends
 * ("Mutual Agreement" ends the defined term "Agreement"), or the phrase is one word that ends a
 * defined term ("Party" ends "Receiving Party"). `stems` comes from `stemTerms`.
 */
export function isDefinedStemmed(folded: string, stems: readonly string[]): boolean {
  const phrase = stemPhrase(folded);
  const single = !phrase.includes(" ");
  for (const defined of stems) {
    if (phrase === defined || phrase.endsWith(` ${defined}`)) return true;
    if (single && defined.endsWith(` ${phrase}`)) return true;
  }
  return false;
}

export const isDefined = (folded: string, definedTerms: readonly string[]): boolean =>
  isDefinedStemmed(folded, stemTerms(definedTerms));
