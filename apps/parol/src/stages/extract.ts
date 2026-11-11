import {
  CATEGORY_IDS,
  LocateSchema,
  type CategoryId,
  type ExtractOutput,
  type IngestOutput,
  type LocatedPassage,
  type RunManifest,
  type SourceSpan,
  type SpanId,
} from "../contracts.js";
import type { RegisteredPrompt, RunExtract } from "../module-contracts.js";
import {
  describeClient,
  describeDocuments,
  flatten,
  renderContractBlock,
} from "../prompts/render.js";
import { renderPrompt } from "../prompts/registry.js";
import { verifyQuote } from "../quotes.js";
import { callModel, normalizeLabel } from "./analyze-call.js";

/** Longest reason kept from the model. It is a short sentence; the cap bounds a runaway reply. */
const REASON_LIMIT = 500;

/** Spans with a keyword hint for each category, in document order. */
function hintsByCategory(ingest: IngestOutput): Map<CategoryId, SpanId[]> {
  const hinted = new Map<CategoryId, Set<SpanId>>();
  for (const annotation of ingest.annotations) {
    if (annotation.kind !== "keyword_hint") continue;
    let set = hinted.get(annotation.category);
    if (set === undefined) {
      set = new Set<SpanId>();
      hinted.set(annotation.category, set);
    }
    set.add(annotation.spanId);
  }
  const ordered = new Map<CategoryId, SpanId[]>();
  for (const category of CATEGORY_IDS) {
    const set = hinted.get(category);
    ordered.set(
      category,
      set === undefined ? [] : ingest.spans.filter((s) => set.has(s.id)).map((s) => s.id),
    );
  }
  return ordered;
}

/** Every category present, nothing located. The shape a failed or skipped call leaves. */
function emptyOutput(
  hints: Map<CategoryId, SpanId[]>,
  options: { degraded: boolean; notFoundReason: string | null },
): ExtractOutput {
  const categories = {} as ExtractOutput["categories"];
  for (const category of CATEGORY_IDS) {
    categories[category] = {
      located: [],
      // A degraded run did not look, so it cannot say that nothing was found.
      notFound: !options.degraded,
      notFoundReason: options.degraded ? null : options.notFoundReason,
      hintSpans: [...(hints.get(category) ?? [])],
    };
  }
  return { categories, degraded: options.degraded };
}

/**
 * The extract output of a model that finds nothing in any category (or, with `degraded`, of a call
 * that failed). Retrieval then reads the whole document for every rule, which is the largest prompt
 * a rule can get, and that is why the spend planner assumes it.
 */
export function emptyExtractOutput(
  ingest: IngestOutput,
  options: { degraded: boolean; notFoundReason: string | null },
): ExtractOutput {
  return emptyOutput(hintsByCategory(ingest), options);
}

/** What the one extract call sends. Pure; `runExtract` and the spend planner share it. */
export interface ExtractRequest {
  system: string;
  prompt: string;
}

export function buildExtractRequest(args: {
  ingest: IngestOutput;
  manifest: RunManifest;
  prompt: RegisteredPrompt;
}): ExtractRequest {
  const { ingest, manifest, prompt } = args;
  const userPrompt = renderPrompt(prompt.definition, {
    contractBlock: renderContractBlock(ingest.spans),
    documents: describeDocuments(manifest),
    client: describeClient(manifest),
  });
  return { system: prompt.definition.system, prompt: userPrompt };
}

/**
 * Locates the passages for each of the seven categories with one model call over every span of
 * every document, then checks the model's work in code.
 *
 * The model's answer is a list of clause labels and quotes. A label that is not in the contract
 * block is dropped (the model made it up or mis-copied it). A quote that does not occur in the
 * span it names is kept as `not_found`: the span is still where the model pointed, and
 * retrieval is better served by a clause that may matter than by none. Retrieval reads such a
 * passage as a hint and not as a location, so it never stands in for a passage that was found.
 * Verified or ambiguous
 * both count as verified for location, because an ambiguous quote is in the span and only fails
 * to pick out one place within it.
 *
 * A model failure degrades the stage instead of failing the run. Retrieval then reads the whole
 * document for every rule, which costs more and is still correct.
 */
export const runExtract: RunExtract = async ({ generator, signal, ingest, manifest, prompt }) => {
  const hints = hintsByCategory(ingest);
  const spans = ingest.spans;

  // Nothing to read means nothing to ask. Every rule will fall back to the (empty) whole document.
  if (spans.length === 0) {
    return {
      output: emptyOutput(hints, {
        degraded: false,
        notFoundReason: "the documents have no reviewable text",
      }),
      calls: [],
    };
  }

  const request = buildExtractRequest({ ingest, manifest, prompt });

  const result = await callModel({
    generator,
    signal,
    stage: "extract",
    ruleKey: null,
    promptVersionId: prompt.definition.id,
    attempt: 1,
    system: request.system,
    prompt: request.prompt,
    sharedPrefix: undefined,
    schema: LocateSchema,
    schemaName: prompt.definition.schemaName,
  });

  if (!result.ok) {
    return {
      output: emptyOutput(hints, { degraded: true, notFoundReason: null }),
      calls: [result.record],
    };
  }

  const byLabel = new Map<string, SourceSpan>(spans.map((span) => [span.modelLabel, span]));
  const passages = new Map<
    CategoryId,
    { located: LocatedPassage[]; named: number; reason: string | null }
  >();
  for (const entry of result.value.categories) {
    let bucket = passages.get(entry.category);
    if (bucket === undefined) {
      bucket = { located: [], named: 0, reason: null };
      passages.set(entry.category, bucket);
    }
    const reason = entry.notFoundReason === null ? "" : flatten(entry.notFoundReason, REASON_LIMIT);
    bucket.reason ??= reason === "" ? null : reason;

    for (const passage of entry.passages) {
      bucket.named++;
      const span = byLabel.get(normalizeLabel(passage.span));
      if (span === undefined) continue;
      const exists = bucket.located.some((p) => p.spanId === span.id && p.quote === passage.quote);
      if (exists) continue;
      const check = verifyQuote(span.text, passage.quote).check;
      bucket.located.push({
        spanId: span.id,
        quote: passage.quote,
        quoteCheck: check === "not_found" ? "not_found" : "verified",
      });
    }
  }

  const categories = {} as ExtractOutput["categories"];
  for (const category of CATEGORY_IDS) {
    const bucket = passages.get(category);
    const located = bucket?.located ?? [];
    const locatedIds = new Set(located.map((p) => p.spanId));
    const notFound = located.length === 0;
    let notFoundReason: string | null = null;
    if (notFound) {
      if (bucket === undefined) notFoundReason = "the model gave no entry for this category";
      else if (bucket.named > 0)
        notFoundReason = "every passage the model named has a label that is not in the documents";
      else notFoundReason = bucket.reason;
    }
    categories[category] = {
      located,
      notFound,
      notFoundReason,
      hintSpans: (hints.get(category) ?? []).filter((id) => !locatedIds.has(id)),
    };
  }

  return { output: { categories, degraded: false }, calls: [result.record("ok")] };
};
