import { estimateTokens } from "@clausewise/review";
import { toJSONSchema, type ZodType } from "zod";
import {
  AnalysisSchema,
  LocateSchema,
  type AnalysisAnswer,
  type ContextBundle,
  type IngestOutput,
  type PlaybookRuleRecord,
  type RunManifest,
  type SourceSpan,
  type WorkflowManifest,
} from "../contracts.js";
import { getPrompt, renderPrompt } from "../prompts/registry.js";
import { renderContractBlock, renderRule, renderSpans } from "../prompts/render.js";
import { buildAnalyzeRequest, repairNote, shownSpans, validate } from "../stages/analyze.js";
import { buildExtractRequest, emptyExtractOutput } from "../stages/extract.js";
import { buildBundles } from "../stages/retrieve.js";
import { costOf, type Price } from "./prices.js";

/**
 * What a review will ask of the model and the most that can cost, worked out from the stored
 * documents before any call is made.
 *
 * The evaluation plans by running the real stages against a generator that sends nothing
 * (evals/src/parol/plan.ts). That is asynchronous, and a review is started inside a synchronous
 * transaction, so this planner builds the stages' own requests through their exported builders
 * (`buildExtractRequest`, `buildAnalyzeRequest`) and counts them. A test pins it to the
 * evaluation's planner on every case of the dataset, so the two cannot drift apart.
 *
 * The figures are a bound under stated assumptions and not a measurement:
 *  - the extract answer is "nothing found", so every rule reads the whole document, which is the
 *    largest prompt a rule can get while the whole document fits the context budget. When it does
 *    not, a rule that shares its category with no other is still sent with whatever clauses the
 *    real answer locates, if those fit, so it is planned at the largest selection that could fit
 *    (`largestSelectionTokens`); a rule that shares a category always reads the whole document and
 *    is not sent;
 *  - every rule's first answer needs one repair call (when the workflow allows a repair), with the
 *    real repair note for one unknown label;
 *  - input is counted with `boundTokens`, which errs high, and no caching is assumed;
 *  - output is the number of calls times `assumedOutputTokens`, an assumption.
 *
 * What the bound does not cover: more than one repair (every shipped version allows one), the
 * client's own retries, thinking tokens beyond the assumed output, and a cache (which only makes the
 * real cost lower). The runtime cap does not rely on the bound.
 */

/** One stage's model calls for one unit of the run. The pair `stage`, `unit` is the key of a `run_stages` row. */
export interface UnitPlan {
  /** `verify` is the support call, made only when the workflow pins a support prompt. */
  stage: "extract" | "analyze" | "verify";
  /** `*` for extract, otherwise the rule key. */
  unit: string;
  /** One attempt each, no repair. */
  calls: number;
  /** Plus the repair call of an analyze unit when the workflow allows a repair. */
  callsWithRepair: number;
  inputTokens: number;
  inputTokensWithRepair: number;
}

export interface RunPlan {
  units: UnitPlan[];
  assumedOutputTokens: number;
  calls: number;
  callsWithRepairs: number;
  inputTokens: number;
  inputTokensWithRepairs: number;
}

/**
 * Output tokens assumed for each call when nothing else is said. The same figure the evaluation
 * assumes (`DEFAULT_ASSUMED_OUTPUT_TOKENS` in evals/src/args.ts); a test pins the two together.
 */
export const DEFAULT_ASSUMED_OUTPUT_TOKENS = 1500;

/** `analyze:dur-1`: how a unit is named in a set of finished units. */
export const unitKey = (unit: Pick<UnitPlan, "stage" | "unit">): string =>
  `${unit.stage}:${unit.unit}`;

/**
 * Tokens in a text, as an upper bound: the pipeline's estimate (1 token per 3 characters of Latin
 * text, 1 per character of other scripts), or a third of the UTF-8 bytes where that is larger (a
 * character outside the basic plane is counted once by the estimate and takes four bytes).
 */
export function boundTokens(text: string): number {
  return Math.max(estimateTokens(text), Math.ceil(Buffer.byteLength(text) / 3));
}

// A first answer that cites a clause label the model was not shown, so the repair note the
// workflow would send is the real one. The pipeline never builds a prompt from an earlier answer
// except this note.
const UNKNOWN_LABEL_ANSWER: AnalysisAnswer = {
  status: "not_applicable",
  evidence: [{ span: "c999999", quote: "x", role: "governing" }],
  discrepancy: "",
  explanation: "",
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};

const schemaTokens = (schema: ZodType): number => boundTokens(JSON.stringify(toJSONSchema(schema)));

/**
 * `estimateTokens` before its rounding, in thirds of a token: three for each character from
 * U+0250 up (one code point, whatever its length in UTF-16) and one for each other. A test pins
 * `ceil(thirds / 3)` to `estimateTokens`, so the two cannot drift apart.
 */
export function estimateThirds(text: string): number {
  let thirds = 0;
  for (const character of text) thirds += (character.codePointAt(0) ?? 0) < 0x250 ? 1 : 3;
  return thirds;
}

/**
 * The most that the contract block of a selection can add to a prompt, in `boundTokens`, for any
 * selection the retrieval would send for this rule: one that fits its budget by the pipeline's own
 * estimate (`estimatedTokens <= budgetTokens`, the rule's text included). That is the best of the
 * clauses by bytes per estimated token that the budget leaves room for, so it is the room left
 * for plain Latin text and only larger where a script takes more bytes than the estimate allows
 * for. It relaxes the choice of clauses to fractions of a clause, which can only raise the figure.
 * Null when not one clause fits, so that no selection can be sent.
 */
export function largestSelectionTokens(
  spans: readonly SourceSpan[],
  rule: PlaybookRuleRecord,
  budgetTokens: number,
): number | null {
  // In thirds of a token. The retrieval estimates the clauses joined by blank lines, then a blank
  // line and the rule: so each clause costs its own text and the two characters after it.
  const room = 3 * budgetTokens - estimateThirds(renderRule(rule));
  const items: { cost: number; bytes: number }[] = [];
  for (const span of spans) {
    const text = renderSpans([span]);
    const cost = estimateThirds(text) + 2;
    if (cost <= room) items.push({ cost, bytes: Buffer.byteLength(text) + 2 });
  }
  if (items.length === 0) return null;
  // The fullest first: the most bytes for each unit of the budget.
  items.sort((a, b) => b.bytes * a.cost - a.bytes * b.cost);
  let left = room;
  let bytes = 0;
  for (const item of items) {
    if (item.cost <= left) {
      left -= item.cost;
      bytes += item.bytes;
      continue;
    }
    bytes += (item.bytes * left) / item.cost;
    break;
  }
  // The estimate of the block itself is at most what the budget leaves; the bytes may say more.
  return Math.max(Math.ceil(room / 3), Math.ceil(bytes / 3));
}

export function planRun(args: {
  ingest: IngestOutput;
  manifest: RunManifest;
  rules: PlaybookRuleRecord[];
  workflow: WorkflowManifest;
  assumedOutputTokens: number;
}): RunPlan {
  const { ingest, manifest, rules, workflow, assumedOutputTokens } = args;
  const prompts = {
    extract: getPrompt(workflow.prompts.extract),
    analyze: getPrompt(workflow.prompts.analyze),
    support: workflow.prompts.support === null ? null : getPrompt(workflow.prompts.support),
  };
  const units: UnitPlan[] = [];

  // A run with nothing to read stops before its first call (the engine refuses it), so it costs
  // nothing and its plan is empty.
  if (ingest.spans.length === 0) return totalsOf(units, assumedOutputTokens);

  // The one extract call, over every span of every document.
  const extractRequest = buildExtractRequest({ ingest, manifest, prompt: prompts.extract });
  const extractTokens =
    boundTokens(extractRequest.system) +
    boundTokens(extractRequest.prompt) +
    schemaTokens(LocateSchema);
  units.push({
    stage: "extract",
    unit: "*",
    calls: 1,
    callsWithRepair: 1,
    inputTokens: extractTokens,
    inputTokensWithRepair: extractTokens,
  });

  // Nothing found by extract: every rule reads the whole document.
  const bundles = buildBundles({
    ingest,
    extract: emptyExtractOutput(ingest, { degraded: false, notFoundReason: "dry run" }),
    rules,
    policy: workflow.retrieval,
    budgetTokens: workflow.budgetTokens,
  });

  const repairs = Number.isFinite(workflow.repairAttempts)
    ? Math.max(0, Math.floor(workflow.repairAttempts)) >= 1
    : false;
  const analysisSchemaTokens = schemaTokens(AnalysisSchema);

  // A rule whose whole-document bundle is over the context budget is not sent with it. A rule that
  // shares its category with another always reads the whole document (stages/retrieve.ts), so it is
  // never sent. Any other rule is sent with the clauses the real extract answer locates for it,
  // whenever they fit, and the plan cannot know which: it is bounded by the largest selection that
  // fits, or has no call when not one clause does.
  const rulesIn = new Map<string, number>();
  for (const rule of rules) rulesIn.set(rule.category, (rulesIn.get(rule.category) ?? 0) + 1);
  interface Sendable {
    bundle: ContextBundle;
    /** The contract block in the prompt, counted apart from `bundle`, when it is a selection. */
    selection: number | null;
  }
  const sendable: Sendable[] = [];
  for (const bundle of bundles) {
    if (!bundle.overBudget) {
      sendable.push({ bundle, selection: null });
      continue;
    }
    if ((rulesIn.get(bundle.category) ?? 0) > 1) continue;
    const selection = largestSelectionTokens(ingest.spans, bundle.rule, workflow.budgetTokens);
    if (selection !== null) sendable.push({ bundle, selection });
  }

  for (const { bundle, selection } of sendable) {
    // A selection is counted apart (`selection`), so its request is built with an empty contract
    // block; a whole-document bundle is built as it is.
    const request = buildAnalyzeRequest({
      bundle: selection === null ? bundle : { ...bundle, spans: [], fullDocument: false },
      ingest,
      manifest,
      prompt: prompts.analyze,
    });
    const block = selection ?? 0;
    const first =
      boundTokens(request.system) + boundTokens(request.prompt) + block + analysisSchemaTokens;
    let second = 0;
    if (repairs) {
      // The note lists the labels shown. The whole document's labels are the longest list a
      // selection of it can have.
      const shown = new Map(shownSpans(bundle, ingest).map((span) => [span.modelLabel, span]));
      const note = repairNote(
        validate(UNKNOWN_LABEL_ANSWER, shown, bundle.rule, prompts.analyze.definition.id),
        [...shown.keys()],
        prompts.analyze.definition.id,
      );
      second =
        boundTokens(request.system) +
        boundTokens(`${request.prompt}\n\n${note}`) +
        block +
        analysisSchemaTokens;
    }
    units.push({
      stage: "analyze",
      unit: bundle.ruleKey,
      calls: 1,
      callsWithRepair: repairs ? 2 : 1,
      inputTokens: first,
      inputTokensWithRepair: first + second,
    });
  }

  // A workflow that pins a support prompt makes one more call per finding that has a verified
  // quote. What it cites is not known before the run, so each is bounded by a prompt that holds
  // every clause of the run (the largest selection, for a rule that is sent with a selection) and a
  // discrepancy as long as the output is assumed to be.
  if (prompts.support !== null) {
    const supportSchemaTokens = schemaTokens(prompts.support.schema);
    for (const { bundle, selection } of sendable) {
      const text = renderPrompt(prompts.support.definition, {
        contractBlock: renderContractBlock(selection === null ? ingest.spans : []),
        rule: renderRule(bundle.rule),
        status: "deviation",
        discrepancy: "x".repeat(assumedOutputTokens * 3),
      });
      const tokens =
        boundTokens(prompts.support.definition.system) +
        boundTokens(text) +
        (selection ?? 0) +
        supportSchemaTokens;
      units.push({
        stage: "verify",
        unit: bundle.ruleKey,
        calls: 1,
        callsWithRepair: 1,
        inputTokens: tokens,
        inputTokensWithRepair: tokens,
      });
    }
  }

  return totalsOf(units, assumedOutputTokens);
}

function totalsOf(units: UnitPlan[], assumedOutputTokens: number): RunPlan {
  const sum = (pick: (unit: UnitPlan) => number): number =>
    units.reduce((total, unit) => total + pick(unit), 0);
  return {
    units,
    assumedOutputTokens,
    calls: sum((u) => u.calls),
    callsWithRepairs: sum((u) => u.callsWithRepair),
    inputTokens: sum((u) => u.inputTokens),
    inputTokensWithRepairs: sum((u) => u.inputTokensWithRepair),
  };
}

/**
 * The most the units chosen by `unfinished` can cost if the model behaves as assumed: every input
 * token at the plain price, nothing cached, every rule needing its repair call, and the assumed
 * output for each call. It is the figure the evaluation's spend guard compares with its limit
 * (`costBounds(...).withRepairsUsd`), and it is an estimate and not a ceiling.
 */
export function upperBoundUsd(
  plan: RunPlan,
  price: Price,
  unfinished: (unit: UnitPlan) => boolean = () => true,
): number {
  let inputTokens = 0;
  let calls = 0;
  for (const unit of plan.units) {
    if (!unfinished(unit)) continue;
    inputTokens += unit.inputTokensWithRepair;
    calls += unit.callsWithRepair;
  }
  return costOf(
    {
      inputTokens,
      outputTokens: calls * plan.assumedOutputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    price,
  );
}
