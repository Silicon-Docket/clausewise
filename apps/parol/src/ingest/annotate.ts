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
// quadratic: terms beyond them are ignored, which costs hints and never correctness.
const MAX_TERMS_PER_SPAN = 50;
const MAX_TERMS_PER_RUN = 500;

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

  spans.forEach((span, index) => {
    const view = views[index]!;
    const own: SpanAnnotation[] = [];

    for (const term of terms) {
      if (definers.get(term)!.has(index)) own.push({ kind: "defines_term", spanId: span.id, term });
      else if (containsWholeWord(view, term)) {
        own.push({ kind: "uses_term", spanId: span.id, term });
      }
    }

    for (const reference of findCrossReferences(view, {
      amendment: span.documentKind === "amendment",
    })) {
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
