import { estimateTokens } from "@clausewise/review";
import {
  DOC_LABELS,
  type BundleSpanReason,
  type CategoryId,
  type ContextBundle,
  type IngestOutput,
  type PlaybookRuleRecord,
  type SourceSpan,
  type SpanId,
} from "../contracts.js";
import type { BuildBundles } from "../module-contracts.js";
import { renderRule, renderSpans } from "../prompts/render.js";
import { headingNumber, referenceNumbers, targetsClause } from "./clause-refs.js";

export { headingNumber };

/**
 * Retrieval builds, for each rule, the passages the analysis may read. It is code and not a
 * model, and its corpus is the run: every span it can return comes from `ingest.spans`, which the
 * server built from the run's own document versions. A span id in the extract output that is not
 * one of them is ignored, so a stale or forged output cannot reach into another matter.
 *
 * R1, the baseline, is "what extract found, what that needs, what a keyword might have found":
 *   1. the spans extract located for the rule's category, with a verified quote,
 *   2. the definition spans of every defined term those spans use,
 *   3. the keyword-hint spans for the category that extract did not locate, and the spans it
 *      pointed at with a quote that is not in them (a pointer that was not confirmed is a hint,
 *      not a location).
 * When extract found nothing it can vouch for, or could not run, the whole of every document is
 * used (`fullDocument`), so that "missing" is a judgment about the documents and not about what
 * retrieval happened to find. A passage whose quote is not in its span is not something extract
 * can vouch for: a mislabelled clause, or a label a document talked the model into, must not
 * stand in for the real location and switch the whole-document read off. The same holds for a
 * rule that shares its category with another rule: extract locates per category, so what it found
 * may be the other rule's clause (see `rulesInCategory` below).
 *
 * R2 adds one step to R1: amendment spans that delete, replace or amend a clause already in the
 * bundle, because an amendment can change a clause without using a word of its category, and the
 * unnumbered paragraphs that carry the wording such an amendment restates.
 *
 * Nothing is truncated. A bundle over the budget is flagged, and the rule is not analysed.
 */

const DOC_ORDER = new Map<string, number>(DOC_LABELS.map((label, index) => [label, index]));

/** The NDA is D1, and every other document of a run is an amendment (buildIngest enforces it). */
const NDA_LABEL = "D1";

/** The verbs that change a clause. "refers" only mentions one. */
const CHANGING_VERBS: ReadonlySet<string> = new Set(["deletes", "replaces", "amends"]);

const REASON_ORDER: BundleSpanReason[] = [
  "located",
  "definition",
  "cross_reference",
  "hint",
  "full_document",
];

function inDocumentOrder(spans: SourceSpan[]): SourceSpan[] {
  return [...spans].sort(
    (a, b) =>
      (DOC_ORDER.get(a.docLabel) ?? DOC_ORDER.size) -
        (DOC_ORDER.get(b.docLabel) ?? DOC_ORDER.size) || a.paragraphIndex - b.paragraphIndex,
  );
}

export const buildBundles: BuildBundles = ({ ingest, extract, rules, policy, budgetTokens }) => {
  const spans = inDocumentOrder(ingest.spans);
  const byId = new Map<SpanId, SourceSpan>(spans.map((span) => [span.id, span]));

  // Annotations are indexed once. An annotation on a span that is not in this run is dropped here.
  const definers = new Map<string, Set<SpanId>>();
  const usedTerms = new Map<SpanId, Set<string>>();
  const hinted = new Map<CategoryId, Set<SpanId>>();
  const changes = new Map<SpanId, { target: string }[]>();
  indexAnnotations(ingest, byId, { definers, usedTerms, hinted, changes });

  // Extract locates passages for a category, not for a rule. Where several rules share a category
  // (the demo playbook has two for permitted disclosures), what was located for the category may
  // be the clause of one of them, and a rule whose own clause is absent would be shown that other
  // clause and never judged `missing`. Such a rule reads the whole document, as one with nothing
  // located does.
  const rulesInCategory = new Map<CategoryId, number>();
  for (const rule of rules)
    rulesInCategory.set(rule.category, (rulesInCategory.get(rule.category) ?? 0) + 1);

  return rules.map((rule): ContextBundle => {
    // A hand-built or older extract output may lack a category; treat that as nothing located.
    const entry: ExtractCategory | undefined = extract.categories[rule.category];

    // Only a passage whose quote was found in its span counts as located. One that was not is a
    // pointer: kept as a hint, so that a clause the model got slightly wrong is still read when
    // something else was located, but never enough on its own to leave the whole document unread.
    const located = new Set<SpanId>();
    const pointed = new Set<SpanId>();
    for (const passage of entry?.located ?? []) {
      if (!byId.has(passage.spanId)) continue;
      (passage.quoteCheck === "not_found" ? pointed : located).add(passage.spanId);
    }

    // Presence and absence rules alike: with nothing located, "missing" and "nothing forbidden"
    // are both claims about every document, so both read every document. A degraded extract
    // located nothing because it did not look.
    const sharesCategory = (rulesInCategory.get(rule.category) ?? 0) > 1;
    const fullDocument = extract.degraded || located.size === 0 || sharesCategory;

    const definitions = new Set<SpanId>();
    for (const id of located) {
      for (const term of usedTerms.get(id) ?? []) {
        for (const definer of definers.get(term) ?? []) definitions.add(definer);
      }
    }

    const hints = new Set<SpanId>();
    for (const id of [...(hinted.get(rule.category) ?? []), ...pointed])
      if (!located.has(id)) hints.add(id);

    const base = new Set<SpanId>(
      fullDocument ? byId.keys() : [...located, ...definitions, ...hints],
    );

    // One hop: a span found only because it changes a bundled clause does not bring in the spans
    // that change it in turn, nor the definitions it uses. That is the whole of R2.
    const crossReferences = new Set<SpanId>();
    if (policy === "R2") {
      const bundledNumbers = spans
        .filter((s) => s.docLabel === NDA_LABEL && base.has(s.id))
        .flatMap(referenceNumbers);
      for (const span of spans) {
        if (span.docLabel === NDA_LABEL || crossReferences.has(span.id)) continue;
        const touches = (changes.get(span.id) ?? []).some(({ target }) =>
          bundledNumbers.some((number) => targetsClause(target, number)),
        );
        if (touches) crossReferences.add(span.id);
      }

      // "Section 6.1 is amended and restated to read as follows:" is followed by paragraphs of
      // the new wording that carry no number and no annotation, so nothing but their position
      // says what they are. They are the text of the instruction that was added, up to the next
      // numbered clause or the next instruction of the amendment's own.
      for (const [index, span] of spans.entries()) {
        if (!crossReferences.has(span.id) || !changes.has(span.id)) continue;
        for (const next of spans.slice(index + 1)) {
          if (next.docLabel !== span.docLabel || next.clauseNumber !== null || changes.has(next.id))
            break;
          crossReferences.add(next.id);
        }
      }
    }

    const included = new Set<SpanId>([...base, ...crossReferences]);
    const reasonSets: Record<BundleSpanReason, Set<SpanId>> = {
      located,
      definition: definitions,
      cross_reference: crossReferences,
      hint: hints,
      full_document: new Set(byId.keys()),
    };

    const chosen = spans.filter((span) => included.has(span.id));
    const bundleSpans = chosen.map((span) => ({
      spanId: span.id,
      why: REASON_ORDER.find((reason) => reasonSets[reason].has(span.id)) ?? "full_document",
    }));

    // What analyze will render: the same clause text and the same rule text, so that the
    // estimate and the prompt cannot drift apart.
    const estimatedTokens = estimateTokens(`${renderSpans(chosen)}\n\n${renderRule(rule)}`);

    return {
      ruleKey: rule.key,
      category: rule.category,
      rule: cloneRule(rule),
      spans: bundleSpans,
      fullDocument,
      estimatedTokens,
      budgetTokens,
      overBudget: estimatedTokens > budgetTokens,
    };
  });
};

type ExtractCategory = { located: { spanId: SpanId; quoteCheck?: string }[] };

function indexAnnotations(
  ingest: IngestOutput,
  byId: Map<SpanId, SourceSpan>,
  into: {
    definers: Map<string, Set<SpanId>>;
    usedTerms: Map<SpanId, Set<string>>;
    hinted: Map<CategoryId, Set<SpanId>>;
    changes: Map<SpanId, { target: string }[]>;
  },
): void {
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V): void => {
    let set = map.get(key);
    if (set === undefined) {
      set = new Set<V>();
      map.set(key, set);
    }
    set.add(value);
  };
  for (const annotation of ingest.annotations) {
    if (!byId.has(annotation.spanId)) continue;
    switch (annotation.kind) {
      case "defines_term":
        add(into.definers, annotation.term, annotation.spanId);
        break;
      case "uses_term":
        add(into.usedTerms, annotation.spanId, annotation.term);
        break;
      case "keyword_hint":
        add(into.hinted, annotation.category, annotation.spanId);
        break;
      case "cross_reference":
        if (CHANGING_VERBS.has(annotation.verb)) {
          const list = into.changes.get(annotation.spanId) ?? [];
          list.push({ target: annotation.target });
          into.changes.set(annotation.spanId, list);
        }
        break;
      case "instruction_like":
        break;
    }
  }
}

/** The bundle owns its rule, so a later change to the playbook object cannot alter a stored bundle. */
function cloneRule(rule: PlaybookRuleRecord): PlaybookRuleRecord {
  return { ...rule, escalateWhen: rule.escalateWhen.map(({ id, text }) => ({ id, text })) };
}
