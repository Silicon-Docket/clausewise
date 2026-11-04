import { beforeEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "../../src/store/index.js";
import { ACTORS, addMatter, makeWorld, startRun, type World } from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const sha = (c: string) => c.repeat(64);
const evalRun = (over: object = {}) => {
  const dataset = w.repo.createEvalDataset({
    label: "parol-cases v1",
    devSha256: sha("a"),
    heldoutSha256: sha("b"),
  });
  return {
    dataset,
    run: w.repo.createEvalRun(
      {
        datasetId: dataset.id,
        split: "dev",
        workflowVersionId: w.workflow.id,
        playbookVersionId: w.playbook.id,
        model: "scripted-1",
        repeats: 3,
        priceTableSha256: sha("c"),
        resultsPath: "evals/results/dev-1.json",
        ...over,
      },
      { actorId: ACTORS.legalEngineer },
    ),
  };
};

describe("evaluation tables", () => {
  it("stores and lists datasets", () => {
    const { dataset } = evalRun();
    expect(dataset).toMatchObject({
      label: "parol-cases v1",
      devSha256: sha("a"),
      heldoutSha256: sha("b"),
    });
    expect(w.repo.getEvalDataset(dataset.id)).toEqual(dataset);
    expect(w.repo.listEvalDatasets()).toEqual([dataset]);
    expect(w.repo.getEvalDataset("eds_nope")).toBeUndefined();
    expect(() =>
      w.repo.createEvalDataset({ label: "", devSha256: sha("a"), heldoutSha256: sha("b") }),
    ).toThrow(ValidationError);
    expect(() =>
      w.repo.createEvalDataset({ label: "x", devSha256: "nope", heldoutSha256: sha("b") }),
    ).toThrow(ValidationError);
  });

  it("stores a run, audits it, and finishes it once", () => {
    const { dataset, run } = evalRun();
    expect(run).toMatchObject({
      datasetId: dataset.id,
      split: "dev",
      repeats: 3,
      model: "scripted-1",
      finishedAt: null,
      workflowVersionId: w.workflow.id,
    });
    w.clock.tick();
    const done = w.repo.finishEvalRun(run.id, { actorId: ACTORS.legalEngineer });
    expect(done.finishedAt).toBe(w.clock.iso());
    w.clock.tick();
    expect(w.repo.finishEvalRun(run.id, { actorId: null }).finishedAt).toBe(done.finishedAt);
    expect(w.repo.listEvalRuns(dataset.id)).toHaveLength(1);
    expect(w.repo.listEvalRuns("eds_other")).toEqual([]);
    expect(w.repo.listEvalRuns()).toHaveLength(1);
    const events = w.repo.listAuditEvents({ action: "eval.record" });
    // The dataset's creation is the first event; the run's two follow it.
    expect(events.map((e) => e.targetType)).toEqual(["eval_dataset", "eval_run", "eval_run"]);
    expect(events.slice(1).map((e) => e.detail.finished ?? e.detail.split)).toEqual(["dev", true]);
    expect(events.every((e) => e.matterId === null)).toBe(true);
  });

  it("audits a dataset with its hashes and nothing else", () => {
    const { dataset } = evalRun();
    const [event] = w.repo.listAuditEvents({ action: "eval.record" });
    expect(event).toMatchObject({
      targetType: "eval_dataset",
      targetId: dataset.id,
      detail: { devSha256: dataset.devSha256, heldoutSha256: dataset.heldoutSha256 },
    });
    expect(Object.keys(event?.detail ?? {}).sort()).toEqual(["devSha256", "heldoutSha256"]);
  });

  it("validates a run and the things it points at", () => {
    const { dataset } = evalRun();
    const make = (over: object) =>
      w.repo.createEvalRun(
        {
          datasetId: dataset.id,
          split: "heldout",
          workflowVersionId: w.workflow.id,
          playbookVersionId: w.playbook.id,
          model: "m",
          repeats: 1,
          priceTableSha256: sha("c"),
          resultsPath: "r.json",
          ...over,
        } as never,
        { actorId: null },
      );
    expect(() => make({ split: "test" })).toThrow(ValidationError);
    expect(() => make({ repeats: 0 })).toThrow(ValidationError);
    expect(() => make({ priceTableSha256: "x" })).toThrow(ValidationError);
    expect(() => make({ model: "" })).toThrow(ValidationError);
    expect(() => make({ datasetId: "eds_nope" })).toThrow(NotFoundError);
    expect(() => make({ workflowVersionId: "wfv_nope" })).toThrow(NotFoundError);
    expect(() => make({ playbookVersionId: "pbv_nope" })).toThrow(NotFoundError);
    expect(() => w.repo.finishEvalRun("evr_nope", { actorId: null })).toThrow(NotFoundError);
    expect(w.repo.listEvalRuns()).toHaveLength(1);
  });

  it("records slot results for runs of synthetic matters, in a stable order", () => {
    const { run: er } = evalRun();
    const m = addMatter(w, { name: "case D05" });
    const matterRun = startRun(w, m);
    const slot = (caseKey: string, ruleKey: string, repeat: number, got = "compliant") =>
      w.repo.recordEvalSlotResult(
        m.id,
        {
          evalRunId: er.id,
          caseKey,
          ruleKey,
          repeat,
          runId: matterRun.id,
          expectedStatus: "deviation",
          gotStatus: got,
          scores: { status_match: got === "deviation", nested: { n: 1 } },
        },
        { actorId: null },
      );
    slot("PAROL-D05", "dur-1", 1);
    slot("PAROL-D05", "dur-1", 0);
    slot("PAROL-D01", "pty-1", 0, "deviation");
    const listed = w.repo.listEvalSlotResults(er.id);
    expect(listed.map((s) => [s.caseKey, s.ruleKey, s.repeat])).toEqual([
      ["PAROL-D01", "pty-1", 0],
      ["PAROL-D05", "dur-1", 0],
      ["PAROL-D05", "dur-1", 1],
    ]);
    expect(listed[0]).toMatchObject({
      expectedStatus: "deviation",
      gotStatus: "deviation",
      runId: matterRun.id,
      scores: { status_match: true, nested: { n: 1 } },
    });
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "eval.record" })).toHaveLength(3);
  });

  it("refuses a repeated slot, bad statuses, unusable scores and an unknown eval run", () => {
    const { run: er } = evalRun();
    const m = addMatter(w);
    const matterRun = startRun(w, m);
    const slot = (over: object = {}) =>
      w.repo.recordEvalSlotResult(
        m.id,
        {
          evalRunId: er.id,
          caseKey: "C",
          ruleKey: "dur-1",
          repeat: 0,
          runId: matterRun.id,
          expectedStatus: "compliant",
          gotStatus: "compliant",
          scores: {},
          ...over,
        } as never,
        { actorId: null },
      );
    slot();
    expect(() => slot()).toThrow(ConflictError);
    expect(() => slot({ repeat: 1, gotStatus: "fine" })).toThrow(ValidationError);
    expect(() => slot({ repeat: 1, expectedStatus: "" })).toThrow(ValidationError);
    expect(() => slot({ repeat: 1, scores: { n: Number.NaN } })).toThrow(ValidationError);
    expect(() => slot({ repeat: -1 })).toThrow(ValidationError);
    expect(() => slot({ repeat: 1, evalRunId: "evr_nope" })).toThrow(NotFoundError);
    expect(w.repo.listEvalSlotResults(er.id)).toHaveLength(1);
  });

  it("refuses results for a matter that is not synthetic", () => {
    const { run: er } = evalRun();
    const real = addMatter(w, { synthetic: false, name: "real" });
    const realRun = startRun(w, real);
    expect(() =>
      w.repo.recordEvalSlotResult(
        real.id,
        {
          evalRunId: er.id,
          caseKey: "C",
          ruleKey: "dur-1",
          repeat: 0,
          runId: realRun.id,
          expectedStatus: "compliant",
          gotStatus: "compliant",
          scores: {},
        },
        { actorId: null },
      ),
    ).toThrow(/synthetic/);
    expect(w.repo.listEvalSlotResults(er.id)).toEqual([]);
  });
});
