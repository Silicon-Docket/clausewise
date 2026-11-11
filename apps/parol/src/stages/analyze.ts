import {
  AnalysisSchema,
  type AnalysisAnswer,
  type CallRecord,
  type ContextBundle,
  type DraftEvidence,
  type DraftFinding,
  type IngestOutput,
  type PlaybookRuleRecord,
  type RunManifest,
  type SourceSpan,
} from "../contracts.js";
import type { RegisteredPrompt, RunAnalyze } from "../module-contracts.js";
import { getFragment, renderPrompt } from "../prompts/registry.js";
import {
  describeClient,
  describeDocuments,
  renderContractBlock,
  renderRule,
} from "../prompts/render.js";
import { callModel, normalizeLabel } from "./analyze-call.js";

/**
 * Checks the documents against one rule with one model call, and a repair call when the answer
 * parses but cannot be used.
 *
 * Model output is never trusted. The schema fixes its shape; this file fixes its meaning: every
 * label it cites must be a clause it was shown, every escalation id must be one the rule has, and
 * `undetermined` must come with a reason. What fails is reported back to the model, or to the
 * caller, by label and id only, and never by quoting the answer or the documents.
 */

// A clause label is echoed in a message only when it has the plain shape of one. Anything else
// came from the model, may be any text at all, and is described by its position instead. An
// escalation id is never echoed, however plain it looks: a run of characters with no space in it
// is still the model's text, and a document can talk the model into writing an instruction in
// that shape. The ids the rule does have come from the playbook and are listed.
const SAFE_LABEL = /^c\d{1,6}$/;

export interface Validated {
  problems: string[];
  /** Labels that are not among the clauses shown, for the repair note's reminder. */
  unknownLabels: boolean;
}

/** What is wrong with an answer, by label and id only. Exported for the spend planner, which assumes one bad label. */
export function validate(
  answer: AnalysisAnswer,
  shown: ReadonlyMap<string, SourceSpan>,
  rule: PlaybookRuleRecord,
  promptId: string,
): Validated {
  const problems: string[] = [];
  let unknownLabels = false;
  const text = (name: string, vars: Record<string, string> = {}): string =>
    getFragment(promptId, name, vars);

  answer.evidence.forEach((item, index) => {
    const label = normalizeLabel(item.span);
    if (shown.has(label)) return;
    unknownLabels = true;
    const position = String(index + 1);
    problems.push(
      SAFE_LABEL.test(label)
        ? text("problemUnknownLabel", { position, label })
        : text("problemNoLabel", { position }),
    );
  });

  const ruleIds = new Set(rule.escalateWhen.map((condition) => condition.id));
  answer.escalateWhenMatched.forEach((id, index) => {
    if (ruleIds.has(id)) return;
    const valid =
      ruleIds.size === 0
        ? text("noConditions")
        : text("validIds", { ids: [...ruleIds].join(", ") });
    problems.push(text("problemUnknownEscalation", { position: String(index + 1), valid }));
  });

  if (answer.status === "undetermined" && (answer.abstainReason ?? "").trim() === "") {
    problems.push(text("problemEmptyAbstain"));
  }
  return { problems, unknownLabels };
}

/**
 * The note appended to the prompt of the repair call: what was wrong with the first answer, by
 * label and id only. Exported because the spend planner builds the repair prompt with it.
 */
export function repairNote(validated: Validated, shownLabels: string[], promptId: string): string {
  return [
    getFragment(promptId, "repairIntro"),
    ...validated.problems.map((problem) => `- ${problem}`),
    ...(validated.unknownLabels
      ? [getFragment(promptId, "repairLabelsShown", { labels: shownLabels.join(", ") })]
      : []),
    getFragment(promptId, "repairOutro"),
  ].join("\n");
}

const blankToNull = (text: string | null): string | null =>
  text === null || text.trim() === "" ? null : text;

/** The draft, with labels mapped to span ids and the small inconsistencies a model leaves normalised. */
function toDraft(
  answer: AnalysisAnswer,
  shown: ReadonlyMap<string, SourceSpan>,
  rule: PlaybookRuleRecord,
): DraftFinding {
  const evidence: DraftEvidence[] = [];
  const seen = new Set<string>();
  for (const item of answer.evidence) {
    const span = shown.get(normalizeLabel(item.span))!;
    const key = `${span.id}\u0000${item.role}\u0000${item.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push({ spanId: span.id, quote: item.quote, role: item.role });
  }
  return {
    ruleKey: rule.key,
    status: answer.status,
    evidence,
    discrepancy: answer.discrepancy,
    explanation: answer.explanation,
    fallbackLanguage: blankToNull(answer.fallbackLanguage),
    escalateWhenMatched: [...new Set(answer.escalateWhenMatched)],
    conflict: blankToNull(answer.conflict),
    // A reason given with another status is harmless but would read as an abstention.
    abstainReason: answer.status === "undetermined" ? blankToNull(answer.abstainReason) : null,
  };
}

/** The spans a bundle shows the model, in the bundle's order. */
export function shownSpans(bundle: ContextBundle, ingest: IngestOutput): SourceSpan[] {
  const byId = new Map(ingest.spans.map((span) => [span.id, span]));
  return bundle.spans.map(({ spanId }) => {
    const span = byId.get(spanId);
    // A bundle is built from this ingest output. A span that is not in it is a bug in the caller.
    if (span === undefined)
      throw new Error(`analyze: the bundle names span ${spanId}, which is not in the run`);
    return span;
  });
}

/** What the first analyze call of one rule sends. Pure; `runAnalyze` and the spend planner share it. */
export interface AnalyzeRequest {
  system: string;
  prompt: string;
  /** The leading part of `prompt` that a caching provider can reuse. */
  sharedPrefix: string | undefined;
}

export function buildAnalyzeRequest(args: {
  bundle: ContextBundle;
  ingest: IngestOutput;
  manifest: RunManifest;
  prompt: RegisteredPrompt;
}): AnalyzeRequest {
  const { bundle, ingest, manifest, prompt } = args;
  const contractBlock = renderContractBlock(shownSpans(bundle, ingest));
  const userPrompt = renderPrompt(prompt.definition, {
    contractBlock,
    documents: describeDocuments(manifest),
    client: describeClient(manifest),
    coverage: getFragment(
      prompt.definition.id,
      bundle.fullDocument ? "coverageWhole" : "coverageSelection",
    ),
    rule: renderRule(bundle.rule),
    ruleId: bundle.rule.key,
  });
  // The block leads the prompt, so a caching provider can reuse it across rules whose bundles
  // are alike. If a prompt version were to put something before it, there is no shared prefix.
  const sharedPrefix = userPrompt.startsWith(contractBlock) ? contractBlock : undefined;
  return { system: prompt.definition.system, prompt: userPrompt, sharedPrefix };
}

export const runAnalyze: RunAnalyze = async ({
  generator,
  signal,
  bundle,
  ingest,
  manifest,
  prompt,
  repairAttempts,
}) => {
  const { rule } = bundle;

  // Retrieval flags a bundle that is too big and the rule is not analysed. This is the same
  // refusal made again here, so a caller that forgets the flag does not spend a call on it.
  if (bundle.overBudget) {
    return {
      ok: false,
      detail: `context_over_budget: about ${bundle.estimatedTokens} tokens against a budget of ${bundle.budgetTokens}`,
      calls: [],
    };
  }

  const shown = new Map(shownSpans(bundle, ingest).map((span) => [span.modelLabel, span]));
  const request = buildAnalyzeRequest({ bundle, ingest, manifest, prompt });

  const repairs = Number.isFinite(repairAttempts) ? Math.max(0, Math.floor(repairAttempts)) : 0;
  const calls: CallRecord[] = [];
  let note: string | null = null;

  for (let attempt = 1; ; attempt++) {
    const result = await callModel({
      generator,
      signal,
      stage: "analyze",
      ruleKey: rule.key,
      promptVersionId: prompt.definition.id,
      attempt,
      system: request.system,
      prompt: note === null ? request.prompt : `${request.prompt}\n\n${note}`,
      sharedPrefix: request.sharedPrefix,
      schema: AnalysisSchema,
      schemaName: prompt.definition.schemaName,
    });

    if (!result.ok) {
      calls.push(result.record);
      return { ok: false, detail: result.failure.detail, calls };
    }

    const validated = validate(result.value, shown, rule, prompt.definition.id);
    if (validated.problems.length === 0) {
      calls.push(result.record("ok"));
      return { ok: true, draft: toDraft(result.value, shown, rule), calls };
    }

    calls.push(result.record("semantic_error"));
    if (attempt > repairs) {
      return {
        ok: false,
        detail: `output_invalid: ${validated.problems.join("; ")}`,
        calls,
      };
    }
    note = repairNote(validated, [...shown.keys()], prompt.definition.id);
  }
};
