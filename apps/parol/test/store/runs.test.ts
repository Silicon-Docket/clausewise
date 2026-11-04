import { beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import {
  ActiveRunError,
  ConflictError,
  InputsIncompleteError,
  InvalidTransitionError,
  NotFoundError,
  StaleRunError,
  ValidationError,
} from "../../src/store/index.js";
import { ACTORS, addMatter, makeWorld, startRun, type MatterFixture, type World } from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const opts = (w: World) => ({ workflowVersionId: w.workflow.id, modelProvider: "scripted", model: "scripted-1" });
const create = (w: World, m: MatterFixture, over: object = {}) =>
  w.repo.createRun(m.id, { manifest: w.repo.buildRunManifest(m.id, opts(w)), startedBy: ACTORS.associate, ...over });

describe("buildRunManifest", () => {
  it("describes the operative documents in label order, the playbook, the workflow and the model", () => {
    const m = addMatter(w, { amendment: true });
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    expect(manifest).toEqual({
      matterId: m.id,
      clientLegalName: "Marlowe Analytics, Inc.",
      documents: [
        {
          documentVersionId: m.nda.versionId,
          label: "D1",
          kind: "nda",
          title: "Mutual NDA",
          versionNo: 1,
          statedDate: "2026-01-15",
          textSha256: w.repo.getVersion(m.id, m.nda.versionId)?.textSha256,
        },
        {
          documentVersionId: m.amendment?.versionId,
          label: "D2",
          kind: "amendment",
          title: "Amendment No. 1",
          versionNo: 1,
          statedDate: "2026-02-20",
          textSha256: w.repo.getVersion(m.id, m.amendment?.versionId as string)?.textSha256,
        },
      ],
      playbook: { versionId: w.playbook.id, slug: "test-playbook", version: "1.0.0", sha256: w.playbook.sha256 },
      workflow: { versionId: w.workflow.id, label: "v1", sha256: w.workflow.sha256 },
      model: { provider: "scripted", model: "scripted-1" },
    });
  });

  it("is refused while the inputs are incomplete, and for an unknown workflow", () => {
    const m = addMatter(w, { pinPlaybook: false });
    expect(() => w.repo.buildRunManifest(m.id, opts(w))).toThrow(InputsIncompleteError);
    w.repo.setPlaybookVersion(m.id, w.playbook.id, { actorId: ACTORS.associate });
    expect(() => w.repo.buildRunManifest(m.id, { ...opts(w), workflowVersionId: "wfv_nope" })).toThrow(NotFoundError);
  });
});

describe("createRun", () => {
  it("records the manifest, its hash and the inputs digest, and moves the matter to running", () => {
    const m = addMatter(w, { amendment: true });
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    const run = w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
    expect(run).toMatchObject({
      matterId: m.id,
      status: "queued",
      purpose: "matter",
      workflowVersionId: w.workflow.id,
      playbookVersionId: w.playbook.id,
      modelProvider: "scripted",
      modelRequested: "scripted-1",
      modelReported: null,
      startedBy: ACTORS.associate,
      finishedAt: null,
      errorKind: null,
    });
    expect(run.manifest).toEqual(manifest);
    expect(run.inputManifestSha256).toBe(hashOf(manifest));
    expect(run.inputManifestSha256).toBe(sha256Hex(run.inputManifestJson));
    expect(run.inputsSha256).toBe(w.repo.computeInputsDigest(m.id));
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
    const event = w.repo.listAuditEvents({ matterId: m.id, action: "run.create" })[0];
    expect(event).toMatchObject({ actorId: ACTORS.associate, targetId: run.id });
    expect(event?.detail).toMatchObject({ manifestSha256: run.inputManifestSha256, inputsSha256: run.inputsSha256, purpose: "matter" });
  });

  it("accepts the hash and the digest when the caller computed them, and rejects them when wrong", () => {
    const m = addMatter(w);
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    expect(() => create(w, m, { manifestSha256: sha256Hex("wrong") })).toThrow(/not the hash/);
    expect(() => create(w, m, { inputsSha256: sha256Hex("wrong") })).toThrow(StaleRunError);
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
    const run = w.repo.createRun(m.id, {
      manifest,
      startedBy: ACTORS.associate,
      manifestSha256: hashOf(manifest),
      inputsSha256: w.repo.computeInputsDigest(m.id) as string,
    });
    expect(run.status).toBe("queued");
  });

  it("is refused unless the inputs digest is non-null", () => {
    const m = addMatter(w);
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    // Uploading a new version clears the operative flag until one is chosen.
    w.repo.addVersion(
      m.id,
      m.nda.documentId,
      { mediaType: "txt", fileSha256: sha256Hex("f2"), textSha256: sha256Hex("t2"), byteSize: 2, statedDate: null, storagePath: `${m.id}/f_${"d".repeat(32)}` },
      { actorId: ACTORS.associate },
    );
    expect(w.repo.computeInputsDigest(m.id)).toBeNull();
    expect(() => w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate })).toThrow(InputsIncompleteError);
    expect(w.repo.listRunsForMatter(m.id)).toEqual([]);
  });

  it("is refused for a manifest built before an input changed", () => {
    const m = addMatter(w);
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate })).toThrow(StaleRunError);
    // A manifest built afterwards is fine.
    expect(create(w, m).status).toBe("queued");
  });

  it("is refused for a manifest that does not describe this matter's inputs", () => {
    const m = addMatter(w);
    const other = addMatter(w, { name: "other" });
    const manifest = w.repo.buildRunManifest(m.id, opts(w));
    const go = (changed: object) => w.repo.createRun(m.id, { manifest: { ...manifest, ...changed } as never, startedBy: ACTORS.associate });
    expect(() => go({ matterId: other.id })).toThrow(/different matter/);
    expect(() => go({ documents: manifest.documents.map((d) => ({ ...d, title: "Forged title" })) })).toThrow(/does not match/);
    expect(() => go({ playbook: { ...manifest.playbook, sha256: sha256Hex("other playbook") } })).toThrow(StaleRunError);
    expect(() => go({ workflow: { ...manifest.workflow, sha256: sha256Hex("other workflow") } })).toThrow(/does not match/);
    expect(() => go({ extra: true })).toThrow(ValidationError);
    expect(() => go({ documents: [] })).toThrow(ValidationError);
    expect(() => go({ workflow: { ...manifest.workflow, versionId: "wfv_nope" } })).toThrow(NotFoundError);
    expect(w.repo.listRunsForMatter(m.id)).toEqual([]);
  });

  it("is refused while a run is active, and says which", () => {
    const m = addMatter(w);
    const first = create(w, m);
    let caught: unknown;
    try {
      create(w, m);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ActiveRunError);
    expect((caught as ActiveRunError).activeRunId).toBe(first.id);
    expect(w.repo.listRunsForMatter(m.id)).toHaveLength(1);
  });

  it("starts from ready or stale only", () => {
    const m = addMatter(w);
    const run = startRun(w, m, "verifying");
    w.repo.updateRunStatus(m.id, run.id, "succeeded");
    expect(w.repo.getMatter(m.id)?.status).toBe("in_review");
    expect(() => create(w, m)).toThrow(/in_review/);
    expect(() => create(w, m)).toThrow(ConflictError);
  });

  it("can be re-run from stale", () => {
    const m = addMatter(w);
    const run = startRun(w, m, "verifying");
    w.repo.updateRunStatus(m.id, run.id, "succeeded");
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(w.repo.getMatter(m.id)?.status).toBe("stale");
    const second = create(w, m);
    expect(second.status).toBe("queued");
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
    expect(w.repo.listRunsForMatter(m.id).map((r) => r.id)).toEqual([second.id, run.id]);
  });

  it("refuses unknown starters, retired workflows and an unapproved playbook", () => {
    const m = addMatter(w);
    expect(() => create(w, m, { startedBy: "usr_nobody" })).toThrow(NotFoundError);
    w.db.prepare("UPDATE workflow_versions SET status = 'retired' WHERE id = ?").run(w.workflow.id);
    expect(() => create(w, m)).toThrow(/retired/);
    expect(() => create(w, m, { purpose: "other" })).toThrow(ValidationError);
  });

  it("records the purpose", () => {
    const m = addMatter(w, { synthetic: true });
    expect(create(w, m, { purpose: "eval" }).purpose).toBe("eval");
  });
});

describe("updateRunStatus", () => {
  it("walks the stages, finishing a run and moving the matter with it", () => {
    const m = addMatter(w);
    const run = create(w, m);
    for (const status of ["ingesting", "extracting", "retrieving", "analyzing", "verifying"] as const) {
      expect(w.repo.updateRunStatus(m.id, run.id, status)).toMatchObject({ status, finishedAt: null });
      expect(w.repo.getMatter(m.id)?.status).toBe("running");
    }
    w.clock.tick();
    const done = w.repo.updateRunStatus(m.id, run.id, "succeeded", { modelReported: "scripted-1-20261101" });
    expect(done).toMatchObject({ status: "succeeded", modelReported: "scripted-1-20261101", finishedAt: w.clock.iso() });
    expect(w.repo.getMatter(m.id)?.status).toBe("in_review");
    expect(w.repo.getActiveRun(m.id)).toBeUndefined();
    expect(w.repo.getCurrentRun(m.id)?.id).toBe(run.id);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "run.status" })).toHaveLength(6);
  });

  it("returns the matter to ready when a run fails or is cancelled, recording why", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const failed = w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "provider_auth" });
    expect(failed).toMatchObject({ status: "failed", errorKind: "provider_auth" });
    expect(failed.finishedAt).not.toBeNull();
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");

    const next = create(w, m);
    const cancelled = w.repo.updateRunStatus(m.id, next.id, "cancelled");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.errorKind).toBeNull();
    expect(w.repo.getMatter(m.id)?.status).toBe("ready");
  });

  it("refuses edges that are not on the diagram, and superseded as a target", () => {
    const m = addMatter(w);
    const run = create(w, m);
    expect(() => w.repo.updateRunStatus(m.id, run.id, "verifying")).toThrow(InvalidTransitionError);
    expect(() => w.repo.updateRunStatus(m.id, run.id, "succeeded")).toThrow(InvalidTransitionError);
    expect(() => w.repo.updateRunStatus(m.id, run.id, "superseded")).toThrow(InvalidTransitionError);
    expect(() => w.repo.updateRunStatus(m.id, run.id, "queued")).toThrow(InvalidTransitionError);
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    expect(() => w.repo.updateRunStatus(m.id, run.id, "ingesting")).toThrow(InvalidTransitionError);
    expect(() => w.repo.updateRunStatus(m.id, "run_nope", "ingesting")).toThrow(NotFoundError);
    expect(() => w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "Has Spaces" })).toThrow(ValidationError);
  });

  it("tells whoever is working on a superseded run to stop", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(w.repo.getRun(m.id, run.id)?.status).toBe("superseded");
    for (const to of ["verifying", "failed", "cancelled", "succeeded"] as const)
      expect(() => w.repo.updateRunStatus(m.id, run.id, to), to).toThrow(StaleRunError);
  });

  it("resumes a failed run on unchanged inputs, and not otherwise", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "interrupted" });
    const resumed = w.repo.updateRunStatus(m.id, run.id, "queued");
    expect(resumed).toMatchObject({ status: "queued", errorKind: null, finishedAt: null });
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
    w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "interrupted" });

    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => w.repo.updateRunStatus(m.id, run.id, "queued")).toThrow(StaleRunError);
  });

  it("will not resume while another run is active", () => {
    const m = addMatter(w);
    const first = startRun(w, m);
    w.repo.updateRunStatus(m.id, first.id, "failed", { errorKind: "interrupted" });
    const second = create(w, m);
    expect(() => w.repo.updateRunStatus(m.id, first.id, "queued")).toThrow(ActiveRunError);
    expect(w.repo.getRun(m.id, second.id)?.status).toBe("queued");
  });

  it("closes the stage rows of a run that ends", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "dur-1", inputSha256: sha256Hex("in") });
    w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "provider_auth" });
    expect(w.repo.listStages(m.id, run.id)[0]).toMatchObject({ status: "failed", errorKind: "provider_auth" });
  });
});

describe("markInterruptedOnBoot", () => {
  it("fails every run a crash left in flight, across matters, and frees the matters", () => {
    const a = addMatter(w);
    const b = addMatter(w, { name: "b" });
    const c = addMatter(w, { name: "c" });
    const runA = startRun(w, a, "analyzing");
    const runB = startRun(w, b, "queued");
    const runC = startRun(w, c, "verifying");
    w.repo.updateRunStatus(c.id, runC.id, "succeeded");
    w.repo.recordStageStart(a.id, runA.id, { stage: "analyze", unit: "pty-1", inputSha256: sha256Hex("x") });

    const interrupted = w.repo.markInterruptedOnBoot();
    expect(interrupted.map((r) => r.runId).sort()).toEqual([runA.id, runB.id].sort());
    expect(w.repo.getRun(a.id, runA.id)).toMatchObject({ status: "failed", errorKind: "interrupted" });
    expect(w.repo.getRun(b.id, runB.id)).toMatchObject({ status: "failed", errorKind: "interrupted" });
    expect(w.repo.getRun(c.id, runC.id)?.status).toBe("succeeded");
    expect(w.repo.getMatter(a.id)?.status).toBe("ready");
    expect(w.repo.getMatter(b.id)?.status).toBe("ready");
    expect(w.repo.getMatter(c.id)?.status).toBe("in_review");
    expect(w.repo.listStages(a.id, runA.id)[0]).toMatchObject({ status: "failed", errorKind: "interrupted" });
    expect(w.repo.markInterruptedOnBoot()).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: a.id, action: "run.status" }).at(-1)?.detail).toMatchObject({ to: "failed", errorKind: "interrupted" });
    // Resume picks it up.
    expect(w.repo.updateRunStatus(a.id, runA.id, "queued").status).toBe("queued");
  });
});

describe("stages", () => {
  const input = sha256Hex("stage input");

  it("records a start and a result, and numbers the attempts", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const first = w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "dur-1", inputSha256: input });
    expect(first).toMatchObject({ stage: "analyze", unit: "dur-1", attempt: 1, status: "running", output: null });
    const closed = w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "dur-1", attempt: 1, status: "failed", errorKind: "schema_error" });
    expect(closed).toMatchObject({ status: "failed", errorKind: "schema_error", output: null, outputSha256: null });
    const second = w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "dur-1", inputSha256: input });
    expect(second.attempt).toBe(2);
    expect(w.repo.recordStageStart(m.id, run.id, { stage: "extract", inputSha256: input }).unit).toBe("*");
    expect(() => w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "dur-1", attempt: 1, status: "succeeded" })).toThrow(/already has a result/);
    expect(() => w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "dur-1", attempt: 9, status: "succeeded" })).toThrow(NotFoundError);
  });

  it("stores the output with its hash and finds it again by input hash", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const output = { status: "compliant", evidence: [{ span: "c3", quote: "two (2) years" }], nested: { a: [1, 2, null] } };
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "dur-1", inputSha256: input });
    const done = w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "dur-1", attempt: 1, status: "succeeded", output });
    expect(done.output).toEqual(output);
    expect(done.outputSha256).toBe(hashOf(output));

    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "dur-1", input)?.output).toEqual(output);
    // Another input, unit or stage is not a hit: resume must redo that work.
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "dur-1", sha256Hex("different input"))).toBeUndefined();
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "gov-1", input)).toBeUndefined();
    expect(w.repo.findReusableStage(m.id, run.id, "verify", "dur-1", input)).toBeUndefined();
  });

  it("does not reuse a failed attempt, a running one, or an output that no longer hashes", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "a", inputSha256: input });
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "a", input)).toBeUndefined();
    w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "a", attempt: 1, status: "failed" });
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "a", input)).toBeUndefined();

    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "a", inputSha256: input });
    w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "a", attempt: 2, status: "succeeded", output: { ok: 1 } });
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "a", input)).toBeDefined();
    w.db.prepare("UPDATE run_stages SET output_json = '{\"ok\":2}' WHERE run_id = ? AND attempt = 2").run(run.id);
    expect(w.repo.findReusableStage(m.id, run.id, "analyze", "a", input)).toBeUndefined();
  });

  it("prefers the newest successful attempt", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    for (const [attempt, value] of [[1, "old"], [2, "new"]] as const) {
      w.repo.recordStageStart(m.id, run.id, { stage: "extract", inputSha256: input });
      w.repo.recordStageResult(m.id, run.id, { stage: "extract", attempt, status: "succeeded", output: { value } });
    }
    expect(w.repo.findReusableStage(m.id, run.id, "extract", "*", input)?.output).toEqual({ value: "new" });
  });

  it("validates names, hashes and JSON", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(() => w.repo.recordStageStart(m.id, run.id, { stage: "Bad Stage", inputSha256: input })).toThrow(ValidationError);
    expect(() => w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "has space", inputSha256: input })).toThrow(ValidationError);
    expect(() => w.repo.recordStageStart(m.id, run.id, { stage: "analyze", inputSha256: "short" })).toThrow(ValidationError);
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", inputSha256: input });
    expect(() => w.repo.recordStageResult(m.id, run.id, { stage: "analyze", attempt: 1, status: "succeeded", output: { n: Number.NaN } })).toThrow();
    expect(w.repo.listStages(m.id, run.id)[0]?.status).toBe("running");
  });

  it("refuses writes for a superseded run, so a stage stops spending money", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "a", inputSha256: input });
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => w.repo.recordStageStart(m.id, run.id, { stage: "analyze", unit: "b", inputSha256: input })).toThrow(StaleRunError);
    expect(() => w.repo.recordStageResult(m.id, run.id, { stage: "analyze", unit: "a", attempt: 1, status: "succeeded", output: {} })).toThrow(StaleRunError);
    // The half-finished stage was closed when the run was superseded.
    expect(w.repo.listStages(m.id, run.id)[0]).toMatchObject({ status: "failed", errorKind: "superseded" });
  });
});

describe("model calls", () => {
  const call = (over: object = {}) => ({
    stage: "analyze" as const,
    ruleKey: "dur-1",
    promptVersionId: "analyze.p1",
    requestSha256: sha256Hex("request"),
    attempt: 1,
    outcome: "ok" as const,
    latencyMs: 812.4,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 0,
    cacheWriteTokens: null,
    ...over,
  });

  it("records calls with hashes, counts and timings, and lists them in order", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const rows = w.repo.insertModelCalls(m.id, run.id, [call(), call({ stage: "extract", ruleKey: null, promptVersionId: "extract.p1", attempt: 2, outcome: "schema_error", costUsdEstimate: 0.0123, priceTableSha256: sha256Hex("prices") })]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ stage: "analyze", ruleKey: "dur-1", latencyMs: 812, inputTokens: 1200, cacheWriteTokens: null, costUsdEstimate: null });
    expect(rows[1]).toMatchObject({ stage: "extract", ruleKey: null, outcome: "schema_error", costUsdEstimate: 0.0123 });
    expect(w.repo.listModelCalls(m.id, run.id).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it("has no column that could hold prompt or response text, and ignores text a caller attaches", () => {
    const columns = (w.db.prepare("PRAGMA table_info(model_calls)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.filter((c) => /prompt$|response|text|body|content|message/.test(c))).toEqual([]);
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.insertModelCalls(m.id, run.id, [
      call({ prompt: "PROMPT-WITH-CLAUSE-TEXT", response: "RESPONSE-WITH-CLAUSE-TEXT", system: "SYSTEM-TEXT" }) as never,
    ]);
    const dump = JSON.stringify(w.db.prepare("SELECT * FROM model_calls").all());
    expect(dump).not.toContain("CLAUSE-TEXT");
    expect(dump).not.toContain("SYSTEM-TEXT");
  });

  it("refuses a prompt version that is not registered, and malformed records, writing none of them", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call(), call({ promptVersionId: "analyze.p9" })])).toThrow(NotFoundError);
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call({ outcome: "great" })])).toThrow(ValidationError);
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call({ requestSha256: "x" })])).toThrow(ValidationError);
    expect(() => w.repo.insertModelCalls(m.id, run.id, [call({ latencyMs: -1 })])).toThrow(ValidationError);
    expect(w.repo.listModelCalls(m.id, run.id)).toEqual([]);
  });

  it("still records the cost of calls made for a run that was superseded meanwhile", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(w.repo.insertModelCalls(m.id, run.id, [call()])).toHaveLength(1);
  });
});
