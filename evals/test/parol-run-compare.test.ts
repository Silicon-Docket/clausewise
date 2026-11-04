import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import {
  PIN_NAMES,
  compareResults,
  decideFromGates,
  describeRefusal,
  diffPins,
  pairSlots,
  renderComparison,
  type Comparison,
  type PinName,
  type SlotChange,
} from "../src/parol/compare.js";
import {
  GATE_IDS,
  evaluateGates,
  type GateId,
  type GateOutcome,
  type GateReport,
} from "../src/parol/gates.js";
import { parseResults, workflowPin, type ResultsFile, type RunMode } from "../src/parol/results.js";
import { scoreRun, summarizeRun } from "../src/parol/score.js";
import { summarizeCost, summarizeLatency } from "../src/parol/timing.js";
import { tinyKey, tinyObservations, tinyResolver } from "../src/parol/testing.js";
import { createKeyOracle } from "../src/parol/oracle.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";

/**
 * Everything compared here is FABRICATED FOR A TEST: results files made by scoring the small
 * hand-worked key of evals/src/parol/testing.ts, and edited to say what a live run might have
 * said. No model produced any number in this file, and none of it is a result.
 */

let dir = "";
let template: ResultsFile;
beforeAll(async () => {
  dir = await makeTempDir();
  const resultsDir = `${dir}/template`;
  const out = await run(["--selftest"], {
    resultsDir,
    gitInfo: async () => ({ commit: "a".repeat(40), dirty: false }),
  });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(resultsDir);
  template = parseResults(await readFile(`${resultsDir}/${name}`, "utf8"));
});
afterAll(async () => {
  await removeDir(dir);
});

type Variant = "base" | "fixed" | "worst";

interface Fab {
  workflow?: "v1" | "v2";
  /** One variant for every repeat, or one per repeat. */
  variants?: Variant | Variant[];
  repeats?: number;
  mode?: RunMode;
  split?: "dev" | "heldout";
  fullSplit?: boolean;
  /** The p95 latency (ms) and mean cost (USD) of a live run. Fabricated figures. */
  p95Ms?: number;
  meanUsd?: number;
}

/** A results file for the tiny key, FABRICATED FOR A TEST. */
function fabricate(options: Fab = {}): ResultsFile {
  const file = JSON.parse(JSON.stringify(template)) as ResultsFile;
  const mode = options.mode ?? "live";
  const repeats = options.repeats ?? 1;
  const given = options.variants;
  const variants: Variant[] = Array.isArray(given)
    ? given
    : Array.from({ length: repeats }, (): Variant => given ?? "base");
  const key = tinyKey();
  const run = scoreRun(
    variants.map((variant, i) => ({
      key,
      repeat: i + 1,
      ...tinyObservations(i + 1, variant),
      resolver: tinyResolver,
    })),
  );
  const live = mode === "live";
  file.mode = mode;
  file.selftest = mode === "selftest";
  file.simulated = mode === "simulated";
  file.banner =
    mode === "selftest"
      ? "FABRICATED SELFTEST BANNER"
      : mode === "simulated"
        ? "FABRICATED SIMULATED BANNER"
        : null;
  file.pins.mode = mode;
  file.pins.repeats = variants.length;
  file.pins.split = options.split ?? "heldout";
  file.pins.workflow = workflowPin(workflowFor(options.workflow ?? "v1"));
  if (live) {
    file.pins.model = {
      provider: "anthropic",
      requested: "claude-sonnet-5-5",
      reported: null,
      reportedNote: "fabricated",
    };
    file.pins.generation = {
      maxOutputTokens: 16000,
      effort: null,
      maxRetries: 2,
      ruleConcurrency: 3,
      temperature: null,
      fallback: null,
    };
    file.pins.prices = {
      sha256: "c".repeat(64),
      model: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    };
  }
  const section = file.sections[0]!;
  section.split = options.split ?? "heldout";
  section.fullSplit = options.fullSplit ?? true;
  section.completedRepeats = variants.length;
  section.caseKeys = ["CASE-A", "CASE-B", "CASE-C"];
  section.twinKeys = ["CASE-C-twin"];
  section.casesInSplit = 3;
  section.metrics = { repeats: run.repeats, stability: run.stability, summary: summarizeRun(run) };
  section.gates = evaluateGates({ run });
  section.latency = live
    ? summarizeLatency(
        variants.map((_, i) => ({
          caseKey: "CASE-A",
          repeat: i + 1,
          outcome: "succeeded" as const,
          totalMs: options.p95Ms ?? 1000,
          stagesMs: {},
        })),
      )
    : null;
  section.cost = live
    ? summarizeCost(
        variants.map((_, i) => ({
          caseKey: "CASE-A",
          repeat: i + 1,
          outcome: "succeeded" as const,
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 3000,
          cacheWriteTokens: 0,
          costUsd: options.meanUsd ?? 0.05,
        })),
      )
    : null;
  return file;
}

const ok = (c: Comparison): Extract<Comparison, { ok: true }> => {
  if (!c.ok) throw new Error(`expected a comparison, got a refusal: ${describeRefusal(c)}`);
  return c;
};

describe("the pins a comparison checks", () => {
  it("lists every difference, and marks the workflow as the declared variable", () => {
    const a = fabricate({ workflow: "v1" });
    const b = fabricate({ workflow: "v2" });
    const differences = diffPins(a.pins, b.pins);
    expect(differences.map((d) => `${d.name}:${d.field}`)).toEqual([
      "workflow:workflow.label",
      "workflow:workflow.retrieval",
      "workflow:workflow.sha256",
    ]);
    expect(differences.every((d) => d.status === "declared")).toBe(true);
    expect(differences.find((d) => d.field === "workflow.label")).toMatchObject({
      baseline: "v1",
      candidate: "v2",
    });
    expect(diffPins(a.pins, a.pins)).toEqual([]);
  });

  it("refuses a difference in any pin but the workflow, naming it, for every pin there is", () => {
    const edits: Record<Exclude<PinName, "workflow">, (f: ResultsFile) => void> = {
      dataset: (f) => (f.pins.dataset.answerKeysSha256 = "d".repeat(64)),
      split: (f) => (f.pins.cases = ["CASE-A"]),
      playbook: (f) => (f.pins.playbook.sha256 = "e".repeat(64)),
      model: (f) => (f.pins.model.requested = "claude-opus-5-5"),
      "model-reported": (f) => (f.pins.model.reported = ["claude-other"]),
      settings: (f) => (f.pins.generation!.maxOutputTokens = 8000),
      prices: (f) => (f.pins.prices!.model.input = 3),
      evaluation: (f) => (f.pins.evaluation.sha256 = "f".repeat(64)),
      code: (f) => (f.pins.code = { commit: "9".repeat(40), dirty: false }),
      repeats: (f) => (f.pins.repeats = 3),
      mode: (f) => (f.pins.mode = "simulated"),
    };
    expect(Object.keys(edits).sort()).toEqual(PIN_NAMES.filter((n) => n !== "workflow").sort());
    for (const [name, edit] of Object.entries(edits)) {
      const a = fabricate();
      const b = fabricate();
      edit(b);
      const refused = diffPins(a.pins, b.pins).filter((d) => d.status === "refused");
      expect(refused.length, name).toBeGreaterThan(0);
      expect(new Set(refused.map((d) => d.name)), name).toEqual(new Set([name]));
      // The same difference is accepted once it is named, except for the evaluation version.
      const allowed = diffPins(a.pins, b.pins, { allow: [name as PinName] });
      expect(
        allowed.some((d) => d.status === "refused"),
        name,
      ).toBe(name === "evaluation");
    }
  });

  it("does not compare the model the provider reported when asked to leave it out, as before a run", () => {
    const a = fabricate();
    const b = fabricate();
    b.pins.model.reported = ["claude-x"];
    expect(diffPins(a.pins, b.pins, { skip: ["model-reported"] })).toEqual([]);
    expect(diffPins(a.pins, b.pins)).toHaveLength(1);
  });
});

describe("refusing to compare", () => {
  it("returns every difference and says how to allow the expected ones", () => {
    const a = fabricate({ workflow: "v1" });
    const b = fabricate({ workflow: "v2" });
    b.pins.model.requested = "claude-opus-5-5";
    b.pins.repeats = 2;
    b.pins.code = { commit: "1".repeat(40), dirty: true };
    const result = compareResults(a, b);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.differences.filter((d) => d.status === "refused").map((d) => d.name)).toEqual([
      "model",
      "code",
      "code",
      "repeats",
    ]);
    const text = describeRefusal(result);
    expect(text).toContain(
      "Refusing to compare: the two runs differ in more than the workflow under test.",
    );
    // Every difference is listed, the declared one too.
    expect(text).toContain("| workflow | workflow.label | v1 | v2 | declared variable |");
    expect(text).toContain(
      "| model | model.requested | claude-sonnet-5-5 | claude-opus-5-5 | REFUSED |",
    );
    expect(text).toContain("--allow-differences model,code,repeats");
  });

  it("compares once the differences are named, and still lists them", () => {
    const a = fabricate({ workflow: "v1" });
    const b = fabricate({ workflow: "v2" });
    b.pins.model.requested = "claude-opus-5-5";
    const c = ok(compareResults(a, b, { allow: ["model"] }));
    expect(c.differences.map((d) => d.status).sort()).toEqual([
      "allowed",
      "declared",
      "declared",
      "declared",
    ]);
    expect(renderComparison(c, { baseline: "v1", candidate: "v2" })).toContain(
      "| model | model.requested | claude-sonnet-5-5 | claude-opus-5-5 | allowed |",
    );
  });

  it("never allows a different evaluation version, even if a caller passes it", () => {
    const a = fabricate();
    const b = fabricate();
    b.pins.evaluation = { label: "parol-eval v2", sha256: "a".repeat(64) };
    const c = compareResults(a, b, { allow: ["evaluation" as PinName] });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(describeRefusal(c)).toContain(
        "A difference in the evaluation version cannot be allowed",
      );
    }
  });

  it("refuses an incomplete run on either side", () => {
    const a = fabricate();
    const b = fabricate();
    b.complete = false;
    const c = compareResults(a, b);
    expect(c).toMatchObject({
      ok: false,
      problems: ["The candidate run is incomplete; a comparison needs finished runs."],
    });
    a.complete = false;
    expect((compareResults(a, b) as { problems: string[] }).problems).toHaveLength(2);
  });

  it("notes when both runs are of one workflow, and when both trees were dirty on the same commit", () => {
    const a = fabricate();
    const b = fabricate();
    a.pins.code = b.pins.code = { commit: "7".repeat(40), dirty: true };
    const c = ok(compareResults(a, b));
    expect(c.notes).toContain(
      "The two runs use the same workflow, so this compares two runs of one version and not two versions.",
    );
    expect(c.notes.some((n) => n.includes("uncommitted changes on the same commit"))).toBe(true);
  });
});

describe("the paired list of slots that changed", () => {
  const run = (variants: Variant[]) =>
    scoreRun(
      variants.map((v, i) => ({
        key: tinyKey(),
        repeat: i + 1,
        ...tinyObservations(i + 1, v),
        resolver: tinyResolver,
      })),
    );

  it("lists the one slot a fix changes, with what each side said and how often it was right", () => {
    const { changes, paired, unpaired } = pairSlots(run(["base"]), run(["fixed"]));
    expect(paired).toBe(12);
    expect(unpaired).toBe(0);
    expect(changes).toEqual([
      {
        caseKey: "CASE-B",
        ruleKey: "exc-1",
        severity: "high",
        expected: "deviation",
        baseline: {
          modal: "compliant",
          histogram: "compliant x1",
          correct: 0,
          repeats: 1,
          failures: ["silent_miss"],
        },
        candidate: {
          modal: "deviation",
          histogram: "deviation x1",
          correct: 1,
          repeats: 1,
          failures: [],
        },
        kind: "improvement",
      },
    ]);
  });

  it("calls the same slot a regression the other way round, and lists regressions first", () => {
    const back = pairSlots(run(["fixed"]), run(["base"])).changes;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      caseKey: "CASE-B",
      ruleKey: "exc-1",
      kind: "regression",
      severity: "high",
    });
    // Against a run that is wrong everywhere, the order is regressions, improvements, then others,
    // high severity first within each.
    const many = pairSlots(run(["base"]), run(["worst"])).changes;
    const kinds = many.map((c) => c.kind);
    expect(kinds).toEqual(
      [...kinds].sort(
        (a, b) =>
          ["regression", "improvement", "changed"].indexOf(a) -
          ["regression", "improvement", "changed"].indexOf(b),
      ),
    );
    expect(many.length).toBeGreaterThan(3);
    const regressions = many.filter((c) => c.kind === "regression");
    const weights = regressions.map((c) => ({ high: 5, medium: 3, low: 1 })[c.severity]);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("pairs by the share of repeats that were right and the most common status, whatever k is", () => {
    // Baseline: the slot was wrong in two repeats and right in one. Candidate: right in all three.
    const { changes } = pairSlots(run(["base", "base", "fixed"]), run(["fixed", "fixed", "fixed"]));
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      caseKey: "CASE-B",
      ruleKey: "exc-1",
      kind: "improvement",
      baseline: {
        modal: "compliant",
        histogram: "compliant x2, deviation x1",
        correct: 1,
        repeats: 3,
      },
      candidate: { modal: "deviation", histogram: "deviation x3", correct: 3, repeats: 3 },
    });
    // A tie between two statuses goes to the earlier in the list of statuses, which is `compliant`.
    const tie = pairSlots(run(["base", "fixed"]), run(["fixed", "fixed"])).changes[0]!;
    expect(tie.baseline).toMatchObject({ modal: "compliant", correct: 1, repeats: 2 });
    // Runs with a different number of repeats are compared by share (1 of 2 against 3 of 3).
    expect(
      pairSlots(run(["base", "fixed"]), run(["fixed", "fixed", "fixed"])).changes[0]!.kind,
    ).toBe("improvement");
  });

  it("lists nothing for two identical runs, and counts slots that are in only one run", () => {
    expect(pairSlots(run(["base"]), run(["base"])).changes).toEqual([]);
    const a = run(["base"]);
    const b = run(["base"]);
    b.repeats[0]!.slotScores = b.repeats[0]!.slotScores.slice(1);
    const result = pairSlots(a, b);
    expect(result.paired).toBe(11);
    expect(result.unpaired).toBe(1);
  });
});

describe("the comparison table", () => {
  it("is computed from the two files: counts, the change, the gate and the candidate's result", () => {
    const base = fabricate({ workflow: "v1", variants: "base" });
    const fixed = fabricate({ workflow: "v2", variants: "fixed" });
    const c = ok(compareResults(base, fixed));
    const rows = Object.fromEntries(c.sections[0]!.rows.map((r) => [r.metric, r]));
    // Four slots are expected to be flagged. The base run finds two of them with a governing
    // citation (the others: one silent miss and one flagged with supporting evidence only), the
    // fixed run finds three.
    expect(rows["Issue recall, strict (count)"]).toEqual({
      metric: "Issue recall, strict (count)",
      baseline: "0.500 (2 of 4)",
      candidate: "0.750 (3 of 4)",
      change: "+0.250",
      gate: ">= 0.90 (17 of 18)",
      pass: "FAIL",
    });
    expect(rows["High-severity silent misses"]).toMatchObject({
      baseline: "1",
      candidate: "0",
      change: "-1.00",
      gate: "0",
      pass: "pass",
    });
    // Stability needs two repeats. With one it has no value, which is n/a and not a perfect 1.
    expect(rows["Stability (mean modal agreement)"]).toMatchObject({
      baseline: "n/a",
      candidate: "n/a",
      change: "n/a",
      pass: "not evaluated",
    });
    // A rate with no denominator in either run is n/a and not a perfect score.
    expect(rows["Unauthorized-data exposure"]).toMatchObject({
      baseline: "n/a",
      candidate: "n/a",
      pass: "not evaluated",
    });
    expect(c.sections[0]!.changes.map((s) => `${s.caseKey} ${s.ruleKey} ${s.kind}`)).toEqual([
      "CASE-B exc-1 improvement",
    ]);
  });

  it("shows latency and cost of live runs and the change in the 95th percentile", () => {
    const base = fabricate({ variants: "base", p95Ms: 2000, meanUsd: 0.1 });
    const fast = fabricate({ workflow: "v2", variants: "fixed", p95Ms: 3000, meanUsd: 0.12 });
    const c = ok(compareResults(base, fast));
    const rows = Object.fromEntries(c.sections[0]!.rows.map((r) => [r.metric, r]));
    expect(rows["p50 / p95 run latency (s)"]).toMatchObject({
      baseline: "2.00 / 2.00",
      candidate: "3.00 / 3.00",
      change: "+1.00",
      pass: "pass",
    });
    expect(rows["Mean / max cost per run (USD)"]).toMatchObject({
      baseline: "$0.1000 / $0.1000",
      candidate: "$0.1200 / $0.1200",
      change: "+0.0200",
    });
    expect(rows["Prompt tokens read from cache"]).toMatchObject({
      baseline: "0.750",
      candidate: "0.750",
      change: "0",
    });
    // 3 s is within 1.5 times 2 s, and $0.12 is within 1.5 times $0.10: G13 passes.
    expect(c.sections[0]!.candidateGates!.results.find((r) => r.id === "G13")!.outcome).toBe(
      "pass",
    );
    const slow = fabricate({ workflow: "v2", variants: "fixed", p95Ms: 3100, meanUsd: 0.12 });
    expect(
      ok(compareResults(base, slow)).sections[0]!.candidateGates!.results.find(
        (r) => r.id === "G13",
      )!.outcome,
    ).toBe("fail");
  });
});

describe("the decision rule", () => {
  /** A gate report FABRICATED FOR A TEST: every gate passes except those named. */
  const report = (outcomes: Partial<Record<GateId, GateOutcome>>): GateReport => {
    const results = GATE_IDS.map((id) => ({
      id,
      title: id,
      threshold: "",
      scope: "whole run" as const,
      outcome: outcomes[id] ?? "pass",
      evidence: [],
      detail: "",
    }));
    return {
      results,
      passed: results.every((r) => r.outcome === "pass"),
      failed: results.filter((r) => r.outcome === "fail").map((r) => r.id),
      notEvaluated: results.filter((r) => r.outcome === "not_evaluated").map((r) => r.id),
    };
  };
  const change = (
    severity: SlotChange["severity"],
    kind: SlotChange["kind"],
    correct: [number, number],
  ): SlotChange => ({
    caseKey: "C",
    ruleKey: "r",
    severity,
    expected: "deviation",
    baseline: { modal: "deviation", histogram: "", correct: correct[0], repeats: 3, failures: [] },
    candidate: { modal: "compliant", histogram: "", correct: correct[1], repeats: 3, failures: [] },
    kind,
  });

  it("promotes only when every gate passes and no slot got worse", () => {
    const d = decideFromGates({ gates: report({}), changes: [], repeats: 3 });
    expect(d.outcome).toBe("promote");
    expect(d.label).toBe("PROMOTE TO PILOT, as a gate result");
    // Two conditions of the rule need another run, and are listed and not assumed.
    expect(d.unchecked).toHaveLength(2);
    expect(d.unchecked[0]).toContain("targeted failure is fixed");
    expect(d.unchecked[1]).toContain("overfitting");
    expect(decideFromGates({ gates: report({}), changes: [], repeats: 2 }).unchecked).toHaveLength(
      3,
    );
  });

  it("promotes with conditions when only cost or latency is over the budget, or a lower-severity slot got worse", () => {
    const g13 = decideFromGates({ gates: report({ G13: "fail" }), changes: [], repeats: 3 });
    expect(g13.outcome).toBe("promote_with_conditions");
    expect(g13.conditions[0]).toContain("Cost or latency is over the budget (G13)");
    const soft = decideFromGates({
      gates: report({}),
      changes: [change("medium", "regression", [3, 2])],
      repeats: 3,
    });
    expect(soft.outcome).toBe("promote_with_conditions");
    expect(soft.conditions[0]).toContain("1 lower-severity slot got worse");
    expect(
      decideFromGates({
        gates: report({ G13: "fail" }),
        changes: [change("low", "regression", [3, 0])],
        repeats: 3,
      }).conditions,
    ).toHaveLength(2);
  });

  it("does not promote when any other gate fails, and says that a failure of G1 to G5 rules it out", () => {
    for (const id of GATE_IDS.filter((g) => g !== "G13")) {
      const d = decideFromGates({ gates: report({ [id]: "fail" }), changes: [], repeats: 3 });
      expect(d.outcome, id).toBe("do_not_promote");
      expect(d.reasons[0], id).toContain(`${id} failed`);
      expect(d.reasons[0]?.includes("any failure of G1 to G5 rules out promotion"), id).toBe(
        /^G[1-5]$/.test(id),
      );
    }
  });

  it("does not promote on a new high-severity failure, even when every gate passes", () => {
    const d = decideFromGates({
      gates: report({}),
      changes: [change("high", "regression", [3, 2])],
      repeats: 3,
    });
    expect(d.outcome).toBe("do_not_promote");
    expect(d.reasons[0]).toContain(
      "1 high-severity slot that every baseline repeat got right is wrong in the candidate",
    );
  });

  it("does not take a gate that was not evaluated for a pass", () => {
    const d = decideFromGates({
      gates: report({ G1: "not_evaluated", G11: "not_evaluated" }),
      changes: [],
      repeats: 3,
    });
    expect(d.outcome).toBe("do_not_promote");
    expect(d.reasons).toEqual([
      "No gate failed, but G1, G11 were not evaluated, and promotion needs every gate to pass.",
    ]);
  });

  it("is applied to two live runs of the whole held-out split, and to nothing else", () => {
    const live = (split: "dev" | "heldout", fullSplit = true) => ({
      a: fabricate({ split, fullSplit, variants: ["base", "base", "base"] }),
      b: fabricate({ split, fullSplit, workflow: "v2", variants: ["fixed", "fixed", "fixed"] }),
    });
    const heldout = live("heldout");
    const decided = ok(compareResults(heldout.a, heldout.b)).sections[0]!;
    // The tiny key's gates cannot all be evaluated (no exposure suites, no calibration set), and
    // strict recall is under 0.90, so the rule says not to promote and says why.
    expect(decided.decision).not.toBeNull();
    expect(decided.decision!.outcome).toBe("do_not_promote");
    expect(decided.decision!.reasons.join(" ")).toMatch(/G6 failed/);
    expect(decided.decisionNote).toBeNull();

    const dev = live("dev");
    const onDev = ok(compareResults(dev.a, dev.b)).sections[0]!;
    expect(onDev.decision).toBeNull();
    expect(onDev.decisionNote).toContain(
      "it is a rule for held-out runs, and this is the dev split",
    );

    const subset = live("heldout", false);
    expect(ok(compareResults(subset.a, subset.b)).sections[0]!.decisionNote).toContain(
      "needs the whole held-out split",
    );

    const scripted = {
      a: fabricate({ mode: "selftest", variants: ["base"] }),
      b: fabricate({ mode: "selftest", workflow: "v2", variants: ["fixed"] }),
    };
    const s = ok(compareResults(scripted.a, scripted.b)).sections[0]!;
    expect(s.decision).toBeNull();
    expect(s.decisionNote).toContain(
      "involves a selftest or a simulated run says nothing about any model",
    );
  });

  it("is worded as a gate result, never as a recommendation, and asks for the legal engineer's sign-off", () => {
    const a = fabricate({ variants: ["base", "base", "base"] });
    const b = fabricate({ workflow: "v2", variants: ["fixed", "fixed", "fixed"] });
    const text = renderComparison(ok(compareResults(a, b)), { baseline: "v1", candidate: "v2" });
    expect(text).toContain("DO NOT PROMOTE, as a gate result.");
    expect(text).toContain("This is the result of the gates and not a recommendation.");
    expect(text).toContain("signed off by the legal engineer");
    expect(text).toContain("nothing here ships a version");
    expect(text).toContain("Conditions of the rule that this comparison cannot check:");
    expect(text).not.toMatch(/\b(recommend|should ship|ready to ship|safe to promote)\b/i);
  });
});

describe("a comparison that involves a scripted run", () => {
  it("says so at the top, over every table, and prints no latency, cost or decision", () => {
    for (const mode of ["selftest", "simulated"] as const) {
      const a = fabricate({ mode, variants: ["base"] });
      const b = fabricate({ mode, workflow: "v2", variants: ["fixed"] });
      const text = renderComparison(ok(compareResults(a, b)), { baseline: "v1", candidate: "v2" });
      const lines = text.split("\n");
      expect(lines[0]).toBe("# Comparison: baseline v1 against candidate v2");
      expect(lines[2]).toBe(
        `**THIS COMPARISON INVOLVES A ${mode.toUpperCase()} RUN. THE NUMBERS BELOW ARE NOT SCORES OF ANY MODEL.**`,
      );
      expect(text.indexOf("THIS COMPARISON INVOLVES")).toBeLessThan(text.indexOf("| Metric"));
      expect(text).toContain(`**${mode.toUpperCase()} INVOLVED: NOT SCORES OF ANY MODEL.**`);
      expect(text).toContain("| p50 / p95 run latency (s) | n/a | n/a | n/a |");
      expect(text).toContain("| Mean / max cost per run (USD) | n/a | n/a | n/a |");
      expect(text).not.toMatch(/\$\d/);
      expect(text).toContain("The decision rule is not applied");
      expect(text).not.toContain("as a gate result.");
    }
  });

  it("names both kinds when a selftest is compared with a simulated run", () => {
    const a = fabricate({ mode: "selftest", variants: ["base"] });
    const b = fabricate({ mode: "simulated", variants: ["fixed"] });
    // The mode is a pin, so the runs differ in it and the caller has to say that is expected.
    expect(compareResults(a, b).ok).toBe(false);
    const text = renderComparison(ok(compareResults(a, b, { allow: ["mode", "model"] })), {
      baseline: "v1",
      candidate: "v1",
    });
    expect(text).toContain("INVOLVES A SELFTEST AND A SIMULATED RUN");
  });

  it("refuses after a run, and not before, when the model the provider reported differs, and compares once it is allowed", async () => {
    const resultsDir = `${dir}/reported`;
    const baseline = `${resultsDir}/baseline.json`;
    const made = await run(["--selftest", "--out", baseline], { resultsDir });
    expect(made.code).toBe(0);
    // FABRICATED FOR A TEST: the baseline says a provider named a model, which a scripted run never does.
    const { readFile: read, writeFile: write } = await import("node:fs/promises");
    const file = JSON.parse(await read(baseline, "utf8")) as ResultsFile;
    file.pins.model.reported = ["claude-reported-by-the-baseline"];
    await write(baseline, JSON.stringify(file));

    const refused = await run(["--selftest", "--compare", baseline], { resultsDir });
    // What a provider will report is not known before the run, so nothing stopped it: the run was
    // made, its results were written and its report printed, and only the comparison was refused.
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      '| model-reported | model.reported | ["claude-reported-by-the-baseline"] | null | REFUSED |',
    );
    expect(refused.stderr).toContain("--allow-differences model-reported");
    expect(refused.stdout).toContain("# Parol evaluation, SELFTEST");
    expect(refused.stdout).not.toContain("# Comparison");

    const allowed = await run(
      ["--selftest", "--compare", baseline, "--allow-differences", "model-reported"],
      {
        resultsDir,
      },
    );
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(allowed.stdout).toContain("# Comparison: baseline v1 against candidate v1");
    expect(allowed.stdout).toContain("| model-reported | model.reported |");
    expect(allowed.stdout).toContain(
      '| model-reported | model.reported | ["claude-reported-by-the-baseline"] | null | allowed |',
    );
  });

  it("does not compare a run that stopped early, says why, and keeps the exit code of the stop", async () => {
    const resultsDir = `${dir}/stopped`;
    const baseline = `${resultsDir}/baseline.json`;
    expect((await run(["--selftest", "--out", baseline], { resultsDir })).code).toBe(0);
    const controller = new AbortController();
    let calls = 0;
    const stopped = await run(["--selftest", "--compare", baseline], {
      resultsDir,
      signal: controller.signal,
      generatorFactory: (request) => {
        const inner = createKeyOracle({
          caseKey: request.prepared.runnable.caseKey,
          expect: request.prepared.runnable.expect,
          spans: request.prepared.ingest.spans,
          rules: request.playbook.rules,
        });
        return {
          ...inner,
          generate: (call) => {
            if (++calls === 20) controller.abort(new Error("Interrupted"));
            return inner.generate(call);
          },
        };
      },
    });
    expect(stopped.code).toBe(130);
    expect(stopped.stderr).toContain("Cannot compare the two runs.");
    expect(stopped.stderr).toContain(
      "The candidate run is incomplete; a comparison needs finished runs.",
    );
    expect(stopped.stderr).not.toContain("Refusing to compare");
    expect(stopped.stdout).toContain("**INCOMPLETE: the run stopped early.**");
    expect(stopped.stdout).not.toContain("# Comparison");
  });

  it("compares two real selftest files made by the command, workflow against workflow", async () => {
    const resultsDir = `${dir}/real`;
    const first = await run(["--selftest", "--workflow", "v1", "--runs", "2"], {
      resultsDir,
      now: () => new Date("2026-11-04T11:00:00Z"),
    });
    expect(first.code).toBe(0);
    const second = await run(
      [
        "--selftest",
        "--workflow",
        "v2",
        "--runs",
        "2",
        "--compare",
        `${resultsDir}/parol-20261104T110000Z.json`,
      ],
      { resultsDir, now: () => new Date("2026-11-04T11:00:01Z") },
    );
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("# Comparison: baseline v1 against candidate v2");
    expect(second.stdout).toContain("**THIS COMPARISON INVOLVES A SELFTEST RUN.");
    expect(second.stdout).toContain(
      "| workflow | workflow.retrieval | R1 | R2 | declared variable |",
    );
    // The oracle is perfect under both, so nothing changed.
    expect(second.stdout).toContain("No paired slot changed (48 paired).");
    // And a model that differs is refused before anything runs.
    const refused = await run(
      ["--selftest", "--runs", "3", "--compare", `${resultsDir}/parol-20261104T110000Z.json`],
      { resultsDir },
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("| repeats | run.repeats | 2 | 3 | REFUSED |");
    expect(refused.stderr).toContain("--allow-differences repeats");
    expect(refused.stderr).toContain("Nothing was sent.");
    expect(refused.stdout).toBe("");
  });
});
