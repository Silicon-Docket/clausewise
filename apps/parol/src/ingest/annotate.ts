import type { DocumentKind, SpanAnnotation, SpanId } from "../contracts.js";
import { findCrossReferences } from "./references.js";
import { instructionPatterns, keywordCategories } from "./signals.js";
import { findDefinedTerms } from "./terms.js";
import { containsWholeWord, matchView } from "./view.js";

/**
 * Deterministic annotations over source spans. Every annotation comes from a pattern in this
 * folder and not from a model, and the patterns are listed with what they catch and what they
 * miss next to the code: terms.ts, references.ts and signals.ts.
 *
 * Annotations are hints that widen or focus what the analysis looks at. None of them is a
 * finding, and none carries document text beyond a defined term or a clause number.
 */

export interface AnnotatableSpan {
  id: SpanId;
  /** Exactly as stored. Annotation reads a normalized copy and never changes this. */
  text: string;
  /** Spans of an amendment are read for the verbs that change a clause. */
  documentKind: DocumentKind;
}

export interface AnnotationResult {
  annotations: SpanAnnotation[];
  /** Pattern names that matched, by span id. Names only: the matched words are not kept. */
  instructionPatterns: Map<SpanId, string[]>;
}

// A run defines a few dozen terms. These caps only matter for a file built to make the matching
// or the output grow without bound: terms beyond them are ignored, which costs hints and never
// correctness. The bounds, with the reason for each:
//  - terms a span defines, terms in the run, and definitions in the run: a paragraph of nothing
//    but definitions, and twenty thousand paragraphs that each repeat them,
//  - terms one span is annotated as using, and uses in the run: every span of a long file
//    holding every term would otherwise be thousands of annotations each,
//  - cross references in the run: a range such as "Sections 1 through 99" names up to a hundred
//    clauses, and a file may hold twenty thousand paragraphs of them,
//  - the work of looking for terms: terms times characters, so that a file of two megabytes with
//    hundreds of terms stops searching instead of running for minutes. It is counted in
//    characters and not in time, so the same input always stops at the same place.
// When a bound is reached the spans before it keep everything, and the spans after it lose that
// kind of annotation. A normal agreement is nowhere near any of them.
const MAX_TERMS_PER_SPAN = 50;
const MAX_TERMS_PER_RUN = 500;
const MAX_DEFINITIONS_PER_RUN = 50_000;
const MAX_USES_PER_SPAN = 100;
const MAX_USES_PER_RUN = 200_000;
const MAX_REFERENCES_PER_RUN = 50_000;
const MAX_TERM_SEARCH_WORK = 400_000_000;

// Plain code-unit order. localeCompare depends on the machine's locale, and the output of this
// module must be identical wherever it runs.
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function valueOf(annotation: SpanAnnotation): string {
  switch (annotation.kind) {
    case "defines_term":
    case "uses_term":
      return annotation.term;
    case "cross_reference":
      return `${annotation.target}\u0000${annotation.verb}`;
    case "instruction_like":
      return annotation.pattern;
    case "keyword_hint":
      return annotation.category;
  }
}

const byKindThenValue = (a: SpanAnnotation, b: SpanAnnotation): number =>
  compare(a.kind, b.kind) || compare(valueOf(a), valueOf(b));

/**
 * Annotations in span order, then kind, then value. Defined terms are matched across every span
 * of the run, so a term the NDA defines and an amendment uses is linked.
 */
export function annotateSpans(spans: AnnotatableSpan[]): AnnotationResult {
  const views = spans.map((span) => matchView(span.text));

  // Pass one: who defines what. Terms are kept in the order they first appear.
  const definers = new Map<string, Set<number>>();
  views.forEach((view, index) => {
    for (const term of findDefinedTerms(view).slice(0, MAX_TERMS_PER_SPAN)) {
      let set = definers.get(term);
      if (set === undefined) {
        if (definers.size >= MAX_TERMS_PER_RUN) continue;
        set = new Set<number>();
        definers.set(term, set);
      }
      set.add(index);
    }
  });
  const terms = [...definers.keys()].sort(compare);

  const annotations: SpanAnnotation[] = [];
  const instruction = new Map<SpanId, string[]>();
  let definitionsLeft = MAX_DEFINITIONS_PER_RUN;
  let usesLeft = MAX_USES_PER_RUN;
  let referencesLeft = MAX_REFERENCES_PER_RUN;
  let searchWorkLeft = MAX_TERM_SEARCH_WORK;

  spans.forEach((span, index) => {
    const view = views[index]!;
    const own: SpanAnnotation[] = [];

    // Searching a span for every term costs terms times its length. When the budget cannot pay
    // for a span, this span and every later one are not searched.
    const searchCost = terms.length * view.length;
    const search = searchCost <= searchWorkLeft;
    if (search) searchWorkLeft -= searchCost;
    else searchWorkLeft = 0;
    let usesHere = 0;
    for (const term of terms) {
      if (definers.get(term)!.has(index)) {
        if (definitionsLeft > 0) {
          definitionsLeft--;
          own.push({ kind: "defines_term", spanId: span.id, term });
        }
      } else if (
        search &&
        usesHere < MAX_USES_PER_SPAN &&
        usesLeft > 0 &&
        containsWholeWord(view, term)
      ) {
        usesHere++;
        usesLeft--;
        own.push({ kind: "uses_term", spanId: span.id, term });
      }
    }

    for (const reference of findCrossReferences(view, {
      amendment: span.documentKind === "amendment",
    })) {
      if (referencesLeft <= 0) break;
      referencesLeft--;
      own.push({
        kind: "cross_reference",
        spanId: span.id,
        target: reference.target,
        verb: reference.verb,
      });
    }

    const patterns = instructionPatterns(view);
    if (patterns.length > 0) instruction.set(span.id, patterns);
    for (const pattern of patterns) {
      own.push({ kind: "instruction_like", spanId: span.id, pattern });
    }

    for (const category of keywordCategories(view)) {
      own.push({ kind: "keyword_hint", spanId: span.id, category });
    }

    annotations.push(...own.sort(byKindThenValue));
  });

  return { annotations, instructionPatterns: instruction };
}
