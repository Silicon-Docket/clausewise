import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { NotFoundError, ValidationError, type NewVersionInput } from "../../src/store/index.js";
import {
  ACTORS,
  addMatter,
  allFindings,
  buildSpans,
  exported,
  fakePath,
  makeWorld,
  startRun,
  type World,
} from "./fixtures.js";

/**
 * Matter scoping is the security property of the data layer: an id that belongs to another matter
 * must behave exactly like an id that does not exist. Two complete matters, A and B, are built; every
 * method is then called as A with B's ids and must answer as it would for an id that is nowhere.
 */

let w: World;
let a: Ent;
let b: Ent;

interface Ent {
  id: string;
  ndaDoc: string;
  amendDoc: string;
  ndaVersion: string;
  amendVersion: string;
  spans: string[];
  runId: string;
  findings: { id: string; ruleKey: string; hash: string; evidenceId: string }[];
  reviews: string[];
  memoId: string;
  feedbackId: string;
  fileSha: string;
  textSha: string;
  /** A text hash that only this matter has. */
  onlyTextSha: string;
  manifest: unknown;
  texts: string[];
}

function entity(world: World): Ent {
  const { repo } = world;
  // Stages and model calls are written while the run is in flight, before it is finished.
  const e = exported(world, { amendment: true }, (run, fixture) => {
    repo.recordStageStart(fixture.id, run.id, {
      stage: "extract",
      inputSha256: sha256Hex("extract-in"),
    });
    repo.recordStageResult(fixture.id, run.id, {
      stage: "extract",
      attempt: 1,
      status: "succeeded",
      output: { located: ["x"] },
    });
    repo.insertModelCalls(fixture.id, run.id, [
      {
        stage: "extract",
        ruleKey: null,
        promptVersionId: "extract.p1",
        requestSha256: sha256Hex("req"),
        attempt: 1,
        outcome: "ok",
        latencyMs: 5,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
  });
  const m = e.m;
  const amendment = m.amendment as NonNullable<typeof m.amendment>;
  const feedback = repo.addFeedback(m.id, {
    userId: ACTORS.reviewer,
    kind: "finding_reason",
    runId: e.run.id,
    findingId: e.findings[0]?.id as string,
    reasonCode: "unclear",
  });
  const version = repo.getVersion(m.id, m.nda.versionId);
  // The two matters hold the same synthetic NDA text, so each also gets a non-operative version whose
  // text hash is its own, written around addVersion so as not to disturb the operative flag.
  const onlyTextSha = sha256Hex(`only-in-${m.id}`);
  world.db
    .prepare(
      `INSERT INTO document_versions
         (id, document_id, matter_id, version_no, media_type, file_sha256, text_sha256, byte_size, stated_date, operative, storage_path, uploaded_by, uploaded_at)
       VALUES (?, ?, ?, 2, 'txt', ?, ?, 1, NULL, 0, ?, ?, 't')`,
    )
    .run(
      `ver_only_${m.id.slice(4)}`,
      m.nda.documentId,
      m.id,
      sha256Hex(`only-file-${m.id}`),
      onlyTextSha,
      fakePath(m.id),
      ACTORS.associate,
    );
  return {
    id: m.id,
    ndaDoc: m.nda.documentId,
    amendDoc: amendment.documentId,
    ndaVersion: m.nda.versionId,
    amendVersion: amendment.versionId,
    spans: [...m.nda.spanIds, ...amendment.spanIds],
    runId: e.run.id,
    findings: e.findings.map((f) => ({
      id: f.id,
      ruleKey: f.ruleKey,
      hash: f.contentSha256,
      evidenceId: f.evidence[0]?.id as string,
    })),
    reviews: e.reviews.map((r) => r.id),
    memoId: e.memo.id,
    feedbackId: feedback.id,
    fileSha: version?.fileSha256 as string,
    textSha: version?.textSha256 as string,
    onlyTextSha,
    manifest: e.run.manifest,
    texts: m.nda.texts,
  };
}

beforeEach(() => {
  w = makeWorld();
  a = entity(w);
  b = entity(w);
});

const missing = {
  document: "doc_ffffffffffffffff",
  version: "ver_ffffffffffffffff",
  span: "ver_ffffffffffffffff:p0",
  run: "run_ffffffffffffffff",
  finding: "fnd_ffffffffffffffff",
  review: "rev_ffffffffffffffff",
  memo: "memo_ffffffffffffffff",
  evidence: "evd_ffffffffffffffff",
};

/** Throws NotFoundError for the foreign id, and the same one, word for word, for an id that exists nowhere. */
function behavesAsMissing(call: (id: string) => unknown, foreign: string, nowhere: string): void {
  const outcome = (id: string): NotFoundError => {
    try {
      call(id);
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundError);
      return error as NotFoundError;
    }
    throw new Error("expected NotFoundError");
  };
  const one = outcome(foreign);
  const two = outcome(nowhere);
  expect(one.entity).toBe(two.entity);
  expect(one.message.replace(foreign, "<id>")).toBe(two.message.replace(nowhere, "<id>"));
}

const newVersion = (matterId: string): NewVersionInput => ({
  mediaType: "txt",
  fileSha256: sha256Hex(`probe-file-${matterId}`),
  textSha256: sha256Hex(`probe-text-${matterId}`),
  byteSize: 1,
  statedDate: null,
  storagePath: fakePath(matterId),
});

/** Everything the database holds about one matter, as text, to prove a call did not touch it. */
function snapshot(matterId: string): string {
  const rows = (sql: string) => JSON.stringify(w.db.prepare(sql).all(matterId));
  return [
    rows("SELECT * FROM matters WHERE id = ?"),
    rows("SELECT * FROM matter_members WHERE matter_id = ? ORDER BY user_id"),
    rows("SELECT * FROM documents WHERE matter_id = ? ORDER BY id"),
    rows("SELECT * FROM document_versions WHERE matter_id = ? ORDER BY id"),
    rows("SELECT * FROM source_spans WHERE matter_id = ? ORDER BY id"),
    rows(
      "SELECT a.* FROM span_annotations a JOIN source_spans s ON s.id = a.span_id WHERE s.matter_id = ? ORDER BY a.rowid",
    ),
    rows("SELECT * FROM runs WHERE matter_id = ? ORDER BY id"),
    rows(
      "SELECT s.* FROM run_stages s JOIN runs r ON r.id = s.run_id WHERE r.matter_id = ? ORDER BY s.rowid",
    ),
    rows(
      "SELECT c.* FROM model_calls c JOIN runs r ON r.id = c.run_id WHERE r.matter_id = ? ORDER BY c.id",
    ),
    rows("SELECT * FROM findings WHERE matter_id = ? ORDER BY id"),
    rows(
      "SELECT e.* FROM finding_evidence e JOIN findings f ON f.id = e.finding_id WHERE f.matter_id = ? ORDER BY e.id",
    ),
    rows(
      "SELECT v.* FROM verification_results v JOIN findings f ON f.id = v.finding_id WHERE f.matter_id = ? ORDER BY v.finding_id, v.check_id",
    ),
    rows("SELECT * FROM reviews WHERE matter_id = ? ORDER BY id"),
    rows("SELECT * FROM memos WHERE matter_id = ? ORDER BY id"),
    rows("SELECT * FROM feedback WHERE matter_id = ? ORDER BY id"),
  ].join("\n");
}

/** Methods that touch no matter data, or that are keyed by something other than a matter. */
const NOT_MATTER_DATA = [
  "seedDemoUsers",
  "getUser",
  "listUsers",
  "createMatter",
  "listMattersForUser",
  "listExpiredMatters",
  "listMatterIds",
  "markInterruptedOnBoot",
  "importPlaybookDraft",
  "approvePlaybookVersion",
  "getPlaybookVersion",
  "findPlaybookVersion",
  "listPlaybookVersions",
  "listRules",
  "getRuleByKey",
  "upsertPromptVersion",
  "getPromptVersion",
  "listPromptVersions",
  "upsertWorkflowVersion",
  "getWorkflowVersion",
  "getWorkflowVersionByLabel",
  "listWorkflowVersions",
  "promoteWorkflowVersion",
  "createEvalDataset",
  "getEvalDataset",
  "listEvalDatasets",
  "createEvalRun",
  "finishEvalRun",
  "getEvalRun",
  "listEvalRuns",
  "listEvalSlotResults",
  "appendAudit",
  "listAuditEvents",
  "verifyAuditChain",
  "transaction",
  "compact",
  "db",
];

const probes: Record<string, () => void> = {
  // --- documents and versions ---
  getDocument: () => {
    expect(w.repo.getDocument(a.id, b.ndaDoc)).toBeUndefined();
    expect(w.repo.getDocument(b.id, b.ndaDoc)?.id).toBe(b.ndaDoc);
  },
  listDocuments: () => {
    expect(
      w.repo
        .listDocuments(a.id)
        .map((d) => d.id)
        .sort(),
    ).toEqual([a.ndaDoc, a.amendDoc].sort());
  },
  getVersion: () => {
    expect(w.repo.getVersion(a.id, b.ndaVersion)).toBeUndefined();
    expect(w.repo.getVersion(b.id, b.ndaVersion)?.id).toBe(b.ndaVersion);
  },
  listVersions: () => {
    expect(w.repo.listVersions(a.id, b.ndaDoc)).toEqual([]);
    expect(w.repo.listVersions(b.id, b.ndaDoc)).toHaveLength(2);
    expect(w.repo.listVersions(a.id).every((v) => v.matterId === a.id)).toBe(true);
  },
  listOperativeDocuments: () => {
    expect(w.repo.listOperativeDocuments(a.id).map((o) => o.version.id)).toEqual([
      a.ndaVersion,
      a.amendVersion,
    ]);
  },
  findVersionByFileSha256: () => {
    expect(w.repo.findVersionByFileSha256(a.id, b.fileSha)).toBeUndefined();
    expect(w.repo.findVersionByFileSha256(b.id, b.fileSha)?.id).toBe(b.ndaVersion);
  },
  findVersionByTextSha256: () => {
    expect(w.repo.findVersionByTextSha256(a.id, b.onlyTextSha)).toBeUndefined();
    expect(w.repo.findVersionByTextSha256(b.id, b.onlyTextSha)?.matterId).toBe(b.id);
    // The same text in both matters is found in each, and each finds its own.
    expect(w.repo.findVersionByTextSha256(a.id, b.textSha)?.matterId).toBe(a.id);
    expect(w.repo.findVersionByTextSha256(b.id, a.textSha)?.matterId).toBe(b.id);
  },
  addDocument: () => {
    // No parameter names another matter's row; it writes only into the matter it is given.
    const before = snapshot(b.id);
    expect(() =>
      w.repo.addDocument(
        a.id,
        { kind: "nda", title: "x", version: newVersion(b.id) },
        { actorId: ACTORS.associate },
      ),
    ).toThrow(ValidationError);
    expect(snapshot(b.id)).toBe(before);
  },
  addVersion: () => {
    const before = snapshot(b.id);
    behavesAsMissing(
      (id) => w.repo.addVersion(a.id, id, newVersion(a.id), { actorId: ACTORS.associate }),
      b.ndaDoc,
      missing.document,
    );
    expect(snapshot(b.id)).toBe(before);
    expect(w.repo.listVersions(b.id, b.ndaDoc)).toHaveLength(2);
  },
  removeDocument: () => {
    behavesAsMissing(
      (id) => w.repo.removeDocument(a.id, id, { actorId: ACTORS.associate }),
      b.ndaDoc,
      missing.document,
    );
    expect(w.repo.getDocument(b.id, b.ndaDoc)).toBeDefined();
  },
  setOperativeVersion: () => {
    behavesAsMissing(
      (id) => w.repo.setOperativeVersion(a.id, id, { actorId: ACTORS.associate }),
      b.ndaVersion,
      missing.version,
    );
  },
  setStatedDate: () => {
    behavesAsMissing(
      (id) => w.repo.setStatedDate(a.id, id, "2030-01-01", { actorId: ACTORS.associate }),
      b.ndaVersion,
      missing.version,
    );
    expect(w.repo.getVersion(b.id, b.ndaVersion)?.statedDate).toBe("2026-01-15");
  },
  // --- spans ---
  getSpan: () => {
    expect(w.repo.getSpan(a.id, b.spans[2] as string)).toBeUndefined();
    expect(w.repo.getSpan(b.id, b.spans[2] as string)?.text).toContain("two (2) years");
  },
  listSpans: () => {
    expect(w.repo.listSpans(a.id, [b.ndaVersion, b.amendVersion])).toEqual([]);
    expect(
      w.repo.listSpans(a.id, [a.ndaVersion, b.ndaVersion]).every((s) => s.matterId === a.id),
    ).toBe(true);
    expect(w.repo.listSpans(b.id, [b.ndaVersion])).toHaveLength(4);
  },
  listAnnotations: () => {
    expect(w.repo.listAnnotations(a.id, [b.ndaVersion, b.amendVersion])).toEqual([]);
    expect(w.repo.listAnnotations(b.id, [b.amendVersion])).toHaveLength(1);
  },
  hasSpans: () => {
    expect(w.repo.hasSpans(a.id, b.ndaVersion)).toBe(false);
    expect(w.repo.hasSpans(b.id, b.ndaVersion)).toBe(true);
  },
  insertSpans: () => {
    behavesAsMissing(
      (id) => w.repo.insertSpans(a.id, buildSpans(id, "D1", b.texts)),
      b.ndaVersion,
      missing.version,
    );
  },
  replaceIngestWarnings: () => {
    // A foreign version behaves as one that is nowhere, and a warning never lands in another matter.
    behavesAsMissing(
      (id) =>
        w.repo.replaceIngestWarnings(a.id, id, [{ code: "unreviewed_content", detail: "counts" }]),
      b.ndaVersion,
      missing.version,
    );
    expect(w.repo.listIngestWarnings(b.id)).toEqual([]);
  },
  listIngestWarnings: () => {
    w.repo.replaceIngestWarnings(b.id, b.ndaVersion, [
      { code: "unreviewed_content", detail: "not reviewed: comments=1" },
    ]);
    expect(w.repo.listIngestWarnings(a.id)).toEqual([]);
    expect(w.repo.listIngestWarnings(a.id, [b.ndaVersion])).toEqual([]);
    expect(w.repo.listIngestWarnings(b.id).every((x) => x.matterId === b.id)).toBe(true);
  },
  replaceAnnotations: () => {
    // Another matter's span cannot be named, and the other matter's annotations are not replaced.
    const before = snapshot(b.id);
    behavesAsMissing(
      (id) =>
        w.repo.replaceAnnotations(
          a.id,
          [a.ndaVersion, b.ndaVersion],
          [{ kind: "keyword_hint", spanId: id, category: "duration" }],
        ),
      b.spans[0] as string,
      missing.span,
    );
    w.repo.replaceAnnotations(a.id, [b.ndaVersion, b.amendVersion], []);
    expect(snapshot(b.id)).toBe(before);
  },
  // --- matters, members, inputs ---
  getMatter: () => {
    // Keyed by the matter itself; whether the caller may see it is the authorization layer's question.
    expect(w.repo.getMatter(a.id)?.id).toBe(a.id);
    expect(w.repo.getMatter("mat_ffffffffffffffff")).toBeUndefined();
  },
  listMembers: () => {
    expect(w.repo.listMembers(a.id).every((m) => m.matterId === a.id)).toBe(true);
  },
  getMember: () => {
    expect(w.repo.getMember(a.id, ACTORS.associate)?.matterId).toBe(a.id);
    expect(w.repo.getMember("mat_ffffffffffffffff", ACTORS.associate)).toBeUndefined();
  },
  addMember: () => {
    w.repo.addMember(a.id, ACTORS.admin, "viewer", { actorId: ACTORS.associate });
    expect(w.repo.getMember(b.id, ACTORS.admin)).toBeUndefined();
  },
  updateClientName: () => {
    const before = snapshot(b.id);
    w.repo.updateClientName(a.id, "Renamed Client, Inc.", { actorId: ACTORS.associate });
    expect(snapshot(b.id)).toBe(before);
  },
  setPlaybookVersion: () => {
    expect(() =>
      w.repo.setPlaybookVersion(a.id, "pbv_ffffffffffffffff", { actorId: ACTORS.associate }),
    ).toThrow(NotFoundError);
  },
  setMatterStatus: () => {
    const before = snapshot(b.id);
    // Only A's id is ever a parameter. The states that belong to applyInputChange are refused whatever
    // the matter, and a state change that is allowed reaches nothing but A.
    expect(() => w.repo.setMatterStatus(a.id, "stale", { actorId: ACTORS.associate })).toThrow(
      ValidationError,
    );
    expect(w.repo.getMatter(a.id)?.status).toBe("exported");
    expect(() =>
      w.repo.setMatterStatus("mat_ffffffffffffffff", "in_review", { actorId: ACTORS.associate }),
    ).toThrow(NotFoundError);
    expect(snapshot(b.id)).toBe(before);
  },
  listMatterAuditEvents: () => {
    const events = w.repo.listMatterAuditEvents(a.id).events;
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.matterId === a.id)).toBe(true);
    // B's id behaves as a matter with events of its own and never mixes into A's page.
    const theirs = w.repo.listMatterAuditEvents(b.id).events;
    expect(theirs.every((e) => e.matterId === b.id)).toBe(true);
    expect(events.some((e) => theirs.some((t) => t.seq === e.seq))).toBe(false);
    expect(w.repo.listMatterAuditEvents("mat_ffffffffffffffff")).toEqual({
      events: [],
      nextAfterSeq: null,
    });
  },
  computeInputsDigest: () => {
    expect(w.repo.computeInputsDigest(a.id)).not.toBe(w.repo.computeInputsDigest(b.id));
  },
  applyInputChange: () => {
    const before = snapshot(b.id);
    w.repo.applyInputChange(a.id, { reason: "document_changed", actorId: ACTORS.associate });
    expect(snapshot(b.id)).toBe(before);
    expect(w.repo.getExportReadiness(b.id, b.runId).ready).toBe(true);
  },
  deleteMatter: () => {
    const before = snapshot(b.id);
    w.repo.deleteMatter(a.id, { actorId: ACTORS.associate });
    expect(snapshot(b.id)).toBe(before);
    expect(w.repo.getMatter(a.id)).toBeUndefined();
  },
  // --- runs and stages ---
  getRun: () => {
    expect(w.repo.getRun(a.id, b.runId)).toBeUndefined();
    expect(w.repo.getRun(b.id, b.runId)?.id).toBe(b.runId);
  },
  listRunsForMatter: () => {
    expect(w.repo.listRunsForMatter(a.id).map((r) => r.id)).toEqual([a.runId]);
  },
  getActiveRun: () => {
    expect(w.repo.getActiveRun(a.id)).toBeUndefined();
  },
  getCurrentRun: () => {
    expect(w.repo.getCurrentRun(a.id)?.id).toBe(a.runId);
  },
  buildRunManifest: () => {
    const manifest = w.repo.buildRunManifest(a.id, {
      workflowVersionId: w.workflow.id,
      modelProvider: "p",
      model: "m",
    });
    expect(JSON.stringify(manifest)).not.toContain(b.id);
    expect(JSON.stringify(manifest)).not.toContain(b.ndaVersion);
  },
  createRun: () => {
    w.repo.applyInputChange(a.id, { reason: "rerun_requested", actorId: null });
    // B's manifest is not A's, and the refusal says nothing about B.
    let error: unknown;
    try {
      w.repo.createRun(a.id, { manifest: b.manifest as never, startedBy: ACTORS.associate });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).not.toContain(b.id);
  },
  updateRunStatus: () => {
    behavesAsMissing((id) => w.repo.updateRunStatus(a.id, id, "superseded"), b.runId, missing.run);
    behavesAsMissing((id) => w.repo.updateRunStatus(a.id, id, "failed"), b.runId, missing.run);
    expect(w.repo.getRun(b.id, b.runId)?.status).toBe("succeeded");
  },
  recordStageStart: () => {
    behavesAsMissing(
      (id) => w.repo.recordStageStart(a.id, id, { stage: "extract", inputSha256: sha256Hex("x") }),
      b.runId,
      missing.run,
    );
  },
  recordStageResult: () => {
    behavesAsMissing(
      (id) =>
        w.repo.recordStageResult(a.id, id, { stage: "extract", attempt: 1, status: "failed" }),
      b.runId,
      missing.run,
    );
  },
  findReusableStage: () => {
    const input = sha256Hex("extract-in");
    expect(w.repo.findReusableStage(a.id, b.runId, "extract", "*", input)).toBeUndefined();
    expect(w.repo.findReusableStage(b.id, b.runId, "extract", "*", input)?.output).toEqual({
      located: ["x"],
    });
  },
  listStages: () => {
    expect(w.repo.listStages(a.id, b.runId)).toEqual([]);
    expect(w.repo.listStages(b.id, b.runId)).toHaveLength(1);
  },
  insertModelCalls: () => {
    behavesAsMissing(
      (id) =>
        w.repo.insertModelCalls(a.id, id, [
          {
            stage: "extract",
            ruleKey: null,
            promptVersionId: "extract.p1",
            requestSha256: sha256Hex("r"),
            attempt: 1,
            outcome: "ok",
            latencyMs: 1,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
        ]),
      b.runId,
      missing.run,
    );
    expect(w.repo.listModelCalls(b.id, b.runId)).toHaveLength(1);
  },
  listModelCalls: () => {
    expect(w.repo.listModelCalls(a.id, b.runId)).toEqual([]);
    expect(w.repo.listModelCalls(b.id, b.runId)).toHaveLength(1);
  },
  // --- findings and reviews ---
  getFinding: () => {
    expect(w.repo.getFinding(a.id, b.findings[0]?.id as string)).toBeUndefined();
    expect(w.repo.getFinding(b.id, b.findings[0]?.id as string)?.matterId).toBe(b.id);
  },
  listFindings: () => {
    expect(w.repo.listFindings(a.id, b.runId)).toEqual([]);
    expect(w.repo.listFindings(b.id, b.runId)).toHaveLength(3);
    expect(w.repo.listFindings(a.id, a.runId).every((f) => f.matterId === a.id)).toBe(true);
  },
  saveFindings: () => {
    const input = allFindings({
      id: b.id,
      nda: {
        documentId: b.ndaDoc,
        versionId: b.ndaVersion,
        spanIds: b.spans.slice(0, 4),
        texts: b.texts,
      },
    });
    behavesAsMissing((id) => w.repo.saveFindings(a.id, id, input), b.runId, missing.run);
  },
  recordReview: () => {
    behavesAsMissing(
      (id) =>
        w.repo.recordReview(a.id, id, {
          reviewerId: ACTORS.reviewer,
          decision: "accept",
          findingContentSha256: b.findings[0]?.hash as string,
        }),
      b.findings[0]?.id as string,
      missing.finding,
    );
    expect(w.repo.listReviews(b.id, b.findings[0]?.id as string)).toHaveLength(1);
  },
  getReview: () => {
    expect(w.repo.getReview(a.id, b.reviews[0] as string)).toBeUndefined();
    expect(w.repo.getReview(b.id, b.reviews[0] as string)?.matterId).toBe(b.id);
  },
  listReviews: () => {
    expect(w.repo.listReviews(a.id, b.findings[0]?.id as string)).toEqual([]);
    expect(w.repo.listReviews(b.id, b.findings[0]?.id as string)).toHaveLength(1);
  },
  listReviewsForRule: () => {
    const reviews = w.repo.listReviewsForRule(a.id, "dur-1");
    expect(reviews).toHaveLength(1);
    expect(reviews.every((r) => r.matterId === a.id)).toBe(true);
  },
  getExportReadiness: () => {
    behavesAsMissing((id) => w.repo.getExportReadiness(a.id, id), b.runId, missing.run);
  },
  // --- memos and feedback ---
  getMemo: () => {
    expect(w.repo.getMemo(a.id, b.memoId)).toBeUndefined();
    expect(w.repo.getMemo(b.id, b.memoId)?.matterId).toBe(b.id);
  },
  getCurrentMemo: () => {
    expect(w.repo.getCurrentMemo(a.id)?.id).not.toBe(b.memoId);
  },
  listMemos: () => {
    expect(w.repo.listMemos(a.id).map((m) => m.matterId)).toEqual([a.id]);
  },
  recordMemo: () => {
    behavesAsMissing(
      (id) =>
        w.repo.recordMemo(a.id, {
          runId: id,
          reviewIds: b.reviews,
          fileSha256: sha256Hex("m"),
          storagePath: fakePath(a.id),
          exportedBy: ACTORS.reviewer,
        }),
      b.runId,
      missing.run,
    );
  },
  addFeedback: () => {
    behavesAsMissing(
      (id) =>
        w.repo.addFeedback(a.id, {
          userId: ACTORS.reviewer,
          kind: "comment",
          text: "t",
          runId: id,
        }),
      b.runId,
      missing.run,
    );
    behavesAsMissing(
      (id) =>
        w.repo.addFeedback(a.id, {
          userId: ACTORS.reviewer,
          kind: "comment",
          text: "t",
          findingId: id,
        }),
      b.findings[0]?.id as string,
      missing.finding,
    );
  },
  listFeedback: () => {
    expect(w.repo.listFeedback(a.id).map((f) => f.matterId)).toEqual([a.id]);
  },
  recordEvalSlotResult: () => {
    const dataset = w.repo.createEvalDataset({
      label: "set",
      devSha256: "a".repeat(64),
      heldoutSha256: "b".repeat(64),
    });
    const evalRun = w.repo.createEvalRun(
      {
        datasetId: dataset.id,
        split: "dev",
        workflowVersionId: w.workflow.id,
        playbookVersionId: w.playbook.id,
        model: "m",
        repeats: 1,
        priceTableSha256: "c".repeat(64),
        resultsPath: "r.json",
      },
      { actorId: null },
    );
    behavesAsMissing(
      (id) =>
        w.repo.recordEvalSlotResult(
          a.id,
          {
            evalRunId: evalRun.id,
            caseKey: "C1",
            ruleKey: "dur-1",
            repeat: 0,
            runId: id,
            expectedStatus: "compliant",
            gotStatus: "compliant",
            scores: {},
          },
          { actorId: null },
        ),
      b.runId,
      missing.run,
    );
    expect(w.repo.listEvalSlotResults(evalRun.id)).toEqual([]);
  },
};

describe("every method that touches matter data is covered", () => {
  it("classifies each public method as matter data (with a probe) or as not matter data", () => {
    const known = new Set([...Object.keys(probes), ...NOT_MATTER_DATA]);
    const unclassified = Object.keys(w.repo).filter((name) => !known.has(name));
    expect(unclassified, "add a probe to scoping.test.ts for these").toEqual([]);
    const stale = [...known].filter((name) => !(name in w.repo));
    expect(stale).toEqual([]);
    const both = Object.keys(probes).filter((name) => NOT_MATTER_DATA.includes(name));
    expect(both).toEqual([]);
  });
});

describe("a foreign id behaves as if it did not exist", () => {
  for (const [name, probe] of Object.entries(probes)) {
    it(name, () => {
      const beforeB = snapshot(b.id);
      probe();
      // Whatever the probe did to A, B is exactly as it was, except where the probe ran a control on B itself.
      if (!["deleteMatter"].includes(name)) expect(snapshot(b.id)).toBe(beforeB);
    });
  }
});

describe("the matter-less methods cannot reach into a matter", () => {
  it("audit listing is filtered by the matter it is given", () => {
    const events = w.repo.listAuditEvents({ matterId: a.id });
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.matterId === a.id)).toBe(true);
  });

  it("listing matters by user returns only that user's memberships", () => {
    w.repo.addMember(a.id, ACTORS.admin, "viewer", { actorId: ACTORS.associate });
    expect(w.repo.listMattersForUser(ACTORS.admin).map((m) => m.id)).toEqual([a.id]);
  });

  it("evaluation results refuse a run of a non-synthetic matter", () => {
    const real = addMatter(w, { synthetic: false, name: "real" });
    const realRun = startRun(w, real);
    const dataset = w.repo.createEvalDataset({
      label: "set",
      devSha256: "a".repeat(64),
      heldoutSha256: "b".repeat(64),
    });
    const evalRun = w.repo.createEvalRun(
      {
        datasetId: dataset.id,
        split: "dev",
        workflowVersionId: w.workflow.id,
        playbookVersionId: w.playbook.id,
        model: "m",
        repeats: 1,
        priceTableSha256: "c".repeat(64),
        resultsPath: "r.json",
      },
      { actorId: null },
    );
    const slot = (matterId: string, runId: string) =>
      w.repo.recordEvalSlotResult(
        matterId,
        {
          evalRunId: evalRun.id,
          caseKey: "C1",
          ruleKey: "dur-1",
          repeat: 0,
          runId,
          expectedStatus: "compliant",
          gotStatus: "compliant",
          scores: {},
        },
        { actorId: null },
      );
    expect(() => slot(real.id, realRun.id)).toThrow(/synthetic/);
    expect(() => slot(real.id, a.runId)).toThrow(/synthetic/);
    expect(slot(a.id, a.runId).runId).toBe(a.runId);
    expect(w.repo.listEvalSlotResults(evalRun.id)).toHaveLength(1);
  });
});
