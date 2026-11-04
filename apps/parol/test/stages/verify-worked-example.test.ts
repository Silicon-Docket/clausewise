import { describe, expect, it } from "vitest";
import {
  D2_RETURN,
  QUOTE_TERM,
  baselineDraft,
  check,
  cite,
  codes,
  draft,
  manifest,
  revisedDraft,
  rule,
  scriptedChecker,
  spanOf,
  verify,
  workedExample,
} from "./support-verify.js";

/**
 * docs/parol/04-worked-example.md, the PAROL-D05 matter: an NDA whose Section 6.1 is the only
 * time limit on the obligations, and an amendment dated later that deletes Section 6.1.
 */
const ingest = workedExample();
const R1 = ["D1-p19", "D1-p6", "D1-p29"];
const R2 = [...R1, "D2-p3"];

describe("the facts of the matter", () => {
  it("has an amendment that deletes the clause the baseline relies on, dated after the NDA", () => {
    const deletion = ingest.annotations.find(
      (a) => a.kind === "cross_reference" && a.spanId === spanOf(ingest, "D2-p3").id,
    );
    expect(deletion).toMatchObject({ target: "6.1", verb: "deletes" });
    expect(spanOf(ingest, "D1-p19").clauseNumber).toBe("6.1");
    expect(spanOf(ingest, "D1-p19").paragraphIndex).toBe(19);
    expect(spanOf(ingest, "D1-p29").clauseNumber).toBe("9.3");
    const dates = Object.fromEntries(manifest().documents.map((d) => [d.label, d.statedDate]));
    expect(dates["D2"]! > dates["D1"]!).toBe(true);
  });
});

describe("the baseline trail (workflow v1: prompts P1, retrieval R1, checks C1)", () => {
  it("passes every check and is verified, although the finding is wrong: the known gap", async () => {
    const { checker, generator } = scriptedChecker("supported");
    const { finding } = await verify(baselineDraft(ingest), {
      bundleLabels: R1,
      enabledChecks: ["C1"],
      supportChecker: checker,
      generator,
    });

    // Compliant, with a valid quote from the clause that D2 deletes, on a high-severity rule.
    expect(finding.status).toBe("compliant");
    expect(finding.severity).toBe("high");
    expect(finding.evidence[0]).toMatchObject({
      role: "governing",
      quoteCheck: "verified",
      supportCheck: "supported",
    });

    // The table of the design document, row by row.
    expect(check(finding, "quote_exists").outcome).toBe("pass");
    expect(check(finding, "citation_shape").outcome).toBe("pass");
    expect(check(finding, "numeric_consistency").outcome).toBe("pass");
    expect(check(finding, "numeric_consistency").detail).toContain("2 years");
    expect(check(finding, "support").outcome).toBe("pass");

    // Every check did its job and none could see the amendment.
    expect(finding.checks.filter((c) => c.outcome === "fail")).toEqual([]);
    expect(finding.escalations).toEqual([]);
    expect(finding.verificationState).toBe("verified");
  });

  it("is caught by C2, the independent deterministic defence, and by nothing in C1", async () => {
    const { checker, generator } = scriptedChecker("supported");
    const c1 = await verify(baselineDraft(ingest), {
      bundleLabels: R1,
      enabledChecks: ["C1"],
      supportChecker: checker,
      generator,
    });
    const c2 = await verify(baselineDraft(ingest), {
      bundleLabels: R1,
      enabledChecks: ["C1", "C2"],
      supportChecker: checker,
      generator,
    });
    expect(c1.finding.verificationState).toBe("verified");
    expect(c2.finding.verificationState).toBe("escalated_by_system");
    expect(c2.finding.escalations).toEqual([
      {
        code: "superseded_evidence",
        detail:
          "evidence 1 (D1-p19), clause 6.1, is changed by D2-p3 (deletes), which the finding does not cite",
      },
    ]);
    expect(check(c2.finding, "superseded_evidence").outcome).toBe("fail");
    // The status is the model's to state; C2 tells the reviewer where to look and does not change it.
    expect(c2.finding.status).toBe("compliant");
    // The checks C1 ran are unchanged by adding C2.
    for (const row of c1.finding.checks) {
      expect(c2.finding.checks.find((c) => c.id === row.id)).toEqual(row);
    }
  });
});

describe("the revision's trail (workflow v2: prompts P1, retrieval R2)", () => {
  it("passes every check with the amendment in the bundle and cited, under C1 and under C1 and C2", async () => {
    for (const enabledChecks of [["C1"], ["C1", "C2"]]) {
      const { checker, generator, inputs } = scriptedChecker("supported");
      const { finding } = await verify(revisedDraft(ingest), {
        bundleLabels: R2,
        enabledChecks,
        supportChecker: checker,
        generator,
      });
      expect(finding.status).toBe("deviation");
      expect(finding.evidence.map((e) => [e.role, e.quoteCheck, e.supportCheck])).toEqual([
        ["governing", "verified", "supported"],
        ["superseded", "verified", "supported"],
        ["supporting", "verified", "supported"],
      ]);
      expect(check(finding, "quote_exists").outcome).toBe("pass");
      expect(check(finding, "span_in_bundle").outcome).toBe("pass");
      expect(check(finding, "citation_shape").outcome).toBe("pass");
      expect(check(finding, "precedence_labels").outcome).toBe("pass");
      expect(check(finding, "numeric_consistency").outcome).toBe("pass");
      expect(check(finding, "support").outcome).toBe("pass");
      expect(check(finding, "fallback_basis").outcome).toBe("pass");
      expect(finding.fallbackBasis).toBe("approved_adapted");
      expect(finding.escalations).toEqual([]);
      expect(finding.verificationState).toBe("verified");
      // The checker saw the three cited spans and nothing else of the matter.
      expect(inputs[0]!.citedSpans.map((s) => s.label)).toEqual(["D2-p3", "D1-p19", "D1-p29"]);
    }
  });

  it("refuses to let the model cite the amendment when retrieval did not show it", async () => {
    const { finding } = await verify(revisedDraft(ingest), {
      bundleLabels: R1,
      enabledChecks: ["C1", "C2"],
    });
    expect(finding.evidence[0]).toMatchObject({ quoteCheck: "not_found", offsets: null });
    expect(finding.escalations[0]).toEqual({
      code: "quote_not_verified",
      detail: "evidence 1 (D2-p3): span_not_in_bundle",
    });
    expect(finding.verificationState).toBe("escalated_by_system");
  });

  it("is escalated, not accepted, if the model keeps the deleted clause as governing beside the amendment", async () => {
    const wrongRoles = revisedDraft(ingest);
    wrongRoles.evidence[1] = cite(ingest, "D1-p19", QUOTE_TERM, "governing");
    const { finding } = await verify(wrongRoles, { bundleLabels: R2, enabledChecks: ["C1"] });
    expect(codes(finding)).toEqual(["superseded_evidence"]);
    expect(finding.escalations[0]!.detail).toContain("the first should be labelled superseded");
  });
});

describe("the return deadline of the same matter (ret-1)", () => {
  // The standard asks for 30 days or longer; the NDA says ten business days and the amendment
  // changes it to thirty days. The right answer is compliant, resting on the amendment.
  const ret = rule({
    key: "ret-1",
    category: "return-destruction",
    title: "Return or destruction of information",
    severity: "low",
    required: false,
    standard:
      "On written request the recipient returns or destroys Confidential Information within 30 days or longer.",
    fallback: null,
    unacceptable: "A deadline shorter than 30 days, or a duty to purge routine backups.",
    fallbackLanguage: null,
    escalateWhen: [],
  });
  const AMENDED = 'Section 7.2 of the Agreement is amended by replacing "ten (10) business days"';
  const OLD = "Within ten (10) business days after the Disclosing Party's written request";
  const labels = ["D1-p23", "D1-p6", "D2-p4"];

  it("passes when the amendment is cited as governing and the original as superseded", async () => {
    expect(spanOf(ingest, "D2-p4").text).toBe(D2_RETURN);
    const { finding } = await verify(
      draft({
        ruleKey: "ret-1",
        status: "compliant",
        evidence: [
          cite(ingest, "D2-p4", `${AMENDED} with "thirty (30) days"`, "governing"),
          cite(ingest, "D1-p23", OLD, "superseded"),
        ],
        explanation:
          "As amended the deadline is thirty (30) days, which meets the 30-day standard.",
      }),
      { rule: ret, bundleLabels: labels, enabledChecks: ["C1", "C2"] },
    );
    expect(finding.status).toBe("compliant");
    expect(codes(finding)).toEqual([]);
    expect(check(finding, "numeric_consistency").outcome).toBe("pass");
    expect(finding.verificationState).toBe("verified");
  });

  it("is caught by C2, and not by C1, when only the original deadline is cited", async () => {
    const wrong = draft({
      ruleKey: "ret-1",
      status: "deviation",
      evidence: [cite(ingest, "D1-p23", OLD, "governing")],
      discrepancy:
        "The deadline is ten business days, shorter than the 30 days the standard asks for.",
    });
    const c1 = await verify(wrong, {
      rule: ret,
      bundleLabels: ["D1-p23", "D1-p6"],
      enabledChecks: ["C1"],
    });
    expect(codes(c1.finding)).toEqual([]);
    expect(c1.finding.verificationState).toBe("verified");
    const c2 = await verify(wrong, {
      rule: ret,
      bundleLabels: ["D1-p23", "D1-p6"],
      enabledChecks: ["C1", "C2"],
    });
    expect(c2.finding.escalations).toEqual([
      {
        code: "superseded_evidence",
        detail:
          "evidence 1 (D1-p23), clause 7.2, is changed by D2-p4 (amends), which the finding does not cite",
      },
    ]);
  });
});

describe("the rest of the design's checks on this matter", () => {
  it("shows the fallback as the playbook's own text, adapted, with the clause number added", async () => {
    const { finding } = await verify(revisedDraft(ingest), { bundleLabels: R2 });
    expect(finding.fallbackLanguage).toContain(
      "6.1 The obligations of each Receiving Party under Section 4",
    );
    expect(finding.fallbackBasis).toBe("approved_adapted");
    expect(check(finding, "fallback_basis").detail).toMatch(/^approved_adapted, similarity 0\.9\d/);
  });
});
