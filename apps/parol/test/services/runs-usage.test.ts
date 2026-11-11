import { ModelRequestError } from "@clausewise/llm";
import type { AnthropicUsage, GenerateObjectRequest } from "@clausewise/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { buildMemoInput } from "../../src/services/memo-input.js";
import { requestSha256 } from "../../src/stages/analyze-call.js";
import { currentRun } from "../../src/usage/scope.js";
import { costOf, createCallPricer, parsePriceTable } from "../../src/usage/prices.js";
import { cleanup, gate, makeWorld, newMatter, reviewed, uploadCase } from "./support.js";
import { meteredWorld, type ReportingOptions } from "../usage/support.js";

afterAll(cleanup);

/**
 * A review records what the provider reported for each of its model calls, the cost the operator's
 * price table gives it, and the model that answered. The scripted model reports the way the
 * Anthropic adapter does, from inside `generate`, with delays that scramble the order in which the
 * calls finish, so the tests show that usage reaches the right call and the right run. Nothing
 * here calls a provider.
 */

const PRICE = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const TABLE = parsePriceTable({ "model-a": PRICE });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const requestKey = (request: GenerateObjectRequest<unknown>): string =>
  requestSha256(request.system, request.prompt);
/** A number that depends on the run and the request, so a mix-up of either shows. */
const fingerprint = (runId: string, key: string): number =>
  Number.parseInt(sha256Hex(runId + key).slice(0, 5), 16);

/** Usage that depends on the call (its request) and on the run it is made in. */
function usageOf(request: GenerateObjectRequest<unknown>): AnthropicUsage {
  const n = fingerprint(currentRun()?.runId ?? "none", requestKey(request));
  return { inputTokens: n, outputTokens: n % 97, cacheReadTokens: n % 5, cacheWriteTokens: 1 };
}

const REPORTS: ReportingOptions = {
  usageFor: usageOf,
  modelFor: () => "model-a-20260101",
  delayMs: (request) => Number.parseInt(requestKey(request).slice(0, 2), 16) % 20,
};

describe("a review by a provider that reports usage", () => {
  it("records the tokens of each call, its cost and the hash of the price table", async () => {
    const w = meteredWorld({ reporter: REPORTS, pricing: createCallPricer(TABLE) });
    const { matterId, am, runId } = await reviewed(w);
    expect(w.services.runs.get(am, runId).status).toBe("succeeded");

    const rows = w.repo.listModelCalls(matterId, runId);
    expect(rows.length).toBe(w.model.calls.length);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      expect(row.inputTokens, row.stage).toBe(fingerprint(runId, row.requestSha256));
      const tokens = {
        inputTokens: row.inputTokens as number,
        outputTokens: row.outputTokens as number,
        cacheReadTokens: row.cacheReadTokens as number,
        cacheWriteTokens: row.cacheWriteTokens as number,
      };
      expect(row.costUsdEstimate).toBeCloseTo(costOf(tokens, PRICE), 12);
      expect(row.priceTableSha256).toBe(TABLE.sha256);
      expect(row.priceTableSha256).toMatch(/^[0-9a-f]{64}$/);
    }

    const usage = w.services.runs.get(am, runId).usage;
    expect(usage).toMatchObject({
      state: "reported",
      calls: rows.length,
      callsWithUsage: rows.length,
      inputTokens: rows.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
      cost: { state: "priced", callsPriced: rows.length, priceTableSha256: TABLE.sha256 },
    });
    expect(usage?.cost.usd).toBeCloseTo(
      rows.reduce((sum, r) => sum + (r.costUsdEstimate ?? 0), 0),
      10,
    );
    expect(usage?.lines[0]).toContain(
      `from ${rows.length} of ${rows.length} recorded model calls.`,
    );
    expect(usage?.lines[1]).toContain(TABLE.sha256.slice(0, 12));
  });

  it("records the model the provider named, on the run and in what the page reads", async () => {
    const w = meteredWorld({ reporter: REPORTS });
    const { matterId, am, runId } = await reviewed(w);
    expect(w.repo.getRun(matterId, runId)?.modelReported).toBe("model-a-20260101");
    expect(w.services.runs.get(am, runId).model).toEqual({
      provider: "anthropic",
      requested: "model-a",
      reported: "model-a-20260101",
    });
  });

  it("keeps both models, sorted, when the provider named two", async () => {
    const w = meteredWorld({
      reporter: {
        usageFor: usageOf,
        modelFor: (request) =>
          request.schemaName === "locate_passages" ? "model-b-1" : "model-a-2",
      },
    });
    const { matterId, runId } = await reviewed(w);
    expect(w.repo.getRun(matterId, runId)?.modelReported).toBe("model-a-2, model-b-1");
  });

  it("keeps the usage of calls in flight together, and of two reviews at once, with its own call and its own run", async () => {
    const w = meteredWorld({
      reporter: {
        ...REPORTS,
        modelFor: () => `model-of-${currentRun()?.runId ?? "none"}`,
        // The later a request sorts, the sooner it answers: three rules in flight finish out of order.
        delayMs: (request) => 24 - (Number.parseInt(requestKey(request).slice(0, 2), 16) % 24),
      },
      pricing: createCallPricer(TABLE),
    });
    const first = newMatter(w, "first");
    await uploadCase(w, first.matterId);
    const second = newMatter(w, "second");
    await uploadCase(w, second.matterId);
    const a = w.services.runs.start(first.am, { workflowLabel: "v2" });
    const b = w.services.runs.start(second.am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(first.am, a.id).status).toBe("succeeded");
    expect(w.services.runs.get(second.am, b.id).status).toBe("succeeded");

    const rowsA = w.repo.listModelCalls(first.matterId, a.id);
    const rowsB = w.repo.listModelCalls(second.matterId, b.id);
    expect(rowsA.length).toBe(rowsB.length);
    for (const [runId, rows] of [
      [a.id, rowsA],
      [b.id, rowsB],
    ] as const)
      for (const row of rows) {
        expect(row.inputTokens, `${row.stage} ${row.ruleKey}`).toBe(
          fingerprint(runId, row.requestSha256),
        );
        expect(row.outputTokens).toBe(fingerprint(runId, row.requestSha256) % 97);
      }
    // The two reviews read the same documents, so the same request was made in both. What tells
    // their calls apart is the run, and the figures differ.
    const shared = rowsA.filter((r) => rowsB.some((s) => s.requestSha256 === r.requestSha256));
    expect(shared.length).toBeGreaterThan(5);
    expect(
      shared.filter(
        (r) =>
          r.inputTokens !== rowsB.find((s) => s.requestSha256 === r.requestSha256)?.inputTokens,
      ).length,
    ).toBeGreaterThan(5);
    // And each review names the model of its own responses only.
    expect(w.repo.getRun(first.matterId, a.id)?.modelReported).toBe(`model-of-${a.id}`);
    expect(w.repo.getRun(second.matterId, b.id)?.modelReported).toBe(`model-of-${b.id}`);
  });

  it("adds up what was recorded before a failure and after the resume that finished the review", async () => {
    const state = { fail: true };
    const w = meteredWorld({
      reporter: REPORTS,
      pricing: createCallPricer(TABLE),
      model: {
        before: async (call) => {
          if (state.fail && call.kind === "analyze" && call.ruleKey === "exc-1") {
            await sleep(10);
            throw new ModelRequestError("the provider said no", 401);
          }
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id)).toMatchObject({
      status: "failed",
      errorKind: "provider_auth",
    });
    const before = w.repo.listModelCalls(matterId, run.id);
    expect(before.length).toBeGreaterThan(2);
    // The model is known although the review failed, and so is the usage so far.
    expect(w.repo.getRun(matterId, run.id)?.modelReported).toBe("model-a-20260101");
    expect(w.services.runs.get(am, run.id).usage).toMatchObject({
      state: "reported",
      calls: before.length,
    });

    state.fail = false;
    w.services.runs.resume(am, run.id);
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("succeeded");
    const after = w.repo.listModelCalls(matterId, run.id);
    // What the first attempt recorded is still there, and the resume added its own.
    expect(after.slice(0, before.length).map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.length).toBeGreaterThan(before.length);
    expect(w.services.runs.get(am, run.id).usage).toMatchObject({
      calls: after.length,
      callsWithUsage: after.length,
    });
  });
});

describe("what the memo is given", () => {
  it("is the run's usage and the model that answered, read from the stored calls", async () => {
    const w = meteredWorld({ reporter: REPORTS, pricing: createCallPricer(TABLE) });
    const { matterId, runId } = await reviewed(w);
    const run = w.repo.getRun(matterId, runId)!;
    const { input } = buildMemoInput({
      repo: w.repo,
      matterId,
      run,
      exporterId: w.reviewer.userId,
      exportedAt: "2026-11-05T09:00:00.000Z",
    });
    const rows = w.repo.listModelCalls(matterId, runId);
    expect(input.run.modelReported).toBe("model-a-20260101");
    expect(input.run.usage).toMatchObject({
      state: "reported",
      calls: rows.length,
      callsWithUsage: rows.length,
      inputTokens: rows.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0),
    });
  });

  it("says no model was called for a stand-in", async () => {
    const w = makeWorld();
    const { matterId, runId } = await reviewed(w);
    const { input } = buildMemoInput({
      repo: w.repo,
      matterId,
      run: w.repo.getRun(matterId, runId)!,
      exporterId: w.reviewer.userId,
      exportedAt: "2026-11-05T09:00:00.000Z",
    });
    expect(input.run.usage).toMatchObject({ state: "stand_in", inputTokens: null });
  });
});

describe("the model of a run that did not finish", () => {
  it("is known as soon as one unit has finished, while the review goes on", async () => {
    const hold = gate();
    const w = meteredWorld({
      reporter: REPORTS,
      model: {
        before: async (call) => {
          if (call.kind === "analyze") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await hold.reached(1);
    // The extract unit has finished and every analyze call is held: the run is not over.
    expect(w.services.runs.get(am, run.id).status).toBe("analyzing");
    expect(w.repo.listModelCalls(matterId, run.id).map((r) => r.stage)).toEqual(["extract"]);
    expect(w.repo.getRun(matterId, run.id)?.modelReported).toBe("model-a-20260101");
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("succeeded");
  });

  it("does not let a failure to record it escape as an unhandled rejection, and logs only a class name", async () => {
    const hold = gate();
    const w = meteredWorld({
      reporter: { ...REPORTS, report: "before" },
      model: { before: async () => hold.pass() },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await hold.reached(1);
    const failing = vi.spyOn(w.repo, "recordReportedModels").mockImplementation(() => {
      throw new RangeError("a message with words of its own in it");
    });
    w.services.runs.cancel(am, run.id);
    hold.open();
    await w.services.runs.idle();
    expect(failing).toHaveBeenCalled();
    expect(w.services.runs.get(am, run.id).status).toBe("cancelled");
    const line = w.logs.find((l) => l.includes("could not record the reported model"));
    expect(line).toContain("(RangeError)");
    expect(w.logs.join("\n")).not.toContain("words of its own");
    failing.mockRestore();
  });

  it("is kept when a provider rejects the run's request", async () => {
    const w = meteredWorld({
      reporter: REPORTS,
      model: {
        before: async (call) => {
          if (call.kind === "analyze") throw new ModelRequestError("the provider said no", 403);
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("failed");
    expect(w.repo.getRun(matterId, run.id)?.modelReported).toBe("model-a-20260101");
  });

  it("is kept when the run is cancelled before any unit finished, from the response that named it", async () => {
    const hold = gate();
    const w = meteredWorld({
      // The response has arrived and named its model; the engine is still working on the call.
      reporter: { ...REPORTS, report: "before" },
      model: { before: async () => hold.pass() },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await hold.reached(1);
    w.services.runs.cancel(am, run.id);
    hold.open();
    await w.services.runs.idle();
    expect(w.services.runs.get(am, run.id).status).toBe("cancelled");
    // No unit finished, so no call row was written; the model is known from the response alone.
    expect(w.repo.listModelCalls(matterId, run.id)).toEqual([]);
    expect(w.repo.getRun(matterId, run.id)?.modelReported).toBe("model-a-20260101");
  });
});

describe("a review by a provider that reports nothing", () => {
  it("records nothing and says it was not reported, with no dollar figure", async () => {
    const w = meteredWorld({ pricing: createCallPricer(TABLE) });
    const { matterId, am, runId } = await reviewed(w);
    const rows = w.repo.listModelCalls(matterId, runId);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows)
      expect(row).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsdEstimate: null,
        priceTableSha256: null,
      });
    expect(w.repo.getRun(matterId, runId)?.modelReported).toBeNull();
    const usage = w.services.runs.get(am, runId).usage;
    expect(usage).toMatchObject({ state: "not_reported", calls: rows.length, callsWithUsage: 0 });
    expect(usage?.lines.join(" ")).toContain(
      `did not report usage for the ${rows.length} model calls`,
    );
    expect(usage?.lines.join(" ")).not.toContain("$");
    expect(w.services.runs.get(am, runId).model.reported).toBeNull();
  });

  it("says no call has been recorded for a review that has made none", async () => {
    const hold = gate();
    const w = meteredWorld({ model: { before: async () => hold.pass() } });
    const { am } = newMatter(w);
    const uploaded = await uploadCase(w, am.matterId);
    expect(uploaded.versionIds.length).toBeGreaterThan(0);
    const run = w.services.runs.start(am, {});
    await hold.reached(1);
    expect(w.services.runs.get(am, run.id).usage).toMatchObject({
      state: "not_reported",
      calls: 0,
    });
    expect(w.services.runs.get(am, run.id).usage?.lines).toEqual([
      "No model call has been recorded for this review yet.",
    ]);
    hold.open();
    await w.services.runs.idle();
  });
});

describe("tokens with no price", () => {
  it("are recorded and shown as not priced, never as a number", async () => {
    const elsewhere = createCallPricer(parsePriceTable({ "model-z": PRICE }));
    for (const pricing of [elsewhere, undefined]) {
      const w = meteredWorld({
        reporter: REPORTS,
        ...(pricing === undefined ? {} : { pricing }),
      });
      const { matterId, am, runId } = await reviewed(w);
      const rows = w.repo.listModelCalls(matterId, runId);
      for (const row of rows) {
        expect(row.inputTokens).not.toBeNull();
        expect(row.costUsdEstimate).toBeNull();
        expect(row.priceTableSha256).toBeNull();
      }
      const usage = w.services.runs.get(am, runId).usage;
      expect(usage).toMatchObject({
        state: "reported",
        cost: { state: "not_priced", usd: null, callsPriced: 0 },
      });
      expect(usage?.lines.join(" ")).not.toContain("$");
      expect(usage?.lines[1]).toBe("Cost: not priced. No price is configured for this model.");
    }
  });
});

describe("a review by a stand-in reader", () => {
  it("says no model was called, whatever the rows hold", async () => {
    const w = makeWorld();
    const { matterId, am, runId } = await reviewed(w);
    const rows = w.repo.listModelCalls(matterId, runId);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) expect(row.inputTokens).toBeNull();
    expect(w.services.runs.get(am, runId).usage).toMatchObject({
      state: "stand_in",
      calls: rows.length,
      callsWithUsage: 0,
      inputTokens: null,
      cost: { state: "not_applicable", usd: null },
      lines: ["No model was called, so there is no usage to record."],
    });
  });
});
