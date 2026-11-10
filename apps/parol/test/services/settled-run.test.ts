import { afterAll, describe, expect, it } from "vitest";
import { findingContentSha256 } from "../../src/canonical.js";
import type { AnalysisAnswer } from "../../src/contracts.js";
import { bodyText, readMemo } from "../export/support.js";
import { cleanup, decideAll, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * The whole way, from a model that contradicts the playbook's flags to the Word file. The demo
 * playbook has seven required rules and one that is not (`ret-1`), so a model that answers
 * `missing` for `ret-1` and `not_applicable` for a required rule is settled both ways. The model
 * is a scripted oracle for an answer key with those two answers replaced: nothing here measures a
 * model.
 */

const NO_CLAUSE: Omit<AnalysisAnswer, "status"> = {
  evidence: [],
  discrepancy: "The documents hold no clause on this.",
  explanation: "No paragraph of the documents covers the subject of the rule.",
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};

const ANSWERS: Record<string, AnalysisAnswer> = {
  "ret-1": { ...NO_CLAUSE, status: "missing" },
  "pty-1": { ...NO_CLAUSE, status: "not_applicable" },
};

async function settledReview(workflowLabel: string) {
  const w = makeWorld({ model: { answers: ANSWERS } });
  const { matterId, am } = newMatter(w);
  await uploadCase(w, matterId);
  const run = w.services.runs.start(am, { workflowLabel });
  await w.services.runs.idle();
  const reviewerAm = w.grant(w.reviewer, matterId);
  return { w, matterId, am, reviewerAm, runId: run.id };
}

describe.each(["v1", "v2"])("workflow %s, a model that contradicts the flags", (label) => {
  it("is settled by the playbook, and the issue table says what the model stated", async () => {
    const { w, am, runId } = await settledReview(label);
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
    const rows = w.services.runs.issues(am, runId);
    const row = (key: string) => rows.find((r) => r.ruleKey === key)!;

    expect(row("ret-1")).toMatchObject({
      status: "not_applicable",
      modelStatus: "missing",
      settlementReason: "the rule is not required",
    });
    expect(row("pty-1")).toMatchObject({
      status: "missing",
      modelStatus: "not_applicable",
      settlementReason: "the rule is required",
    });
    // A finding nothing settled has no model status, and its row has none in JSON either.
    const others = rows.filter((r) => !["ret-1", "pty-1"].includes(r.ruleKey));
    expect(others.length).toBe(6);
    for (const other of others) {
      expect(other.modelStatus ?? null).toBeNull();
      expect(JSON.parse(JSON.stringify(other))).not.toHaveProperty("modelStatus");
      expect(JSON.parse(JSON.stringify(other))).not.toHaveProperty("settlementReason");
    }
  });

  it("keeps the model's status in the store, the trail and the audit event, and the hash covers it", async () => {
    const { w, matterId, am, runId } = await settledReview(label);
    const record = w.repo.listFindings(matterId, runId).find((f) => f.ruleKey === "ret-1")!;
    expect(record.status).toBe("not_applicable");
    expect(record.modelStatus).toBe("missing");
    expect(record.checks.find((c) => c.id === "status_settled")).toEqual({
      id: "status_settled",
      kind: "deterministic",
      outcome: "pass",
      detail:
        "the workflow stated missing and the playbook settles it to not_applicable: the rule is not required",
    });
    expect(findingContentSha256(record)).toBe(record.contentSha256);
    expect(findingContentSha256({ ...record, modelStatus: null })).not.toBe(record.contentSha256);

    const view = w.services.runs.finding(am, record.id);
    expect(view.issue.modelStatus).toBe("missing");
    expect(view.checks.map((c) => c.id)).toContain("status_settled");

    const saved = w.repo.listAuditEvents({ matterId, action: "finding.save" });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.detail).toMatchObject({ saved: 8, settled: 2 });
  });

  it("is judged as settled: the checks read the settled status and still test the model's claim of absence", async () => {
    const { w, matterId, runId } = await settledReview(label);
    const records = w.repo.listFindings(matterId, runId);
    const of = (key: string) => records.find((f) => f.ruleKey === key)!;

    // The model said missing for ret-1 and the rule is not required: the shape check reads the
    // settled not_applicable (over a selection, which a whole-document claim refuses), and the
    // hints of its category are still held against the model's claim that no clause exists.
    expect(of("ret-1").escalations.map((e) => [e.code, e.detail])).toEqual([
      [
        "support_not_confirmed",
        "status not_applicable needs the whole document in the bundle, and it was not",
      ],
      [
        "missing_not_confirmed",
        "keyword hints for return-destruction on D1-p21 and D1-p23 are in the bundle and are not cited",
      ],
    ]);
    // The model said not_applicable for the required pty-1: it is judged as the missing it settles to.
    expect(of("pty-1").escalations.map((e) => [e.code, e.detail])[0]).toEqual([
      "support_not_confirmed",
      "status missing needs the whole document in the bundle, and it was not",
    ]);
    expect(of("pty-1").escalations.map((e) => e.code)).toContain("missing_not_confirmed");
    // The settlement row itself is a record: it passed, and no flag is named for having settled.
    for (const key of ["ret-1", "pty-1"]) {
      expect(of(key).checks.find((c) => c.id === "status_settled")?.outcome).toBe("pass");
      for (const flag of of(key).escalations) expect(flag.detail).not.toMatch(/settle/);
    }
  });
});

describe("a settled finding, through to the memo", () => {
  it("is decided against its own hash, exported, and marked as settled in the Word file", async () => {
    const { w, am, reviewerAm, runId } = await settledReview("v2");
    const issues = w.services.runs.issues(reviewerAm, runId);
    const decided = decideAll(w, reviewerAm, issues);
    const settled = decided.find((v) => v.issue.ruleKey === "ret-1")!;
    expect(settled.issue.modelStatus).toBe("missing");
    expect(settled.reviews[0]?.decision).toBeDefined();

    const memo = await w.services.reviews.exportMemo(reviewerAm);
    const read = await readMemo((await w.services.reviews.memoFile(reviewerAm, memo.memoId)).bytes);
    const text = bodyText(read);
    expect(text).toContain(
      "Status settled by the playbook: the workflow stated Missing; the rule is not required.",
    );
    expect(text).toContain(
      "Status settled by the playbook: the workflow stated Not applicable; the rule is required.",
    );
    expect(text.split("Status settled by the playbook:")).toHaveLength(3);
    expect(am.matterId).toBe(reviewerAm.matterId);
  });
});
