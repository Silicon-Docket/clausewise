import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import {
  ActiveRunError,
  ContentMismatchError,
  ExportBlockedError,
  InputsIncompleteError,
  InvalidTransitionError,
  NotFoundError,
  StaleFindingError,
  StaleRunError,
  StoreError,
  type NewVersionInput,
} from "../../src/store/index.js";
import {
  ACTORS,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  buildSpans,
  exported,
  fakePath,
  findingFor,
  makeWorld,
  rehash,
  reviewable,
  startRun,
  succeed,
  type World,
} from "./fixtures.js";

/**
 * An id arrives in a request, so it can be anything an attacker types, and a message that repeats it
 * carries it into the logs. The first probe below uses a value shaped exactly like an id, because
 * a check that lets well-formed ids through is the check that was missed before.
 */
const ID = "zq-secret-id-9c1e";
const HASH = sha256Hex("any");

interface Refusal {
  code: string;
  message: string;
  error: StoreError;
}

function refusal(fn: () => unknown): Refusal {
  try {
    fn();
  } catch (error) {
    expect(error, "a probe must be refused by the store, not crash").toBeInstanceOf(StoreError);
    const e = error as StoreError;
    return { code: e.code, message: e.message, error: e };
  }
  throw new Error("expected the store to refuse this call");
}

const newVersion = (matterId: string, seed: string): NewVersionInput => ({
  mediaType: "txt",
  fileSha256: sha256Hex(`file-${seed}`),
  textSha256: sha256Hex(`text-${seed}`),
  byteSize: 1,
  statedDate: null,
  storagePath: fakePath(matterId),
});

/** Every probe builds the state it needs, so none depends on another. */
function probes(w: World): Record<string, { run: () => unknown; forbidden: string[] }> {
  const { repo } = w;
  const evalRun = () => {
    const dataset = repo.createEvalDataset({
      label: "set",
      devSha256: "a".repeat(64),
      heldoutSha256: "b".repeat(64),
    });
    return repo.createEvalRun(
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
  };
  const actor = { actorId: ACTORS.associate };
  const ids = Object.values(ACTORS);
  const ruleKeys = RULES.map((r) => r.key);
  const out: Record<string, { run: () => unknown; forbidden: string[] }> = {};

  /** `forbidden` also lists the real ids the probe touches, which must stay out of the message too. */
  const add = (name: string, run: () => unknown, ...forbidden: string[]) => {
    out[name] = {
      run,
      forbidden: [ID, ...ids, ...ruleKeys, w.playbook.id, w.workflow.id, ...forbidden],
    };
  };

  // --- not found: the id is the thing that must not come back ---
  add("run, read", () => {
    const e = exported(w);
    return repo.getExportReadiness(e.m.id, ID);
  });
  add("run, status", () => {
    const e = exported(w);
    return repo.updateRunStatus(e.m.id, ID, "failed");
  });
  add("run, stage start", () => {
    const e = exported(w);
    return repo.recordStageStart(e.m.id, ID, { stage: "extract", inputSha256: HASH });
  });
  add(
    "run, stage result",
    () => {
      const e = exported(w);
      return repo.recordStageResult(e.m.id, e.run.id, {
        stage: "zq_secret_stage",
        unit: "zq-secret-unit",
        attempt: 1,
        status: "succeeded",
      });
    },
    "zq_secret_stage",
    "zq-secret-unit",
  );
  add("run, model calls", () => {
    const e = exported(w);
    return repo.insertModelCalls(e.m.id, e.run.id, [
      {
        stage: "extract",
        ruleKey: null,
        promptVersionId: ID,
        requestSha256: HASH,
        attempt: 1,
        outcome: "ok",
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      },
    ]);
  });
  add("run, save findings", () => {
    const e = exported(w);
    return repo.saveFindings(e.m.id, ID, []);
  });
  add("run, memo", () => {
    const e = exported(w);
    return repo.recordMemo(e.m.id, {
      runId: ID,
      reviewIds: [],
      fileSha256: HASH,
      storagePath: fakePath(e.m.id),
      exportedBy: ACTORS.reviewer,
    });
  });
  add("run, feedback", () => {
    const e = exported(w);
    return repo.addFeedback(e.m.id, {
      userId: ACTORS.reviewer,
      kind: "comment",
      text: "t",
      runId: ID,
    });
  });
  add("finding, review", () => {
    const e = exported(w);
    return repo.recordReview(e.m.id, ID, {
      reviewerId: ACTORS.reviewer,
      decision: "accept",
      findingContentSha256: HASH,
    });
  });
  add("finding, feedback", () => {
    const e = exported(w);
    return repo.addFeedback(e.m.id, {
      userId: ACTORS.reviewer,
      kind: "comment",
      text: "t",
      findingId: ID,
    });
  });
  add(
    "evidence, review edit",
    () => {
      const r = reviewable(w);
      const f = r.findings[0]!;
      return repo.recordReview(r.m.id, f.id, {
        reviewerId: ACTORS.reviewer,
        decision: "edit",
        reasonCode: "other",
        reason: "r",
        edits: { evidenceRoles: [{ evidenceId: ID, role: "supporting" }] },
        findingContentSha256: f.contentSha256,
      });
    },
    "usr_demo",
  );
  add("user, member", () => {
    const e = exported(w);
    return repo.addMember(e.m.id, ID, "viewer", actor);
  });
  add("user, creator", () => repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ID }));
  add("document version, operative", () => {
    const e = exported(w);
    return repo.setOperativeVersion(e.m.id, ID, actor);
  });
  add("document version, stated date", () => {
    const e = exported(w);
    return repo.setStatedDate(e.m.id, ID, "2026-01-01", actor);
  });
  add("document, new version", () => {
    const e = exported(w);
    return repo.addVersion(e.m.id, ID, newVersion(e.m.id, "v"), actor);
  });
  add("document, remove", () => {
    const e = exported(w);
    return repo.removeDocument(e.m.id, ID, actor);
  });
  add("playbook version, pin", () => {
    const e = exported(w);
    return repo.setPlaybookVersion(e.m.id, ID, actor);
  });
  add("playbook version, approve", () =>
    repo.approvePlaybookVersion(ID, { actorId: ACTORS.admin }),
  );
  add("workflow version, promote", () =>
    repo.promoteWorkflowVersion(ID, { actorId: ACTORS.admin, promotionRecord: "docs/record.md" }),
  );
  add("workflow version, manifest", () => {
    const r = reviewable(w);
    return repo.buildRunManifest(r.m.id, { workflowVersionId: ID, modelProvider: "p", model: "m" });
  });
  add("span, annotation", () => {
    const e = exported(w);
    return repo.insertSpans(e.m.id, [], [{ kind: "uses_term", spanId: ID, term: "t" }]);
  });
  add("document version, spans", () => {
    const e = exported(w);
    return repo.insertSpans(e.m.id, buildSpans(ID, "D1", ["a"]));
  });
  add("matter, delete", () => repo.deleteMatter(ID, { actorId: ACTORS.admin }));
  add("eval dataset", () =>
    repo.createEvalRun(
      {
        datasetId: ID,
        split: "dev",
        workflowVersionId: w.workflow.id,
        playbookVersionId: w.playbook.id,
        model: "m",
        repeats: 1,
        priceTableSha256: HASH,
        resultsPath: "r.json",
      },
      { actorId: null },
    ),
  );
  add("eval run, finish", () => repo.finishEvalRun(ID, { actorId: null }));
  add("eval run, slot", () => {
    const e = exported(w);
    return repo.recordEvalSlotResult(
      e.m.id,
      {
        evalRunId: ID,
        caseKey: "C1",
        ruleKey: "dur-1",
        repeat: 0,
        runId: e.run.id,
        expectedStatus: "compliant",
        gotStatus: "compliant",
        scores: {},
      },
      { actorId: null },
    );
  });

  // --- conflicts: the ids of the rows involved are the thing that must not come back ---
  add(
    "member exists",
    () => {
      const e = exported(w);
      return repo.addMember(e.m.id, ACTORS.associate, "viewer", actor);
    },
    "mat_",
  );
  add(
    "second NDA",
    () => {
      const e = exported(w);
      return repo.addDocument(
        e.m.id,
        { kind: "nda", title: "t", version: newVersion(e.m.id, "n") },
        actor,
      );
    },
    "mat_",
  );
  add(
    "third amendment",
    () => {
      const m = addMatter(w, { amendment: true });
      repo.addDocument(
        m.id,
        { kind: "amendment", title: "A2", version: newVersion(m.id, "a2") },
        actor,
      );
      return repo.addDocument(
        m.id,
        { kind: "amendment", title: "A3", version: newVersion(m.id, "a3") },
        actor,
      );
    },
    "mat_",
    "doc_",
  );
  add(
    "spans differ",
    () => {
      const e = exported(w);
      return repo.insertSpans(e.m.id, buildSpans(e.m.nda.versionId, "D1", ["different"]));
    },
    "ver_",
  );
  add(
    "run already active",
    () => {
      const m = addMatter(w);
      const manifest = repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
      repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
      return repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
    },
    "mat_",
    "run_",
  );
  add(
    "inputs incomplete",
    () => {
      const m = addMatter(w, { pinPlaybook: false });
      return repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
    },
    "mat_",
  );
  add(
    "matter not runnable",
    () => {
      const e = exported(w);
      const manifest = repo.buildRunManifest(e.m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
      return repo.createRun(e.m.id, { manifest, startedBy: ACTORS.associate });
    },
    "mat_",
  );
  add(
    "stale manifest",
    () => {
      const m = addMatter(w);
      const manifest = repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
      repo.updateClientName(m.id, "Changed Name, Inc.", actor);
      return repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
    },
    "mat_",
  );
  add(
    "superseded run, status",
    () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      repo.applyInputChange(m.id, { reason: "document_changed", actorId: null });
      return repo.updateRunStatus(m.id, run.id, "failed");
    },
    "mat_",
    "run_",
  );
  add(
    "superseded run, findings",
    () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      repo.applyInputChange(m.id, { reason: "document_changed", actorId: null });
      return repo.saveFindings(m.id, run.id, []);
    },
    "mat_",
    "run_",
  );
  add(
    "run not writing",
    () => {
      const e = exported(w);
      return repo.saveFindings(e.m.id, e.run.id, []);
    },
    "mat_",
    "run_",
  );
  add(
    "run transition",
    () => {
      const e = exported(w);
      return repo.updateRunStatus(e.m.id, e.run.id, "ingesting");
    },
    "mat_",
    "run_",
  );
  add(
    "run transition, unknown state",
    () => {
      const e = exported(w);
      return repo.updateRunStatus(e.m.id, e.run.id, ID as never);
    },
    "mat_",
    "run_",
  );
  add(
    "matter transition, unknown state",
    () => {
      const e = exported(w);
      return repo.setMatterStatus(e.m.id, ID as never, actor);
    },
    "mat_",
  );
  add(
    "matter not fully decided",
    () => {
      const r = reviewable(w);
      return repo.setMatterStatus(r.m.id, "review_complete", actor);
    },
    "mat_",
  );
  add(
    "matter not complete",
    () => {
      const m = addMatter(w, { pinPlaybook: false });
      return repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
    },
    "mat_",
  );
  add(
    "matter status that only an input change sets",
    () => {
      const m = addMatter(w);
      return repo.setMatterStatus(m.id, "stale", actor);
    },
    "mat_",
  );
  add(
    "stage on a run that is not in flight",
    () => {
      const e = exported(w);
      return repo.recordStageStart(e.m.id, e.run.id, {
        stage: "extract",
        inputSha256: sha256Hex("x"),
      });
    },
    "mat_",
    "run_",
  );
  add(
    "storage path already in use",
    () => {
      const m = addMatter(w);
      return repo.addDocument(
        m.id,
        {
          kind: "amendment",
          title: "Amendment",
          version: {
            mediaType: "txt",
            fileSha256: sha256Hex("another file"),
            textSha256: sha256Hex("another text"),
            byteSize: 1,
            statedDate: null,
            storagePath: repo.getVersion(m.id, m.nda.versionId)?.storagePath as string,
          },
        },
        actor,
      );
    },
    "mat_",
    "ver_",
  );
  add(
    "identical file uploaded again",
    () => {
      const m = addMatter(w);
      return repo.addVersion(
        m.id,
        m.nda.documentId,
        {
          mediaType: "txt",
          fileSha256: repo.getVersion(m.id, m.nda.versionId)?.fileSha256 as string,
          textSha256: sha256Hex("another text"),
          byteSize: 1,
          statedDate: null,
          storagePath: fakePath(m.id),
        },
        actor,
      );
    },
    "mat_",
    "doc_",
  );
  add(
    "matter has no run",
    () => {
      const m = addMatter(w);
      return repo.setMatterStatus(m.id, "running", actor);
    },
    "mat_",
  );
  add(
    "matter running, delete",
    () => {
      const m = addMatter(w);
      startRun(w, m);
      return repo.deleteMatter(m.id, actor);
    },
    "mat_",
  );
  add(
    "finding stale",
    () => {
      const r = reviewable(w);
      repo.applyInputChange(r.m.id, { reason: "document_changed", actorId: null });
      return repo.recordReview(r.m.id, r.findings[0]!.id, {
        reviewerId: ACTORS.reviewer,
        decision: "accept",
        findingContentSha256: r.findings[0]!.contentSha256,
      });
    },
    "mat_",
    "fnd_",
  );
  add(
    "content changed",
    () => {
      const r = reviewable(w);
      return repo.recordReview(r.m.id, r.findings[0]!.id, {
        reviewerId: ACTORS.reviewer,
        decision: "accept",
        findingContentSha256: HASH,
      });
    },
    "mat_",
    "fnd_",
  );
  add(
    "already exported",
    () => {
      const e = exported(w);
      return repo.recordReview(e.m.id, e.findings[0]!.id, {
        reviewerId: ACTORS.reviewer,
        decision: "accept",
        findingContentSha256: e.findings[0]!.contentSha256,
      });
    },
    "mat_",
    "fnd_",
  );
  add(
    "export blocked",
    () => {
      const r = reviewable(w);
      return repo.recordMemo(r.m.id, {
        runId: r.run.id,
        reviewIds: [],
        fileSha256: HASH,
        storagePath: fakePath(r.m.id),
        exportedBy: ACTORS.reviewer,
      });
    },
    "mat_",
    "run_",
  );
  add(
    "unknown rule",
    () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      const span = { id: m.nda.spanIds[2]!, text: m.nda.texts[2]! };
      return repo.saveFindings(m.id, run.id, [
        rehash({ ...findingFor("dur-1", span), ruleKey: ID }),
      ]);
    },
    "mat_",
    "run_",
  );
  add(
    "rule disagrees",
    () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      const span = { id: m.nda.spanIds[2]!, text: m.nda.texts[2]! };
      return repo.saveFindings(m.id, run.id, [
        rehash({ ...findingFor("dur-1", span), severity: "low" }),
      ]);
    },
    "mat_",
    "run_",
  );
  add(
    "finding exists with other content",
    () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      const span = { id: m.nda.spanIds[2]!, text: m.nda.texts[2]! };
      repo.saveFindings(m.id, run.id, [findingFor("dur-1", span)]);
      return repo.saveFindings(m.id, run.id, [
        rehash({ ...findingFor("dur-1", span), explanation: "Changed." }),
      ]);
    },
    "mat_",
    "run_",
  );
  add("playbook already approved", () =>
    repo.approvePlaybookVersion(w.playbook.id, { actorId: ACTORS.admin }),
  );
  add("playbook version exists", () =>
    repo.importPlaybookDraft(
      {
        slug: "test-playbook",
        version: "1.0.0",
        yaml: "different",
        sha256: sha256Hex("different"),
        rules: RULES,
      },
      { actorId: ACTORS.legalEngineer },
    ),
  );
  add("prompt id taken", () =>
    repo.upsertPromptVersion({
      id: "analyze.p1",
      stage: "analyze",
      template: "other",
      schemaJson: "{}",
      sha256: sha256Hex("other"),
    }),
  );
  add("prompt hash taken", () => {
    const template = "template for analyze.p1";
    return repo.upsertPromptVersion({
      id: "analyze.p9",
      stage: "analyze",
      template,
      schemaJson: "{}",
      sha256: sha256Hex(`analyze.p1\n${template}`),
    });
  });
  add("workflow label taken", () => {
    const other = { ...WORKFLOW_MANIFEST, budgetTokens: 9000 };
    return repo.upsertWorkflowVersion({ manifest: other, sha256: hashOf(other) });
  });
  add("workflow pins unknown prompt", () => {
    const other = {
      ...WORKFLOW_MANIFEST,
      label: "v9",
      prompts: { ...WORKFLOW_MANIFEST.prompts, analyze: ID },
    };
    return repo.upsertWorkflowVersion({ manifest: other, sha256: hashOf(other) });
  });
  add("workflow already promoted", () => {
    repo.promoteWorkflowVersion(w.workflow.id, {
      actorId: ACTORS.admin,
      promotionRecord: "docs/record.md",
    });
    return repo.promoteWorkflowVersion(w.workflow.id, {
      actorId: ACTORS.admin,
      promotionRecord: "docs/record.md",
    });
  });
  add(
    "eval slot exists",
    () => {
      const e = exported(w);
      const er = evalRun();
      const slot = {
        evalRunId: er.id,
        caseKey: "C1",
        ruleKey: "dur-1",
        repeat: 0,
        runId: e.run.id,
        expectedStatus: "compliant",
        gotStatus: "compliant",
        scores: {},
      };
      repo.recordEvalSlotResult(e.m.id, slot, { actorId: null });
      return repo.recordEvalSlotResult(e.m.id, slot, { actorId: null });
    },
    "mat_",
    "run_",
    "evr_",
  );
  return out;
}

describe("error messages never repeat what the caller gave them, not even an id", () => {
  const names = Object.keys(probes(makeWorld()));

  for (const name of names)
    it(name, () => {
      const w = makeWorld();
      const probe = probes(w)[name]!;
      const { message } = refusal(probe.run);
      expect(message.length).toBeGreaterThan(0);
      for (const text of probe.forbidden)
        expect(message, `"${text}" in "${message}"`).not.toContain(text);
      // Nor a prefix-shaped id of any entity: ids are `<kind>_<hex>`.
      expect(message).not.toMatch(
        /\b(mat|doc|ver|run|fnd|evd|rev|memo|fbk|pbv|pbr|wfv|evr|eds|mcl)_[0-9a-f]{8,}/,
      );
    });

  it("covers the paths that used to echo", () => {
    const w = makeWorld();
    const all = probes(w);
    const codes = new Set(Object.values(all).map((p) => refusal(p.run).code));
    for (const code of [
      "not_found",
      "member_exists",
      "nda_exists",
      "amendment_limit",
      "spans_differ",
      "active_run",
      "inputs_incomplete",
      "matter_not_runnable",
      "stale_run",
      "run_not_writing",
      "invalid_transition",
      "not_fully_decided",
      "no_active_run",
      "matter_running",
      "stale_finding",
      "content_mismatch",
      "matter_exported",
      "export_blocked",
      "unknown_rule",
      "rule_mismatch",
      "finding_exists",
      "already_approved",
      "playbook_version_exists",
      "prompt_id_taken",
      "prompt_hash_taken",
      "workflow_label_taken",
      "unknown_prompt",
      "already_promoted",
      "slot_exists",
    ])
      expect(codes, code).toContain(code);
  });
});

describe("the errors that carry a field", () => {
  it("an active run is named in a field the store read from its own rows, and not in the message", () => {
    const w = makeWorld();
    const m = addMatter(w);
    const run = startRun(w, m);
    const manifest = w.repo.buildRunManifest(m.id, {
      workflowVersionId: w.workflow.id,
      modelProvider: "p",
      model: "m",
    });
    const { error } = refusal(() =>
      w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate }),
    );
    expect(error).toBeInstanceOf(ActiveRunError);
    expect((error as ActiveRunError).activeRunId).toBe(run.id);
    expect(error.message).not.toContain(run.id);
  });

  it("a not-found error names a kind of thing from a closed set, and keeps no id", () => {
    const w = makeWorld();
    const m = addMatter(w);
    const { error } = refusal(() => w.repo.getExportReadiness(m.id, ID));
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).entity).toBe("run");
    expect(JSON.stringify(error)).not.toContain(ID);
    expect(Object.values(error).join(" ")).not.toContain(ID);
  });

  it("the other conflicts carry nothing from the request", () => {
    const w = makeWorld();
    const r = reviewable(w);
    w.repo.applyInputChange(r.m.id, { reason: "document_changed", actorId: null });
    const f = r.findings[0]!;
    const stale = refusal(() =>
      w.repo.recordReview(r.m.id, f.id, {
        reviewerId: ACTORS.reviewer,
        decision: "accept",
        findingContentSha256: f.contentSha256,
      }),
    );
    expect(stale.error).toBeInstanceOf(StaleFindingError);
    expect(JSON.stringify(stale.error)).not.toContain(f.id);

    const fresh = reviewable(w);
    const mismatch = refusal(() =>
      w.repo.recordReview(fresh.m.id, fresh.findings[0]!.id, {
        reviewerId: ACTORS.reviewer,
        decision: "accept",
        findingContentSha256: HASH,
      }),
    );
    expect(mismatch.error).toBeInstanceOf(ContentMismatchError);
    expect(JSON.stringify(mismatch.error)).not.toContain(fresh.findings[0]!.id);

    const stalled = refusal(() => w.repo.updateRunStatus(r.m.id, r.run.id, "failed"));
    expect(stalled.error).toBeInstanceOf(StaleRunError);
    expect((stalled.error as StaleRunError).why).toBe("superseded");

    const blocked = refusal(() =>
      w.repo.recordMemo(fresh.m.id, {
        runId: fresh.run.id,
        reviewIds: [],
        fileSha256: HASH,
        storagePath: fakePath(fresh.m.id),
        exportedBy: ACTORS.reviewer,
      }),
    );
    expect(blocked.error).toBeInstanceOf(ExportBlockedError);
    expect((blocked.error as ExportBlockedError).blockers.length).toBeGreaterThan(0);
    expect(blocked.message).toMatch(/blocked by \d+ item/);
  });

  it("a transition names only states that exist", () => {
    const w = makeWorld();
    const m = addMatter(w);
    const known = refusal(() => w.repo.setMatterStatus(m.id, "exported", actor(w)));
    expect(known.error).toBeInstanceOf(InvalidTransitionError);
    expect(known.message).toBe("matter cannot move from ready to exported");
    const unknown = refusal(() => w.repo.setMatterStatus(m.id, ID as never, actor(w)));
    expect(unknown.message).toBe("matter cannot move from ready to (unknown state)");
  });

  it("an incomplete matter says what it needs, and not which matter", () => {
    const w = makeWorld();
    const m = addMatter(w, { pinPlaybook: false });
    const { error, message } = refusal(() =>
      w.repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      }),
    );
    expect(error).toBeInstanceOf(InputsIncompleteError);
    expect(message).toMatch(/playbook version and an operative version of every document/);
  });
});

const actor = (_w: World) => ({ actorId: ACTORS.associate });

// ---------------------------------------------------------------------------------------------
// The same rule, held at the source: a message may interpolate only what is listed here, and each
// entry says why it is safe. Adding an interpolation to an error is a decision, and this is where it
// is made.
// ---------------------------------------------------------------------------------------------

describe("what an error message in the store may interpolate", () => {
  /** expression, then why it cannot carry text from a request. */
  const ALLOWED: Record<string, string> = {
    // Names of fields and limits, written in the code that validates them.
    field: "the name of the field being validated, a literal at every call site",
    label: "the name of the thing being validated, a literal at every call site",
    max: "a numeric limit",
    min: "a numeric limit",
    where: "zod issue paths and codes, which come from the schemas",
    MAX_DETAIL_STRING_LENGTH: "a constant",
    MAX_DETAIL_DEPTH: "a constant",
    MAX_DETAIL_ENTRIES: "a constant",
    MAX_RETAIN_DAYS: "a constant",
    containerDepth: "a nesting level, a number",
    depth: "a nesting level, a number",
    "typeof value": "typeof yields one of a fixed set of words",
    // Migration files: written by developers and read from the migrations folder.
    file: "a migration file name from the migrations folder",
    "migration.version": "a migration number",
    "index + 1": "a position",
    "row.version": "a migration number read from schema_migrations",
    "row.name": "a migration name read from schema_migrations",
    // Closed vocabularies and counts.
    entity: "a member of EntityKind, or one of four entity words, typed as a literal union",
    why: "one of two literals",
    "stateName(from)": "a state name if it is one that exists, otherwise a fixed phrase",
    "stateName(to)": "a state name if it is one that exists, otherwise a fixed phrase",
    "blockers.length": "a count",
    "current.status": "a run status read from the database",
    "matter.status": "a matter status read from the database",
    "input.decision": "checked against REVIEW_DECISIONS before it is used",
    "input.kind": "checked against the feedback kinds before it is used",
    at: "the position of a finding in the batch, `finding <n>`",
    'left.join(", ")':
      "names of tables read from sqlite_master, matched against /^[a-z_][a-z0-9_]*$/ before use; no value of a request",
  };

  const dir = fileURLToPath(new URL("../../src/store/", import.meta.url));
  const used = new Set<string>();
  const offenders: string[] = [];

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(`${dir}${file}`, "utf8");
    // `throw new SomeError(...)` and `super(code, message)` in the error classes.
    const statement = /(?:throw new [A-Za-z]+|super)\(([\s\S]*?)\);/g;
    for (const match of source.matchAll(statement)) {
      for (const expr of (match[1] ?? "").matchAll(/\$\{([^}]*)\}/g)) {
        const text = (expr[1] ?? "").trim();
        if (text in ALLOWED) used.add(text);
        else offenders.push(`${file}: \${${text}}`);
      }
    }
  }

  it("nothing outside the list", () => {
    expect(
      offenders,
      "an error message interpolates something that is not on the list above",
    ).toEqual([]);
  });

  it("nothing on the list that is no longer used", () => {
    expect(Object.keys(ALLOWED).filter((k) => !used.has(k))).toEqual([]);
  });

  it("the id-checking helper that let well-formed ids through is gone", () => {
    const errors = readFileSync(`${dir}errors.ts`, "utf8");
    expect(errors).not.toMatch(/safeId/);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")))
      expect(readFileSync(`${dir}${file}`, "utf8"), file).not.toMatch(/\bsafeId\b/);
  });
});
