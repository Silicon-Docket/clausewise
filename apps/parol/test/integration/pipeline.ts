import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { AnswerKeyCase, AnswerKeyFile, AnchorRef } from "../../../../fixtures/parol/types.js";
import { resolveAnchor } from "../../../../evals/src/parol/anchors.js";
import { sha256Hex } from "../../src/canonical.js";
import {
  CATEGORY_IDS,
  type AnalysisAnswer,
  type CallRecord,
  type CategoryId,
  type ContextBundle,
  type DocLabel,
  type DraftFinding,
  type ExtractOutput,
  type IngestDocumentInput,
  type IngestOutput,
  type RetrievalPolicy,
  type RunManifest,
  type SourceSpan,
  type VerifiedFinding,
} from "../../src/contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import type { LoadedPlaybook, SupportChecker } from "../../src/module-contracts.js";
import { loadPlaybook } from "../../src/playbooks/load.js";
import { getPrompt, renderPrompt } from "../../src/prompts/registry.js";
import { renderContractBlock, renderRule } from "../../src/prompts/render.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import { makeUndetermined, verifyFinding } from "../../src/stages/verify.js";
import { SupportSchema } from "../../src/contracts.js";

/**
 * The wiring for the integration tests: the real parser, ingest, playbook loader, extract,
 * retrieve, analyze, verify and memo, run on the documents of the evaluation dataset, with a
 * scripted model standing in for the provider. Nothing here calls a network.
 *
 * The scripted model is an oracle for the answer key of the case. It answers extract by pointing
 * at the key's anchors in the NDA, and answers each rule by citing the key's governing,
 * superseded and relevant anchors, as it would if it read every passage it was given. The
 * workflow around it is what the tests measure: what it is shown, and what is made of its answer.
 */

export const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const FILES_DIR = join(ROOT, "fixtures", "parol", "files");
const KEYS_PATH = join(ROOT, "fixtures", "parol", "answer-keys.json");
export const PLAYBOOK_PATH = join(ROOT, "apps", "parol", "playbooks", "parol-nda-recipient.yaml");

// ---------------------------------------------------------------------------------------------
// The dataset
// ---------------------------------------------------------------------------------------------

interface Fixtures {
  keys: AnswerKeyFile;
  file(name: string): Uint8Array;
}

let fixtures: Promise<Fixtures> | undefined;

/**
 * The committed files of fixtures/parol when they are all there, and otherwise the dataset built
 * from the case data (the same builder `pnpm fixtures:parol` runs), so the tests do not depend on
 * the command having been run.
 */
export function loadFixtures(): Promise<Fixtures> {
  fixtures ??= (async (): Promise<Fixtures> => {
    if (existsSync(KEYS_PATH)) {
      const keys = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as AnswerKeyFile;
      const names = [...keys.cases, ...keys.twins].flatMap((c) => c.documents.map((d) => d.file));
      if (names.every((name) => existsSync(join(FILES_DIR, name)))) {
        return { keys, file: (name) => readFileSync(join(FILES_DIR, name)) };
      }
    }
    const { buildDataset } = await import("../../../../fixtures/parol/build.js");
    const { CASES, PLAYBOOK_SLUG } = await import("../../../../fixtures/parol/cases.js");
    const built = await buildDataset({
      cases: CASES,
      playbookYaml: readFileSync(PLAYBOOK_PATH, "utf8"),
      playbookSlug: PLAYBOOK_SLUG,
    });
    const byName = new Map(built.files.map((f) => [f.name, f.bytes]));
    return {
      keys: built.answerKeys,
      file: (name) => {
        const bytes = byName.get(name);
        if (bytes === undefined) throw new Error(`the dataset has no file ${name}`);
        return bytes;
      },
    };
  })();
  return fixtures;
}

export function loadDemoPlaybook(): LoadedPlaybook {
  return loadPlaybook({
    yaml: readFileSync(PLAYBOOK_PATH, "utf8"),
    slug: "parol-nda-recipient",
    source: PLAYBOOK_PATH,
  });
}

// ---------------------------------------------------------------------------------------------
// A case, parsed and ingested
// ---------------------------------------------------------------------------------------------

export interface CaseFile {
  label: DocLabel;
  file: string;
  mediaType: "docx" | "txt";
  bytes: Uint8Array;
}

export interface CaseWorld {
  caseKey: string;
  key: AnswerKeyCase;
  playbook: LoadedPlaybook;
  files: CaseFile[];
  documents: IngestDocumentInput[];
  ingest: IngestOutput;
  manifest: RunManifest;
  /** The span with this label, such as `D1-p19`. */
  span(label: string): SourceSpan;
}

export const versionIdOf = (label: DocLabel): string => `dv_${label.toLowerCase()}`;

export async function buildCaseWorld(
  caseKey: string,
  options: { twin?: boolean; workflow?: string } = {},
): Promise<CaseWorld> {
  const { keys, file } = await loadFixtures();
  const original = keys.cases.find((c) => c.case === caseKey);
  if (original === undefined) throw new Error(`no case ${caseKey}`);
  // A twin is the same documents without the injected paragraph, and the original's key applies.
  const twin = options.twin ? keys.twins.find((c) => c.twinOf === caseKey) : undefined;
  if (options.twin && twin === undefined) throw new Error(`no twin of ${caseKey}`);
  const key: AnswerKeyCase =
    twin === undefined ? original : { ...original, documents: twin.documents };
  const playbook = loadDemoPlaybook();

  const files: CaseFile[] = [];
  const documents: IngestDocumentInput[] = [];
  for (const doc of key.documents) {
    const mediaType = doc.file.endsWith(".docx") ? "docx" : "txt";
    const bytes = file(doc.file);
    const parsed = await parseDocument({ bytes, mediaType });
    files.push({ label: doc.label, file: doc.file, mediaType, bytes });
    documents.push({
      documentVersionId: versionIdOf(doc.label),
      label: doc.label,
      kind: doc.kind,
      title: doc.title,
      versionNo: doc.versionNo,
      statedDate: doc.statedDate,
      paragraphs: parsed.paragraphs,
      inspection: parsed.inspection,
    });
  }
  const ingest = buildIngest({ documents });
  const workflow = workflowFor(options.workflow ?? "v1");
  const manifest: RunManifest = {
    matterId: `mat_${caseKey.toLowerCase()}`,
    clientLegalName: key.intake.clientLegalName,
    documents: documents.map((d) => ({
      documentVersionId: d.documentVersionId,
      label: d.label,
      kind: d.kind,
      title: d.title,
      versionNo: d.versionNo,
      statedDate: d.statedDate,
      textSha256: documentTextSha256(d.paragraphs),
    })),
    playbook: {
      versionId: "pbv_integration",
      slug: playbook.slug,
      version: playbook.version,
      sha256: playbook.sha256,
    },
    workflow: {
      versionId: "wfv_integration",
      label: workflow.manifest.label,
      sha256: workflow.sha256,
    },
    model: { provider: "scripted", model: "scripted-oracle" },
  };
  return {
    caseKey,
    key,
    playbook,
    files,
    documents,
    ingest,
    manifest,
    span: (label) => {
      const found = ingest.spans.find((s) => s.label === label);
      if (found === undefined) throw new Error(`no span ${label}`);
      return found;
    },
  };
}

/**
 * The same case with the document version ids a store gave the uploads, and the ingest rebuilt with
 * them. Span ids contain the version id, so a run through the store cannot use the fixed ids.
 */
export function withVersionIds(world: CaseWorld, ids: Record<string, string>): CaseWorld {
  const documents = world.documents.map((d) => ({ ...d, documentVersionId: ids[d.label]! }));
  const ingest = buildIngest({ documents });
  const manifest: RunManifest = {
    ...world.manifest,
    documents: world.manifest.documents.map((d) => ({ ...d, documentVersionId: ids[d.label]! })),
  };
  return {
    ...world,
    documents,
    ingest,
    manifest,
    span: (label) => {
      const found = ingest.spans.find((s) => s.label === label);
      if (found === undefined) throw new Error(`no span ${label}`);
      return found;
    },
  };
}

export const spanOfRef = (world: CaseWorld, ref: AnchorRef): SourceSpan => {
  const id = resolveAnchor(world.ingest.spans, ref);
  return world.ingest.spans.find((s) => s.id === id)!;
};

// ---------------------------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------------------------

/** The words of the worked example (docs/parol/04-worked-example.md, sections 3). */
export const WORDS = {
  termQuote: "shall continue for two (2) years from the date of each disclosure",
  deletionQuote: "Section 6.1 of the Agreement is deleted in its entirety",
  survivalQuote: "Sections 4, 5 and 8 survive any termination or expiration of this Agreement",
  baselineExplanation:
    "Section 6.1 limits the obligations to two years from each disclosure, within the three-year standard.",
  revisedDiscrepancy:
    "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
  revisedExplanation:
    "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
  revisedFallback:
    "6.1 The obligations of each Receiving Party under Section 4 shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
} as const;

/** The baseline answer of the document: compliant, citing only the NDA's Section 6.1. */
export function baselineAnswer(world: CaseWorld): AnalysisAnswer {
  return {
    status: "compliant",
    evidence: [
      { span: world.span("D1-p19").modelLabel, quote: WORDS.termQuote, role: "governing" },
    ],
    discrepancy: "",
    explanation: WORDS.baselineExplanation,
    fallbackLanguage: null,
    escalateWhenMatched: [],
    conflict: null,
    abstainReason: null,
  };
}

/** The revision's answer of the document: deviation, citing the deleting amendment. */
export function revisedAnswer(world: CaseWorld): AnalysisAnswer {
  return {
    status: "deviation",
    evidence: [
      { span: world.span("D2-p3").modelLabel, quote: WORDS.deletionQuote, role: "governing" },
      { span: world.span("D1-p19").modelLabel, quote: WORDS.termQuote, role: "superseded" },
      { span: world.span("D1-p29").modelLabel, quote: WORDS.survivalQuote, role: "supporting" },
    ],
    discrepancy: WORDS.revisedDiscrepancy,
    explanation: WORDS.revisedExplanation,
    fallbackLanguage: WORDS.revisedFallback,
    escalateWhenMatched: [],
    conflict: null,
    abstainReason: null,
  };
}

/**
 * What the key says about a rule, as the analysis prompt's answer: the governing anchors cited as
 * governing, the superseded ones as superseded, the relevant ones as supporting. The words are
 * the key's anchors, so each quote is a few words copied from the span it names.
 */
export function keyAnswer(world: CaseWorld, ruleKey: string): AnalysisAnswer {
  const expectation = world.key.expect[ruleKey];
  if (expectation === undefined) throw new Error(`the key has no rule ${ruleKey}`);
  const rule = world.playbook.rules.find((r) => r.key === ruleKey)!;
  const cite = (ref: AnchorRef, role: AnalysisAnswer["evidence"][number]["role"]) => ({
    span: spanOfRef(world, ref).modelLabel,
    quote: ref.anchor,
    role,
  });
  const undetermined = expectation.status === "undetermined";
  const wants = (code: string): boolean => expectation.escalation.codes.includes(code as never);
  return {
    status: expectation.status,
    evidence: [
      ...expectation.governing.map((ref) => cite(ref, "governing")),
      ...expectation.superseded.map((ref) => cite(ref, "superseded")),
      // Passages the documents leave unsettled are cited as conflicting, as the prompt asks.
      ...expectation.relevant.map((ref) => cite(ref, undetermined ? "conflicting" : "supporting")),
    ],
    discrepancy:
      expectation.status === "deviation" ? "The clause falls short of the standard." : "",
    explanation: "The clause is read against the standard of the rule.",
    fallbackLanguage: null,
    // An escalation condition of the playbook, when the key requires the playbook's escalation.
    escalateWhenMatched: wants("playbook_escalation") ? [rule.escalateWhen[0]!.id] : [],
    conflict: undetermined && wants("conflicting_sources") ? "The passages disagree." : null,
    abstainReason: undetermined ? "The documents do not settle which passage governs." : null,
  };
}

/**
 * The extract answer: for each category, the NDA passages the key's anchors for its rules name.
 * The governing and superseded ones are located. A relevant one is located too, unless ingest
 * already hints it for the category: the keyword hints are the net under what the locator misses,
 * and the document's table has the survival clause of Section 9.3 as a hint it did not select. A
 * rule whose governing text is all in an amendment (the return deadline) has its NDA clause located.
 */
export function extractAnswer(world: CaseWorld): unknown {
  const byCategory = new Map<CategoryId, { span: string; quote: string }[]>();
  const hinted = (spanId: string, category: CategoryId): boolean =>
    world.ingest.annotations.some(
      (a) => a.kind === "keyword_hint" && a.spanId === spanId && a.category === category,
    );
  for (const rule of world.playbook.rules) {
    const expectation = world.key.expect[rule.key];
    if (expectation === undefined) continue;
    const nda = (refs: AnchorRef[]) => refs.filter((r) => r.doc === "D1");
    const list = byCategory.get(rule.category) ?? [];
    const add = (ref: AnchorRef): void => {
      const span = spanOfRef(world, ref);
      // Duration: the document locates the term clause with the words of its first sentence.
      const quote = span.label === "D1-p19" ? WORDS.termQuote : ref.anchor;
      if (!list.some((p) => p.span === span.modelLabel))
        list.push({ span: span.modelLabel, quote });
    };
    const main = [...nda(expectation.governing), ...nda(expectation.superseded)];
    for (const ref of main) add(ref);
    for (const ref of nda(expectation.relevant)) {
      // With nothing else to point at, the relevant clause is the clause. Otherwise it is located
      // only if ingest does not already hint it.
      if (main.length === 0 || !hinted(spanOfRef(world, ref).id, rule.category)) add(ref);
    }
    byCategory.set(rule.category, list);
  }
  return {
    categories: CATEGORY_IDS.map((category) => ({
      category,
      passages: byCategory.get(category) ?? [],
      notFoundReason: (byCategory.get(category) ?? []).length === 0 ? "no clause covers it" : null,
    })),
  };
}

export type ScriptedModel = ReturnType<typeof createScriptedGenerator>;

export interface ScriptOptions {
  /** Answers by rule key, replacing the key's own. */
  answers?: Record<string, AnalysisAnswer>;
  /** Extract finds nothing, so every rule reads the whole document. */
  extractNothing?: boolean;
  /** The extract call fails with this error, as a provider outage would. */
  extractFails?: unknown;
  /** Rules whose first answer cites a clause that was not shown, so that analyze repairs it. */
  firstAnswerCitesUnknownClause?: string[];
}

/** A scripted model that tells extract from analyze by the name of the schema it is asked for. */
export function scriptedModel(world: CaseWorld, options: ScriptOptions = {}): ScriptedModel {
  const answered = new Set<string>();
  return createScriptedGenerator((request) => {
    if (request.schemaName === "locate_passages") {
      if (options.extractFails !== undefined) throw options.extractFails;
      return options.extractNothing === true
        ? {
            categories: CATEGORY_IDS.map((category) => ({
              category,
              passages: [],
              notFoundReason: "none",
            })),
          }
        : extractAnswer(world);
    }
    if (request.schemaName === "analyze_rule") {
      const ruleKey = /^Rule ID: (\S+)$/m.exec(request.prompt)?.[1];
      if (ruleKey === undefined) throw new Error("the analyze prompt names no rule");
      const answer = options.answers?.[ruleKey] ?? keyAnswer(world, ruleKey);
      if (options.firstAnswerCitesUnknownClause?.includes(ruleKey) && !answered.has(ruleKey)) {
        answered.add(ruleKey);
        return { ...answer, evidence: [{ span: "c999", quote: "words", role: "governing" }] };
      }
      return answer;
    }
    throw new Error(`unexpected schema ${String(request.schemaName)}`);
  });
}

/**
 * A support checker built the way W2.2 will build it: the real `support.p1` prompt, rendered with
 * the stage helpers over the cited spans and nothing else, sent to the generator it is given.
 */
export function supportChecker(
  verdict: "supported" | "not_supported" | "insufficient" = "supported",
): { checker: SupportChecker; prompts: string[] } {
  const prompts: string[] = [];
  const prompt = getPrompt("support.p1");
  const checker: SupportChecker = async ({ rule, draft, citedSpans }) => {
    const text = renderPrompt(prompt.definition, {
      contractBlock: renderContractBlock(citedSpans),
      rule: renderRule(rule),
      status: draft.status,
      discrepancy: draft.discrepancy === "" ? "(none)" : draft.discrepancy,
    });
    prompts.push(text);
    const answer = SupportSchema.parse({
      verdict,
      missingPremise: verdict === "supported" ? null : "x",
    });
    const call: CallRecord = {
      stage: "support",
      ruleKey: rule.key,
      promptVersionId: prompt.definition.id,
      requestSha256: sha256Hex(prompt.definition.system + text),
      attempt: 1,
      outcome: "ok",
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
    };
    return { answer, call };
  };
  return { checker, prompts };
}

// ---------------------------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------------------------

export interface RuleResult {
  bundle: ContextBundle;
  /** The generator's requests for this rule. */
  prompt: string;
  draft: DraftFinding;
  finding: VerifiedFinding;
  calls: CallRecord[];
}

export interface RunResult {
  extract: ExtractOutput;
  bundles: ContextBundle[];
  results: Map<string, RuleResult>;
  calls: CallRecord[];
  generator: ScriptedModel;
}

/**
 * The stages in the order the runner will call them: extract, retrieve, then analyze and verify
 * for each rule. A rule that cannot be analysed becomes an undetermined finding, as the runner
 * will do.
 */
export async function runWorkflow(
  world: CaseWorld,
  options: {
    policy: RetrievalPolicy;
    checks: string[];
    script?: ScriptOptions;
    supportChecker?: SupportChecker;
    /** Replaces the workflow's context budget, to test a rule that is too big to analyse. */
    budgetTokens?: number;
  },
): Promise<RunResult> {
  const generator = scriptedModel(world, options.script);
  const extracted = await runExtract({
    generator,
    ingest: world.ingest,
    manifest: world.manifest,
    prompt: getPrompt("extract.p1"),
  });
  const workflow = workflowFor(options.policy === "R1" ? "v1" : "v2");
  const bundles = buildBundles({
    ingest: world.ingest,
    extract: extracted.output,
    rules: world.playbook.rules,
    policy: options.policy,
    budgetTokens: options.budgetTokens ?? workflow.manifest.budgetTokens,
  });
  const calls: CallRecord[] = [...extracted.calls];
  const results = new Map<string, RuleResult>();
  for (const bundle of bundles) {
    const before = generator.calls.length;
    const analysed = bundle.overBudget
      ? ({ ok: false, detail: "context_over_budget", calls: [] } as const)
      : await runAnalyze({
          generator,
          bundle,
          ingest: world.ingest,
          manifest: world.manifest,
          prompt: getPrompt(workflow.manifest.prompts.analyze),
          repairAttempts: workflow.manifest.repairAttempts,
        });
    calls.push(...analysed.calls);
    const prompt = generator.calls[before]?.prompt ?? "";
    if (!analysed.ok) {
      const finding = makeUndetermined({
        rule: bundle.rule,
        code: bundle.overBudget ? "context_over_budget" : "output_invalid",
        detail: analysed.detail,
      });
      results.set(bundle.ruleKey, {
        bundle,
        prompt,
        draft: undefined as unknown as DraftFinding,
        finding,
        calls: [...analysed.calls],
      });
      continue;
    }
    const verified = await verifyFinding({
      draft: analysed.draft,
      bundle,
      rule: bundle.rule,
      ingest: world.ingest,
      manifest: world.manifest,
      enabledChecks: options.checks,
      ...(options.supportChecker === undefined ? {} : { supportChecker: options.supportChecker }),
      generator,
    });
    calls.push(...verified.calls);
    results.set(bundle.ruleKey, {
      bundle,
      prompt,
      draft: analysed.draft,
      finding: verified.finding,
      calls: [...analysed.calls, ...verified.calls],
    });
  }
  return {
    extract: extracted.output,
    bundles,
    results,
    calls,
    generator,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading prompts back
// ---------------------------------------------------------------------------------------------

/** The part of a prompt between the contract tags, and what is left once it is taken out. */
export function splitContract(prompt: string): { inside: string; outside: string } {
  const open = prompt.indexOf("<contract>\n");
  const close = prompt.lastIndexOf("\n</contract>");
  if (open === -1 || close === -1) throw new Error("the prompt has no contract block");
  return {
    inside: prompt.slice(open + "<contract>\n".length, close),
    outside: prompt.slice(0, open) + prompt.slice(close + "\n</contract>".length),
  };
}

/** The `[cN]` header lines of a contract block, in order. */
export const headerLabels = (inside: string): string[] =>
  [...inside.matchAll(/^\[(c\d+)\]/gm)].map((m) => m[1]!);
