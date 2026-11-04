import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findingContentSha256, sha256Hex } from "../../src/canonical.js";
import type { VerifiedFinding } from "../../src/contracts.js";
import {
  ConflictError,
  FileStore,
  NotFoundError,
  StaleRunError,
  ValidationError,
  type NewVersionInput,
} from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  addMatter,
  buildSpans,
  decideAll,
  exported,
  fakePath,
  findingFor,
  makeWorld,
  rehash,
  reviewable,
  saveAll,
  startRun,
  succeed,
  type MatterFixture,
  type World,
} from "./fixtures.js";

/**
 * One block per finding of the review of the store module. Each case reproduces what the reviewer
 * reported, so it failed before the fix and holds the fix in place after it.
 */

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const actor = { actorId: ACTORS.associate };

const newVersion = (matterId: string, over: Partial<NewVersionInput> = {}): NewVersionInput => {
  const seed = sha256Hex(`${matterId}:${Math.random()}`);
  return {
    mediaType: "txt",
    fileSha256: sha256Hex(`file:${seed}`),
    textSha256: sha256Hex(`text:${seed}`),
    byteSize: 10,
    statedDate: null,
    storagePath: fakePath(matterId),
    ...over,
  };
};

const span = (m: MatterFixture, i: number) => ({
  id: m.nda.spanIds[i] as string,
  text: m.nda.texts[i] as string,
});

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const allCurrent = (matterId: string, runId: string): boolean =>
  w.repo.listFindings(matterId, runId).every((f) => f.validity === "current");

// ---------------------------------------------------------------------------------------------
// 1. setMatterStatus cannot bypass applyInputChange or the run state
// ---------------------------------------------------------------------------------------------

describe("finding 1: setMatterStatus does not reach stale, draft or ready", () => {
  it("refuses stale from in_review and leaves the run, findings and decisions current", () => {
    const r = reviewable(w);
    expect(w.repo.getMatter(r.m.id)?.status).toBe("in_review");
    expect(() => w.repo.setMatterStatus(r.m.id, "stale", actor)).toThrow(ValidationError);
    expect(codeOf(() => w.repo.setMatterStatus(r.m.id, "stale", actor))).toBe(
      "use_apply_input_change",
    );
    expect(w.repo.getMatter(r.m.id)?.status).toBe("in_review");
    expect(allCurrent(r.m.id, r.run.id)).toBe(true);
    expect(w.repo.getRun(r.m.id, r.run.id)?.status).toBe("succeeded");
    // Nothing could have started a second succeeded run on the same inputs.
    expect(() =>
      w.repo.createRun(r.m.id, {
        manifest: w.repo.buildRunManifest(r.m.id, {
          workflowVersionId: w.workflow.id,
          modelProvider: "scripted",
          model: "scripted-1",
        }),
        startedBy: ACTORS.associate,
      }),
    ).toThrow(ConflictError);
  });

  it("refuses stale from review_complete and from exported, and the memo stays as it was", () => {
    const decided = reviewable(w);
    decideAll(w, decided.m.id, decided.findings);
    expect(w.repo.getMatter(decided.m.id)?.status).toBe("review_complete");
    expect(() => w.repo.setMatterStatus(decided.m.id, "stale", actor)).toThrow(ValidationError);
    expect(w.repo.getMatter(decided.m.id)?.status).toBe("review_complete");
    expect(allCurrent(decided.m.id, decided.run.id)).toBe(true);

    const e = exported(w);
    expect(() => w.repo.setMatterStatus(e.m.id, "stale", actor)).toThrow(ValidationError);
    expect(w.repo.getMatter(e.m.id)?.status).toBe("exported");
    expect(w.repo.getCurrentMemo(e.m.id)?.status).toBe("current");
    expect(w.repo.getExportReadiness(e.m.id, e.run.id).ready).toBe(true);
  });

  it("refuses ready while a run is in flight, and refuses draft", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
    expect(() => w.repo.setMatterStatus(m.id, "ready", actor)).toThrow(ValidationError);
    expect(() => w.repo.setMatterStatus(m.id, "draft", actor)).toThrow(ValidationError);
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
    expect(w.repo.getActiveRun(m.id)?.id).toBe(run.id);
  });

  it("still answers an unknown matter with NotFoundError, whatever state is asked for", () => {
    for (const to of ["stale", "ready", "draft"] as const)
      expect(() => w.repo.setMatterStatus("mat_0000000000000000", to, actor)).toThrow(
        NotFoundError,
      );
  });

  it("applyInputChange is the route to stale, and it invalidates everything", () => {
    const r = reviewable(w);
    const result = w.repo.applyInputChange(r.m.id, { reason: "rerun_requested", actorId: null });
    expect(result.status).toBe("stale");
    expect(w.repo.getRun(r.m.id, r.run.id)?.status).toBe("superseded");
    expect(w.repo.listFindings(r.m.id, r.run.id).every((f) => f.validity === "stale")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. saveFindings checks that a finding agrees with itself and with its spans
// ---------------------------------------------------------------------------------------------

describe("finding 2: saveFindings refuses a finding that contradicts itself", () => {
  const setup = () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    return { m, run };
  };
  const save = (m: MatterFixture, runId: string, f: VerifiedFinding) =>
    w.repo.saveFindings(m.id, runId, [f]);
  const countFindings = (m: MatterFixture, runId: string) =>
    w.repo.listFindings(m.id, runId).length;

  it("verified, with a failing check and no escalation", () => {
    const { m, run } = setup();
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      checks: [{ id: "quote_exists", kind: "deterministic", outcome: "fail", detail: "0 of 1" }],
      escalations: [],
      verificationState: "verified",
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("verification_state_mismatch");
    expect(countFindings(m, run.id)).toBe(0);
  });

  it("verified, with an escalation", () => {
    const { m, run } = setup();
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      escalations: [{ code: "support_not_confirmed", detail: "support: insufficient" }],
      verificationState: "verified",
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("verification_state_mismatch");
  });

  it("escalated by the system with nothing to escalate", () => {
    const { m, run } = setup();
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      verificationState: "escalated_by_system",
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("verification_state_mismatch");
  });

  it("a compliant finding whose only evidence was not found, with no escalation", () => {
    const { m, run } = setup();
    const base = findingFor("dur-1", span(m, 2));
    const f = rehash({
      ...base,
      status: "compliant",
      evidence: [
        {
          spanId: span(m, 2).id,
          quote: "obligations continue for ten years",
          role: "governing",
          quoteCheck: "not_found",
          offsets: null,
          supportCheck: "not_run",
        },
      ],
      verificationState: "verified",
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("unverified_quote_not_escalated");
    expect(countFindings(m, run.id)).toBe(0);
  });

  it("the same unfound quote is saved once it carries quote_not_verified and the failed check", () => {
    const { m, run } = setup();
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      evidence: [
        {
          spanId: span(m, 2).id,
          quote: "obligations continue for ten years",
          role: "governing",
          quoteCheck: "not_found",
          offsets: null,
          supportCheck: "not_run",
        },
      ],
      checks: [{ id: "quote_exists", kind: "deterministic", outcome: "fail", detail: "0 of 1" }],
      escalations: [{ code: "quote_not_verified", detail: "evidence 1: quote_not_found" }],
      verificationState: "escalated_by_system",
    });
    const [saved] = save(m, run.id, f);
    expect(saved?.verificationState).toBe("escalated_by_system");
    expect(saved?.evidence[0]?.quoteCheck).toBe("not_found");
  });

  it("a verified quote whose words are not at its offsets in the span", () => {
    const { m, run } = setup();
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      evidence: [
        {
          spanId: span(m, 2).id,
          quote: "obligations continue for ten years",
          role: "governing",
          quoteCheck: "verified",
          offsets: { start: 0, end: 10 },
          supportCheck: "supported",
        },
      ],
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("quote_mismatch");
    expect(countFindings(m, run.id)).toBe(0);
  });

  it("a verified quote that is in the span but at other offsets", () => {
    const { m, run } = setup();
    const text = span(m, 2).text;
    const quote = "two (2) years";
    const at = text.indexOf(quote);
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      evidence: [
        {
          spanId: span(m, 2).id,
          quote,
          role: "governing",
          quoteCheck: "verified",
          offsets: { start: at + 1, end: at + 1 + quote.length },
          supportCheck: "supported",
        },
      ],
    });
    expect(codeOf(() => save(m, run.id, f))).toBe("quote_mismatch");
  });

  it("a quote claimed ambiguous that occurs once, and one that is not there at all", () => {
    const { m, run } = setup();
    const evidence = (quote: string) => [
      {
        spanId: span(m, 2).id,
        quote,
        role: "supporting" as const,
        quoteCheck: "ambiguous" as const,
        offsets: null,
        supportCheck: "not_run" as const,
      },
    ];
    for (const quote of ["two (2) years", "ten years of silence"])
      expect(
        codeOf(() =>
          save(
            m,
            run.id,
            rehash({ ...findingFor("dur-1", span(m, 2)), evidence: evidence(quote) }),
          ),
        ),
      ).toBe("quote_mismatch");
  });

  it("an honest verified quote and an honest ambiguous quote are saved", () => {
    const { m, run } = setup();
    const text = span(m, 2).text;
    const unique = "two (2) years";
    const at = text.indexOf(unique);
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      evidence: [
        {
          spanId: span(m, 2).id,
          quote: unique,
          role: "governing",
          quoteCheck: "verified",
          offsets: { start: at, end: at + unique.length },
          supportCheck: "supported",
        },
        {
          spanId: span(m, 2).id,
          quote: "each",
          role: "supporting",
          quoteCheck: "ambiguous",
          offsets: null,
          supportCheck: "supported",
        },
      ],
    });
    const [saved] = save(m, run.id, f);
    expect(saved?.evidence.map((e) => e.quoteCheck)).toEqual(["verified", "ambiguous"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. model_calls.rule_key holds a rule key and nothing else
// ---------------------------------------------------------------------------------------------

describe("finding 3: a model call names a rule of the run's playbook", () => {
  const call = (ruleKey: string | null) => ({
    stage: "analyze" as const,
    ruleKey,
    promptVersionId: "analyze.p1",
    requestSha256: sha256Hex("request"),
    attempt: 1,
    outcome: "ok" as const,
    latencyMs: 12,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });

  it("refuses a sentence of document text in the rule key column", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const sentence =
      "The Receiving Party shall hold the Confidential Information in strict confidence for a period of two years";
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call(sentence)])).toThrow(ValidationError);
    expect(w.repo.listModelCalls(m.id, run.id)).toEqual([]);
  });

  it("refuses a well-formed key that is not a rule of the run's playbook, and a long single word", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(codeOf(() => w.repo.insertModelCalls(m.id, run.id, [call("zzz-9")]))).toBe(
      "unknown_rule",
    );
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call("x".repeat(65))])).toThrow(
      ValidationError,
    );
    expect(w.repo.listModelCalls(m.id, run.id)).toEqual([]);
  });

  it("stores a real rule key and a null one", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const rows = w.repo.insertModelCalls(m.id, run.id, [call("dur-1"), call(null)]);
    expect(rows.map((r) => r.ruleKey)).toEqual(["dur-1", null]);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Stages are written only while their run is in flight
// ---------------------------------------------------------------------------------------------

describe("finding 4: recordStageStart and recordStageResult need an active run", () => {
  const stage = { stage: "analyze", unit: "dur-1", inputSha256: sha256Hex("in") };

  it("a cancelled run takes no new stage, so nothing is left running", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    expect(codeOf(() => w.repo.recordStageStart(m.id, run.id, stage))).toBe("run_not_active");
    expect(w.repo.markInterruptedOnBoot()).toEqual([]);
    expect(w.repo.listStages(m.id, run.id).filter((s) => s.status === "running")).toEqual([]);
  });

  it("a succeeded run's provenance is not added to after the fact", () => {
    const e = exported(w);
    expect(() => w.repo.recordStageStart(e.m.id, e.run.id, stage)).toThrow(ConflictError);
    expect(w.repo.listStages(e.m.id, e.run.id)).toEqual([]);
  });

  it("a failed run takes none until it is resumed", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "boom" });
    expect(() => w.repo.recordStageStart(m.id, run.id, stage)).toThrow(ConflictError);
    w.repo.updateRunStatus(m.id, run.id, "queued");
    expect(w.repo.recordStageStart(m.id, run.id, stage).status).toBe("running");
  });

  it("a result for a stage of a run that has since been cancelled is refused", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const started = w.repo.recordStageStart(m.id, run.id, stage);
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    expect(() =>
      w.repo.recordStageResult(m.id, run.id, {
        stage: "analyze",
        unit: "dur-1",
        attempt: started.attempt,
        status: "succeeded",
        output: { x: 1 },
      }),
    ).toThrow(ConflictError);
  });

  it("a superseded run is still reported as stale, and an active run still works", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const started = w.repo.recordStageStart(m.id, run.id, stage);
    expect(
      w.repo.recordStageResult(m.id, run.id, {
        stage: "analyze",
        unit: "dur-1",
        attempt: started.attempt,
        status: "succeeded",
        output: { x: 1 },
      }).status,
    ).toBe("succeeded");
    w.repo.applyInputChange(m.id, { reason: "rerun_requested", actorId: null });
    expect(() => w.repo.recordStageStart(m.id, run.id, stage)).toThrow(StaleRunError);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. A re-run on unchanged inputs leaves the exported memo alone
// ---------------------------------------------------------------------------------------------

describe("finding 5: re-run with unchanged inputs", () => {
  it("supersedes findings, decisions and the run, and leaves the exported memo current", () => {
    const e = exported(w);
    const digest = w.repo.getMatter(e.m.id)?.currentInputsSha256;
    const result = w.repo.applyInputChange(e.m.id, { reason: "rerun_requested", actorId: null });
    expect(result.inputsSha256).toBe(digest);
    expect(result.previousInputsSha256).toBe(digest);
    expect(result.memosSuperseded).toBe(0);
    expect(result.status).toBe("stale");
    expect(result.findingsMarkedStale).toBe(3);
    expect(result.reviewsMarkedStale).toBe(3);
    expect(result.runsSuperseded).toBe(1);
    expect(w.repo.getMemo(e.m.id, e.memo.id)?.status).toBe("current");
    expect(w.repo.getRun(e.m.id, e.run.id)?.status).toBe("superseded");
  });

  it("the new run's memo then supersedes the old one, and only that memo may mark the matter exported", () => {
    const e = exported(w);
    w.repo.applyInputChange(e.m.id, { reason: "rerun_requested", actorId: null });
    const run = startRun(w, e.m);
    const findings = saveAll(w, e.m, run);
    succeed(w, e.m, run);
    const reviews = decideAll(w, e.m.id, findings);
    expect(w.repo.getMatter(e.m.id)?.status).toBe("review_complete");
    // The only current memo is the old run's: it is not the memo of this run's decisions.
    expect(() => w.repo.setMatterStatus(e.m.id, "exported", actor)).toThrow(/no current memo/);
    const memo = w.repo.recordMemo(e.m.id, {
      runId: run.id,
      reviewIds: reviews.map((r) => r.id),
      fileSha256: sha256Hex("second memo"),
      storagePath: fakePath(e.m.id),
      exportedBy: ACTORS.reviewer,
    });
    expect(w.repo.getMemo(e.m.id, e.memo.id)?.status).toBe("superseded");
    expect(w.repo.getCurrentMemo(e.m.id)?.id).toBe(memo.id);
  });

  it("a change that moves the digest, or a playbook switch, still supersedes the memo", () => {
    const e = exported(w);
    w.repo.updateClientName(e.m.id, "Renamed Client, Inc.", actor);
    expect(w.repo.getMemo(e.m.id, e.memo.id)?.status).toBe("superseded");
  });

  it("a rerun_requested on a matter whose inputs did change supersedes the memo", () => {
    const e = exported(w);
    // Move the stored digest away from the real one, as if an input had changed unseen.
    w.db
      .prepare("UPDATE matters SET current_inputs_sha256 = ? WHERE id = ?")
      .run("0".repeat(64), e.m.id);
    const result = w.repo.applyInputChange(e.m.id, { reason: "rerun_requested", actorId: null });
    expect(result.memosSuperseded).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 6. One stored file, one row; an identical upload changes nothing
// ---------------------------------------------------------------------------------------------

describe("finding 6: storage paths are unique and identical uploads are not stored again", () => {
  it("a second document cannot name the first document's file", () => {
    const m = addMatter(w);
    const ndaPath = w.repo.getVersion(m.id, m.nda.versionId)?.storagePath as string;
    expect(
      codeOf(() =>
        w.repo.addDocument(
          m.id,
          {
            kind: "amendment",
            title: "Amendment",
            version: newVersion(m.id, { storagePath: ndaPath, operative: true }),
          },
          actor,
        ),
      ),
    ).toBe("storage_path_in_use");
    expect(w.repo.listDocuments(m.id)).toHaveLength(1);
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
  });

  it("a new version cannot name an existing version's file, and a memo cannot name a document's", () => {
    const e = exported(w, { amendment: true });
    const ndaPath = w.repo.getVersion(e.m.id, e.m.nda.versionId)?.storagePath as string;
    expect(
      codeOf(() =>
        w.repo.addVersion(
          e.m.id,
          e.m.nda.documentId,
          newVersion(e.m.id, { storagePath: ndaPath }),
          actor,
        ),
      ),
    ).toBe("storage_path_in_use");
    expect(w.repo.getMatter(e.m.id)?.status).toBe("exported");

    // A memo path that is a document's path.
    const r = reviewable(w);
    const reviews = decideAll(w, r.m.id, r.findings);
    const docPath = w.repo.getVersion(r.m.id, r.m.nda.versionId)?.storagePath as string;
    expect(
      codeOf(() =>
        w.repo.recordMemo(r.m.id, {
          runId: r.run.id,
          reviewIds: reviews.map((x) => x.id),
          fileSha256: sha256Hex("memo"),
          storagePath: docPath,
          exportedBy: ACTORS.reviewer,
        }),
      ),
    ).toBe("storage_path_in_use");
    expect(w.repo.getCurrentMemo(r.m.id)).toBeUndefined();
  });

  it("a document's path cannot be a memo's path either", () => {
    const e = exported(w);
    expect(
      codeOf(() =>
        w.repo.addDocument(
          e.m.id,
          {
            kind: "amendment",
            title: "Amendment",
            version: newVersion(e.m.id, { storagePath: e.memo.storagePath }),
          },
          actor,
        ),
      ),
    ).toBe("storage_path_in_use");
  });

  it("removeDocument hands back only paths no other row uses", () => {
    const m = addMatter(w, { amendment: true });
    const all = w.repo.listVersions(m.id).map((v) => v.storagePath);
    const paths = w.repo.removeDocument(m.id, m.amendment?.documentId as string, actor);
    expect(paths).toHaveLength(1);
    expect(w.repo.listVersions(m.id).map((v) => v.storagePath)).not.toContain(paths[0]);
    expect(all).toContain(paths[0]);
  });

  it("the database itself refuses two rows with one path, in one table and across both", () => {
    const e = exported(w);
    const version = w.db
      .prepare("SELECT * FROM document_versions WHERE matter_id = ?")
      .get(e.m.id) as Record<string, SQLInputValue>;
    const insertVersion = (path: string) => () => {
      const next: Record<string, SQLInputValue> = {
        ...version,
        id: "ver_dup",
        version_no: 99,
        operative: 0,
        storage_path: path,
      };
      const cols = Object.keys(next);
      w.db
        .prepare(
          `INSERT INTO document_versions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...cols.map((c) => next[c] as SQLInputValue));
    };
    expect(insertVersion(version["storage_path"] as string)).toThrow(/storage_path|one row/);
    expect(insertVersion(e.memo.storagePath)).toThrow(/one row/);

    const memo = w.db.prepare("SELECT * FROM memos WHERE id = ?").get(e.memo.id) as Record<
      string,
      SQLInputValue
    >;
    w.db.prepare("UPDATE memos SET status = 'superseded' WHERE id = ?").run(e.memo.id);
    const next: Record<string, SQLInputValue> = {
      ...memo,
      id: "memo_dup",
      status: "current",
      storage_path: version["storage_path"] as SQLInputValue,
    };
    const cols = Object.keys(next);
    expect(() =>
      w.db
        .prepare(
          `INSERT INTO memos (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...cols.map((c) => next[c] as SQLInputValue)),
    ).toThrow(/one row/);
  });

  it("an identical file uploaded again is refused and changes nothing", () => {
    const r = reviewable(w);
    const existing = w.repo.getVersion(r.m.id, r.m.nda.versionId);
    const events = w.repo.listAuditEvents({ matterId: r.m.id }).length;
    expect(
      codeOf(() =>
        w.repo.addVersion(
          r.m.id,
          r.m.nda.documentId,
          newVersion(r.m.id, { fileSha256: existing?.fileSha256 as string, operative: true }),
          actor,
        ),
      ),
    ).toBe("duplicate_file");
    expect(w.repo.getMatter(r.m.id)?.status).toBe("in_review");
    expect(allCurrent(r.m.id, r.run.id)).toBe(true);
    expect(w.repo.listVersions(r.m.id, r.m.nda.documentId)).toHaveLength(1);
    expect(w.repo.listAuditEvents({ matterId: r.m.id })).toHaveLength(events);
  });

  it("an identical file as a new document is refused too", () => {
    const m = addMatter(w);
    const existing = w.repo.getVersion(m.id, m.nda.versionId);
    expect(
      codeOf(() =>
        w.repo.addDocument(
          m.id,
          {
            kind: "amendment",
            title: "Amendment",
            version: newVersion(m.id, { fileSha256: existing?.fileSha256 as string }),
          },
          actor,
        ),
      ),
    ).toBe("duplicate_file");
  });

  it("the same bytes in another matter are a different upload", () => {
    const a = addMatter(w);
    const b = addMatter(w);
    const existing = w.repo.getVersion(a.id, a.nda.versionId);
    const added = w.repo.addVersion(
      b.id,
      b.nda.documentId,
      newVersion(b.id, { fileSha256: existing?.fileSha256 as string }),
      actor,
    );
    expect(added.versionNo).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// 7. NUL characters are refused instead of truncated
// ---------------------------------------------------------------------------------------------

describe("finding 7: a NUL character is refused, not silently cut", () => {
  it("insertSpans refuses a span whose text holds a NUL, and stores nothing", () => {
    const m = addMatter(w, { spans: false });
    const text = "6.1 The obligations\u0000 continue for two years";
    const [s] = buildSpans(m.nda.versionId, "D1", [text]);
    expect(s?.textSha256).toBe(sha256Hex(text));
    expect(codeOf(() => w.repo.insertSpans(m.id, [s as NonNullable<typeof s>]))).toBe(
      "nul_character",
    );
    expect(w.repo.listSpans(m.id, [m.nda.versionId])).toEqual([]);
  });

  it("insertSpans refuses a NUL in a heading as well", () => {
    const m = addMatter(w, { spans: false });
    const [s] = buildSpans(m.nda.versionId, "D1", ["clean text"]);
    expect(
      codeOf(() =>
        w.repo.insertSpans(m.id, [{ ...(s as NonNullable<typeof s>), heading: "Dur\u0000ation" }]),
      ),
    ).toBe("nul_character");
  });

  it("saveFindings refuses a NUL in a discrepancy, an explanation, a check detail or an escalation", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const base = findingFor("dur-1", span(m, 2));
    const variants: VerifiedFinding[] = [
      rehash({ ...base, discrepancy: "two\u0000 years" }),
      rehash({ ...base, explanation: "meets\u0000 the rule" }),
      rehash({
        ...base,
        checks: [
          { id: "quote_exists", kind: "deterministic", outcome: "pass", detail: "1\u0000 of 1" },
        ],
      }),
    ];
    for (const f of variants)
      expect(codeOf(() => w.repo.saveFindings(m.id, run.id, [f]))).toBe("nul_character");
    expect(w.repo.listFindings(m.id, run.id)).toEqual([]);
  });

  it("a NUL inside an escalation is JSON-escaped, so it is stored whole and still hashes", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      escalations: [{ code: "support_not_confirmed", detail: "support\u0000 insufficient" }],
      verificationState: "escalated_by_system",
    });
    const [saved] = w.repo.saveFindings(m.id, run.id, [f]);
    expect(saved?.escalations[0]?.detail).toBe("support\u0000 insufficient");
    expect(findingContentSha256(saved as VerifiedFinding)).toBe(f.contentSha256);
  });

  it("a playbook with a NUL in its text is refused, not stored cut short", () => {
    const yaml = `${PLAYBOOK_YAML}# note\u0000 hidden\n`;
    expect(
      codeOf(() =>
        w.repo.importPlaybookDraft(
          {
            slug: "nul-playbook",
            version: "1.0.0",
            yaml,
            sha256: sha256Hex(yaml),
            rules: RULES,
          },
          { actorId: ACTORS.legalEngineer },
        ),
      ),
    ).toBe("nul_character");
  });
});

// ---------------------------------------------------------------------------------------------
// 8. Replace guards that do not depend on recursive_triggers
// ---------------------------------------------------------------------------------------------

describe("finding 8: INSERT OR REPLACE cannot rewrite a retired playbook or a matter", () => {
  beforeEach(() => {
    w.db.exec("PRAGMA recursive_triggers = OFF");
  });

  it("a retired playbook version cannot be replaced", () => {
    w.db.prepare("UPDATE playbook_versions SET status = 'retired' WHERE id = ?").run(w.playbook.id);
    const row = w.db
      .prepare("SELECT * FROM playbook_versions WHERE id = ?")
      .get(w.playbook.id) as Record<string, SQLInputValue>;
    const next: Record<string, SQLInputValue> = {
      ...row,
      status: "draft",
      approved_by: null,
      approved_at: null,
      yaml: "changed",
    };
    const cols = Object.keys(next);
    expect(() =>
      w.db
        .prepare(
          `INSERT OR REPLACE INTO playbook_versions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...cols.map((c) => next[c] as SQLInputValue)),
    ).toThrow(/immutable/);
    expect(
      (
        w.db.prepare("SELECT yaml FROM playbook_versions WHERE id = ?").get(w.playbook.id) as {
          yaml: string;
        }
      ).yaml,
    ).toBe(PLAYBOOK_YAML);
  });

  it("a matter cannot be replaced, so its findings are not cascaded away", () => {
    const e = exported(w);
    const count = () =>
      (
        w.db.prepare("SELECT count(*) AS n FROM findings WHERE matter_id = ?").get(e.m.id) as {
          n: number;
        }
      ).n;
    expect(count()).toBe(3);
    const row = w.db.prepare("SELECT * FROM matters WHERE id = ?").get(e.m.id) as Record<
      string,
      SQLInputValue
    >;
    const cols = Object.keys(row);
    expect(() =>
      w.db
        .prepare(
          `INSERT OR REPLACE INTO matters (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(...cols.map((c) => row[c] as SQLInputValue)),
    ).toThrow(/never replaced/);
    expect(count()).toBe(3);
    expect(w.repo.getMatter(e.m.id)?.status).toBe("exported");
  });
});

// ---------------------------------------------------------------------------------------------
// 9. Audit listing for a matter needs a matter
// ---------------------------------------------------------------------------------------------

describe("finding 9: listMatterAuditEvents is scoped and says when it was cut off", () => {
  it("returns only the named matter's events", () => {
    const a = exported(w);
    const b = exported(w);
    const page = w.repo.listMatterAuditEvents(a.m.id);
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((e) => e.matterId === a.m.id)).toBe(true);
    expect(page.events.some((e) => e.matterId === b.m.id)).toBe(false);
    expect(page.nextAfterSeq).toBeNull();
  });

  it("an unknown matter has no events, and a missing matter id is an error, never everything", () => {
    exported(w);
    expect(w.repo.listMatterAuditEvents("mat_0000000000000000")).toEqual({
      events: [],
      nextAfterSeq: null,
    });
    for (const bad of [undefined, null, "", 7])
      expect(() => w.repo.listMatterAuditEvents(bad as never)).toThrow(ValidationError);
  });

  it("pages from the oldest event and tells the caller where to continue", () => {
    const e = exported(w);
    const everyEvent = w.repo.listMatterAuditEvents(e.m.id, { limit: 10_000 }).events;
    expect(everyEvent.length).toBeGreaterThan(3);
    const seen: number[] = [];
    let after = 0;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = w.repo.listMatterAuditEvents(e.m.id, { limit: 3, afterSeq: after });
      seen.push(...page.events.map((x) => x.seq));
      if (page.nextAfterSeq === null) break;
      expect(page.events).toHaveLength(3);
      after = page.nextAfterSeq;
    }
    expect(seen).toEqual(everyEvent.map((x) => x.seq));
  });

  it("filters by action within the matter", () => {
    const e = exported(w);
    const page = w.repo.listMatterAuditEvents(e.m.id, { action: "memo.export" });
    expect(page.events.map((x) => x.action)).toEqual(["memo.export"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 10. A matter folder with no row can be found and removed
// ---------------------------------------------------------------------------------------------

describe("finding 10: orphaned matter folders", () => {
  let base: string;
  let store: FileStore;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "parol-orphans-"));
    store = new FileStore(join(base, "files"));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("lists the matter folders and nothing else in the root", () => {
    store.save("mat_0123456789abcdef", new Uint8Array([1]));
    store.save("mat_fedcba9876543210", new Uint8Array([2]));
    mkdirSync(join(store.root, "lost+found"));
    mkdirSync(join(store.root, "mat_SHORT"));
    writeFileSync(join(store.root, "notes.txt"), "x");
    expect(store.listMatterIds()).toEqual(["mat_0123456789abcdef", "mat_fedcba9876543210"]);
  });

  it("removes the folder of a matter whose rows are gone and keeps the others", () => {
    const keep = addMatter(w);
    const gone = addMatter(w);
    const keptPath = store.save(keep.id, new Uint8Array([1, 2, 3]));
    store.save(gone.id, new Uint8Array([4, 5, 6]));

    // The crash: the rows are deleted, the process stops before FileStore.deleteMatter runs.
    w.repo.deleteMatter(gone.id, actor);
    expect(w.repo.getMatter(gone.id)).toBeUndefined();
    expect(store.listMatterIds()).toContain(gone.id);

    const removed = store.sweepOrphans(w.repo.listMatterIds());
    expect(removed).toEqual([gone.id]);
    expect(store.listMatterIds()).toEqual([keep.id]);
    expect([...store.read(keptPath)]).toEqual([1, 2, 3]);
    // A second sweep finds nothing.
    expect(store.sweepOrphans(w.repo.listMatterIds())).toEqual([]);
  });

  it("repo.listMatterIds lists every matter that has a row", () => {
    const a = addMatter(w);
    const b = addMatter(w);
    expect(w.repo.listMatterIds().sort()).toEqual([a.id, b.id].sort());
    w.repo.deleteMatter(b.id, actor);
    expect(w.repo.listMatterIds()).toEqual([a.id]);
  });

  it("a link planted under a matter name is removed as a link and its target is untouched", () => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    symlinkSync(outside, join(store.root, "mat_aaaaaaaaaaaaaaaa"));
    expect(store.sweepOrphans([])).toEqual(["mat_aaaaaaaaaaaaaaaa"]);
    expect(store.listMatterIds()).toEqual([]);
    expect(() => store.read("mat_aaaaaaaaaaaaaaaa/f_00000000000000000000000000000000")).toThrow();
    // The target survived.
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });

  it("refuses ids that are not matter ids when told which folders to keep", () => {
    store.save("mat_0123456789abcdef", new Uint8Array([1]));
    expect(store.sweepOrphans(["../x", 7 as never])).toEqual(["mat_0123456789abcdef"]);
  });
});
