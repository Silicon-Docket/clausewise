/**
 * The perfect oracle of the selftest: a scripted stand-in for the model that answers every request
 * as the answer key says. It is the production form of the oracle the integration tests use
 * (apps/parol/test/integration/pipeline.ts), and it is not a language model. What it proves is that
 * the dataset, the parser, the stages, the scorer and the runner agree with each other; a score it
 * earns says nothing about any model.
 *
 * Two things make it a fair "perfect reader" and not a cheat.
 *
 *  - It points extract at every passage the key names for a category, in any document, so the
 *    workflow shows it what a correct reading needs. A real model has to find those passages.
 *  - It cites only clauses that its prompt shows. The prompt is the only thing a model reads, so an
 *    oracle that cited a clause it was not shown would be reading the key and not the workflow.
 *    If a workflow ever fails to show it a governing passage, the oracle still states the key's
 *    status but cites what it has, and the scorer then counts the missing citation.
 *
 * Every anchor is resolved once, when the oracle is built, so that a key that no longer matches its
 * documents stops the run loudly. Resolving inside `generate` would be turned into a failed model
 * call by the stages and look like a model failure.
 *
 * Nothing the oracle returns is document text except the anchor words, which are copied from the
 * documents so that a quote verifies, and the rest of its answers are fixed sentences.
 */
import type { ObjectGenerator } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import {
  CATEGORY_IDS,
  type AnalysisAnswer,
  type CategoryId,
  type EscalationCode,
  type PlaybookRuleRecord,
  type SourceSpan,
} from "../../../apps/parol/src/contracts.js";
import type { AnchorRef, RuleExpectation } from "../../../fixtures/parol/types.js";
import { resolveAnchor } from "./anchors.js";

export const ORACLE_PROVIDER = "oracle";
export const ORACLE_MODEL = "parol-key-oracle";
export const ORACLE_DISCLOSURE =
  "a scripted oracle that answers from the answer key (not a language model, and not a measurement of one): nothing is sent anywhere";

/** The schema names the stages ask for. See the prompt registry. */
const SCHEMAS = { extract: "locate_passages", analyze: "analyze_rule", support: "check_support" };

export interface OracleWorld {
  /** For logs and errors. */
  caseKey: string;
  /** The key's expectations: those of the case, or for a twin those of the case it is a twin of. */
  expect: Readonly<Record<string, RuleExpectation>>;
  /** The spans of this case's run. */
  spans: readonly SourceSpan[];
  rules: readonly PlaybookRuleRecord[];
}

interface Cite {
  label: string;
  quote: string;
}

interface RuleScript {
  rule: PlaybookRuleRecord;
  expectation: RuleExpectation;
  governing: Cite[];
  superseded: Cite[];
  relevant: Cite[];
}

/** The labels of the clauses a prompt shows: the header lines inside its contract block. */
export function shownLabels(prompt: string): Set<string> {
  const open = prompt.indexOf("<contract>\n");
  const close = prompt.lastIndexOf("\n</contract>");
  if (open === -1 || close < open) return new Set();
  const inside = prompt.slice(open + "<contract>\n".length, close);
  return new Set([...inside.matchAll(/^\[(c\d+)\]/gm)].map((match) => match[1]!));
}

const ruleIdOf = (prompt: string): string | undefined => /^Rule ID: (\S+)$/m.exec(prompt)?.[1];

export function createKeyOracle(world: OracleWorld): ObjectGenerator & {
  readonly calls: ReturnType<typeof createScriptedGenerator>["calls"];
} {
  const labelOf = (ref: AnchorRef): string => {
    const id = resolveAnchor(world.spans, ref, world.caseKey);
    return world.spans.find((span) => span.id === id)!.modelLabel;
  };
  const cites = (refs: readonly AnchorRef[]): Cite[] =>
    refs.map((ref) => ({ label: labelOf(ref), quote: ref.anchor }));

  const scripts = new Map<string, RuleScript>();
  for (const rule of world.rules) {
    const expectation = world.expect[rule.key];
    if (expectation === undefined) {
      throw new Error(`${world.caseKey} ${rule.key}: the key has no expectation for the rule`);
    }
    scripts.set(rule.key, {
      rule,
      expectation,
      governing: cites(expectation.governing),
      superseded: cites(expectation.superseded),
      relevant: cites(expectation.relevant),
    });
  }

  // Extract: for each category, the passages the key names for its rules, once per clause.
  const located = new Map<CategoryId, Cite[]>(CATEGORY_IDS.map((category) => [category, []]));
  for (const script of scripts.values()) {
    const bucket = located.get(script.rule.category)!;
    for (const cite of [...script.governing, ...script.superseded, ...script.relevant]) {
      if (!bucket.some((existing) => existing.label === cite.label)) bucket.push(cite);
    }
  }
  const extractAnswer = {
    categories: CATEGORY_IDS.map((category) => {
      const passages = located.get(category)!;
      return {
        category,
        passages: passages.map(({ label, quote }) => ({ span: label, quote })),
        notFoundReason: passages.length === 0 ? "no clause covers it" : null,
      };
    }),
  };

  const analyzeAnswer = (prompt: string): AnalysisAnswer => {
    const ruleId = ruleIdOf(prompt);
    const script = ruleId === undefined ? undefined : scripts.get(ruleId);
    if (script === undefined) throw new Error("the oracle was asked about a rule it does not know");
    const { expectation, rule } = script;
    const shown = shownLabels(prompt);
    const visible = (list: Cite[]): Cite[] => list.filter((cite) => shown.has(cite.label));
    const undetermined = expectation.status === "undetermined";
    const wants = (code: EscalationCode): boolean => expectation.escalation.codes.includes(code);
    return {
      status: expectation.status,
      evidence: [
        ...visible(script.governing).map((c) => ({
          span: c.label,
          quote: c.quote,
          role: "governing" as const,
        })),
        ...visible(script.superseded).map((c) => ({
          span: c.label,
          quote: c.quote,
          role: "superseded" as const,
        })),
        // Passages the documents leave unsettled are cited as conflicting, as the prompt asks.
        ...visible(script.relevant).map((c) => ({
          span: c.label,
          quote: c.quote,
          role: undetermined ? ("conflicting" as const) : ("supporting" as const),
        })),
      ],
      discrepancy:
        expectation.status === "deviation" ? "The clause falls short of the standard." : "",
      explanation: "The clause is read against the standard of the rule.",
      fallbackLanguage: null,
      // The playbook's own escalation condition, when the key requires the playbook's escalation.
      escalateWhenMatched:
        wants("playbook_escalation") && rule.escalateWhen[0] !== undefined
          ? [rule.escalateWhen[0].id]
          : [],
      conflict: undetermined && wants("conflicting_sources") ? "The passages disagree." : null,
      abstainReason: undetermined ? "The documents do not settle which passage governs." : null,
    };
  };

  return createScriptedGenerator(
    (request) => {
      switch (request.schemaName) {
        case SCHEMAS.extract:
          return extractAnswer;
        case SCHEMAS.analyze:
          return analyzeAnswer(request.prompt);
        case SCHEMAS.support:
          return { verdict: "supported", missingPremise: null };
        default:
          // A request of a kind the stages do not make today. The message names no input.
          throw new Error("the oracle does not know this kind of request");
      }
    },
    { provider: ORACLE_PROVIDER, model: ORACLE_MODEL, disclosure: ORACLE_DISCLOSURE },
  );
}
