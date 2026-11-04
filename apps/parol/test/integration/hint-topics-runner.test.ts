import { afterAll, describe, expect, it } from "vitest";
import type { AnalysisAnswer } from "../../src/contracts.js";
import { cleanup, makeWorld, newMatter, uploadCase } from "../services/support.js";
import { buildCaseWorld, keyAnswer, type CaseWorld } from "./pipeline.js";

afterAll(cleanup);

/**
 * Hint topics through the real runner. The stage tests hand a rule to retrieval and verification
 * directly, and the dataset test loads the playbook itself, so neither shows what the runner does
 * with a rule on its way from the store to the stages. It reads each rule from the store and
 * copies the fields the stages use; a field it does not copy is a field the stages never see, and
 * `hintTopics` is then absent, which means every topic of the category counts. That is the defect
 * hint topics exist to remove, and it comes back without a sound if the copy drops the field.
 */

const MISSING_PDS_2: AnalysisAnswer = {
  status: "missing",
  evidence: [],
  discrepancy: "",
  explanation: "No clause lets the recipient disclose what law requires.",
  fallbackLanguage:
    "The Receiving Party may disclose Confidential Information to the extent required by law.",
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};

async function review(world: CaseWorld, answers: Record<string, AnalysisAnswer> = {}) {
  const w = makeWorld({ model: { world, answers } });
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId, world);
  const run = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  const issues = w.services.runs.issues(am, run.id);
  return { w, issues, issue: (key: string) => issues.find((i) => i.ruleKey === key)! };
}

describe("the demo playbook's hint topics, through the runner", () => {
  it("stores the topics the stages are to read", async () => {
    const { w } = await review(await buildCaseWorld("PAROL-D03"));
    const rules = w.repo.listRules(w.playbookVersionId);
    expect(rules.find((r) => r.key === "pds-1")?.hintTopics).toEqual(["representatives"]);
    expect(rules.find((r) => r.key === "pds-2")?.hintTopics).toEqual(["legal-compulsion"]);
  });

  it("verifies `missing` for pds-2 when the NDA has no compelled-disclosure clause, without escalation", async () => {
    // PAROL-D03 has a representatives clause, the definition of Affiliate and the retention
    // clause's "copies required by law", and nothing about being compelled to disclose.
    const world = await buildCaseWorld("PAROL-D03");
    expect(world.key.expect["pds-2"]!.status).toBe("missing");
    const { issue } = await review(world);
    expect(issue("pds-2")).toMatchObject({
      status: "missing",
      verificationState: "verified",
      escalations: [],
    });
  });

  it("does the same for PAROL-D08, whose NDA also carries an instruction-like paragraph", async () => {
    const world = await buildCaseWorld("PAROL-D08");
    const { issue } = await review(world);
    expect(issue("pds-2")).toMatchObject({
      status: "missing",
      verificationState: "verified",
      escalations: [],
    });
  });

  it("still escalates `missing` for pds-2 when the NDA has a compelled-disclosure clause the analysis did not cite", async () => {
    // PAROL-D01 has one, so a model that calls pds-2 missing there is contradicted by the hint.
    const world = await buildCaseWorld("PAROL-D01");
    expect(world.key.expect["pds-2"]!.status).toBe("compliant");
    const { issue } = await review(world, { "pds-2": MISSING_PDS_2 });
    expect(issue("pds-2").status).toBe("missing");
    expect(issue("pds-2").verificationState).toBe("escalated_by_system");
    expect(issue("pds-2").escalations.map((e) => e.code)).toEqual(["missing_not_confirmed"]);
  });

  it("leaves every other rule as the key says", async () => {
    const world = await buildCaseWorld("PAROL-D03");
    const { issues } = await review(world);
    for (const issue of issues) {
      expect(issue.status, issue.ruleKey).toBe(world.key.expect[issue.ruleKey]!.status);
    }
    // Sanity: the key answers are the ones the model gave.
    expect(keyAnswer(world, "pds-2").status).toBe("missing");
  });
});
