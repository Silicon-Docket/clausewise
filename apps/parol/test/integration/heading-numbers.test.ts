import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import type { AnalysisAnswer, RunManifest } from "../../src/contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { runAnalyze } from "../../src/stages/analyze.js";
import { runExtract } from "../../src/stages/extract.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import { verifyFinding } from "../../src/stages/verify.js";
import { loadDemoPlaybook } from "./pipeline.js";

/**
 * Retrieval and verification must read an amendment's target the same way. Many NDAs number a
 * section in its heading and leave the paragraph under it unnumbered ("2. TERM" over "The
 * obligations ... continue for two (2) years ..."). An amendment that deletes "Section 2" changes
 * that paragraph. Retrieval (R2) shows the model the amendment for it; the check that the model
 * took the amendment into account must therefore know the paragraph is Section 2, or the amendment
 * is shown and its being ignored goes unnoticed.
 */

const NDA = `MUTUAL NONDISCLOSURE AGREEMENT

This Mutual Nondisclosure Agreement (the "Agreement") is made on 2 February 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC.

1. DEFINITIONS

"Confidential Information" means non-public information disclosed by a Party.

2. TERM

The obligations of each Receiving Party shall continue for two (2) years from the date of each disclosure of Confidential Information.

3. GENERAL

This Agreement is governed by the laws of the State of Delaware.
`;

const AMENDMENT = `AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT

This Amendment No. 1 amends the Mutual Nondisclosure Agreement dated 2 February 2026 (the "Agreement").

1. Section 2 of the Agreement is deleted in its entirety.
`;

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const TERM = "shall continue for two (2) years from the date of each disclosure";
const DELETION = "Section 2 of the Agreement is deleted in its entirety";

const playbook = loadDemoPlaybook();
const dates = ["2026-02-02", "2026-09-15"];
const documents = await Promise.all(
  [NDA, AMENDMENT].map(async (text, index) => {
    const parsed = await parseDocument({ bytes: enc(text), mediaType: "txt" });
    return {
      documentVersionId: `dv_d${index + 1}`,
      label: index === 0 ? ("D1" as const) : ("D2" as const),
      kind: index === 0 ? ("nda" as const) : ("amendment" as const),
      title: index === 0 ? "Mutual NDA" : "Amendment No. 1",
      versionNo: 1,
      statedDate: dates[index]!,
      paragraphs: parsed.paragraphs,
      inspection: null,
    };
  }),
);
const ingest = buildIngest({ documents });
const manifest: RunManifest = {
  matterId: "mat_headings",
  clientLegalName: "Lanternfish Software, Inc.",
  documents: documents.map((d) => ({
    documentVersionId: d.documentVersionId,
    label: d.label,
    kind: d.kind,
    title: d.title,
    versionNo: 1,
    statedDate: d.statedDate,
    textSha256: documentTextSha256(d.paragraphs),
  })),
  playbook: {
    versionId: "pbv",
    slug: playbook.slug,
    version: playbook.version,
    sha256: playbook.sha256,
  },
  workflow: { versionId: "wfv", label: "v2", sha256: sha256Hex("v2") },
  model: { provider: "scripted", model: "scripted" },
};
const span = (start: string) => ingest.spans.find((s) => s.text.startsWith(start))!;
const body = span("The obligations of each");
const deletion = span("1. Section 2 of the Agreement");

async function run(
  answer: Omit<AnalysisAnswer, "escalateWhenMatched" | "conflict" | "abstainReason">,
) {
  const generator = createScriptedGenerator((request) =>
    request.schemaName === "locate_passages"
      ? {
          categories: [
            {
              category: "duration",
              passages: [{ span: body.modelLabel, quote: TERM }],
              notFoundReason: null,
            },
          ],
        }
      : { ...answer, escalateWhenMatched: [], conflict: null, abstainReason: null },
  );
  const extract = await runExtract({
    generator,
    ingest,
    manifest,
    prompt: getPrompt("extract.p1"),
  });
  const bundle = buildBundles({
    ingest,
    extract: extract.output,
    rules: playbook.rules,
    policy: "R2",
    budgetTokens: 12000,
  }).find((b) => b.ruleKey === "dur-1")!;
  const analysed = await runAnalyze({
    generator,
    bundle,
    ingest,
    manifest,
    prompt: getPrompt("analyze.p1"),
    repairAttempts: 0,
  });
  if (!analysed.ok) throw new Error(analysed.detail);
  const verified = (checks: string[]) =>
    verifyFinding({
      draft: analysed.draft,
      bundle,
      rule: bundle.rule,
      ingest,
      manifest,
      enabledChecks: checks,
    });
  return { bundle, c1: await verified(["C1"]), c2: await verified(["C1", "C2"]) };
}

describe("an NDA that numbers its sections in headings", () => {
  it("reads the paragraph under '2. TERM' as unnumbered, with the number in its heading", () => {
    expect(body.clauseNumber).toBeNull();
    expect(body.heading).toBe("2. TERM");
    expect(
      ingest.annotations.filter((a) => a.kind === "cross_reference" && a.spanId === deletion.id),
    ).toEqual([{ kind: "cross_reference", spanId: deletion.id, target: "2", verb: "deletes" }]);
  });

  it("shows the model the deleting amendment under R2", async () => {
    const { bundle } = await run({
      status: "compliant",
      evidence: [{ span: body.modelLabel, quote: TERM, role: "governing" }],
      discrepancy: "",
      explanation: "The term is stated.",
      fallbackLanguage: null,
    });
    expect(bundle.spans.find((s) => s.spanId === deletion.id)?.why).toBe("cross_reference");
  });

  it("escalates a finding that ignores the amendment it was shown, under C2", async () => {
    const { c1, c2 } = await run({
      status: "compliant",
      evidence: [{ span: body.modelLabel, quote: TERM, role: "governing" }],
      discrepancy: "",
      explanation: "The term is stated.",
      fallbackLanguage: null,
    });
    expect(c1.finding.verificationState).toBe("verified");
    expect(c2.finding.verificationState).toBe("escalated_by_system");
    expect(c2.finding.escalations).toEqual([
      {
        code: "superseded_evidence",
        detail:
          "evidence 1 (D1-p5), clause 2, is changed by D2-p2 (deletes), which the finding does not cite",
      },
    ]);
  });

  it("accepts a finding that cites the amendment as governing and the paragraph as superseded", async () => {
    const answer = {
      status: "deviation" as const,
      evidence: [
        { span: deletion.modelLabel, quote: DELETION, role: "governing" as const },
        { span: body.modelLabel, quote: TERM, role: "superseded" as const },
      ],
      discrepancy: "Amendment No. 1 deletes Section 2, the only time limit on the obligations.",
      explanation: "The term no longer applies.",
      fallbackLanguage: null,
    };
    const { c1, c2 } = await run(answer);
    for (const result of [c1, c2]) {
      expect(result.finding.escalations).toEqual([]);
      expect(result.finding.verificationState).toBe("verified");
      expect(result.finding.checks.find((c) => c.id === "precedence_labels")?.outcome).toBe("pass");
    }
  });

  it("flags a paragraph labelled superseded when no cited amendment changes its section", async () => {
    const { c1 } = await run({
      status: "compliant",
      evidence: [{ span: body.modelLabel, quote: TERM, role: "superseded" }],
      discrepancy: "",
      explanation: "The term is stated.",
      fallbackLanguage: null,
    });
    expect(c1.finding.escalations.map((e) => e.code)).toContain("superseded_evidence");
    expect(
      c1.finding.escalations.some((e) =>
        e.detail.includes("no cited amendment span amends, replaces or deletes clause 2"),
      ),
    ).toBe(true);
  });
});
