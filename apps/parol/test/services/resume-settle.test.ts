import { afterAll, describe, expect, it, vi } from "vitest";
import type { AnalysisAnswer } from "../../src/contracts.js";
import { cleanup, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

/**
 * A run that stored its verify outputs under the code before status settlement existed, and is
 * resumed after the deploy, must verify again and not reuse them: they show the status the model
 * stated where the playbook now settles it, and a reviewer would decide on the wrong one. The
 * verify stage's input hash carries `SETTLEMENT_VERSION` for this.
 *
 * The code before the change is stood in for by two switches. While `state.old` is true the input
 * hash of a verify unit is made without the settlement version, and `settleStatus` settles
 * nothing. The first run is made in that state and fails when its findings are saved, after its
 * verify outputs are stored. The switch is then turned off and the run resumed.
 */

const state = vi.hoisted(() => ({ old: false }));

vi.mock("../../src/canonical.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/canonical.js")>();
  return {
    ...real,
    hashOf: (value: unknown): string => {
      if (
        state.old &&
        typeof value === "object" &&
        value !== null &&
        (value as { stage?: unknown }).stage === "verify"
      ) {
        const { settle: _settle, ...withoutMarker } = value as Record<string, unknown>;
        return real.hashOf(withoutMarker);
      }
      return real.hashOf(value);
    },
  };
});

vi.mock("../../src/settlement.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/settlement.js")>();
  return {
    ...real,
    settleStatus: ((rule, status) =>
      state.old ? status : real.settleStatus(rule, status)) as typeof real.settleStatus,
  };
});

const MISSING: AnalysisAnswer = {
  status: "missing",
  evidence: [],
  discrepancy: "The documents hold no clause on this.",
  explanation: "No paragraph of the documents covers the subject of the rule.",
  fallbackLanguage: null,
  escalateWhenMatched: [],
  conflict: null,
  abstainReason: null,
};

describe("resuming a run whose verify outputs predate settlement", () => {
  it("verifies those units again, settles the status, and asks no model for anything it has", async () => {
    const w = makeWorld({ model: { answers: { "ret-1": MISSING } } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);

    // The first run, as the old code made it: ret-1 is stored as the model stated it.
    state.old = true;
    const save = vi.spyOn(w.repo, "saveFindings").mockImplementationOnce(() => {
      throw new Error("the disk is full");
    });
    const run = w.services.runs.start(am, { workflowLabel: "v1" });
    await w.services.runs.idle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(w.services.runs.get(am, run.id).status).toBe("failed");
    const stored = w.repo.listStages(matterId, run.id).filter((s) => s.stage === "verify");
    expect(stored.map((s) => s.status)).toEqual(Array(8).fill("succeeded"));
    const old = stored.find((s) => s.unit === "ret-1")!;
    expect((old.output as { status: string; modelStatus?: unknown }).status).toBe("missing");
    expect((old.output as { modelStatus?: unknown }).modelStatus).toBeUndefined();

    // The deploy: the code now settles, and its verify input carries the settlement version.
    state.old = false;
    const calls = w.model.calls.length;
    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();

    expect(w.services.runs.get(am, run.id)).toMatchObject({ status: "succeeded", findingCount: 8 });
    const verifies = w.repo.listStages(matterId, run.id).filter((s) => s.stage === "verify");
    // Every unit was verified again: the first attempt stays on record, a second follows it.
    expect(verifies.filter((s) => s.attempt === 1)).toHaveLength(8);
    expect(verifies.filter((s) => s.attempt === 2 && s.status === "succeeded")).toHaveLength(8);
    // The finding the reviewer sees is the settled one, not the stored one.
    const row = w.services.runs.issues(am, run.id).find((r) => r.ruleKey === "ret-1")!;
    expect(row).toMatchObject({ status: "not_applicable", modelStatus: "missing" });
    // Nothing that was already answered was asked again (workflow v1 has no support check).
    expect(w.model.calls.slice(calls)).toEqual([]);
  });

  it("keeps a verify output made by the current code: the version is the same on a resume", async () => {
    state.old = false;
    const w = makeWorld({ model: { answers: { "ret-1": MISSING } } });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const save = vi.spyOn(w.repo, "saveFindings").mockImplementationOnce(() => {
      throw new Error("the disk is full");
    });
    const run = w.services.runs.start(am, { workflowLabel: "v1" });
    await w.services.runs.idle();
    expect(save).toHaveBeenCalledTimes(1);
    expect(w.services.runs.get(am, run.id).status).toBe("failed");

    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("succeeded");
    const verifies = w.repo.listStages(matterId, run.id).filter((s) => s.stage === "verify");
    // Eight units, one attempt each: the stored outputs were reused.
    expect(verifies).toHaveLength(8);
    expect(verifies.every((s) => s.attempt === 1)).toBe(true);
    const row = w.services.runs.issues(am, run.id).find((r) => r.ruleKey === "ret-1")!;
    expect(row).toMatchObject({ status: "not_applicable", modelStatus: "missing" });
  });
});
