import { beforeEach, describe, expect, it } from "vitest";
import { findingContentSha256, sha256Hex } from "../../src/canonical.js";
import type { VerifiedFinding } from "../../src/contracts.js";
import { ACTORS, addMatter, allFindings, buildSpans, fakePath, makeWorld, rehash, startRun, succeed, type World } from "./fixtures.js";

/**
 * The store holds document text where it has to (spans, quotes, run stage outputs, review reasons)
 * and nowhere else. These tests plant a marker in every kind of text a caller can supply, run the
 * whole workflow, and then look for the marker in the places that are never allowed to hold it: the
 * audit log, error messages, and the model call table.
 */

const MARK = "ZQ-SECRET-CLAUSE-9C1E";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const dumpTable = (table: string): string => JSON.stringify(w.db.prepare(`SELECT * FROM ${table}`).all());

describe("the audit log", () => {
  it("never receives text from a title, a client name, a quote, a reason, an edit or a comment", () => {
    const matter = w.repo.createMatter({ name: `Matter ${MARK}`, clientLegalName: `Client ${MARK}, Inc.`, createdBy: ACTORS.associate });
    const text = [`1. ${MARK} opening`, `2. The ${MARK} obligations continue for two (2) years.`];
    const { document, version } = w.repo.addDocument(
      matter.id,
      { kind: "nda", title: `Title ${MARK}`, version: { mediaType: "txt", fileSha256: sha256Hex("f"), textSha256: sha256Hex(text.join("\n")), byteSize: 10, statedDate: "2026-01-01", storagePath: fakePath(matter.id), operative: true } },
      { actorId: ACTORS.associate },
    );
    w.repo.insertSpans(matter.id, buildSpans(version.id, document.label, text));
    w.repo.setPlaybookVersion(matter.id, w.playbook.id, { actorId: ACTORS.associate });
    w.repo.updateClientName(matter.id, `Renamed ${MARK}, Inc.`, { actorId: ACTORS.associate });

    const manifest = w.repo.buildRunManifest(matter.id, { workflowVersionId: w.workflow.id, modelProvider: "scripted", model: "m" });
    const run = w.repo.createRun(matter.id, { manifest, startedBy: ACTORS.associate });
    for (const status of ["ingesting", "extracting", "retrieving", "analyzing"] as const) w.repo.updateRunStatus(matter.id, run.id, status);
    w.repo.recordStageStart(matter.id, run.id, { stage: "extract", inputSha256: sha256Hex("in") });
    w.repo.recordStageResult(matter.id, run.id, { stage: "extract", attempt: 1, status: "succeeded", output: { quote: MARK } });

    const spanId = `${version.id}:p1`;
    const quote = `The ${MARK} obligations`;
    const finding: VerifiedFinding = rehash({
      ...allFindingsFor(spanId, quote),
      explanation: `Because of ${MARK}.`,
      discrepancy: `${MARK} differs.`,
      status: "deviation",
    });
    const [saved] = w.repo.saveFindings(matter.id, run.id, [finding]);
    expect(findingContentSha256(saved as VerifiedFinding)).toBe(finding.contentSha256);
    // The playbook has three rules; complete the run so it can be reviewed.
    const others = w.repo.listRules(w.playbook.id).filter((r) => r.key !== "dur-1");
    w.repo.saveFindings(matter.id, run.id, others.map((r) => rehash({ ...allFindingsFor(spanId, quote, r.key, r.category, r.severity), explanation: "ok" })));
    succeed(w, { id: matter.id, nda: { documentId: document.id, versionId: version.id, spanIds: [spanId], texts: text } }, w.repo.getRun(matter.id, run.id) as never);

    const review = w.repo.recordReview(matter.id, (saved as { id: string }).id, {
      reviewerId: ACTORS.reviewer,
      decision: "edit",
      reason: `Reason mentioning ${MARK}`,
      edits: { discrepancy: `Edited ${MARK}`, fallbackLanguage: `Fallback ${MARK}` },
      findingContentSha256: (saved as { contentSha256: string }).contentSha256,
    });
    expect(review.reason).toContain(MARK);
    w.repo.addFeedback(matter.id, { userId: ACTORS.reviewer, kind: "missed_issue", text: `Missed ${MARK}` });
    w.repo.insertModelCalls(matter.id, run.id, [
      { stage: "analyze", ruleKey: "dur-1", promptVersionId: "analyze.p1", requestSha256: sha256Hex("r"), attempt: 1, outcome: "ok", latencyMs: 3, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, prompt: MARK, response: MARK } as never,
    ]);
    w.repo.applyInputChange(matter.id, { reason: "document_changed", actorId: ACTORS.associate });
    w.repo.deleteMatter(matter.id, { actorId: ACTORS.associate });

    // The marker did get into the places that are meant to hold it, so a clean result below means something.
    expect(dumpTable("audit_events")).not.toContain(MARK);
    expect(dumpTable("model_calls")).not.toContain(MARK);
    expect(w.repo.listAuditEvents({ matterId: matter.id }).length).toBeGreaterThan(15);
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("has the marker in the tables that are meant to hold it (so the scan above can fail)", () => {
    const matter = addMatter(w);
    const run = startRun(w, matter);
    w.repo.recordStageStart(matter.id, run.id, { stage: "extract", inputSha256: sha256Hex("in") });
    w.repo.recordStageResult(matter.id, run.id, { stage: "extract", attempt: 1, status: "succeeded", output: { quote: MARK } });
    w.repo.addFeedback(matter.id, { userId: ACTORS.reviewer, kind: "comment", text: MARK });
    expect(dumpTable("run_stages")).toContain(MARK);
    expect(dumpTable("feedback")).toContain(MARK);
  });
});

function allFindingsFor(spanId: string, quote: string, ruleKey = "dur-1", category = "duration", severity = "high"): VerifiedFinding {
  return {
    ruleKey,
    category: category as never,
    severity: severity as never,
    status: "compliant",
    evidence: [{ spanId, quote, role: "governing", quoteCheck: "verified", offsets: { start: 0, end: 5 }, supportCheck: "supported" }],
    discrepancy: "",
    explanation: "",
    fallbackLanguage: null,
    fallbackBasis: "none",
    conflict: null,
    abstainReason: null,
    checks: [{ id: "quote_exists", kind: "deterministic", outcome: "pass", detail: "1 of 1" }],
    escalations: [],
    verificationState: "verified",
    contentSha256: "0".repeat(64),
  };
}

describe("error messages", () => {
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("never quote what the caller gave them", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const f = allFindings(m)[1] as VerifiedFinding;
    const attempts: (() => unknown)[] = [
      () => w.repo.createMatter({ name: `${MARK}\u0000`, clientLegalName: "c", createdBy: ACTORS.associate }),
      () => w.repo.createMatter({ name: "n", clientLegalName: `x\n${MARK}`, createdBy: ACTORS.associate }),
      () => w.repo.createMatter({ name: "n", clientLegalName: "c".repeat(300) + MARK, createdBy: ACTORS.associate }),
      () => w.repo.updateClientName(m.id, `${MARK}\u0007`, { actorId: ACTORS.associate }),
      () => w.repo.setStatedDate(m.id, m.nda.versionId, MARK, { actorId: ACTORS.associate }),
      () => w.repo.addDocument(m.id, { kind: "nda", title: MARK, version: { mediaType: "txt", fileSha256: MARK, textSha256: sha256Hex("t"), byteSize: 1, statedDate: null, storagePath: fakePath(m.id) } }, { actorId: ACTORS.associate }),
      () => w.repo.addDocument(m.id, { kind: MARK as never, title: "t", version: { mediaType: "txt", fileSha256: sha256Hex("f"), textSha256: sha256Hex("t"), byteSize: 1, statedDate: null, storagePath: fakePath(m.id) } }, { actorId: ACTORS.associate }),
      () => w.repo.addDocument(m.id, { kind: "amendment", title: "t", version: { mediaType: "txt", fileSha256: sha256Hex("f2"), textSha256: sha256Hex("t"), byteSize: 1, statedDate: null, storagePath: `${m.id}/ ${MARK}` } }, { actorId: ACTORS.associate }),
      () => w.repo.insertSpans(m.id, buildSpans(m.nda.versionId, "D1", [MARK]).map((s) => ({ ...s, textSha256: sha256Hex("different") }))),
      () => w.repo.insertSpans(m.id, buildSpans(m.nda.versionId, "D1", [MARK]).map((s) => ({ ...s, paragraphIndex: -1, id: MARK }))),
      () => w.repo.insertSpans(m.id, [], [{ kind: "uses_term", spanId: MARK, term: MARK }]),
      () => w.repo.saveFindings(m.id, run.id, [{ ...f, quoteCheck: MARK, explanation: `${MARK} changed` } as never]),
      () => w.repo.saveFindings(m.id, run.id, [{ ...f, explanation: `${MARK} changed` }]),
      () => w.repo.saveFindings(m.id, run.id, [rehash({ ...f, evidence: [{ ...(f.evidence[0] as object), quote: MARK, offsets: { start: 0, end: 99999 } }] as never })]),
      () => w.repo.saveFindings(m.id, run.id, [rehash({ ...f, ruleKey: MARK })]),
      () => w.repo.saveFindings(m.id, run.id, [rehash({ ...f, escalations: [{ code: MARK as never, detail: MARK }] })]),
      () => w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: MARK as never }),
      () => w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "x".repeat(5000) + MARK }),
      () => w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "ok", reasonCode: MARK }),
      () => w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: MARK }),
      () => w.repo.recordStageStart(m.id, run.id, { stage: MARK, inputSha256: sha256Hex("x") }),
      () => w.repo.applyInputChange(m.id, { reason: MARK, actorId: null }),
      () => w.repo.appendAudit({ actorId: null, matterId: m.id, action: "a.b", targetType: "x", targetId: "id", detail: { quote: MARK.repeat(30) } }),
      () => w.repo.appendAudit({ actorId: null, matterId: m.id, action: "a.b", targetType: "x", targetId: MARK + " words" }),
      () => w.repo.importPlaybookDraft({ slug: MARK, version: "1", yaml: "x", sha256: sha256Hex("x"), rules: [] }, { actorId: ACTORS.legalEngineer }),
      () => w.repo.importPlaybookDraft({ slug: "ok", version: "1", yaml: MARK, sha256: sha256Hex("other"), rules: [] }, { actorId: ACTORS.legalEngineer }),
      () => w.repo.upsertPromptVersion({ id: MARK, stage: "analyze", template: MARK, schemaJson: "{}", sha256: sha256Hex("p") }),
      () => w.repo.promoteWorkflowVersion(w.workflow.id, { actorId: ACTORS.admin, promotionRecord: `a\n${MARK}` }),
      () => w.repo.createRun(m.id, { manifest: { matterId: MARK } as never, startedBy: ACTORS.associate }),
    ];
    const messages = attempts.map(messageOf);
    expect(messages.every((message) => message.length > 0), JSON.stringify(messages.map((x) => x.length))).toBe(true);
    for (const message of messages) expect(message).not.toContain(MARK);
  });
});
