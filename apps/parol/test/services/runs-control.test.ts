import { afterAll, describe, expect, it } from "vitest";
import { hashOf } from "../../src/canonical.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { cleanup, gate, makeWorld, newMatter, reviewed, uploadCase } from "./support.js";

afterAll(cleanup);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The amendment with one more paragraph at the end: a corrected version of the same document. */
const corrected = (original: Uint8Array): Uint8Array =>
  new TextEncoder().encode(
    `${new TextDecoder().decode(original).trimEnd()}\n\n5. This Amendment may be signed in counterparts.\n`,
  );

describe("cancel", () => {
  it("stops a run in flight, saves nothing half done, and frees the matter", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(3);

    const cancelled = w.services.runs.cancel(am, run.id);
    expect(cancelled.status).toBe("cancelled");
    expect(w.services.matters.view(am).matter.status).toBe("ready");
    hold.open();
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "cancelled", findingCount: 0 });
    expect(w.services.runs.issues(am, run.id)).toEqual([]);
    // No stage is left running, and no analysis was saved after the cancel.
    const stages = w.repo.listStages(matterId, run.id);
    expect(stages.some((s) => s.status === "running")).toBe(false);
    expect(stages.filter((s) => s.stage === "analyze" && s.status === "succeeded")).toEqual([]);
    expect(stages.filter((s) => s.stage === "verify")).toEqual([]);
    expect(w.repo.listModelCalls(matterId, run.id).filter((c) => c.stage === "analyze")).toEqual(
      [],
    );
    expect(w.logs.some((l) => l.includes(`run ${run.id}`) && l.includes("cancelled"))).toBe(true);
    // Only three rules were ever asked: the cancel stopped the rest from starting.
    expect(w.model.count("analyze")).toBe(3);

    // A cancelled run cannot be resumed, and a new one can be started.
    expect(() => w.services.runs.resume(am, run.id)).toThrow();
    const again = w.services.runs.start(am, { workflowLabel: "v2" });
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.get(am, again.id).status).toBe("succeeded");
  });

  it("does not wait for a provider that ignores the abort signal", async () => {
    // A call that never returns, as a stalled connection would: the cancel still frees the slot.
    const w = makeWorld({
      config: { maxConcurrentRuns: 1 },
      model: {
        before: (call) =>
          call.kind === "analyze" ? new Promise<void>(() => undefined) : undefined,
      },
    });
    const first = newMatter(w, "stalled");
    await uploadCase(w, first.matterId);
    const run = w.services.runs.start(first.am, {});
    for (let i = 0; i < 100 && w.model.count("analyze") < 3; i++) await sleep(5);
    expect(w.model.count("analyze")).toBe(3);
    w.services.runs.cancel(first.am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(first.am, run.id).status).toBe("cancelled");
    // idle() resolved at all, so the stalled call no longer holds the slot.
    expect(w.logs.some((l) => l.includes(run.id) && l.includes("cancelled"))).toBe(true);
  });

  it("takes a run out of the queue before it starts", async () => {
    const hold = gate();
    const w = makeWorld({
      config: { maxConcurrentRuns: 1 },
      model: {
        before: async (call) => {
          if (call.kind === "extract") await hold.pass();
        },
      },
    });
    const first = newMatter(w, "first");
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    await uploadCase(w, second.matterId);
    w.services.runs.start(first.am, {});
    const waiting = w.services.runs.start(second.am, {});
    await hold.reached(1);
    expect(w.services.runs.get(second.am, waiting.id).status).toBe("queued");

    w.services.runs.cancel(second.am, waiting.id);
    hold.open();
    await w.services.runs.idle();
    // It never reached the model.
    expect(hold.arrived).toBe(1);
    expect(w.services.runs.get(second.am, waiting.id).status).toBe("cancelled");
    expect(w.repo.listStages(second.matterId, waiting.id)).toEqual([]);
  });

  it("is for the associate, and for a run of this matter only", async () => {
    const w = makeWorld();
    const { matterId, am, runId } = await reviewed(w);
    const other = newMatter(w, "other");
    await uploadCase(w, other.matterId);
    expect(() => w.services.runs.cancel(w.grant(w.reviewer, matterId), runId)).toThrow(
      expect.objectContaining({ name: "ForbiddenError" }),
    );
    // A run of another matter is as good as absent.
    expect(() => w.services.runs.cancel(other.am, runId)).toThrow(
      expect.objectContaining({ name: "NotFoundError" }),
    );
    // And a finished run cannot be cancelled.
    expect(() => w.services.runs.cancel(am, runId)).toThrow();
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
  });
});

describe("a document that changes while a run is in flight", () => {
  it("stops the run quietly and saves nothing for it afterwards", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await hold.reached(3);

    const rows = () => ({
      stages: w.repo
        .listStages(matterId, run.id)
        .map((s) => `${s.stage}/${s.unit}/${s.attempt}/${s.status}`),
      calls: w.repo.listModelCalls(matterId, run.id).length,
      findings: w.repo.listFindings(matterId, run.id).length,
    });
    const atTheChange = rows();

    // The associate uploads a corrected amendment while the model is still working.
    const result = await w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "amendment-1-corrected.txt",
      bytes: corrected((await import("./support.js")).baseWorld.files[1]!.bytes),
      statedDate: "2026-09-16",
    });
    expect(result.versionId).toBeTruthy();
    expect(w.repo.getRun(matterId, run.id)!.status).toBe("superseded");
    expect(w.services.matters.view(am).matter.status).toBe("stale");
    const afterChange = rows();

    hold.open();
    await w.services.runs.idle();

    // The answers that came back after the change were not saved: not as stage results, not as
    // model calls, not as findings; and the run was not marked as anything but superseded.
    expect(rows().calls).toBe(afterChange.calls);
    expect(rows().findings).toBe(0);
    expect(rows().stages.filter((s) => s.endsWith("succeeded")).length).toBe(
      afterChange.stages.filter((s) => s.endsWith("succeeded")).length,
    );
    expect(afterChange.calls).toBe(atTheChange.calls);
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "superseded",
      errorKind: null,
      current: false,
      findingCount: 0,
    });
    expect(
      w.logs.some((l) => l.includes(run.id) && l.includes("stopped quietly (superseded)")),
    ).toBe(true);
    // No more rules were asked once the document changed, beyond those already under way.
    expect(w.model.count("analyze")).toBe(3);
    expect(w.repo.listStages(matterId, run.id).some((s) => s.status === "running")).toBe(false);

    // The matter can be reviewed again on the new document.
    const again = w.services.runs.start(am, { workflowLabel: "v2" });
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.get(am, again.id)).toMatchObject({ status: "succeeded", current: true });
  });

  it("stops a run that is waiting in the queue, so that it never starts", async () => {
    const hold = gate();
    const w = makeWorld({
      config: { maxConcurrentRuns: 1 },
      model: {
        before: async (call) => {
          if (call.kind === "extract") await hold.pass();
        },
      },
    });
    const first = newMatter(w, "first");
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    const uploaded = await uploadCase(w, second.matterId);
    w.services.runs.start(first.am, {});
    const waiting = w.services.runs.start(second.am, {});
    await hold.reached(1);

    w.services.matters.setStatedDate(second.am, uploaded.versionIds[1]!, "2026-09-30");
    expect(w.repo.getRun(second.matterId, waiting.id)!.status).toBe("superseded");
    hold.open();
    await w.services.runs.idle();
    expect(hold.arrived).toBe(1);
    expect(w.repo.listStages(second.matterId, waiting.id)).toEqual([]);
  });
});

describe("progress", () => {
  it("tells the page which stage a run is in and how far it has got", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "extract") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "queued", progress: null });
    await hold.reached(1);
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "extracting",
      progress: { stage: "extract", done: 0, total: 1 },
    });
    expect(w.services.matters.view(am).activeRun?.id).toBe(run.id);
    hold.open();
    await w.services.runs.idle();
    const done = w.services.runs.get(am, run.id);
    expect(done).toMatchObject({ status: "succeeded", progress: null });
    // Every stage left a record: ingest, extract, retrieve, then a unit per rule for the last two.
    const stages = w.repo.listStages(matterId, run.id);
    expect(stages.filter((s) => s.unit === "*").map((s) => s.stage)).toEqual([
      "ingest",
      "extract",
      "retrieve",
    ]);
    expect(stages.filter((s) => s.stage === "analyze")).toHaveLength(8);
    expect(stages.filter((s) => s.stage === "verify")).toHaveLength(8);
    expect(stages.every((s) => s.status === "succeeded" && s.outputSha256 !== null)).toBe(true);
  });

  it("shows how far a failed run got", async () => {
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind === "analyze" && call.ruleKey === "gov-1") {
            await sleep(10);
            const { ModelRequestError } = await import("@clausewise/llm");
            throw new ModelRequestError("no", 401);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    const failed = w.services.runs.get(am, run.id);
    expect(failed.status).toBe("failed");
    expect(failed.progress).toMatchObject({ stage: "analyze", total: 8 });
    expect(failed.progress!.done).toBeGreaterThan(0);
    expect(failed.progress!.done).toBeLessThan(8);
    expect(matterId).toBeTruthy();
  });
});

describe("workflows", () => {
  it("uses the baseline unless a version has been promoted, and then the promoted one", async () => {
    const w = makeWorld();
    const first = await reviewed(w, {});
    // reviewed() names v2; start without a label for the default.
    const { matterId, am } = newMatter(w, "default");
    await uploadCase(w, matterId);
    const base = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(base.workflowLabel).toBe("v1");

    w.repo.promoteWorkflowVersion(w.repo.getWorkflowVersionByLabel("v2")!.id, {
      actorId: w.admin.userId,
      promotionRecord: "docs/parol/promotions/v2.md",
    });
    // A new review: the matter has results, so this is a re-run.
    const promoted = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(promoted.workflowLabel).toBe("v2");
    expect(w.services.runs.get(am, base.id).status).toBe("superseded");
    expect(first.runId).toBeTruthy();
  });

  it("runs the support check when the workflow pins a support prompt, and keeps its calls", async () => {
    const w = makeWorld();
    const withSupport = {
      ...WORKFLOWS["v2"]!.manifest,
      label: "v3-support",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
    };
    w.repo.upsertWorkflowVersion({ manifest: withSupport, sha256: hashOf(withSupport) });
    const { matterId, am, runId } = await reviewed(w, { workflowLabel: "v3-support" });
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
    const supportCalls = w.repo
      .listModelCalls(matterId, runId)
      .filter((c) => c.stage === "support");
    expect(supportCalls.length).toBeGreaterThan(0);
    expect(
      supportCalls.every((c) => c.promptVersionId === "support.p1" && c.outcome === "ok"),
    ).toBe(true);
    // The checker was shown the cited passages and the rule, and nothing of the other documents.
    const dur = w.services.runs.issues(am, runId).find((i) => i.ruleKey === "dur-1")!;
    const view = w.services.runs.finding(am, dur.findingId);
    expect(view.checks.find((c) => c.id === "support")).toMatchObject({
      kind: "model",
      outcome: "pass",
    });
    expect(
      view.evidence.every((e) => e.quoteCheck !== "verified" || e.supportCheck === "supported"),
    ).toBe(true);
  });

  it("escalates a finding the support check does not confirm", async () => {
    const w = makeWorld({ model: { supportVerdict: "not_supported" } });
    const withSupport = {
      ...WORKFLOWS["v2"]!.manifest,
      label: "v3-support",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
    };
    w.repo.upsertWorkflowVersion({ manifest: withSupport, sha256: hashOf(withSupport) });
    const { am, runId } = await reviewed(w, { workflowLabel: "v3-support" });
    const issues = w.services.runs.issues(am, runId);
    const flagged = issues.filter((i) =>
      i.escalations.some((e) => e.code === "support_not_confirmed"),
    );
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.every((i) => i.verificationState === "escalated_by_system")).toBe(true);
  });

  it("a support check that fails is recorded and the finding is not confirmed", async () => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "support") throw new Error("boom");
        },
      },
    });
    const withSupport = {
      ...WORKFLOWS["v2"]!.manifest,
      label: "v3-support",
      prompts: { extract: "extract.p1", analyze: "analyze.p1", support: "support.p1" },
    };
    w.repo.upsertWorkflowVersion({ manifest: withSupport, sha256: hashOf(withSupport) });
    const { matterId, am, runId } = await reviewed(w, { workflowLabel: "v3-support" });
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
    const calls = w.repo.listModelCalls(matterId, runId).filter((c) => c.stage === "support");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.outcome === "transport")).toBe(true);
    const flagged = w.services.runs
      .issues(am, runId)
      .filter((i) => i.escalations.some((e) => e.code === "support_not_confirmed"));
    expect(flagged.length).toBeGreaterThan(0);
  });
});
