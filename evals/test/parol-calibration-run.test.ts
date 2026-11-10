import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelOutputError, ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../apps/parol/src/canonical.js";
import { loadPlaybook } from "../../apps/parol/src/playbooks/load.js";
import { createSupportChecker } from "../../apps/parol/src/services/support-checker.js";
import { getPrompt } from "../../apps/parol/src/prompts/registry.js";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import type { CalibrationFile, CalibrationKeyPair } from "../../fixtures/parol/types.js";
import {
  CALIBRATION_FILE,
  CalibrationSetError,
  loadCalibrationSet,
  prepareCalibration,
  runCalibration,
} from "../src/parol/calibration-run.js";
import { loadDataset, type Dataset } from "../src/parol/dataset.js";
import { buildParolPlan } from "../src/parol/plan.js";
import { RECORDING_SUFFIX, requestKey } from "../src/parol/replay.js";
import { prepareCase, runnableCases } from "../src/parol/runner.js";
import {
  copyRoot,
  editJson,
  makeTempDir,
  oracleFactory,
  readResults,
  removeDir,
  run,
} from "../src/parol/testing-run.js";
import { readFileSync } from "node:fs";
import { createKeyOracle } from "../src/parol/oracle.js";
import type { ObjectGenerator } from "@clausewise/llm";

/**
 * The calibration run. The pairs here are FABRICATED FOR A TEST from the text of PAROL-D01: eight
 * short pairs with made-up labels, not the real calibration set, and the verdicts come from a
 * script. Nothing here says anything about any model.
 */

let dir = "";
let n = 0;
let root = "";
let dataset: Dataset;
let pairs: CalibrationKeyPair[] = [];
const playbookPath = (r: string): string =>
  join(r, "apps/parol/playbooks/parol-nda-recipient.yaml");

beforeAll(async () => {
  dir = await makeTempDir();
  root = await copyRoot(dir);
  const loaded = await loadDataset(root);
  if (!loaded.ok) throw new Error("the copied dataset does not load");
  dataset = loaded.dataset;
  const playbook = loadPlaybook({
    yaml: readFileSync(playbookPath(root), "utf8"),
    slug: dataset.keys.playbook.slug,
    source: playbookPath(root),
  });
  const entry = dataset.keys.cases.find((c) => c.case === "PAROL-D01")!;
  const [runnable] = runnableCases({ cases: [entry], twins: [] });
  const prepared = await prepareCase({
    dataset,
    runnable: runnable!,
    repeat: 1,
    playbook,
    workflow: workflowFor("v3"),
    parsed: new Map(),
  });
  // Eight numbered clauses, each quoted by its first words, which occur once in their clause.
  const chosen = prepared.ingest.spans
    .filter((span) => span.clauseNumber !== null && span.text.split(/\s+/).length > 14)
    .slice(0, 8);
  expect(chosen).toHaveLength(8);
  pairs = chosen.map((span, i): CalibrationKeyPair => {
    const label = i % 2 === 0 ? "supported" : "unsupported";
    return {
      id: `CAL-${String(i + 1).padStart(2, "0")}`,
      case: "PAROL-D01",
      rule: playbook.rules[i % playbook.rules.length]!.key,
      label,
      ...(label === "unsupported" ? { kind: i % 4 === 1 ? "superseded" : "wrong_frame" } : {}),
      claim: {
        status: i % 3 === 0 ? "compliant" : "deviation",
        // Every pair has a token of its own in its discrepancy, so that a scripted checker can tell
        // a calibration request from the support calls of a case.
        discrepancy: `TOKEN-${i + 1} a made-up discrepancy`,
        explanation: "made up",
      },
      evidence: {
        doc: span.docLabel,
        clause: span.clauseNumber,
        quote: span.text.split(/\s+/).slice(0, 8).join(" "),
        paragraph: span.paragraphIndex,
      },
      paragraphSha256: sha256Hex(span.text),
      note: "made up",
    } as CalibrationKeyPair;
  });
});
afterAll(async () => {
  await removeDir(dir);
});

/** A copy of the dataset with the test pairs recorded in splits.json, as the builder does. */
async function withSet(edit?: (file: CalibrationFile) => void): Promise<string> {
  const copy = join(dir, `copy-${++n}`);
  await mkdir(copy, { recursive: true });
  const r = await copyRoot(copy);
  const file: CalibrationFile = {
    format: 1,
    dataset: "parol-calibration test",
    playbook: dataset.keys.playbook as CalibrationFile["playbook"],
    counts: {
      pairs: pairs.length,
      supported: 4,
      unsupported: 4,
      byKind: {
        superseded: 2,
        wrong_frame: 2,
        overlooked_exception: 0,
        other_party_obligation: 0,
        definition_as_duty: 0,
      },
    },
    pairs: structuredClone(pairs),
  };
  edit?.(file);
  await writeFile(join(r, CALIBRATION_FILE), `${JSON.stringify(file, null, 2)}\n`);
  await editJson<{ calibration?: unknown }>(join(r, "fixtures/parol/splits.json"), (splits) => {
    splits.calibration = { sha256: sha256Hex(canonicalJson(file)), ...file.counts };
  });
  return r;
}

const loadedOf = async (r: string): Promise<Dataset> => {
  const loaded = await loadDataset(r);
  if (!loaded.ok) throw new Error("does not load");
  return loaded.dataset;
};

describe("loading the calibration set", () => {
  it("says there is none when splits.json records none", async () => {
    const copy = join(dir, `copy-${++n}`);
    await mkdir(copy, { recursive: true });
    const r = await copyRoot(copy);
    await editJson<{ calibration?: unknown }>(join(r, "fixtures/parol/splits.json"), (splits) => {
      delete splits.calibration;
    });
    expect(await loadCalibrationSet(await loadedOf(r))).toEqual({ ok: false, reason: "absent" });
  });

  it("loads a set that agrees with the hash and the counts splits.json records", async () => {
    const r = await withSet();
    const loaded = await loadCalibrationSet(await loadedOf(r));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.set.file.pairs).toHaveLength(8);
  });

  it("refuses a set that was edited after it was recorded", async () => {
    const r = await withSet();
    await editJson<CalibrationFile>(join(r, CALIBRATION_FILE), (file) => {
      file.pairs[0]!.label = "unsupported";
    });
    const loaded = await loadCalibrationSet(await loadedOf(r));
    expect(loaded).toMatchObject({ ok: false, reason: "integrity" });
    if (!loaded.ok && loaded.reason === "integrity") {
      expect(loaded.problems.join(" ")).toMatch(/hashes to/);
    }
  });

  it("refuses a set written for another version of the playbook", async () => {
    const r = await withSet((file) => {
      file.playbook = { ...file.playbook, sha256: "0".repeat(64) };
    });
    const loaded = await loadCalibrationSet(await loadedOf(r));
    expect(loaded).toMatchObject({ ok: false, reason: "integrity" });
  });

  it("reports a file that is not a calibration set instead of crashing on it", async () => {
    for (const body of ["null", "{}", "[]", '"x"', '{"pairs":[]}', '{"pairs":{},"playbook":{}}']) {
      const r = await withSet();
      await writeFile(join(r, CALIBRATION_FILE), body);
      const loaded = await loadCalibrationSet(await loadedOf(r));
      expect(loaded, body).toMatchObject({ ok: false, reason: "integrity" });
    }
  });

  it("reports a recorded set whose file is missing", async () => {
    const r = await withSet();
    await removeDir(join(r, CALIBRATION_FILE));
    expect(await loadCalibrationSet(await loadedOf(r))).toMatchObject({
      ok: false,
      reason: "integrity",
    });
  });
});

describe("preparing and running the pairs", () => {
  const setup = async (edit?: (file: CalibrationFile) => void) => {
    const r = await withSet(edit);
    const data = await loadedOf(r);
    const loaded = await loadCalibrationSet(data);
    if (!loaded.ok) throw new Error("does not load");
    const playbook = loadPlaybook({
      yaml: readFileSync(playbookPath(r), "utf8"),
      slug: data.keys.playbook.slug,
      source: playbookPath(r),
    });
    const workflow = workflowFor("v3");
    return { data, set: loaded.set, playbook, workflow };
  };

  /** A scripted checker that answers by the label of the pair whose discrepancy it is shown. */
  const checker = (mistakes: { miss?: string; alarm?: string; fail?: string } = {}) => {
    const seen: string[] = [];
    const generator: ObjectGenerator = {
      provider: "anthropic",
      model: "a-model",
      disclosure: "a scripted stand-in",
      async generate(request) {
        seen.push(request.prompt);
        const index = pairs.findIndex(
          (p) =>
            request.prompt.includes(p.evidence.quote) &&
            request.prompt.includes(p.claim.discrepancy),
        );
        const pair = pairs[index]!;
        if (pair.id === mistakes.fail) throw new ModelOutputError("never valid", false);
        const unsupported = pair.label === "unsupported";
        const caught = pair.id === mistakes.miss ? false : unsupported;
        const flagged = pair.id === mistakes.alarm ? true : caught;
        return request.schema.parse({
          verdict: flagged ? (index % 2 === 0 ? "insufficient" : "not_supported") : "supported",
          missingPremise: flagged ? "made up" : null,
        });
      },
    };
    return { generator, seen };
  };

  it("finds each cited paragraph and builds the claim the checker is shown", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    expect(prepared).toHaveLength(8);
    for (const item of prepared) {
      expect(item.span.text).toContain(item.pair.evidence.quote);
      expect(item.draft.evidence).toEqual([
        { spanId: item.span.id, quote: item.pair.evidence.quote, role: "governing" },
      ]);
      expect(item.draft.status).toBe(item.pair.claim.status);
      expect(item.rule.key).toBe(item.pair.rule);
    }
  });

  it("refuses a pair whose quote is not in the document, without quoting it", async () => {
    const { data, set, playbook, workflow } = await setup((file) => {
      file.pairs[2]!.evidence.quote = "words that are in no document of the case at all";
    });
    const error = await prepareCalibration({ set, dataset: data, playbook, workflow }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CalibrationSetError);
    expect((error as Error).message).toContain("CAL-03");
    expect((error as Error).message).not.toContain("words that are in no document");
  });

  it("refuses a pair whose paragraph is not the paragraph its label was written for", async () => {
    // The quote is still unique in its clause, but the paragraph the label was written for has
    // changed (a different index, or text that no longer hashes to what was recorded).
    for (const edit of [
      (file: CalibrationFile) => {
        file.pairs[1]!.evidence.paragraph += 1;
      },
      (file: CalibrationFile) => {
        file.pairs[1]!.paragraphSha256 = "0".repeat(64);
      },
    ]) {
      const { data, set, playbook, workflow } = await setup(edit);
      const error = await prepareCalibration({ set, dataset: data, playbook, workflow }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(CalibrationSetError);
      expect((error as Error).message).toContain("CAL-02");
      expect((error as Error).message).toContain("not the paragraph its label was written for");
    }
  });

  it("refuses a pair built from a held-out case, which would send held-out text outside the ledger", async () => {
    const { data, set, playbook, workflow } = await setup((file) => {
      file.pairs[0]!.case = "PAROL-H01";
    });
    const error = await prepareCalibration({ set, dataset: data, playbook, workflow }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CalibrationSetError);
    expect((error as Error).message).toContain("not in the development split");
    expect((error as Error).message).toContain("CAL-01");
  });

  it("refuses a pair from a case the keys do not have", async () => {
    const { data, set, playbook, workflow } = await setup((file) => {
      file.pairs[0]!.case = "PAROL-D99";
    });
    await expect(prepareCalibration({ set, dataset: data, playbook, workflow })).rejects.toThrow(
      /not in the answer keys/,
    );
  });

  it("scores the verdicts, with the kind of each missed pair", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const { generator, seen } = checker({ miss: "CAL-02", alarm: "CAL-05" });
    const record = await runCalibration({
      set,
      prepared,
      prompt: getPrompt("support.p1"),
      generator,
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(8);
    // Four unsupported pairs, one of them missed; four supported, one of them flagged.
    expect(record.result.catchRate).toMatchObject({ numerator: 3, denominator: 4 });
    expect(record.result.falseAlarmRate).toMatchObject({ numerator: 1, denominator: 4 });
    expect(record.result.catchByKind["superseded"]).toMatchObject({ numerator: 1, denominator: 2 });
    expect(record.result.catchByKind["wrong_frame"]).toMatchObject({
      numerator: 2,
      denominator: 2,
    });
    expect(record).toMatchObject({
      setSha256: set.sha256,
      prompt: { id: "support.p1", sha256: getPrompt("support.p1").sha256 },
      supportedPairs: 4,
      unsupportedPairs: 4,
      failedPairs: 0,
      modelCalls: 8,
      note: null,
    });
  });

  it("shows the checker only the rule, the status, the discrepancy and the cited paragraph", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const { generator, seen } = checker();
    await runCalibration({
      set,
      prepared,
      prompt: getPrompt("support.p1"),
      generator,
      signal: new AbortController().signal,
    });
    for (const [index, item] of prepared.entries()) {
      const prompt = seen.find((text) => text.includes(item.pair.evidence.quote))!;
      expect(prompt).toContain(item.span.text);
      // Not the explanation, not the label, not the note, not the id or the kind.
      expect(prompt).not.toContain(item.pair.claim.explanation);
      expect(prompt).not.toContain(item.pair.note);
      expect(prompt).not.toContain(item.pair.id);
      expect(prompt).not.toContain(item.pair.kind ?? "\u0000");
      // And no other paragraph of the case: the cited one is the only passage in the prompt.
      const others = prepared[(index + 1) % prepared.length]!.span.text;
      expect(prompt).not.toContain(others);
    }
  });

  it("counts a call that returned no verdict against the checker on both sides", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    // CAL-02 is unsupported and CAL-03 is supported; both calls fail.
    const failing = checker({ fail: "CAL-02" });
    const record = await runCalibration({
      set,
      prepared,
      prompt: getPrompt("support.p1"),
      generator: failing.generator,
      signal: new AbortController().signal,
    });
    expect(record.failedPairs).toBe(1);
    expect(record.result.catchRate).toMatchObject({ numerator: 3, denominator: 4 });
    expect(record.result.failed).toEqual({ supported: 0, unsupported: 1 });
    // The outcome of every call is kept, so that an outage can be told from a refusal.
    expect(record.callOutcomes).toEqual({ ok: 7, schema_error: 1 });
    expect(record.note).toMatch(/1 of 8 calls returned no verdict/);
    // The catch rate is a lower bound and the false alarm rate an upper bound, and the note says so.
    expect(record.note).toMatch(
      /catch rate is a lower bound and the false alarm rate an upper bound/,
    );
    const failingSupported = checker({ fail: "CAL-03" });
    const second = await runCalibration({
      set,
      prepared,
      prompt: getPrompt("support.p1"),
      generator: failingSupported.generator,
      signal: new AbortController().signal,
    });
    expect(second.result.falseAlarmRate).toMatchObject({ numerator: 1, denominator: 4 });
  });

  it("asks the checker exactly what a review asks it for the same claim and passage", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const support = getPrompt("support.p1");
    const viaRun: string[] = [];
    const viaReview: string[] = [];
    const spy = (into: string[]): ObjectGenerator => ({
      provider: "anthropic",
      model: "a-model",
      disclosure: "a scripted stand-in",
      async generate(request) {
        into.push(requestKey(request));
        return request.schema.parse({ verdict: "supported", missingPremise: null });
      },
    });
    await runCalibration({
      set,
      prepared,
      prompt: support,
      generator: spy(viaRun),
      signal: new AbortController().signal,
    });
    // The same pair through the checker of the review, as verifyFinding builds the call.
    const check = createSupportChecker(support);
    for (const item of prepared) {
      await check({
        generator: spy(viaReview),
        signal: new AbortController().signal,
        rule: item.rule,
        draft: item.draft,
        citedSpans: [item.span],
      });
    }
    expect([...viaRun].sort()).toEqual([...viaReview].sort());
  });

  it("stops at an abort, with no record and no further calls", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const controller = new AbortController();
    let calls = 0;
    const generator: ObjectGenerator = {
      provider: "anthropic",
      model: "a-model",
      disclosure: "a scripted stand-in",
      async generate(request) {
        calls += 1;
        if (calls === 2) controller.abort(new Error("stop"));
        return request.schema.parse({ verdict: "supported", missingPremise: null });
      },
    };
    await expect(
      runCalibration({
        set,
        prepared,
        prompt: getPrompt("support.p1"),
        generator,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
    // A pair that had not started is not started: at most the calls already in flight finish.
    expect(calls).toBeLessThan(prepared.length);
  });

  it("stops on a provider error that every call would meet", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const { ModelRequestError } = await import("@clausewise/llm");
    const generator: ObjectGenerator = {
      provider: "anthropic",
      model: "a-model",
      disclosure: "a scripted stand-in",
      async generate() {
        throw new ModelRequestError("bad key", 401, true);
      },
    };
    await expect(
      runCalibration({
        set,
        prepared,
        prompt: getPrompt("support.p1"),
        generator,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ name: "EvaluationProviderFailure" });
  });

  it("adds one call per pair to the plan, once for the run and not once per repeat", async () => {
    const { data, set, playbook, workflow } = await setup();
    const prepared = await prepareCalibration({ set, dataset: data, playbook, workflow });
    const entry = data.keys.cases.find((c) => c.case === "PAROL-D01")!;
    const runnables = runnableCases({ cases: [entry], twins: [] });
    const base = { dataset: data, runnables, playbook, workflow, assumedOutputTokens: 1000 };
    const without = await buildParolPlan({ ...base, repeats: 3 });
    const withSet = await buildParolPlan({ ...base, repeats: 3, calibration: prepared });
    expect(withSet.calibration).toMatchObject({ calls: 8 });
    expect(withSet.calls - without.calls).toBe(8);
    expect(withSet.callsWithRepairs - without.callsWithRepairs).toBe(8);
    expect(withSet.inputTokens).toBeGreaterThan(without.inputTokens);
    expect(withSet.outputTokens - without.outputTokens).toBe(8 * 1000);
    // Not multiplied by the repeats.
    const one = await buildParolPlan({ ...base, repeats: 1, calibration: prepared });
    expect(one.calibration).toEqual(withSet.calibration);
  });

  it("refuses to plan the pairs for a workflow with the support check off", async () => {
    const { data, set, playbook } = await setup();
    const prepared = await prepareCalibration({
      set,
      dataset: data,
      playbook,
      workflow: workflowFor("v3"),
    });
    const entry = data.keys.cases.find((c) => c.case === "PAROL-D01")!;
    await expect(
      buildParolPlan({
        dataset: data,
        runnables: runnableCases({ cases: [entry], twins: [] }),
        playbook,
        workflow: workflowFor("v1"),
        repeats: 1,
        assumedOutputTokens: 1000,
        calibration: prepared,
      }),
    ).rejects.toThrow(/pins a support prompt/);
  });
});

describe("--calibration on the command line", () => {
  /** Answers cases as the key does, and the calibration pairs by the label of the pair. */
  const factoryFor = () => {
    const stand = oracleFactory({});
    let calibrationCalls = 0;
    const factory: Parameters<typeof run>[1]["generatorFactory"] = (request) => {
      const inner = stand.factory(request);
      return {
        ...inner,
        async generate(call) {
          // A calibration request is the only support request that cites one of the test quotes
          // together with its discrepancy; the compliant pairs have none, so match on the quote.
          const pair =
            call.schemaName === "check_support"
              ? pairs.find(
                  (p) =>
                    call.prompt.includes(p.evidence.quote) &&
                    call.prompt.includes(p.claim.discrepancy),
                )
              : undefined;
          if (pair !== undefined) {
            calibrationCalls += 1;
            return call.schema.parse({
              verdict: pair.label === "unsupported" ? "not_supported" : "supported",
              missingPremise: null,
            });
          }
          return inner.generate(call);
        },
      };
    };
    return { factory, calls: () => calibrationCalls };
  };

  it("needs a workflow that pins a support prompt", async () => {
    const r = await withSet();
    const out = await run(["--yes", "--calibration", "--case", "PAROL-D01"], {
      resultsDir: join(dir, `res-${++n}`),
      root: r,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/pins a support prompt/);
    expect(out.stderr).toMatch(/--workflow v3/);
  });

  it("will not run with a scripted stand-in", async () => {
    for (const flag of ["--selftest", "--simulate"]) {
      const out = await run([flag, "--calibration"], { resultsDir: join(dir, `res-${++n}`) });
      expect(out.code).toBe(1);
      expect(out.stderr).toMatch(/needs a live run or a replay/);
    }
  });

  it("says the dataset has none when splits.json records none", async () => {
    const copy = join(dir, `copy-${++n}`);
    await mkdir(copy, { recursive: true });
    const r = await copyRoot(copy);
    await editJson<{ calibration?: unknown }>(join(r, "fixtures/parol/splits.json"), (splits) => {
      delete splits.calibration;
    });
    const out = await run(["--yes", "--calibration", "--workflow", "v3", "--case", "PAROL-D01"], {
      resultsDir: join(dir, `res-${++n}`),
      root: r,
    });
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/no calibration set/);
  });

  it("stops with an integrity failure for a set that was edited, before anything is sent", async () => {
    const r = await withSet();
    await editJson<CalibrationFile>(join(r, CALIBRATION_FILE), (file) => {
      file.pairs[0]!.note = "edited";
    });
    const stand = factoryFor();
    const out = await run(["--yes", "--calibration", "--workflow", "v3", "--case", "PAROL-D01"], {
      resultsDir: join(dir, `res-${++n}`),
      root: r,
      generatorFactory: stand.factory,
    });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain("INTEGRITY FAILURE: the calibration set");
    expect(stand.calls()).toBe(0);
  });

  it("runs the pairs once after the cases and records them in the results, and a replay gives the same", async () => {
    const r = await withSet();
    const resultsDir = join(dir, `res-${++n}`);
    const stand = factoryFor();
    const out = await run(
      ["--yes", "--calibration", "--workflow", "v3", "--case", "PAROL-D01", "--runs", "2"],
      { resultsDir, root: r, generatorFactory: stand.factory },
    );
    expect(out.code, out.stderr).toBe(0);
    expect(stand.calls()).toBe(8);
    expect(out.stderr).toMatch(/calibration set: 8 pairs/);
    const names = await readdir(resultsDir);
    const resultsName = names.find((name) => name.endsWith(".json"))!;
    const recordingName = names.find((name) => name.endsWith(RECORDING_SUFFIX))!;
    const file = await readResults(join(resultsDir, resultsName));
    expect(file.suites.calibration).toMatchObject({
      supportedPairs: 4,
      unsupportedPairs: 4,
      failedPairs: 0,
      modelCalls: 8,
      prompt: { id: "support.p1" },
    });
    expect(file.suites.calibration!.result.catchRate).toMatchObject({
      numerator: 4,
      denominator: 4,
    });
    expect(file.suites.exposure).toBeNull();
    // The set has 4 and 4 pairs, not the 20 and 20 that G11 is written for: not evaluated.
    const gate = file.sections[0]!.gates as { results: { id: string; outcome: string }[] };
    expect(gate.results.find((g) => g.id === "G11")!.outcome).toBe("not_evaluated");
    expect(out.stdout).toContain("Support checker calibration (gate G11)");
    expect(out.stdout).toContain("4 of 4");

    // A replay re-scores the calibration calls too, from the recording, with no model.
    const replayDir = join(dir, `res-${++n}`);
    const again = await run(
      [
        "--replay",
        join(resultsDir, recordingName),
        "--calibration",
        "--workflow",
        "v3",
        "--case",
        "PAROL-D01",
        "--runs",
        "2",
      ],
      { resultsDir: replayDir, root: r, env: {} },
    );
    expect(again.code, again.stderr).toBe(0);
    const [replayName] = await readdir(replayDir);
    const replayed = await readResults(join(replayDir, replayName!));
    expect(replayed.suites.calibration!.result).toEqual(file.suites.calibration!.result);
  });
});

describe("--calibration that stops part way", () => {
  it("says the set was started and stopped, and does not say it was not run", async () => {
    const r = await withSet();
    const resultsDir = join(dir, `res-${++n}`);
    const stand = oracleFactory({});
    let pairCalls = 0;
    const factory: Parameters<typeof run>[1]["generatorFactory"] = (request) => {
      const inner = stand.factory(request);
      return {
        ...inner,
        async generate(call) {
          const pair =
            call.schemaName === "check_support"
              ? pairs.find(
                  (p) =>
                    call.prompt.includes(p.evidence.quote) &&
                    call.prompt.includes(p.claim.discrepancy),
                )
              : undefined;
          if (pair !== undefined) {
            pairCalls += 1;
            // The key is refused after two pairs: every further call would meet the same error.
            if (pairCalls > 2) throw new ModelRequestError("bad key", 401, true);
            return call.schema.parse({ verdict: "not_supported", missingPremise: null });
          }
          return inner.generate(call);
        },
      };
    };
    const out = await run(["--yes", "--calibration", "--workflow", "v3", "--case", "PAROL-D01"], {
      resultsDir,
      root: r,
      generatorFactory: factory,
    });
    expect(out.code).toBe(1);
    const names = await readdir(resultsDir);
    const file = await readResults(
      join(
        resultsDir,
        names.find((name) => name.endsWith(".json"))!,
      ),
    );
    expect(file.complete).toBe(false);
    expect(file.suites.calibration).toBeNull();
    expect(file.notes.join(" ")).toMatch(
      /calibration set was started and stopped before it finished \(\d+ of 8 calls were started\)/,
    );
    // The report does not claim the set was simply not run.
    expect(out.stdout).toContain("or the run stopped before the calibration set finished");
    expect(out.stdout).not.toContain("calibration set was not run");
  });
});

// The key oracle is imported so that a change to its exports is a compile error here.
void createKeyOracle;
