import { createScriptedGenerator } from "@clausewise/llm/testing";
import {
  SupportSchema,
  spanIdOf,
  type CallRecord,
  type ContextBundle,
  type DocLabel,
  type DraftEvidence,
  type DraftFinding,
  type IngestOutput,
  type PlaybookRuleRecord,
  type RunManifest,
  type SourceSpan,
  type SpanAnnotation,
  type VerifiedFinding,
} from "../../src/contracts.js";
import type {
  SupportCheckInput,
  SupportChecker,
  VerifyArgs,
  VerifyResult,
} from "../../src/module-contracts.js";
import { verifyFinding } from "../../src/stages/verify.js";

/**
 * Hand-built runs for the verify tests. Spans and annotations are written out and not produced by
 * ingest, so that a check is tested against exactly the facts the test states and a change to the
 * ingest patterns cannot move a verify test. Every party and passage here is invented for these
 * tests; the wording follows the shape of docs/parol/04-worked-example.md without copying a
 * contract.
 */

// ---------------------------------------------------------------------------------------------
// Spans
// ---------------------------------------------------------------------------------------------

export const versionIdOf = (label: DocLabel): string => `dv_${label.toLowerCase()}`;

export interface SpanSpec {
  doc: DocLabel;
  paragraph: number;
  text: string;
  clause?: string | null;
  heading?: string | null;
}

let counter = 0;

/** A span the way ingest would build it, with a model label counted from c1 across a run. */
export function makeSpan(spec: SpanSpec, modelNumber: number): SourceSpan {
  return {
    id: spanIdOf(versionIdOf(spec.doc), spec.paragraph),
    label: `${spec.doc}-p${spec.paragraph}`,
    modelLabel: `c${modelNumber}`,
    documentVersionId: versionIdOf(spec.doc),
    docLabel: spec.doc,
    paragraphIndex: spec.paragraph,
    clauseId: `c${spec.paragraph}`,
    clauseNumber: spec.clause ?? null,
    heading: spec.heading ?? null,
    text: spec.text,
    textSha256: String(++counter).padStart(64, "0"),
  };
}

export function ingestOf(specs: SpanSpec[], annotations: SpanAnnotation[] = []): IngestOutput {
  return { spans: specs.map((spec, i) => makeSpan(spec, i + 1)), annotations, warnings: [] };
}

export const idOf = (doc: DocLabel, paragraph: number): string =>
  spanIdOf(versionIdOf(doc), paragraph);

export function spanOf(ingest: IngestOutput, label: string): SourceSpan {
  const found = ingest.spans.find((s) => s.label === label);
  if (found === undefined) throw new Error(`no span ${label}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// The rule, the manifest and the worked example
// ---------------------------------------------------------------------------------------------

export function rule(overrides: Partial<PlaybookRuleRecord> = {}): PlaybookRuleRecord {
  return {
    key: "dur-1",
    category: "duration",
    title: "Duration of confidentiality obligations",
    severity: "high",
    required: true,
    kind: "presence",
    standard:
      "Obligations end three years or less after each disclosure. Continued protection of trade secrets for as long as they remain trade secrets is acceptable.",
    fallback: "Obligations end five years or less after the agreement ends.",
    unacceptable:
      "Obligations that are perpetual or have no stated end, for information that is not a trade secret.",
    guidance: null,
    fallbackLanguage:
      "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
    escalateWhen: [
      {
        id: "over-five-years",
        text: "The stated period is longer than the fallback but finite, which is a business decision.",
      },
      { id: "needs-partner", text: "A partner must approve any change to this term." },
    ],
    ...overrides,
  };
}

export const CLIENT = "Lanternfish Software, Inc.";
export const NDA_DATE = "2026-02-02";
export const AMENDMENT_DATE = "2026-09-15";

export function manifest(
  overrides: { clientLegalName?: string; dates?: Partial<Record<DocLabel, string | null>> } = {},
): RunManifest {
  const dates: Record<DocLabel, string | null> = {
    D1: NDA_DATE,
    D2: AMENDMENT_DATE,
    D3: "2026-10-01",
    ...overrides.dates,
  };
  const doc = (label: DocLabel, title: string): RunManifest["documents"][number] => ({
    documentVersionId: versionIdOf(label),
    label,
    kind: label === "D1" ? "nda" : "amendment",
    title,
    versionNo: 1,
    statedDate: dates[label],
    textSha256: "a".repeat(64),
  });
  return {
    matterId: "m_test",
    clientLegalName: overrides.clientLegalName ?? CLIENT,
    documents: [
      doc("D1", "Mutual NDA"),
      doc("D2", "Amendment No. 1"),
      doc("D3", "Amendment No. 2"),
    ],
    playbook: {
      versionId: "pv_1",
      slug: "parol-nda-recipient",
      version: "1.0.0",
      sha256: "b".repeat(64),
    },
    workflow: { versionId: "wv_1", label: "v1", sha256: "c".repeat(64) },
    model: { provider: "scripted", model: "scripted-model" },
  };
}

/** The passages of the PAROL-D05 example that matter, at the paragraph numbers the design gives. */
export const D1_DEFINITION =
  '1.2 "Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure.';
export const D1_TERM =
  "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.";
export const D1_SURVIVAL =
  "9.3 Sections 4, 5 and 8 survive any termination or expiration of this Agreement.";
export const D1_RETURN =
  "7.2 Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.";
export const D2_DELETE = "2. Section 6.1 of the Agreement is deleted in its entirety.";
export const D2_RETURN =
  '3. Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".';

export const QUOTE_TERM = "shall continue for two (2) years from the date of each disclosure";
export const QUOTE_DELETE = "Section 6.1 of the Agreement is deleted in its entirety";
export const QUOTE_SURVIVAL =
  "Sections 4, 5 and 8 survive any termination or expiration of this Agreement";

export function workedExample(): IngestOutput {
  return ingestOf(
    [
      { doc: "D1", paragraph: 0, text: "MUTUAL NONDISCLOSURE AGREEMENT" },
      {
        doc: "D1",
        paragraph: 1,
        text: 'This Mutual Nondisclosure Agreement (the "Agreement") is made on 2 February 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC.',
      },
      { doc: "D1", paragraph: 6, text: D1_DEFINITION, clause: "1.2", heading: "1. DEFINITIONS" },
      { doc: "D1", paragraph: 19, text: D1_TERM, clause: "6.1", heading: "6. TERM" },
      { doc: "D1", paragraph: 23, text: D1_RETURN, clause: "7.2", heading: "7. GENERAL" },
      { doc: "D1", paragraph: 29, text: D1_SURVIVAL, clause: "9.3", heading: "9. SURVIVAL" },
      { doc: "D2", paragraph: 0, text: "AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT" },
      {
        doc: "D2",
        paragraph: 1,
        text: 'This Amendment No. 1 (the "Amendment") is made as of 15 September 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC, and amends the Mutual Nondisclosure Agreement between them dated 2 February 2026 (the "Agreement").',
      },
      { doc: "D2", paragraph: 3, text: D2_DELETE, clause: "2", heading: "2. TERM" },
      { doc: "D2", paragraph: 4, text: D2_RETURN, clause: "3", heading: "3. RETURN" },
    ],
    [
      define("D1", 1, "Agreement"),
      define("D1", 6, "Confidential Information"),
      define("D1", 6, "Disclosing Party"),
      define("D1", 6, "Receiving Party"),
      define("D2", 1, "Amendment"),
      define("D2", 1, "Agreement"),
      reference("D1", 29, "4", "refers"),
      reference("D1", 29, "5", "refers"),
      reference("D1", 29, "8", "refers"),
      reference("D2", 3, "6.1", "deletes"),
      reference("D2", 4, "7.2", "amends"),
      hint("D1", 19, "duration"),
      hint("D1", 29, "duration"),
    ],
  );
}

export const define = (doc: DocLabel, paragraph: number, term: string): SpanAnnotation => ({
  kind: "defines_term",
  spanId: idOf(doc, paragraph),
  term,
});
export const reference = (
  doc: DocLabel,
  paragraph: number,
  target: string,
  verb: "replaces" | "amends" | "deletes" | "refers",
): SpanAnnotation => ({ kind: "cross_reference", spanId: idOf(doc, paragraph), target, verb });
export const hint = (
  doc: DocLabel,
  paragraph: number,
  category: PlaybookRuleRecord["category"],
): SpanAnnotation => ({ kind: "keyword_hint", spanId: idOf(doc, paragraph), category });

// ---------------------------------------------------------------------------------------------
// Bundles, drafts and calls
// ---------------------------------------------------------------------------------------------

export function bundle(
  ingest: IngestOutput,
  labels: string[],
  options: { rule?: PlaybookRuleRecord; fullDocument?: boolean } = {},
): ContextBundle {
  const r = options.rule ?? rule();
  return {
    ruleKey: r.key,
    category: r.category,
    rule: r,
    spans: labels.map((label) => ({ spanId: spanOf(ingest, label).id, why: "located" as const })),
    fullDocument: options.fullDocument ?? false,
    estimatedTokens: 1000,
    budgetTokens: 12_000,
    overBudget: false,
  };
}

export const cite = (
  ingest: IngestOutput,
  label: string,
  quote: string,
  role: DraftEvidence["role"] = "governing",
): DraftEvidence => ({ spanId: spanOf(ingest, label).id, quote, role });

export function draft(overrides: Partial<DraftFinding> = {}): DraftFinding {
  return {
    ruleKey: "dur-1",
    status: "deviation",
    evidence: [],
    discrepancy: "",
    explanation: "",
    fallbackLanguage: null,
    escalateWhenMatched: [],
    conflict: null,
    abstainReason: null,
    ...overrides,
  };
}

/** The baseline failure of the design: compliant, citing the deleted 6.1, the amendment unseen. */
export function baselineDraft(ingest: IngestOutput): DraftFinding {
  return draft({
    status: "compliant",
    evidence: [cite(ingest, "D1-p19", QUOTE_TERM, "governing")],
    explanation:
      "Section 6.1 limits the obligations to two years from each disclosure, within the three-year standard.",
  });
}

/** The revision's answer, with the amendment in the bundle and cited. */
export function revisedDraft(ingest: IngestOutput): DraftFinding {
  return draft({
    status: "deviation",
    evidence: [
      cite(ingest, "D2-p3", QUOTE_DELETE, "governing"),
      cite(ingest, "D1-p19", QUOTE_TERM, "superseded"),
      cite(ingest, "D1-p29", QUOTE_SURVIVAL, "supporting"),
    ],
    discrepancy:
      "Amendment No. 1 deletes Section 6.1, the only time limit on the obligations in Section 4, and Section 9.3 keeps Section 4 in force after termination. As amended, the obligations have no stated end for information that is not a trade secret, which the playbook lists as unacceptable.",
    explanation:
      "The original two-year term in Section 6.1 no longer applies. Nothing else in the Agreement or the Amendment limits how long the Section 4 obligations last.",
    fallbackLanguage:
      "6.1 The obligations of each Receiving Party under Section 4 shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
  });
}

export interface RunOptions extends Partial<Omit<VerifyArgs, "draft" | "ingest" | "bundle">> {
  bundleLabels?: string[];
  fullDocument?: boolean;
  ingest?: IngestOutput;
  bundle?: ContextBundle;
}

/** Runs verify with C1 by default. The bundle is the baseline's unless told otherwise. */
export async function verify(d: DraftFinding, options: RunOptions = {}): Promise<VerifyResult> {
  const ingest = options.ingest ?? workedExample();
  const r = options.rule ?? rule();
  const b =
    options.bundle ??
    bundle(ingest, options.bundleLabels ?? ["D1-p19", "D1-p6", "D1-p29"], {
      rule: r,
      fullDocument: options.fullDocument ?? false,
    });
  return verifyFinding({
    draft: d,
    bundle: b,
    rule: r,
    ingest,
    manifest: options.manifest ?? manifest(),
    enabledChecks: options.enabledChecks ?? ["C1"],
    ...(options.supportChecker === undefined ? {} : { supportChecker: options.supportChecker }),
    ...(options.generator === undefined ? {} : { generator: options.generator }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export const codes = (finding: VerifiedFinding): string[] => finding.escalations.map((e) => e.code);

export function check(finding: VerifiedFinding, id: string) {
  const found = finding.checks.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`no check ${id}; have ${finding.checks.map((c) => c.id).join(", ")}`);
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// A support checker built the way the real one is: it asks the generator it is given.
// ---------------------------------------------------------------------------------------------

export function callRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    stage: "support",
    ruleKey: "dur-1",
    promptVersionId: "support.p1",
    requestSha256: "d".repeat(64),
    attempt: 1,
    outcome: "ok",
    latencyMs: 12,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    ...overrides,
  };
}

export type SupportScript = "supported" | "not_supported" | "insufficient" | "throws" | "abort";

/**
 * A checker that makes one generator call over the cited spans and records what it was given, and
 * the generator that answers it. `inputs` holds every call's input so a test can assert that the
 * checker saw only the cited spans.
 */
export function scriptedChecker(script: SupportScript) {
  const inputs: SupportCheckInput[] = [];
  const generator = createScriptedGenerator(() => ({
    verdict: script === "throws" || script === "abort" ? "supported" : script,
    missingPremise: script === "supported" ? null : "a premise",
  }));
  const checker: SupportChecker = async (input) => {
    inputs.push(input);
    if (script === "throws") throw new Error("the provider failed with some document text in it");
    if (script === "abort") {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    const answer = await input.generator.generate({
      system: "You check support.",
      prompt: input.citedSpans.map((s) => s.text).join("\n"),
      schema: SupportSchema,
    });
    return { answer, call: callRecord() };
  };
  return { checker, generator, inputs };
}
