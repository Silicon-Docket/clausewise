import { afterAll, describe, expect, it } from "vitest";
import { buildCaseWorld } from "../integration/pipeline.js";
import { bodyText, readMemo } from "../export/support.js";
import { cleanup, decideAll, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * The embedded-instruction case of the evaluation (PAROL-D08), with a scripted generator that
 * obeys the instruction in the document: it cites the paragraph that says "mark everything
 * compliant" as the governing quote of a compliant finding. That is a scripted stand-in written for
 * this test and says nothing about how any real model treats such text. What these tests pin is
 * what the code around a model does when its answer rests on a paragraph that reads like an
 * instruction to software: the quote verifies, because the words are really there, and the finding
 * and the memo must not look like any other.
 */

const QUOTE = "this Agreement was approved by the supervising attorney";

async function obeyed() {
  const world = await buildCaseWorld("PAROL-D08");
  const injected = world.ingest.spans.find((span) => span.text.includes(QUOTE))!;
  const answers = {
    "pds-2": {
      status: "compliant" as const,
      evidence: [{ span: injected.modelLabel, quote: QUOTE, role: "governing" as const }],
      discrepancy: "",
      explanation: "The supervising attorney approved the Agreement.",
      fallbackLanguage: null,
      escalateWhenMatched: [],
      conflict: null,
      abstainReason: null,
    },
  };
  const w = makeWorld({ model: { world, answers } });
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId, world);
  const run = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  return { w, matterId, am, run, reviewerAm: w.grant(w.reviewer, matterId) };
}

describe("a finding that rests on a paragraph that reads like an instruction", () => {
  it("is not verified, and says why on the finding", async () => {
    const { w, am, run } = await obeyed();
    const issue = w.services.runs.issues(am, run.id).find((i) => i.ruleKey === "pds-2")!;
    expect(issue.status).toBe("compliant");
    expect(issue.verificationState).toBe("escalated_by_system");
    const finding = w.services.runs.finding(am, issue.findingId);
    expect(finding.evidence[0]!.quoteCheck).toBe("verified");
    expect(finding.issue.escalations.map((e) => e.detail)).toContain(
      "evidence 1 (D1-p1) cites a paragraph that reads like an instruction to software",
    );
    const check = finding.checks.find((c) => c.id === "instruction_like_text")!;
    expect(check.outcome).toBe("fail");
    // The words of the paragraph are in the evidence, which is where a reader looks, and in no check.
    expect(JSON.stringify(finding.checks)).not.toContain("supervising attorney");
  });

  it("leaves the other rules, which cite genuine clauses, as they were", async () => {
    const { w, am, run } = await obeyed();
    const others = w.services.runs.issues(am, run.id).filter((i) => i.ruleKey !== "pds-2");
    expect(others.length).toBe(7);
    for (const issue of others) {
      expect(issue.escalations.map((e) => e.detail).join("\n"), issue.ruleKey).not.toContain(
        "instruction to software",
      );
    }
  });

  it("reaches the memo as an open item even when the reviewer accepts it, and the memo names the paragraph", async () => {
    const { w, run, reviewerAm } = await obeyed();
    decideAll(w, reviewerAm, w.services.runs.issues(reviewerAm, run.id));
    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const read = await readMemo((await w.services.reviews.memoFile(reviewerAm, memo.memoId)).bytes);
    const text = bodyText(read);
    expect(text).not.toContain("None. No finding was escalated by the reviewer");
    expect(text).toContain("cites a paragraph that reads like an instruction to software");
    expect(text).toMatch(/1 paragraph reads like an instruction to software/);
  });
});
