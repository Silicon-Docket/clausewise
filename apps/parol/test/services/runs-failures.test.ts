import { ModelRequestError } from "@clausewise/llm";
import { afterAll, describe, expect, it } from "vitest";
import { hashOf } from "../../src/canonical.js";
import { markInterruptedRuns } from "../../src/boot/register.js";
import { createServices } from "../../src/services/index.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { ActiveRunError, StaleRunError } from "../../src/store/index.js";
import {
  cleanup,
  controlledModel,
  gate,
  makeWorld,
  newMatter,
  reviewed,
  uploadCase,
} from "./support.js";

afterAll(cleanup);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const errorOf = async (fn: () => unknown): Promise<unknown> => {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

describe("a rule whose analysis fails", () => {
  it("becomes undetermined with output_invalid, and the run still succeeds", async () => {
    const w = makeWorld({
      model: {
        // A provider hiccup that is not fatal: the rule gets no answer, the others do.
        before: (call) => {
          if (call.kind === "analyze" && call.ruleKey === "ret-1")
            throw new ModelRequestError("the provider is busy", 429);
        },
      },
    });
    const { am, runId, matterId } = await reviewed(w);
    expect(w.services.runs.get(am, runId)).toMatchObject({ status: "succeeded", findingCount: 8 });
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
    const issues = w.services.runs.issues(am, runId);
    const ret = issues.find((i) => i.ruleKey === "ret-1")!;
    expect(ret).toMatchObject({ status: "undetermined", verificationState: "escalated_by_system" });
    expect(ret.escalations.map((e) => e.code)).toEqual(["output_invalid"]);
    // The other seven are untouched by it.
    expect(issues.filter((i) => i.status === "undetermined")).toHaveLength(1);
    // The failed call is on record, without any text.
    const calls = w.repo.listModelCalls(matterId, runId).filter((c) => c.ruleKey === "ret-1");
    expect(calls.map((c) => c.outcome)).toEqual(["transport"]);
  });

  it("is undetermined with context_over_budget, and no call is made for it, when the context is too big", async () => {
    const w = makeWorld();
    const tiny = { ...WORKFLOWS["v2"]!.manifest, label: "tiny", budgetTokens: 20 };
    w.repo.upsertWorkflowVersion({ manifest: tiny, sha256: hashOf(tiny) });
    const { am, runId } = await reviewed(w, { workflowLabel: "tiny" });
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");
    const issues = w.services.runs.issues(am, runId);
    expect(issues.every((i) => i.status === "undetermined")).toBe(true);
    expect(
      issues.every((i) => i.escalations.map((e) => e.code).join() === "context_over_budget"),
    ).toBe(true);
    expect(w.model.count("analyze")).toBe(0);
    expect(w.model.count("extract")).toBe(1);
  });
});

describe("extract that fails for a reason that is not fatal", () => {
  it("degrades: every rule reads the whole documents, and the run still succeeds", async () => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "extract") throw new ModelRequestError("overloaded", 529);
        },
      },
    });
    const { matterId, am, runId } = await reviewed(w);
    expect(w.services.runs.get(am, runId)).toMatchObject({ status: "succeeded", findingCount: 8 });
    const extract = w.repo.listStages(matterId, runId).find((s) => s.stage === "extract")!;
    expect(extract.status).toBe("succeeded");
    expect((extract.output as { degraded: boolean }).degraded).toBe(true);
    // The rules were still asked, with the whole of the documents in front of the model.
    expect(w.model.count("analyze")).toBe(8);
    expect(w.repo.listModelCalls(matterId, runId).find((c) => c.stage === "extract")!.outcome).toBe(
      "transport",
    );
  });
});

describe("a fatal provider error", () => {
  const kinds: [
    string,
    number,
    boolean | undefined,
    ModelRequestError["kind"] | undefined,
    string,
  ][] = [
    ["a rejected key", 401, undefined, undefined, "provider_auth"],
    ["a key that may not do this", 403, undefined, undefined, "provider_permission"],
    ["a model that is not there", 404, undefined, undefined, "provider_model"],
    ["an empty balance", 402, undefined, undefined, "provider_billing"],
    ["a redirect", 302, true, "other", "provider_redirect"],
  ];

  it.each(kinds)(
    "on a rule: %s stops the run with a closed code and keeps what was done",
    async (_name, status, fatal, kind, expected) => {
      const w = makeWorld({
        model: {
          before: async (call) => {
            if (call.kind === "analyze" && call.ruleKey === "exc-1") {
              // The other rules are answered while this one is held, then the provider refuses it.
              await sleep(10);
              throw new ModelRequestError(
                "the provider said no, with words of its own",
                status,
                fatal,
                kind,
              );
            }
          },
        },
      });
      const { matterId, am } = newMatter(w);
      await uploadCase(w, matterId);
      const run = w.services.runs.start(am, {});
      await w.services.runs.idle();

      const after = w.services.runs.get(am, run.id);
      expect(after).toMatchObject({ status: "failed", errorKind: expected, findingCount: 0 });
      expect(JSON.stringify(after)).not.toContain("words of its own");
      expect(w.services.matters.view(am).matter.status).toBe("ready");
      expect(w.services.runs.issues(am, run.id)).toEqual([]);

      // The rules that were done are kept as stage results, and the one that met the error is failed.
      const stages = w.repo.listStages(matterId, run.id);
      expect(
        stages.filter((s) => s.stage === "analyze" && s.status === "succeeded").length,
      ).toBeGreaterThan(0);
      expect(
        stages.filter((s) => s.status === "failed").map((s) => [s.stage, s.unit, s.errorKind]),
      ).toEqual([["analyze", "exc-1", expected]]);
      // Its failed call is on record as fatal, and the record carries no text.
      const fatalCalls = w.repo
        .listModelCalls(matterId, run.id)
        .filter((c) => c.outcome === "fatal");
      expect(fatalCalls.map((c) => c.ruleKey)).toEqual(["exc-1"]);
      expect(w.logs.join("\n")).not.toContain("words of its own");
      // The retrieval stage ran; verify never started.
      expect(stages.some((s) => s.stage === "verify")).toBe(false);
    },
  );

  it("on extract stops the run before any rule is asked", async () => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "extract") throw new ModelRequestError("no key", 401);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    expect(w.model.count("analyze")).toBe(0);
    // Extract would have degraded and gone on to read the whole document for every rule.
    expect(w.repo.listStages(matterId, run.id).map((s) => [s.stage, s.status])).toEqual([
      ["ingest", "succeeded"],
      ["extract", "failed"],
    ]);
  });

  it("is not resumed into a degraded success: the unit that met it is asked again", async () => {
    let broken = true;
    const w = makeWorld({
      model: {
        before: (call) => {
          if (broken && call.kind === "extract") throw new ModelRequestError("no key", 401);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    broken = false;
    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", errorKind: null });
    expect(w.model.count("extract")).toBe(2);
  });
});

describe("an unexpected error", () => {
  it("fails the run as internal, and the log carries the name of the error and nothing else", async () => {
    const w = makeWorld();
    // A workflow that pins a prompt the code does not have: the run cannot be set up.
    w.repo.upsertPromptVersion({
      id: "analyze.p9",
      stage: "analyze",
      template: "x",
      schemaJson: "{}",
      sha256: "a".repeat(64),
    });
    const odd = {
      ...WORKFLOWS["v1"]!.manifest,
      label: "odd",
      prompts: { extract: "extract.p1", analyze: "analyze.p9", support: null },
    };
    w.repo.upsertWorkflowVersion({ manifest: odd, sha256: hashOf(odd) });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "odd" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "internal",
    });
    expect(w.services.matters.view(am).matter.status).toBe("ready");
    const line = w.logs.find((l) => l.includes("failed, internal"))!;
    expect(line).toContain(run.id);
    expect(line).toContain("(Error)");
    expect(line).not.toContain("analyze.p9");
  });
});

describe("resume", () => {
  it("picks a failed run up where it stopped and does not ask again what it already has", async () => {
    let broken = true;
    const w = makeWorld({
      model: {
        before: async (call) => {
          // The third rule is refused after the others have been answered.
          if (broken && call.kind === "analyze" && call.ruleKey === "exc-1") {
            await sleep(10);
            throw new ModelRequestError("no", 401);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("failed");

    const done = new Set(
      w.repo
        .listStages(matterId, run.id)
        .filter((s) => s.stage === "analyze" && s.status === "succeeded")
        .map((s) => s.unit),
    );
    expect(done.size).toBeGreaterThan(0);
    expect(done.has("exc-1")).toBe(false);
    const callsBefore = w.model.calls.length;
    const extractsBefore = w.model.count("extract");

    broken = false;
    const resumed = w.services.runs.resume(am, run.id);
    expect(resumed.status).toBe("queued");
    // Asked twice, only one resume can be in flight.
    expect(() => w.services.runs.resume(am, run.id)).toThrow(
      expect.objectContaining({ name: "InvalidTransitionError" }),
    );
    expect(w.services.matters.view(am).matter.status).toBe("running");
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "succeeded",
      findingCount: 8,
      errorKind: null,
    });
    expect(w.model.count("extract")).toBe(extractsBefore);
    const again = w.model.calls.slice(callsBefore).filter((c) => c.kind === "analyze");
    // Each rule that was done is not asked again; each that was not is asked exactly once.
    for (const rule of done) expect(again.filter((c) => c.ruleKey === rule)).toEqual([]);
    for (const issue of w.services.runs.issues(am, run.id))
      if (!done.has(issue.ruleKey))
        expect(again.filter((c) => c.ruleKey === issue.ruleKey)).toHaveLength(1);
    expect(w.services.matters.view(am).matter.status).toBe("in_review");
    // The attempts are on record: the failed one stays, and a new one follows it.
    expect(
      w.repo
        .listStages(matterId, run.id)
        .filter((s) => s.stage === "analyze" && s.unit === "exc-1")
        .map((s) => [s.attempt, s.status]),
    ).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
  });

  it("only resumes a failed run, only the associate may, and not when the inputs have changed", async () => {
    const w = makeWorld({
      model: {
        before: (call) => {
          if (call.kind === "extract") throw new ModelRequestError("no", 401);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    const uploaded = await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("failed");

    // A reviewer may not resume it.
    const reviewerAm = w.grant(w.reviewer, matterId);
    expect(await errorOf(() => w.services.runs.resume(reviewerAm, run.id))).toMatchObject({
      name: "ForbiddenError",
      action: "run.resume",
    });

    // The inputs change: the run is superseded and cannot come back.
    await w.services.matters.addVersion(am, uploaded.documentIds[1]!, {
      fileName: "corrected.txt",
      bytes: new TextEncoder().encode(
        "AMENDMENT NO. 1\n\n1. Section 6.1 of the Agreement is restated as follows. The obligations continue for two years from each disclosure.",
      ),
      statedDate: "2026-09-20",
    });
    // The failed run stays as it is, and the store will not put it back on inputs it was not
    // started on.
    expect(await errorOf(() => w.services.runs.resume(am, run.id))).toBeInstanceOf(StaleRunError);
    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "failed", current: false });
    expect(w.model.count("extract")).toBe(1);
    await w.services.runs.idle();
  });
});

describe("a restart", () => {
  it("fails what was in flight as interrupted, and resume finishes it", async () => {
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
    await hold.reached(1);
    expect(w.services.runs.get(am, run.id).status).toBe("analyzing");
    expect(w.services.runs.get(am, run.id).progress).toMatchObject({ stage: "analyze", total: 8 });

    // The process dies here. The next one starts by marking what the last left behind.
    const lines: string[] = [];
    const interrupted = markInterruptedRuns(w.repo, (l) => lines.push(l));
    expect(interrupted).toEqual([{ matterId, runId: run.id }]);
    expect(lines).toEqual([
      `run ${run.id} (matter ${matterId}): interrupted by a restart, it can be resumed`,
    ]);
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "interrupted",
    });
    expect(w.services.matters.view(am).matter.status).toBe("ready");

    // A new process, over the same database, with a model that answers.
    const fresh = controlledModel();
    const second = createServices({ ...w.deps, generator: fresh.generator });
    second.runs.resume(am, run.id);
    await second.runs.idle();
    expect(second.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
    expect(w.repo.getMatter(matterId)!.status).toBe("in_review");
    // Extract was done before the crash, so the new process does not ask for it again; the rules
    // had not been answered, so it asks each of them once.
    expect(fresh.count("extract")).toBe(0);
    expect(fresh.count("analyze")).toBe(8);
  });
});

describe("the queue", () => {
  it("refuses a second run on one matter", async () => {
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
    const first = w.services.runs.start(am, {});
    // The page can say it in words, and the route can link to the run: the error carries its id.
    expect(w.services.matters.view(am).start).toEqual({
      ready: false,
      reasons: ["A review is already running"],
    });
    const refused = await errorOf(() => w.services.runs.start(am, {}));
    expect(refused).toBeInstanceOf(ActiveRunError);
    expect((refused as ActiveRunError).activeRunId).toBe(first.id);
    expect(await errorOf(() => w.services.runs.resume(am, first.id))).toBeInstanceOf(Error);
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.list(am)).toHaveLength(1);
  });

  it("runs two matters at once and holds the third until one is done", async () => {
    const hold = gate();
    const w = makeWorld({
      config: { maxConcurrentRuns: 2 },
      model: {
        before: async (call) => {
          if (call.kind === "extract") await hold.pass();
        },
      },
    });
    const ids: string[] = [];
    for (const name of ["one", "two", "three"]) {
      const { matterId, am } = newMatter(w, name);
      await uploadCase(w, matterId);
      ids.push(matterId);
      w.services.runs.start(am, {});
    }
    // Two have reached the model; the third waits its turn and has not.
    await hold.reached(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(hold.arrived).toBe(2);
    const statuses = ids.map((id) => w.repo.listRunsForMatter(id)[0]!.status);
    expect(statuses.filter((s) => s === "queued")).toEqual(["queued"]);
    hold.open();
    await w.services.runs.idle();
    for (const id of ids) expect(w.repo.listRunsForMatter(id)[0]!.status).toBe("succeeded");
    expect(hold.arrived).toBe(3);
  });

  it("runs one at a time when the limit is one", async () => {
    let inFlight = 0;
    let most = 0;
    const w = makeWorld({
      config: { maxConcurrentRuns: 1 },
      model: {
        before: async (call) => {
          if (call.kind !== "extract") return;
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 10));
          inFlight -= 1;
        },
      },
    });
    for (const name of ["a", "b", "c"]) {
      const { matterId, am } = newMatter(w, name);
      await uploadCase(w, matterId);
      w.services.runs.start(am, {});
    }
    await w.services.runs.idle();
    expect(most).toBe(1);
  });

  it("lets a provider that caches a shared prefix see the first answer before the others begin", async () => {
    const order: string[] = [];
    const w = makeWorld({
      model: {
        info: { cachesSharedPrefix: true },
        before: async (call) => {
          if (call.kind !== "analyze") return;
          order.push(`start ${call.ruleKey}`);
          await sleep(5);
          order.push(`end ${call.ruleKey}`);
        },
      },
    });
    await reviewed(w);
    expect(order.slice(0, 2)).toEqual(["start pty-1", "end pty-1"]);
    expect(order.filter((o) => o.startsWith("start"))).toHaveLength(8);
  });

  it("refuses a limit that is not a whole number of runs", () => {
    for (const bad of [0, -1, 1.5, Number.NaN])
      expect(() => makeWorld({ config: { maxConcurrentRuns: bad } })).toThrow(RangeError);
  });

  it("does not analyse more than three rules of one run at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const w = makeWorld({
      model: {
        before: async (call) => {
          if (call.kind !== "analyze") return;
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
        },
      },
    });
    await reviewed(w);
    expect(most).toBe(3);
  });

  it("reports an unknown workflow as not found and a retired one as a conflict, both by kind", async () => {
    const w = makeWorld();
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    expect(await errorOf(() => w.services.runs.start(am, { workflowLabel: "v99" }))).toMatchObject({
      name: "NotFoundError",
    });
  });

  it("refuses a second run through the store as well, with the id of the run in flight", async () => {
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
    const first = w.services.runs.start(am, {});
    // Past the readiness check, the store is the last word.
    const manifest = w.repo.buildRunManifest(matterId, {
      workflowVersionId: w.repo.getWorkflowVersionByLabel("v1")!.id,
      modelProvider: "x",
      model: "y",
    });
    const error = await errorOf(() =>
      w.repo.createRun(matterId, { manifest, startedBy: w.associate.userId }),
    );
    expect(error).toBeInstanceOf(ActiveRunError);
    expect((error as ActiveRunError).activeRunId).toBe(first.id);
    hold.open();
    await w.services.runs.idle();
    expect(StaleRunError).toBeDefined();
  });
});
