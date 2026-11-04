import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workflowFor } from "../../apps/parol/src/prompts/workflows.js";
import { playbookFactProblems } from "../src/parol/dataset.js";
import { evaluateGates } from "../src/parol/gates.js";
import {
  CALL_OUTCOME_MEANINGS,
  HELDOUT_LEDGER,
  endpointHost,
  findContamination,
  parseResults,
  providerOwnHost,
  recordHeldoutRun,
  runHealth,
  type ResultsFile,
} from "../src/parol/results.js";
import { renderReport } from "../src/parol/report.js";
import { decideSpend, costBounds, type ParolPlan } from "../src/parol/plan.js";
import { modelOfResponse, reportingFetch } from "../src/parol/reported-model.js";
import type { RepeatMetrics, SlotScore } from "../src/parol/score.js";
import { repeatMetrics } from "../src/parol/testing.js";
import { makeTempDir, removeDir, run } from "../src/parol/testing-run.js";
import { readdir } from "node:fs/promises";

/**
 * Unit tests written from the findings of the independent review of the runner, beside the
 * command-level ones in parol-cli-review.test.ts. Anything built by hand here is FABRICATED FOR A
 * TEST: no model produced a number in this file.
 */

let dir = "";
let n = 0;
let template: ResultsFile;
beforeAll(async () => {
  dir = await makeTempDir();
  const out = await run(["--selftest", "--case", "PAROL-D01"], { resultsDir: `${dir}/template` });
  expect(out.code, out.stderr).toBe(0);
  const [name] = await readdir(`${dir}/template`);
  template = parseResults(await readFile(`${dir}/template/${name}`, "utf8"));
});
afterAll(async () => {
  await removeDir(dir);
});

const fresh = (): string => `${dir}/f${++n}`;

// ---------------------------------------------------------------------------------------------
// The facts of the playbook rules
// ---------------------------------------------------------------------------------------------

describe("playbookFactProblems", () => {
  const playbook = [
    { key: "a-1", category: "parties", severity: "high", required: true },
    { key: "b-1", category: "duration", severity: "low", required: false },
  ];
  const facts = {
    "a-1": { category: "parties", severity: "high", required: true },
    "b-1": { category: "duration", severity: "low", required: false },
  } as const;

  it("finds nothing when the key holds the playbook's facts", () => {
    expect(playbookFactProblems(facts as never, playbook)).toEqual([]);
  });

  it("names each fact of each rule that differs, and no value", () => {
    const edited = {
      "a-1": { category: "duration", severity: "low", required: false },
      "b-1": facts["b-1"],
    };
    expect(playbookFactProblems(edited as never, playbook)).toEqual([
      "rule a-1: the category in the answer key differs from the playbook",
      "rule a-1: the severity in the answer key differs from the playbook",
      "rule a-1: the required flag in the answer key differs from the playbook",
    ]);
  });

  it("finds a rule of the playbook the key lacks, and a rule of the key the playbook lacks", () => {
    const { "b-1": _gone, ...without } = facts;
    expect(playbookFactProblems(without as never, playbook)).toEqual([
      "rule b-1: the answer key holds no facts for a rule of the playbook",
    ]);
    const extra = { ...facts, "c-1": facts["a-1"] };
    expect(playbookFactProblems(extra as never, playbook)).toEqual([
      "rule c-1: the answer key holds facts for a rule the playbook does not have",
    ]);
  });

  it("does not repeat a rule name that does not read as one", () => {
    const extra = { ...facts, "x\u001b[31m secret": facts["a-1"] };
    const [problem] = playbookFactProblems(extra as never, playbook);
    expect(problem).toBe(
      "rule (a name that is not shown): the answer key holds facts for a rule the playbook does not have",
    );
  });

  it("treats an entry that is not an object as missing", () => {
    expect(playbookFactProblems({ "a-1": null, "b-1": facts["b-1"] } as never, playbook)).toEqual([
      "rule a-1: the answer key holds no facts for a rule of the playbook",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------------------------

describe("the endpoint of a request", () => {
  it("is the provider's own host when no base URL is set", () => {
    expect(endpointHost("anthropic", undefined)).toBe("api.anthropic.com");
    expect(endpointHost("openai", undefined)).toBe("api.openai.com");
    expect(endpointHost("openai-compatible", undefined)).toBeNull();
    expect(providerOwnHost("anthropic")).toBe("api.anthropic.com");
    expect(providerOwnHost("openai-compatible")).toBeNull();
    expect(providerOwnHost("constructor")).toBeNull();
  });

  it("is the host and port of a base URL, and never its path, query or credentials", () => {
    expect(endpointHost("anthropic", "http://127.0.0.1:9")).toBe("127.0.0.1:9");
    expect(endpointHost("openai-compatible", "http://localhost:11434/v1")).toBe("localhost:11434");
    expect(endpointHost("anthropic", "https://gw.example.com/token-in-path/v1")).toBe(
      "gw.example.com",
    );
    // The configuration refuses credentials, but the pin must not depend on that.
    expect(endpointHost("anthropic", "https://user:pw@gw.example.com/x?key=1")).toBe(
      "gw.example.com",
    );
    expect(endpointHost("anthropic", "http://[::1]:8080/v1")).toBe("[::1]:8080");
  });

  it("is null for a base URL that cannot be read", () => {
    expect(endpointHost("anthropic", "not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The model named in a response
// ---------------------------------------------------------------------------------------------

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function sse(chunks: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" }, ...init },
  );
}

const START = `event: message_start\ndata: ${JSON.stringify({
  type: "message_start",
  message: { id: "m", model: "claude-sonnet-5-5-20261001", usage: { input_tokens: 1 } },
})}\n\n`;

describe("modelOfResponse", () => {
  it("reads the model field of a message", async () => {
    expect(await modelOfResponse(json({ model: "claude-sonnet-5-5-20261001" }))).toBe(
      "claude-sonnet-5-5-20261001",
    );
  });

  it("reads the model of the message_start event of a stream, whatever the chunking", async () => {
    expect(await modelOfResponse(sse([START, "event: message_stop\ndata: {}\n\n"]))).toBe(
      "claude-sonnet-5-5-20261001",
    );
    // Cut inside the line, so that no chunk holds a whole event.
    const cut = [START.slice(0, 20), START.slice(20, 75), START.slice(75)];
    expect(await modelOfResponse(sse(cut))).toBe("claude-sonnet-5-5-20261001");
  });

  it("names nothing for a stream with no message_start, an empty body, or other types", async () => {
    expect(await modelOfResponse(sse(["event: ping\ndata: {}\n\n"]))).toBeUndefined();
    expect(await modelOfResponse(sse([]))).toBeUndefined();
    expect(
      await modelOfResponse(new Response("model", { headers: { "content-type": "text/plain" } })),
    ).toBeUndefined();
    expect(await modelOfResponse(json("a string"))).toBeUndefined();
    expect(await modelOfResponse(json({}))).toBeUndefined();
  });

  it("keeps only a plain model identifier, because a response is provider data", async () => {
    for (const bad of [
      "has space",
      "line\nbreak",
      "x".repeat(200),
      "",
      "\u001b[31mred",
      42,
      ["a"],
      { a: 1 },
    ]) {
      expect(await modelOfResponse(json({ model: bad })), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("does not fail on a body that is not JSON", async () => {
    const broken = new Response("{", { headers: { "content-type": "application/json" } });
    expect(await modelOfResponse(broken)).toBeUndefined();
  });
});

describe("reportingFetch", () => {
  it("passes each successful response on untouched, and reports its model once it is read", async () => {
    const seen: string[] = [];
    const reply = { model: "claude-sonnet-5-5-20261001", content: [{ type: "text", text: "hi" }] };
    const wrapped = reportingFetch(
      async () => json(reply),
      (model) => seen.push(model),
    );
    const response = await wrapped.fetch("http://127.0.0.1:9/v1/messages", { method: "POST" });
    await wrapped.settle();
    expect(seen).toEqual(["claude-sonnet-5-5-20261001"]);
    // The caller's copy is whole and unread.
    expect(await response.json()).toEqual(reply);
  });

  it("leaves a stream whole for the caller, whatever it read of its own copy", async () => {
    const seen: string[] = [];
    const tail = "event: content_block_delta\ndata: {}\n\n".repeat(50);
    const wrapped = reportingFetch(
      async () => sse([START, tail]),
      (model) => seen.push(model),
    );
    const response = await wrapped.fetch("http://127.0.0.1:9/v1/messages");
    await wrapped.settle();
    expect(seen).toEqual(["claude-sonnet-5-5-20261001"]);
    expect(await response.text()).toBe(START + tail);
  });

  it("reports nothing for an error status, and does not touch its body", async () => {
    const seen: string[] = [];
    const wrapped = reportingFetch(
      async () => json({ model: "claude-sonnet-5-5-20261001" }, { status: 500 }),
      (model) => seen.push(model),
    );
    const response = await wrapped.fetch("http://127.0.0.1:9/v1/messages");
    await wrapped.settle();
    expect(seen).toEqual([]);
    expect(response.status).toBe(500);
    expect((await response.json()) as unknown).toEqual({ model: "claude-sonnet-5-5-20261001" });
  });

  it("lets the failure of the inner fetch through as it was", async () => {
    const wrapped = reportingFetch(
      async () => {
        throw new Error("socket hang up");
      },
      () => undefined,
    );
    await expect(wrapped.fetch("http://127.0.0.1:9/v1/messages")).rejects.toThrow("socket hang up");
  });
});

// ---------------------------------------------------------------------------------------------
// Whether the run measured the model
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: the selftest file with its first run edited to say what a bad run might say. */
function withRun(change: (run: ResultsFile["runs"][number]) => void): ResultsFile {
  const file = JSON.parse(JSON.stringify(template)) as ResultsFile;
  change(file.runs[0]!);
  return file;
}

describe("runHealth", () => {
  it("is clean for a run whose calls were all answered", () => {
    const health = runHealth(template);
    expect(health).toMatchObject({
      runs: 1,
      failedRuns: 0,
      calls: { ok: 9 },
      transportCalls: 0,
      extractDegradedRuns: 0,
      rulesOverBudget: 0,
      clean: true,
      problems: [],
    });
  });

  it("is not clean for calls lost on the wire, an extraction that fell back, or a rule never sent", () => {
    expect(runHealth(withRun((r) => (r.callOutcomes = { ok: 7, transport: 2 }))).clean).toBe(false);
    expect(runHealth(withRun((r) => (r.extractDegraded = true))).clean).toBe(false);
    const over = runHealth(withRun((r) => (r.rulesOverBudget = 3)));
    expect(over.clean).toBe(false);
    expect(over.problems).toEqual([
      expect.stringContaining("3 rules were not sent because the context was over the budget"),
    ]);
  });

  it("counts a single call in the singular, and sorts the outcomes", () => {
    const health = runHealth(
      withRun((r) => (r.callOutcomes = { transport: 1, ok: 8, cut_off: 1 })),
    );
    expect(health.problems[0]).toMatch(/^1 model call failed on the wire/);
    expect(Object.keys(health.calls)).toEqual(["cut_off", "ok", "transport"]);
  });

  it("does not call an answer that was bad a failure of the infrastructure", () => {
    // The model's own refusals, cut-off and malformed answers are scores of the model.
    const health = runHealth(
      withRun((r) => (r.callOutcomes = { ok: 5, schema_error: 1, refusal: 1, cut_off: 1 })),
    );
    expect(health.clean).toBe(true);
  });

  it("looks at one split when asked", () => {
    const file = withRun((r) => (r.callOutcomes = { transport: 2 }));
    expect(runHealth(file, "dev").clean).toBe(false);
    expect(runHealth(file, "heldout")).toMatchObject({ runs: 0, clean: true });
  });

  it("is described in the report by outcome, with a meaning for every outcome the stages record", () => {
    const report = renderReport(withRun((r) => (r.callOutcomes = { ok: 7, transport: 2 })));
    expect(report).toContain("## Calls and degraded stages");
    expect(report).toContain("| transport | 2 | ");
    expect(report).toContain("NOT A CLEAN MEASUREMENT");
    for (const outcome of [
      "ok",
      "schema_error",
      "semantic_error",
      "refusal",
      "cut_off",
      "transport",
      "fatal",
    ]) {
      expect(CALL_OUTCOME_MEANINGS[outcome], outcome).toBeTruthy();
    }
  });

  it("is told for a clean selftest in one line, with the count of its calls", () => {
    const report = renderReport(template);
    expect(report).toContain("| ok | 9 |");
    expect(report).toContain(
      "No call failed on the wire, no extraction fell back to the whole document and no rule was left unsent.",
    );
    expect(report).not.toContain("NOT A CLEAN MEASUREMENT");
  });
});

// ---------------------------------------------------------------------------------------------
// G4 and G5 with nothing at risk
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: a slot score with only the fields the gates read set to anything but a default. */
function slot(over: Partial<SlotScore> = {}): SlotScore {
  return {
    caseKey: "C",
    ruleKey: "r",
    repeat: 0,
    severity: "low",
    weight: 1,
    expected: "compliant",
    observed: "compliant",
    statusCorrect: true,
    expectedFlag: false,
    givenFlag: false,
    strictTruePositive: false,
    lenientTruePositive: false,
    silentMiss: false,
    keySupport: true,
    verifiedButUnsupported: false,
    escalationMode: "not_expected",
    escalationRequired: false,
    escalationMet: false,
    verifiedQuotes: 1,
    unnecessaryEscalation: false,
    failures: [],
    failure: null,
    factor: 0,
    ...over,
  };
}

function withSlots(
  slots: SlotScore[],
  over: Parameters<typeof repeatMetrics>[1] = {},
): RepeatMetrics {
  const metrics = repeatMetrics(0, over);
  metrics.slotScores = slots;
  return metrics;
}

const gate = (repeats: RepeatMetrics[], id: "G4" | "G5") =>
  evaluateGates({ run: { repeats, stability: null } }).results.find((r) => r.id === id)!;

const HIGH_FLAG = slot({
  severity: "high",
  expected: "deviation",
  observed: "deviation",
  expectedFlag: true,
  givenFlag: true,
  keySupport: true,
});
const UNDETERMINED = slot({ observed: "undetermined", keySupport: null, statusCorrect: false });

describe("G4, high-severity silent misses", () => {
  it("is not evaluated when no expected flag of high severity was there to miss", () => {
    const result = gate([withSlots([slot(), slot({ severity: "medium" })])], "G4");
    expect(result.outcome).toBe("not_evaluated");
    expect(result.detail).toBe("repeat 0: high-severity silent misses 0 of 0 (0)");
  });

  it("is not evaluated for a flag that is not of high severity, or a high rule with no flag expected", () => {
    const lowFlag = slot({ expectedFlag: true, severity: "low", expected: "deviation" });
    const highClean = slot({ severity: "high" });
    expect(gate([withSlots([lowFlag, highClean])], "G4").outcome).toBe("not_evaluated");
  });

  it("passes at zero out of the flags there were, and says how many", () => {
    const result = gate([withSlots([HIGH_FLAG, slot()])], "G4");
    expect(result.outcome).toBe("pass");
    expect(result.detail).toBe("repeat 0: high-severity silent misses 0 of 1 (0)");
  });

  it("fails on a miss whatever the denominator says", () => {
    const miss = withSlots([HIGH_FLAG], { highSilentMisses: 1 });
    expect(gate([miss], "G4").outcome).toBe("fail");
    // An inconsistent record, a miss out of nothing, still fails.
    const inconsistent = withSlots([slot()], { highSilentMisses: 1 });
    expect(gate([inconsistent], "G4").outcome).toBe("fail");
  });

  it("is not evaluated for the run when one repeat has nothing at risk and the others pass", () => {
    const result = gate([withSlots([HIGH_FLAG]), withSlots([slot()])], "G4");
    expect(result.outcome).toBe("not_evaluated");
  });

  it("is judged by its count alone for a record made from counts, which has no slots", () => {
    expect(gate([repeatMetrics(0)], "G4").outcome).toBe("pass");
    expect(gate([repeatMetrics(0, { highSilentMisses: 1 })], "G4").outcome).toBe("fail");
  });
});

describe("G5, verified but unsupported findings", () => {
  it("is not evaluated when no finding was determined", () => {
    const result = gate([withSlots([UNDETERMINED, UNDETERMINED])], "G5");
    expect(result.outcome).toBe("not_evaluated");
    expect(result.detail).toBe("repeat 0: verified but unsupported findings 0 of 0 (0)");
  });

  it("passes at zero out of the determined findings there were", () => {
    const result = gate([withSlots([slot(), HIGH_FLAG, UNDETERMINED])], "G5");
    expect(result.outcome).toBe("pass");
    expect(result.detail).toBe("repeat 0: verified but unsupported findings 0 of 2 (0)");
  });

  it("fails on one", () => {
    expect(gate([withSlots([slot()], { verifiedButUnsupported: 1 })], "G5").outcome).toBe("fail");
  });
});

// ---------------------------------------------------------------------------------------------
// The spend decision
// ---------------------------------------------------------------------------------------------

/** FABRICATED FOR A TEST: the plan of parol-run-plan.test.ts, 36 calls or 68 with repairs. */
const HAND_PLAN: ParolPlan = {
  repeats: 2,
  assumedOutputTokens: 1500,
  cases: [],
  runsPerRepeat: 2,
  slotsPerRepeat: 16,
  calls: 36,
  callsWithRepairs: 68,
  inputTokens: 200_000,
  inputTokensWithRepairs: 380_000,
  outputTokens: 36 * 1500,
  outputTokensWithRepairs: 68 * 1500,
};
const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };

describe("decideSpend", () => {
  const bounds = costBounds(HAND_PLAN, PRICE, { maxOutputTokens: 16_000, maxRetries: 2 });
  const args = { yes: true, plan: HAND_PLAN, bounds, fallback: false };

  it("holds a run to the bound that includes every repair call, worked out by hand", () => {
    // 36 calls: 200,000 input tokens at $2 and 54,000 output at $10 is $0.94. With the repair of
    // every rule: 380,000 input is $0.76 and 102,000 output is $1.02, which is $1.78.
    expect(bounds.upperBoundUsd).toBeCloseTo(0.94, 10);
    expect(bounds.withRepairsUsd).toBeCloseTo(1.78, 10);
    // A limit between the two used to start the run. It no longer does.
    const between = decideSpend({ ...args, maxCostUsd: 1.5 });
    expect(between).toMatchObject({ go: false });
    expect(between.go === false && between.message).toContain(
      "Refusing to run: the cost upper bound of $1.7800 is above --max-cost $1.5000.",
    );
    expect(decideSpend({ ...args, maxCostUsd: 1.77 })).toMatchObject({ go: false });
    // At exactly the bound it goes, as the harness's guard allows.
    expect(decideSpend({ ...args, maxCostUsd: bounds.withRepairsUsd })).toEqual({ go: true });
    expect(decideSpend({ ...args, maxCostUsd: 2 })).toEqual({ go: true });
  });

  it("words a refusal for what it is: at most these calls and at most this cost, and --case", () => {
    const refused = decideSpend({ ...args, yes: false, maxCostUsd: 1 });
    expect(refused.go).toBe(false);
    const message = refused.go ? "" : refused.message;
    expect(message).toContain(
      "Nothing was sent. This evaluation would make up to 68 model calls and cost at most $1.7800.",
    );
    expect(message).toContain("or do less with --case or --runs");
    expect(message).not.toContain("--fixture");
  });

  it("still refuses a run with CLAUSEWISE_FALLBACK on, whatever the limit", () => {
    const refused = decideSpend({ ...args, maxCostUsd: 100, fallback: true });
    expect(refused.go).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The ledger of held-out runs
// ---------------------------------------------------------------------------------------------

describe("the ledger of held-out runs", () => {
  const v1 = workflowFor("v1");
  const entry = (folder: string, over: Partial<Parameters<typeof recordHeldoutRun>[0]> = {}) =>
    recordHeldoutRun({
      resultsDir: folder,
      startedAt: new Date("2026-11-04T10:00:00Z"),
      workflowLabel: v1.manifest.label,
      workflowSha256: v1.sha256,
      model: "claude-sonnet-5-5",
      outPath: "/somewhere/else/first.json",
      ...over,
    });
  const find = (folder: string) =>
    findContamination({
      resultsDir: folder,
      workflowLabel: v1.manifest.label,
      workflowSha256: v1.sha256,
    });

  it("creates the folder, records the base name only, and is read back as an earlier run", async () => {
    const folder = fresh();
    await entry(folder);
    const text = await readFile(`${folder}/${HELDOUT_LEDGER}`, "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).not.toContain("somewhere");
    const found = await find(folder);
    expect(found).toMatchObject({
      split: "heldout",
      priorRuns: [
        {
          file: "first.json",
          startedAt: "2026-11-04T10:00:00.000Z",
          model: "claude-sonnet-5-5",
          complete: false,
          elsewhere: true,
        },
      ],
      scriptedPriorRuns: 0,
    });
    expect(found!.note).toContain("(first.json, results not in this folder)");
  });

  it("counts a run once however many of the ledger, its file and its checkpoint tell of it", async () => {
    const folder = fresh();
    await entry(folder, { outPath: `${folder}/x.json` });
    // FABRICATED FOR A TEST: a live held-out file with the pins of that run, written as the file and as the checkpoint.
    const live = JSON.parse(JSON.stringify(template)) as ResultsFile;
    live.mode = "live";
    live.selftest = false;
    live.pins.mode = "live";
    live.banner = null;
    live.startedAt = "2026-11-04T10:00:00.000Z";
    live.pins.workflow = {
      ...live.pins.workflow,
      label: v1.manifest.label,
      sha256: v1.sha256,
    };
    live.sections[0]!.split = "heldout";
    for (const r of live.runs) r.split = "heldout";
    await writeFile(`${folder}/x.json`, JSON.stringify(live));
    await writeFile(`${folder}/x.json.partial`, JSON.stringify(live));
    const found = await find(folder);
    expect(found!.priorRuns).toHaveLength(1);
    // The file is what knows how the run ended, so it wins over the ledger.
    expect(found!.priorRuns[0]).toMatchObject({ file: "x.json", complete: true });
    expect(found!.priorRuns[0]!.elsewhere).toBeUndefined();
  });

  it("does not count an entry of another workflow, or a line that is not an entry", async () => {
    const folder = fresh();
    await entry(folder, { workflowSha256: "b".repeat(64) });
    await entry(folder, { workflowLabel: "v2" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(`${folder}/${HELDOUT_LEDGER}`, "not json\n{}\n\n[1]\n");
    expect(await find(folder)).toBeNull();
  });

  it("writes a file name that does not read as one as a fixed phrase", async () => {
    const folder = fresh();
    await entry(folder, { outPath: "/x/\u001b[31mred token=sk-secret.json" });
    const found = await find(folder);
    expect(found!.priorRuns[0]!.file).toBe("a file with an unusual name");
    expect(JSON.stringify(found)).not.toContain("sk-secret");
  });

  it("appends: a second run is a second line", async () => {
    const folder = fresh();
    await entry(folder);
    await entry(folder, { startedAt: new Date("2026-11-05T10:00:00Z"), outPath: "/a/second.json" });
    const found = await find(folder);
    expect(found!.priorRuns.map((p) => p.file)).toEqual(["first.json", "second.json"]);
    expect(found!.note).toContain("run 2 times before");
  });

  it("is not read as a results file when the folder is listed", async () => {
    const folder = fresh();
    await mkdir(folder, { recursive: true });
    await writeFile(`${folder}/${HELDOUT_LEDGER}`, "");
    expect(await find(folder)).toBeNull();
  });
});
