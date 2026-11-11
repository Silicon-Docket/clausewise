/**
 * The plan of a live evaluation run: how many model calls it will make and the most they can cost,
 * worked out before any of them is sent. It follows the Clausewise harness (evals/src/plan.ts and
 * guard.ts) and reuses its arithmetic, its price table and its refusal rules.
 *
 * The plan is a dry run of the real stages. Extract, retrieval and analyze run once per case
 * against a generator that sends nothing, so the prompts, the windows and the number of calls are
 * the stages' own and not a copy of their rules. The dry generator answers extract with "nothing
 * found", which makes every rule read the whole document and every prompt as large as it can
 * get, and it answers each analyze request with a first answer that needs repair and a second that
 * does not, so that the repair prompts are the real ones too.
 *
 * The figures are a bound under stated assumptions and not a measurement:
 *  - input is counted with `estimateTokens` (an overestimate for English) and no caching;
 *  - output is the number of calls times `--assumed-output-tokens`, an assumption;
 *  - the first figure counts one attempt per call and no repair, the second adds the repair call of
 *    every rule, the third also gives every call all of the provider client's retries (document 3:
 *    "(1 + 2) attempts for the first answer, times two if a repair is needed, so six calls").
 */
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { toJSONSchema } from "zod";
import {
  AnalysisSchema,
  CATEGORY_IDS,
  type AnalysisAnswer,
  type ContextBundle,
} from "../../../apps/parol/src/contracts.js";
import type {
  LoadedPlaybook,
  RegisteredWorkflow,
} from "../../../apps/parol/src/module-contracts.js";
import { getPrompt, renderPrompt } from "../../../apps/parol/src/prompts/registry.js";
import { renderContractBlock, renderRule } from "../../../apps/parol/src/prompts/render.js";
import {
  buildAnalyzeRequest,
  repairNote,
  runAnalyze,
  shownSpans,
  validate,
} from "../../../apps/parol/src/stages/analyze.js";
import { runExtract } from "../../../apps/parol/src/stages/extract.js";
import { buildBundles } from "../../../apps/parol/src/stages/retrieve.js";
import { largestSelectionTokens } from "../../../apps/parol/src/usage/plan.js";
import type { Split } from "../../../fixtures/parol/types.js";
import { decide, int, plain, usd, type Decision } from "../guard.js";
import { boundTokens, costCeiling, costUpperBound, type Plan } from "../plan.js";
import { PRICE_WARNING, type Price } from "../prices.js";
import type { PreparedPair } from "./calibration-run.js";
import type { Dataset } from "./dataset.js";
import { prepareCase, type ParsedFiles, type RunnableCase } from "./runner.js";

export interface CasePlan {
  caseKey: string;
  split: Split;
  twinOf: string | null;
  documents: number;
  /** Clauses (spans) in the run. */
  spans: number;
  rules: number;
  /**
   * Rules that are not sent: their bundle is over the workflow's context budget and they share a
   * category with another rule (so they always read the whole document), or not one clause of the
   * document fits. A rule over the budget that could be sent with a selection of clauses is planned,
   * not counted here.
   */
  rulesOverBudget: number;
  /** Model calls in one run, one attempt each and no repair. */
  calls: number;
  /** Calls when every rule needs its repair attempt. */
  callsWithRepairs: number;
  /** Upper bound on the input tokens of the calls above. */
  inputTokens: number;
  inputTokensWithRepairs: number;
}

/** The calibration set's share of a plan: one call per pair, once per run and not per repeat. */
export interface CalibrationPlan {
  calls: number;
  /** Upper bound on the input tokens of those calls. */
  inputTokens: number;
}

export interface ParolPlan {
  repeats: number;
  /** Absent or null when the calibration set is not part of the run. */
  calibration?: CalibrationPlan | null;
  assumedOutputTokens: number;
  cases: CasePlan[];
  /** Case and twin runs in one repeat. */
  runsPerRepeat: number;
  /** Rule slots scored in one repeat, twins included. */
  slotsPerRepeat: number;
  calls: number;
  callsWithRepairs: number;
  inputTokens: number;
  inputTokensWithRepairs: number;
  outputTokens: number;
  outputTokensWithRepairs: number;
}

// Any valid answer to an analyze request will do for the second attempt. The pipeline never builds
// a prompt from an earlier answer except the repair note, which names the label that was wrong.
const VALID_ANSWER = {
  status: "not_applicable",
  evidence: [],
  discrepancy: "",
  explanation: "",
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};
const INVALID_FIRST_ANSWER = {
  ...VALID_ANSWER,
  evidence: [{ span: "c999999", quote: "x", role: "governing" }],
};

export async function buildParolPlan(args: {
  dataset: Dataset;
  runnables: readonly RunnableCase[];
  playbook: LoadedPlaybook;
  workflow: RegisteredWorkflow;
  repeats: number;
  assumedOutputTokens: number;
  /** The pairs of the calibration set, prepared. They add one support call each, once. */
  calibration?: readonly PreparedPair[];
}): Promise<ParolPlan> {
  const { playbook, workflow } = args;
  const wm = workflow.manifest;
  const prompts = {
    extract: getPrompt(wm.prompts.extract),
    analyze: getPrompt(wm.prompts.analyze),
    support: wm.prompts.support === null ? null : getPrompt(wm.prompts.support),
  };
  const parsed: ParsedFiles = new Map();
  const cases: CasePlan[] = [];

  for (const runnable of args.runnables) {
    const prepared = await prepareCase({
      dataset: args.dataset,
      runnable,
      repeat: 1,
      playbook,
      workflow,
      parsed,
    });
    const manifest = { ...prepared.manifest, model: { provider: "plan", model: "plan" } };
    const answered = new Map<string, number>();
    const generator = createScriptedGenerator((request) => {
      switch (request.schemaName) {
        case "locate_passages":
          return {
            categories: CATEGORY_IDS.map((category) => ({
              category,
              passages: [],
              notFoundReason: "dry run",
            })),
          };
        case "analyze_rule": {
          const rule = /^Rule ID: (\S+)$/m.exec(request.prompt)?.[1] ?? "";
          const n = answered.get(rule) ?? 0;
          answered.set(rule, n + 1);
          return n === 0 ? INVALID_FIRST_ANSWER : VALID_ANSWER;
        }
        default:
          throw new Error("the plan's dry run met a request it does not know");
      }
    });
    const extracted = await runExtract({
      generator,
      ingest: prepared.ingest,
      manifest,
      prompt: prompts.extract,
    });
    const bundles = buildBundles({
      ingest: prepared.ingest,
      extract: extracted.output,
      rules: playbook.rules,
      policy: wm.retrieval,
      budgetTokens: wm.budgetTokens,
    });
    for (const bundle of bundles) {
      if (bundle.overBudget) continue;
      await runAnalyze({
        generator,
        bundle,
        ingest: prepared.ingest,
        manifest,
        prompt: prompts.analyze,
        repairAttempts: wm.repairAttempts,
      });
    }

    let inputTokens = 0;
    let inputTokensWithRepairs = 0;
    let calls = 0;
    let callsWithRepairs = 0;
    const seenRule = new Set<string>();
    for (const call of generator.calls) {
      const tokens =
        boundTokens(call.system) +
        boundTokens(call.prompt) +
        boundTokens(JSON.stringify(toJSONSchema(call.schema)));
      const rule =
        call.schemaName === "analyze_rule"
          ? (/^Rule ID: (\S+)$/m.exec(call.prompt)?.[1] ?? "")
          : "";
      // The first request of a rule, and the extract request, are the attempt that is always made.
      const first = call.schemaName !== "analyze_rule" || !seenRule.has(rule);
      seenRule.add(rule);
      callsWithRepairs += 1;
      inputTokensWithRepairs += tokens;
      if (first) {
        calls += 1;
        inputTokens += tokens;
      }
    }

    // A rule whose bundle is over the context budget is not sent with the whole document, but that
    // does not leave it out of the bound. A rule that shares its category with another always reads
    // the whole document (stages/retrieve.ts) and is never sent. Any other rule is sent with the
    // clauses the real extract answer locates for it, whenever they fit, and the plan cannot know
    // which: it is bounded by the largest selection that fits (`largestSelectionTokens`, which the
    // application's planner uses too), and has no call when not one clause fits. A selection's
    // contract block is counted apart, so its request is built with an empty block, in the first
    // request, the repair request and the support call alike. A test holds this to the
    // application's planner on documents over the budget (parol-app-plan-parity-long).
    const analysable = bundles.filter((bundle) => !bundle.overBudget);
    const rulesIn = new Map<string, number>();
    for (const rule of playbook.rules)
      rulesIn.set(rule.category, (rulesIn.get(rule.category) ?? 0) + 1);
    const selected: { bundle: ContextBundle; block: number }[] = [];
    for (const bundle of bundles) {
      if (!bundle.overBudget || (rulesIn.get(bundle.category) ?? 0) > 1) continue;
      const block = largestSelectionTokens(prepared.ingest.spans, bundle.rule, wm.budgetTokens);
      if (block !== null) selected.push({ bundle, block });
    }
    if (selected.length > 0) {
      const repairs = Number.isFinite(wm.repairAttempts)
        ? Math.max(0, Math.floor(wm.repairAttempts)) >= 1
        : false;
      const analysisSchemaTokens = boundTokens(JSON.stringify(toJSONSchema(AnalysisSchema)));
      for (const { bundle, block } of selected) {
        const request = buildAnalyzeRequest({
          bundle: { ...bundle, spans: [], fullDocument: false },
          ingest: prepared.ingest,
          manifest,
          prompt: prompts.analyze,
        });
        const first =
          boundTokens(request.system) + boundTokens(request.prompt) + block + analysisSchemaTokens;
        let second = 0;
        if (repairs) {
          // The note lists the labels shown. The whole document's labels are the longest list a
          // selection of it can have.
          const shown = new Map(
            shownSpans(bundle, prepared.ingest).map((span) => [span.modelLabel, span]),
          );
          const note = repairNote(
            validate(
              INVALID_FIRST_ANSWER as AnalysisAnswer,
              shown,
              bundle.rule,
              prompts.analyze.definition.id,
            ),
            [...shown.keys()],
            prompts.analyze.definition.id,
          );
          second =
            boundTokens(request.system) +
            boundTokens(`${request.prompt}\n\n${note}`) +
            block +
            analysisSchemaTokens;
        }
        calls += 1;
        callsWithRepairs += repairs ? 2 : 1;
        inputTokens += first;
        inputTokensWithRepairs += first + second;
      }
    }

    // A workflow that pins a support prompt makes one more call per finding that has a verified
    // quote. What it cites is not known before the run, so each is bounded by a prompt that holds
    // every clause of the run (the largest selection, for a rule sent with a selection) and a
    // discrepancy as long as the output is assumed to be.
    if (prompts.support !== null) {
      const schemaTokens = boundTokens(JSON.stringify(toJSONSchema(prompts.support.schema)));
      const sent = [
        ...analysable.map((bundle) => ({ bundle, block: null as number | null })),
        ...selected,
      ];
      for (const { bundle, block } of sent) {
        const text = renderPrompt(prompts.support.definition, {
          contractBlock: renderContractBlock(block === null ? prepared.ingest.spans : []),
          rule: renderRule(bundle.rule),
          status: "deviation",
          discrepancy: "x".repeat(args.assumedOutputTokens * 3),
        });
        const tokens =
          boundTokens(prompts.support.definition.system) +
          boundTokens(text) +
          (block ?? 0) +
          schemaTokens;
        calls += 1;
        callsWithRepairs += 1;
        inputTokens += tokens;
        inputTokensWithRepairs += tokens;
      }
    }

    cases.push({
      caseKey: runnable.caseKey,
      split: runnable.split,
      twinOf: runnable.twinOf,
      documents: prepared.manifest.documents.length,
      spans: prepared.ingest.spans.length,
      rules: bundles.length,
      rulesOverBudget: bundles.length - analysable.length - selected.length,
      calls,
      callsWithRepairs,
      inputTokens,
      inputTokensWithRepairs,
    });
  }

  const sum = (pick: (c: CasePlan) => number): number =>
    cases.reduce((total, c) => total + pick(c), 0) * args.repeats;

  // The calibration pairs are sent once, with the support prompt of the workflow, each with its own
  // paragraph and discrepancy. They are bounded by the prompts the checker would really build.
  let calibration: CalibrationPlan | null = null;
  if (args.calibration !== undefined && args.calibration.length > 0) {
    if (prompts.support === null) {
      throw new Error("the calibration set needs a workflow that pins a support prompt");
    }
    const schemaTokens = boundTokens(JSON.stringify(toJSONSchema(prompts.support.schema)));
    let inputTokens = 0;
    for (const item of args.calibration) {
      const text = renderPrompt(prompts.support.definition, {
        contractBlock: renderContractBlock([item.span]),
        rule: renderRule(item.rule),
        status: item.draft.status,
        discrepancy: item.draft.discrepancy === "" ? "(none)" : item.draft.discrepancy,
      });
      inputTokens +=
        boundTokens(prompts.support.definition.system) + boundTokens(text) + schemaTokens;
    }
    calibration = { calls: args.calibration.length, inputTokens };
  }
  const extra = {
    calls: calibration?.calls ?? 0,
    inputTokens: calibration?.inputTokens ?? 0,
  };
  const calls = sum((c) => c.calls) + extra.calls;
  const callsWithRepairs = sum((c) => c.callsWithRepairs) + extra.calls;
  return {
    repeats: args.repeats,
    calibration,
    assumedOutputTokens: args.assumedOutputTokens,
    cases,
    runsPerRepeat: cases.length,
    slotsPerRepeat: cases.reduce((total, c) => total + c.rules, 0),
    calls,
    callsWithRepairs,
    inputTokens: sum((c) => c.inputTokens) + extra.inputTokens,
    inputTokensWithRepairs: sum((c) => c.inputTokensWithRepairs) + extra.inputTokens,
    outputTokens: calls * args.assumedOutputTokens,
    outputTokensWithRepairs: callsWithRepairs * args.assumedOutputTokens,
  };
}

// ---------------------------------------------------------------------------------------------
// The cost bound, with the Clausewise arithmetic
// ---------------------------------------------------------------------------------------------

/** The plan in the shape the Clausewise harness's bound functions take. */
export function asHarnessPlan(plan: ParolPlan, withRepairs: boolean): Plan {
  return {
    runs: plan.repeats,
    assumedOutputTokens: plan.assumedOutputTokens,
    fixtures: plan.cases.map((c) => ({
      fixture: c.caseKey,
      playbook: "",
      rules: c.rules,
      clauses: c.spans,
      windows: 1,
      callsPerRun: withRepairs ? c.callsWithRepairs : c.calls,
      inputTokensPerRun: withRepairs ? c.inputTokensWithRepairs : c.inputTokens,
    })),
    calls: withRepairs ? plan.callsWithRepairs : plan.calls,
    inputTokens: withRepairs ? plan.inputTokensWithRepairs : plan.inputTokens,
    outputTokens: withRepairs ? plan.outputTokensWithRepairs : plan.outputTokens,
  };
}

export interface CostBounds {
  /** One attempt per call, no repair call. Not an upper bound on the run: the workflow repairs. */
  upperBoundUsd: number;
  /** Every rule needs its repair call. What the spend guard compares with `--max-cost`. */
  withRepairsUsd: number;
  /** Every call also uses all of the provider client's retries. */
  retryWorstCaseUsd: number;
  /** Every attempt generates all the output it is allowed. */
  ceilingUsd: number;
}

export function costBounds(
  plan: ParolPlan,
  price: Price,
  limits: { maxOutputTokens: number; maxRetries: number },
): CostBounds {
  const once = asHarnessPlan(plan, false);
  const repaired = asHarnessPlan(plan, true);
  const withRepairsUsd = costUpperBound(repaired, price);
  return {
    upperBoundUsd: costUpperBound(once, price),
    withRepairsUsd,
    retryWorstCaseUsd: withRepairsUsd * (1 + limits.maxRetries),
    ceilingUsd: costCeiling(repaired, price, limits),
  };
}

/**
 * Whether a live run may start, by the Clausewise spend guard, on the bound that includes every
 * rule's repair call. The workflow itself makes a repair call (`repairAttempts`) for an answer
 * that fails its checks, so the figure for one attempt per call is not a bound on the run, and a
 * run allowed on it could stop part-way with the money spent. What the provider's client retries
 * is not in this bound; the runtime guard holds the run to `--max-cost` request by request.
 * The words of the guard are the harness's: its call count is a count of calls the run would make
 * if nothing needed repair, and its advice offers `--fixture`, which here is `--case`.
 */
export function decideSpend(args: {
  yes: boolean;
  plan: ParolPlan;
  bounds: CostBounds;
  maxCostUsd: number;
  fallback: boolean;
}): Decision {
  const decision = decide({
    yes: args.yes,
    calls: args.plan.callsWithRepairs,
    upperBoundUsd: args.bounds.withRepairsUsd,
    maxCostUsd: args.maxCostUsd,
    fallback: args.fallback,
  });
  if (decision.go) return decision;
  return {
    go: false,
    message: decision.message
      .replaceAll("--fixture", "--case")
      .replace("would make ", "would make up to "),
  };
}

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------

export interface PlanDescription {
  mode: "selftest" | "simulated" | "live" | "replay";
  datasetLabel: string;
  splitLabel: string;
  workflowLabel: string;
  retrieval: string;
  provider: string;
  model: string;
  price: Price | null;
  bounds: CostBounds | null;
  maxRetries: number | null;
  maxOutputTokens: number | null;
  maxCostUsd: number;
  fallback: boolean;
}

function row(cells: string[], widths: number[]): string {
  return `  ${cells.map((text, i) => (i === 0 ? text.padEnd(widths[i] ?? 0) : text.padStart(widths[i] ?? 0))).join("  ")}`;
}

/** The plan as plain text for stderr. It is printed before anything is sent. */
export function describeParolPlan(plan: ParolPlan, context: PlanDescription): string {
  const header = ["Case", "Documents", "Clauses", "Rules", "Calls per run"];
  const body = plan.cases.map((c) => [
    plain(c.caseKey),
    String(c.documents),
    String(c.spans),
    String(c.rules),
    String(c.calls),
  ]);
  const widths = header.map((title, i) =>
    Math.max(title.length, ...body.map((cells) => cells[i]?.length ?? 0)),
  );
  const scripted = context.mode !== "live"; // no request is sent, so there is no cost to bound
  const cases = plan.cases.filter((c) => c.twinOf === null).length;
  const lines = [
    context.mode === "selftest"
      ? "Selftest plan (no model will be called)"
      : context.mode === "simulated"
        ? "Simulated plan (the scripted simulated reader answers; no model will be called)"
        : context.mode === "replay"
          ? "Replay plan (recorded answers are re-scored; no model will be called and nothing is sent)"
          : "Evaluation plan (nothing has been sent yet)",
    `  Dataset: ${plain(context.datasetLabel)}, split ${plain(context.splitLabel)}`,
    `  Workflow: ${plain(context.workflowLabel)} (retrieval ${plain(context.retrieval)})`,
    `  Model: ${plain(context.model)} (${plain(context.provider)})`,
    `  Runs: ${cases} ${cases === 1 ? "case" : "cases"}, ${plan.runsPerRepeat - cases} injection ${plan.runsPerRepeat - cases === 1 ? "twin" : "twins"}, ${plan.repeats} ${plan.repeats === 1 ? "repeat" : "repeats"}, ${int(plan.slotsPerRepeat)} rule slots per repeat`,
    "",
    row(header, widths),
    ...body.map((cells) => row(cells, widths)),
    "",
    `  Model calls in total: ${int(plan.calls)}${plan.calibration == null ? "" : ` (${int(plan.calibration.calls)} of them the support checker's calibration pairs, ${context.mode === "replay" ? "answered once from the recording" : "sent once for the run"})`}`,
  ];
  if (scripted) return `${lines.join("\n")}\n`;

  lines.push(
    `  Model calls if every rule needed its repair call: ${int(plan.callsWithRepairs)}`,
    `  Input tokens, upper bound: ${int(plan.inputTokens)} (1 token per 3 characters of Latin text and 1 per character of other scripts, over every prompt and the response schema, the whole of every document in every rule's prompt, no caching, one attempt per call)`,
    `  Output tokens, upper bound: ${int(plan.outputTokens)} (${int(plan.calls)} calls x ${int(plan.assumedOutputTokens)} tokens assumed per call. Thinking counts as output, so raise it for a model that thinks at length, with --assumed-output-tokens)`,
  );
  if (context.price !== null && context.bounds !== null) {
    lines.push(
      `  Prices per million tokens: ${context.price.input} input, ${context.price.output} output (from the price table)`,
      `  Cost with one attempt per call and no repair call: ${usd(context.bounds.upperBoundUsd)}`,
      `  Cost upper bound, if every rule needed its repair call: ${usd(context.bounds.withRepairsUsd)}. --max-cost is checked against this figure.`,
    );
    if (context.maxRetries !== null && context.maxRetries > 0) {
      lines.push(
        `  If, as well, every call used all ${context.maxRetries} of its retries the bound would be ${usd(context.bounds.retryWorstCaseUsd)}`,
      );
    }
    if (context.maxOutputTokens !== null) {
      lines.push(
        `  Hard ceiling: ${usd(context.bounds.ceilingUsd)} if every attempt of every call generated all ${int(context.maxOutputTokens)} output tokens it is allowed (CLAUSEWISE_MAX_OUTPUT_TOKENS). The cost upper bound above assumes far less, so the run is also held to --max-cost request by request.`,
      );
    }
  }
  if (context.fallback) {
    lines.push(
      "  CLAUSEWISE_FALLBACK is on: a request the model declines is rerun on another model, which the price table does not cover.",
    );
  }
  lines.push(`  Spend limit (--max-cost): ${usd(context.maxCostUsd)}`, `  ${PRICE_WARNING}`);
  return `${lines.join("\n")}\n`;
}
