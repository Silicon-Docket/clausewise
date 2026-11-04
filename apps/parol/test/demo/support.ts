import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import type {
  ContextBundle,
  DraftFinding,
  ExtractOutput,
  RunManifest,
  VerifiedFinding,
} from "../../src/contracts.js";
import { createSimulatedModel } from "../../src/demo/index.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { workflowFor } from "../../src/prompts/workflows.js";
import { createSupportChecker } from "../../src/services/support-checker.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import { makeUndetermined, verifyFinding } from "../../src/stages/verify.js";
import { spanOfRef, type CaseWorld } from "../integration/pipeline.js";

/**
 * The real stages run over the PAROL-D05 documents with the simulated reader as the model.
 * Nothing here scripts an answer: whatever a finding says, the reader said it from the clauses the
 * stages put in front of it.
 */

export type Recording = ObjectGenerator & { readonly requests: GenerateObjectRequest<unknown>[] };

/** The simulated reader, remembering what it was asked, so a test can read the prompts. */
export function recordingReader(inner: ObjectGenerator = createSimulatedModel()): Recording {
  const requests: GenerateObjectRequest<unknown>[] = [];
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    requests,
    generate: (request) => {
      requests.push(request as GenerateObjectRequest<unknown>);
      return inner.generate(request);
    },
  };
}

/** What a review needs of a case: the documents as the stages see them, and the playbook. */
export type Subject = Pick<CaseWorld, "ingest" | "manifest" | "playbook">;

export interface Reviewed {
  generator: Recording;
  extract: ExtractOutput;
  bundles: ContextBundle[];
  drafts: Map<string, DraftFinding>;
  findings: Map<string, VerifiedFinding>;
  /** The analyze prompt of each rule. */
  prompts: Map<string, string>;
}

export interface ReviewOptions {
  /** The workflow version, which decides the retrieval policy. */
  workflow: "v1" | "v2";
  /** Replaces the workflow's own check sets, such as `["C1", "C2"]` for the baseline with C2. */
  checks?: string[];
  /** Runs the model support check too, as a workflow that pins a support prompt would. */
  support?: boolean;
  manifest?: RunManifest;
}

/** Extract, retrieve, analyze and verify, in the order the runner calls them. */
export async function review(world: Subject, options: ReviewOptions): Promise<Reviewed> {
  const generator = recordingReader();
  const workflow = workflowFor(options.workflow);
  const manifest = options.manifest ?? world.manifest;
  const extracted = await runExtract({
    generator,
    ingest: world.ingest,
    manifest,
    prompt: getPrompt("extract.p1"),
  });
  const bundles = buildBundles({
    ingest: world.ingest,
    extract: extracted.output,
    rules: world.playbook.rules,
    policy: workflow.manifest.retrieval,
    budgetTokens: workflow.manifest.budgetTokens,
  });
  const checks = options.checks ?? [...workflow.manifest.checks];
  const supportChecker = options.support ? createSupportChecker(getPrompt("support.p1")) : null;
  const drafts = new Map<string, DraftFinding>();
  const findings = new Map<string, VerifiedFinding>();
  const prompts = new Map<string, string>();
  for (const bundle of bundles) {
    const before = generator.requests.length;
    const analysed = await runAnalyze({
      generator,
      bundle,
      ingest: world.ingest,
      manifest,
      prompt: getPrompt(workflow.manifest.prompts.analyze),
      repairAttempts: workflow.manifest.repairAttempts,
    });
    prompts.set(bundle.ruleKey, generator.requests[before]?.prompt ?? "");
    if (!analysed.ok) {
      findings.set(
        bundle.ruleKey,
        makeUndetermined({ rule: bundle.rule, code: "output_invalid", detail: analysed.detail }),
      );
      continue;
    }
    drafts.set(bundle.ruleKey, analysed.draft);
    const verified = await verifyFinding({
      draft: analysed.draft,
      bundle,
      rule: bundle.rule,
      ingest: world.ingest,
      manifest,
      enabledChecks: checks,
      supportChecker,
      generator,
    });
    findings.set(bundle.ruleKey, verified.finding);
  }
  return { generator, extract: extracted.output, bundles, drafts, findings, prompts };
}

/** The span labels, such as `D1-p19`, that a finding cites, with the role of each. */
export function citations(
  world: CaseWorld,
  finding: Pick<VerifiedFinding, "evidence">,
): [string, string][] {
  return finding.evidence.map((e) => [
    world.ingest.spans.find((s) => s.id === e.spanId)!.label,
    e.role,
  ]);
}

/** The labels of the spans the key names for a rule in one role. */
export function keyLabels(
  world: CaseWorld,
  ruleKey: string,
  role: "governing" | "superseded" | "relevant",
): string[] {
  return world.key.expect[ruleKey]![role].map((ref) => spanOfRef(world, ref).label);
}

/** The bundle of a rule with some spans taken out, as if retrieval had not chosen them. */
export function without(
  world: CaseWorld,
  bundle: ContextBundle,
  ...labels: string[]
): ContextBundle {
  const gone = new Set(labels.map((label) => world.span(label).id));
  return { ...bundle, spans: bundle.spans.filter((s) => !gone.has(s.spanId)) };
}

export async function analyse(
  world: Subject,
  bundle: ContextBundle,
  options: { generator?: Recording; manifest?: RunManifest } = {},
): Promise<DraftFinding> {
  const analysed = await runAnalyze({
    generator: options.generator ?? recordingReader(),
    bundle,
    ingest: world.ingest,
    manifest: options.manifest ?? world.manifest,
    prompt: getPrompt("analyze.p1"),
    repairAttempts: 0,
  });
  if (!analysed.ok) throw new Error(`the analysis did not come back usable: ${analysed.detail}`);
  return analysed.draft;
}

export async function verify(
  world: Subject,
  bundle: ContextBundle,
  draft: DraftFinding,
  checks: string[] = ["C1"],
  manifest: RunManifest = world.manifest,
): Promise<VerifiedFinding> {
  const result = await verifyFinding({
    draft,
    bundle,
    rule: bundle.rule,
    ingest: world.ingest,
    manifest,
    enabledChecks: checks,
  });
  return result.finding;
}
