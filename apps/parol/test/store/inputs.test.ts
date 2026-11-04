import { beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { NotFoundError, ValidationError, inputsDigestOf, type NewVersionInput } from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  allFindings,
  exported,
  fakePath,
  makeWorld,
  reviewable,
  saveAll,
  startRun,
  succeed,
  type World,
} from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const newVersion = (matterId: string, text: string, over: Partial<NewVersionInput> = {}): NewVersionInput => ({
  mediaType: "txt",
  fileSha256: sha256Hex(`file:${text}`),
  textSha256: sha256Hex(`text:${text}`),
  byteSize: text.length,
  statedDate: null,
  storagePath: fakePath(matterId),
  ...over,
});

const reasonsOf = (matterId: string) =>
  w.repo.listAuditEvents({ matterId, action: "inputs.changed" }).map((e) => e.detail.reason);

describe("computeInputsDigest", () => {
  it("is a hash of client name, playbook hash and each document's operative version, in ordinal order", () => {
    const m = addMatter(w, { amendment: true });
    const nda = w.repo.getVersion(m.id, m.nda.versionId);
    const amendment = w.repo.getVersion(m.id, m.amendment?.versionId as string);
    // Written out longhand, so the test fails if the shape of the digest changes by accident.
    const expected = hashOf({
      clientLegalName: "Marlowe Analytics, Inc.",
      playbookSha256: sha256Hex(PLAYBOOK_YAML),
      documents: [
        { versionId: nda?.id, textSha256: nda?.textSha256, statedDate: "2026-01-15", kind: "nda" },
        { versionId: amendment?.id, textSha256: amendment?.textSha256, statedDate: "2026-02-20", kind: "amendment" },
      ],
    });
    expect(w.repo.computeInputsDigest(m.id)).toBe(expected);
    expect(w.repo.getMatter(m.id)?.currentInputsSha256).toBe(expected);
  });

  it("is null without a playbook, without an operative NDA, or with a document that has no operative version", () => {
    const noPlaybook = addMatter(w, { pinPlaybook: false });
    expect(w.repo.computeInputsDigest(noPlaybook.id)).toBeNull();

    const empty = w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate });
    w.repo.setPlaybookVersion(empty.id, w.playbook.id, { actorId: ACTORS.associate });
    expect(w.repo.computeInputsDigest(empty.id)).toBeNull();

    // An amendment alone is not enough: there must be an NDA.
    w.repo.addDocument(
      empty.id,
      { kind: "amendment", title: "Amendment", version: newVersion(empty.id, "a", { operative: true }) },
      { actorId: ACTORS.associate },
    );
    expect(w.repo.computeInputsDigest(empty.id)).toBeNull();

    const nda = w.repo.addDocument(
      empty.id,
      { kind: "nda", title: "NDA", version: newVersion(empty.id, "n") },
      { actorId: ACTORS.associate },
    );
    // The NDA exists but is not operative yet.
    expect(w.repo.computeInputsDigest(empty.id)).toBeNull();
    w.repo.setOperativeVersion(empty.id, nda.version.id, { actorId: ACTORS.associate });
    expect(w.repo.computeInputsDigest(empty.id)).not.toBeNull();

    // A third document without an operative version makes it incomplete again.
    w.repo.addDocument(empty.id, { kind: "amendment", title: "Second", version: newVersion(empty.id, "b") }, { actorId: ACTORS.associate });
    expect(w.repo.computeInputsDigest(empty.id)).toBeNull();
    expect(w.repo.computeInputsDigest("mat_0000000000000000")).toBeNull();
  });

  it("changes with each thing it covers", () => {
    const m = addMatter(w, { amendment: true });
    const seen = new Set<string | null>([w.repo.computeInputsDigest(m.id)]);
    const note = () => seen.add(w.repo.computeInputsDigest(m.id));

    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    note();
    w.repo.setStatedDate(m.id, m.amendment?.versionId as string, "2026-03-01", { actorId: ACTORS.associate });
    note();
    const v2 = w.repo.addVersion(m.id, m.nda.documentId, newVersion(m.id, "revised nda"), { actorId: ACTORS.associate });
    w.repo.setOperativeVersion(m.id, v2.id, { actorId: ACTORS.associate });
    note();
    // Same text, new version: the version id is part of the digest, so this is a different input.
    const v3 = w.repo.addVersion(m.id, m.nda.documentId, newVersion(m.id, "resaved nda", { textSha256: v2.textSha256 }), { actorId: ACTORS.associate });
    w.repo.setOperativeVersion(m.id, v3.id, { actorId: ACTORS.associate });
    note();
    const other = w.repo.approvePlaybookVersion(
      w.repo.importPlaybookDraft({ slug: "test-playbook", version: "1.1.0", yaml: `${PLAYBOOK_YAML}# 1.1\n`, sha256: sha256Hex(`${PLAYBOOK_YAML}# 1.1\n`), rules: RULES }, { actorId: ACTORS.legalEngineer }).id,
      { actorId: ACTORS.admin },
    );
    w.repo.setPlaybookVersion(m.id, other.id, { actorId: ACTORS.associate });
    note();
    expect(seen.size).toBe(6);
    expect(seen.has(null)).toBe(false);
  });

  it("also covers kind and document order, which the pure function shows", () => {
    const base = {
      clientLegalName: "C",
      playbookSha256: sha256Hex("p"),
      documents: [
        { versionId: "v1", textSha256: sha256Hex("a"), statedDate: null, kind: "nda" as const },
        { versionId: "v2", textSha256: sha256Hex("b"), statedDate: "2026-01-01", kind: "amendment" as const },
      ],
    };
    const digest = inputsDigestOf(base);
    expect(inputsDigestOf({ ...base, documents: [...base.documents].reverse() })).not.toBe(digest);
    const [first, second] = base.documents as [(typeof base.documents)[number], (typeof base.documents)[number]];
    expect(inputsDigestOf({ ...base, documents: [{ ...first, kind: "amendment" }, second] })).not.toBe(digest);
    expect(inputsDigestOf({ ...base, documents: [{ ...first, statedDate: "2026-01-02" }, second] })).not.toBe(digest);
    expect(inputsDigestOf(JSON.parse(JSON.stringify(base)))).toBe(digest);
  });

  it("leaves out workflow and model, which belong to the run manifest", () => {
    const m = addMatter(w);
    const other = { ...WORKFLOW_MANIFEST, label: "v2", retrieval: "R2" as const };
    const wf2 = w.repo.upsertWorkflowVersion({ manifest: other, sha256: hashOf(other) });
    const digest = w.repo.computeInputsDigest(m.id);

    const a = w.repo.buildRunManifest(m.id, { workflowVersionId: w.workflow.id, modelProvider: "scripted", model: "m1" });
    const b = w.repo.buildRunManifest(m.id, { workflowVersionId: wf2.id, modelProvider: "other", model: "m2" });
    expect(hashOf(a)).not.toBe(hashOf(b));
    expect(w.repo.computeInputsDigest(m.id)).toBe(digest);

    // A run records both: the manifest hash differs, the inputs digest is the same.
    const first = w.repo.createRun(m.id, { manifest: a, startedBy: ACTORS.associate });
    w.repo.updateRunStatus(m.id, first.id, "cancelled");
    const second = w.repo.createRun(m.id, { manifest: b, startedBy: ACTORS.associate });
    expect(second.inputsSha256).toBe(first.inputsSha256);
    expect(second.inputManifestSha256).not.toBe(first.inputManifestSha256);
    expect(w.repo.getMatter(m.id)?.currentInputsSha256).toBe(digest);
  });
});

describe("applyInputChange", () => {
  it("marks findings and decisions stale, supersedes the memo and the run, and says how many", () => {
    const e = exported(w);
    w.clock.tick();
    const result = w.repo.applyInputChange(e.m.id, { reason: "document_changed", actorId: ACTORS.associate });
    expect(result).toMatchObject({
      matterId: e.m.id,
      reason: "document_changed",
      status: "stale",
      findingsMarkedStale: 3,
      reviewsMarkedStale: 3,
      memosSuperseded: 1,
      runsSuperseded: 1,
    });
    expect(result.inputsSha256).toBe(w.repo.computeInputsDigest(e.m.id));
    expect(result.previousInputsSha256).toBe(e.run.inputsSha256);

    const findings = w.repo.listFindings(e.m.id, e.run.id);
    expect(findings.map((f) => [f.validity, f.staleReason])).toEqual([
      ["stale", "document_changed"],
      ["stale", "document_changed"],
      ["stale", "document_changed"],
    ]);
    expect(findings.flatMap((f) => f.reviews.map((r) => r.validity))).toEqual(["stale", "stale", "stale"]);
    expect(w.repo.getMemo(e.m.id, e.memo.id)?.status).toBe("superseded");
    expect(w.repo.getCurrentMemo(e.m.id)).toBeUndefined();
    expect(w.repo.getRun(e.m.id, e.run.id)).toMatchObject({ status: "superseded" });
    expect(w.repo.getMatter(e.m.id)?.status).toBe("stale");
    expect(w.repo.getCurrentRun(e.m.id)).toBeUndefined();
    const event = w.repo.listAuditEvents({ matterId: e.m.id, action: "inputs.changed" }).at(-1);
    expect(event).toMatchObject({ actorId: ACTORS.associate });
    expect(event?.detail).toMatchObject({ reason: "document_changed", status: "stale", findingsMarkedStale: 3, reviewsMarkedStale: 3, memosSuperseded: 1, runsSuperseded: 1 });
  });

  it("stores the recomputed digest even when nothing else is affected", () => {
    const m = addMatter(w);
    w.db.prepare("UPDATE matters SET current_inputs_sha256 = 'stale-value' WHERE id = ?").run(m.id);
    const result = w.repo.applyInputChange(m.id, { reason: "operative_changed", actorId: null });
    expect(result).toMatchObject({ findingsMarkedStale: 0, reviewsMarkedStale: 0, memosSuperseded: 0, runsSuperseded: 0, status: "ready" });
    expect(w.repo.getMatter(m.id)?.currentInputsSha256).toBe(w.repo.computeInputsDigest(m.id));
  });

  it("supersedes a run that is still in flight and closes its open stage", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "dur-1", inputSha256: sha256Hex("x") });
    const result = w.repo.applyInputChange(m.id, { reason: "client_name_changed", actorId: null });
    expect(result).toMatchObject({ runsSuperseded: 1, status: "stale" });
    expect(w.repo.getRun(m.id, run.id)?.status).toBe("superseded");
    expect(w.repo.getActiveRun(m.id)).toBeUndefined();
    expect(w.repo.listStages(m.id, run.id)[0]).toMatchObject({ status: "failed", errorKind: "superseded" });
  });

  it("returns a matter with nothing run yet to draft or ready by completeness", () => {
    const m = addMatter(w, { amendment: true });
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
    w.repo.removeDocument(m.id, m.amendment?.documentId as string, { actorId: ACTORS.associate });
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
    w.repo.removeDocument(m.id, m.nda.documentId, { actorId: ACTORS.associate });
    expect(w.repo.getMatter(m.id)?.status).toBe("draft");
    expect(w.repo.getMatter(m.id)?.currentInputsSha256).toBeNull();
    // A failed run produced nothing, so it does not make the matter stale either.
    const n = addMatter(w);
    const run = startRun(w, n);
    w.repo.updateRunStatus(n.id, run.id, "failed", { errorKind: "provider_auth" });
    w.repo.updateClientName(n.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(w.repo.getMatter(n.id)?.status).toBe("ready");
  });

  it("keeps a stale matter stale through further changes, and never touches failed runs", () => {
    const r = reviewable(w);
    w.repo.updateClientName(r.m.id, "One Name, Inc.", { actorId: ACTORS.associate });
    const again = w.repo.applyInputChange(r.m.id, { reason: "client_name_changed", actorId: null });
    expect(again).toMatchObject({ status: "stale", findingsMarkedStale: 0, reviewsMarkedStale: 0, runsSuperseded: 0 });
    // Stale findings keep the reason they first went stale for.
    expect(w.repo.listFindings(r.m.id, r.run.id)[0]?.staleReason).toBe("client_name_changed");
  });

  it("accepts only a short code as a reason, because the reason is stored on findings", () => {
    const m = addMatter(w);
    for (const bad of ["", "Has Spaces", "x".repeat(65), "UPPER", "the client renamed it", "1abc"])
      expect(() => w.repo.applyInputChange(m.id, { reason: bad, actorId: null }), bad).toThrow(ValidationError);
    expect(() => w.repo.applyInputChange("mat_0000000000000000", { reason: "document_changed", actorId: null })).toThrow(NotFoundError);
  });

  it("is atomic: if the audit event cannot be written nothing changes, including the edit that caused it", () => {
    const e = exported(w);
    w.db.exec(`CREATE TEMP TRIGGER fail_inputs_changed BEFORE INSERT ON audit_events
      WHEN NEW.action = 'inputs.changed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => w.repo.updateClientName(e.m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate })).toThrow("injected failure");

    expect(w.repo.getMatter(e.m.id)).toMatchObject({ clientLegalName: "Marlowe Analytics, Inc.", status: "exported", currentInputsSha256: e.run.inputsSha256 });
    expect(w.repo.listFindings(e.m.id, e.run.id).map((f) => f.validity)).toEqual(["current", "current", "current"]);
    expect(w.repo.getRun(e.m.id, e.run.id)?.status).toBe("succeeded");
    expect(w.repo.getCurrentMemo(e.m.id)?.id).toBe(e.memo.id);
    expect(w.repo.getExportReadiness(e.m.id, e.run.id).ready).toBe(true);
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });
});

describe("every method that changes an input invalidates by itself", () => {
  const cases: [string, string, (r: ReturnType<typeof exported>) => void][] = [
    ["a new version of an operative document, chosen", "document_changed", (r) => {
      w.repo.addVersion(r.m.id, r.m.nda.documentId, newVersion(r.m.id, "v2", { operative: true }), { actorId: ACTORS.associate });
    }],
    ["a new version of an operative document, not yet chosen", "document_changed", (r) => {
      w.repo.addVersion(r.m.id, r.m.nda.documentId, newVersion(r.m.id, "v2"), { actorId: ACTORS.associate });
    }],
    ["another version chosen as operative", "operative_changed", (r) => {
      // Add it while stale-proof by choosing it afterwards in a second step.
      const v = w.repo.addVersion(r.m.id, r.m.nda.documentId, newVersion(r.m.id, "v2"), { actorId: ACTORS.associate });
      w.repo.setOperativeVersion(r.m.id, v.id, { actorId: ACTORS.associate });
    }],
    ["an amendment added", "document_added", (r) => {
      w.repo.addDocument(r.m.id, { kind: "amendment", title: "A", version: newVersion(r.m.id, "a", { operative: true }) }, { actorId: ACTORS.associate });
    }],
    ["a document removed", "document_removed", (r) => {
      w.repo.removeDocument(r.m.id, r.m.nda.documentId, { actorId: ACTORS.associate });
    }],
    ["a stated date changed", "stated_date_changed", (r) => {
      w.repo.setStatedDate(r.m.id, r.m.nda.versionId, "2026-06-30", { actorId: ACTORS.associate });
    }],
    ["the client name edited", "client_name_changed", (r) => {
      w.repo.updateClientName(r.m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    }],
    ["another playbook version selected", "playbook_changed", (r) => {
      const yaml = `${PLAYBOOK_YAML}# 1.2\n`;
      const v = w.repo.approvePlaybookVersion(
        w.repo.importPlaybookDraft({ slug: "test-playbook", version: "1.2.0", yaml, sha256: sha256Hex(yaml), rules: RULES }, { actorId: ACTORS.legalEngineer }).id,
        { actorId: ACTORS.admin },
      );
      w.repo.setPlaybookVersion(r.m.id, v.id, { actorId: ACTORS.associate });
    }],
  ];

  for (const [title, reason, act] of cases) {
    it(`${title}: findings and decisions stale, memo superseded, run superseded, matter stale (${reason})`, () => {
      const r = exported(w, { amendment: true });
      act(r);
      expect(reasonsOf(r.m.id)).toContain(reason);
      expect(w.repo.listFindings(r.m.id, r.run.id).every((f) => f.validity === "stale" && f.staleReason !== null)).toBe(true);
      expect(w.repo.listFindings(r.m.id, r.run.id).flatMap((f) => f.reviews).every((x) => x.validity === "stale")).toBe(true);
      expect(w.repo.getCurrentMemo(r.m.id)).toBeUndefined();
      expect(w.repo.getMemo(r.m.id, r.memo.id)?.status).toBe("superseded");
      expect(w.repo.getRun(r.m.id, r.run.id)?.status).toBe("superseded");
      expect(w.repo.getMatter(r.m.id)?.status).toBe("stale");
      expect(w.repo.getExportReadiness(r.m.id, r.run.id).ready).toBe(false);
    });
  }

  it("the first reason recorded on a finding is the one that made it stale", () => {
    const r = exported(w, { amendment: true });
    w.repo.addVersion(r.m.id, r.m.nda.documentId, newVersion(r.m.id, "v2"), { actorId: ACTORS.associate });
    expect(w.repo.listFindings(r.m.id, r.run.id)[0]?.staleReason).toBe("document_changed");
  });
});

describe("the rows of the invalidation table in docs/parol/03", () => {
  // The fixture itself pins a playbook, which is an input change; only events after that count.
  const baseline = new WeakMap<object, number>();
  const exportedMatter = (opts: Parameters<typeof exported>[1] = {}) => {
    const r = exported(w, opts);
    baseline.set(r, reasonsOf(r.m.id).length);
    return r;
  };
  const untouched = (r: ReturnType<typeof exported>) => {
    expect(w.repo.listFindings(r.m.id, r.run.id).every((f) => f.validity === "current")).toBe(true);
    expect(w.repo.listFindings(r.m.id, r.run.id).flatMap((f) => f.reviews).every((x) => x.validity === "current")).toBe(true);
    expect(w.repo.getCurrentMemo(r.m.id)?.id).toBe(r.memo.id);
    expect(w.repo.getRun(r.m.id, r.run.id)?.status).toBe("succeeded");
    expect(w.repo.getMatter(r.m.id)?.status).toBe("exported");
    expect(w.repo.getExportReadiness(r.m.id, r.run.id).ready).toBe(true);
    expect(reasonsOf(r.m.id)).toHaveLength(baseline.get(r) as number);
  };

  it("identical file re-uploaded: the lookup finds it, and looking changes nothing", () => {
    const r = exportedMatter();
    const existing = w.repo.getVersion(r.m.id, r.m.nda.versionId);
    expect(w.repo.findVersionByFileSha256(r.m.id, existing?.fileSha256 as string)?.id).toBe(r.m.nda.versionId);
    untouched(r);
  });

  it("re-saved file with identical text: the lookup finds it by text hash, and looking changes nothing", () => {
    const r = exportedMatter();
    const existing = w.repo.getVersion(r.m.id, r.m.nda.versionId);
    expect(w.repo.findVersionByTextSha256(r.m.id, existing?.textSha256 as string)?.id).toBe(r.m.nda.versionId);
    expect(w.repo.findVersionByFileSha256(r.m.id, sha256Hex("different bytes"))).toBeUndefined();
    untouched(r);
  });

  it("new playbook version approved but not selected: nothing changes", () => {
    const r = exportedMatter();
    const yaml = `${PLAYBOOK_YAML}# 1.1\n`;
    const v = w.repo.importPlaybookDraft({ slug: "test-playbook", version: "1.1.0", yaml, sha256: sha256Hex(yaml), rules: RULES }, { actorId: ACTORS.legalEngineer });
    w.repo.approvePlaybookVersion(v.id, { actorId: ACTORS.admin });
    untouched(r);
    expect(w.repo.getMatter(r.m.id)?.playbookVersionId).toBe(w.playbook.id);
  });

  it("workflow version promoted to pilot: existing runs keep their label and nothing changes", () => {
    const r = exportedMatter();
    const next = { ...WORKFLOW_MANIFEST, label: "v2", retrieval: "R2" as const };
    const wf = w.repo.upsertWorkflowVersion({ manifest: next, sha256: hashOf(next) });
    w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: "docs/promotions/v2.md" });
    untouched(r);
    expect(w.repo.getRun(r.m.id, r.run.id)?.workflowVersionId).toBe(w.workflow.id);
  });

  it("same client name, same playbook, same operative version, same date: nothing changes", () => {
    const r = exportedMatter();
    w.repo.updateClientName(r.m.id, "  Marlowe Analytics, Inc.  ", { actorId: ACTORS.associate });
    w.repo.setPlaybookVersion(r.m.id, w.playbook.id, { actorId: ACTORS.associate });
    w.repo.setOperativeVersion(r.m.id, r.m.nda.versionId, { actorId: ACTORS.associate });
    w.repo.setStatedDate(r.m.id, r.m.nda.versionId, "2026-01-15", { actorId: ACTORS.associate });
    untouched(r);
  });

  it("a stated date on a version that is not operative is not an input", () => {
    const r = exportedMatter();
    // A second, non-operative version of the same document. It is written around addVersion, which
    // would clear the operative flag of the first and so change the inputs.
    w.db
      .prepare(
        `INSERT INTO document_versions
           (id, document_id, matter_id, version_no, media_type, file_sha256, text_sha256, byte_size,
            stated_date, operative, storage_path, uploaded_by, uploaded_at)
         SELECT 'ver_side', document_id, matter_id, 2, media_type, ?, ?, 1, NULL, 0, storage_path,
                uploaded_by, uploaded_at
         FROM document_versions WHERE id = ?`,
      )
      .run(sha256Hex("side file"), sha256Hex("side text"), r.m.nda.versionId);
    w.repo.setStatedDate(r.m.id, "ver_side", "2026-09-09", { actorId: ACTORS.associate });
    expect(w.repo.getVersion(r.m.id, "ver_side")?.statedDate).toBe("2026-09-09");
    untouched(r);
  });

  it("re-run with unchanged inputs: new findings, the old ones superseded with the run, decisions not carried over", () => {
    const r = reviewable(w);
    const oldReviews = r.findings.map((f) =>
      w.repo.recordReview(r.m.id, f.id, { reviewerId: ACTORS.reviewer, decision: "accept", findingContentSha256: f.contentSha256 }),
    );
    const digestBefore = w.repo.computeInputsDigest(r.m.id);

    // A matter that has results does not start a new run from in_review; the explicit act is to discard them.
    w.repo.applyInputChange(r.m.id, { reason: "rerun_requested", actorId: ACTORS.associate });
    expect(w.repo.getMatter(r.m.id)?.status).toBe("stale");
    const run2 = startRun(w, { ...r.m });
    const findings2 = saveAll(w, r.m, run2);
    succeed(w, r.m, run2);

    expect(w.repo.getRun(r.m.id, r.run.id)?.status).toBe("superseded");
    expect(w.repo.computeInputsDigest(r.m.id)).toBe(digestBefore);
    expect(findings2.every((f) => f.validity === "current" && f.reviews.length === 0)).toBe(true);
    expect(w.repo.listFindings(r.m.id, r.run.id).every((f) => f.validity === "stale")).toBe(true);
    // The prior decision is there for reference, and because the content is the same, a one-click re-confirm is possible.
    const prior = w.repo.listReviewsForRule(r.m.id, "dur-1");
    expect(prior.map((p) => p.id)).toEqual([oldReviews[1]?.id]);
    expect(prior[0]?.findingContentSha256).toBe(findings2[1]?.contentSha256);
    expect(w.repo.getExportReadiness(r.m.id, run2.id).blockers.map((b) => b.reason)).toEqual(["no_review", "no_review", "no_review"]);
    expect(allFindings(r.m)).toHaveLength(3);
  });
});
