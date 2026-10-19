import { ModelOutputError } from "@clausewise/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import type { Clause, ProgressEvent, ReviewReport } from "../src/types.js";
import {
  budgetFor,
  clausesOf,
  expectedWindows,
  fixture,
  gatedGenerator,
  loadPlaybook,
  onlyRules,
  tick,
  type Gate,
} from "./pipeline-support.js";

const input = fixture("nda-aggressive.docx");
const playbook = loadPlaybook();
const ruleIds = playbook.rules.map((r) => r.id);

let clauses: Clause[];
let manyWindows: number;
let windowCount: number;

beforeAll(async () => {
  clauses = await clausesOf(input);
  manyWindows = budgetFor(playbook, clauses, 3);
  windowCount = expectedWindows(playbook, clauses, manyWindows).length;
  expect(windowCount).toBeGreaterThan(1);
});

/** Settles every call as it starts until the review ends, and gives up if it never does. */
async function settleAll(gate: Gate, review: Promise<unknown>): Promise<void> {
  let finished = false;
  void review.then(
    () => (finished = true),
    () => (finished = true),
  );
  for (let round = 0; round < 3000 && !finished; round += 1) {
    for (const call of gate.calls) call.resolve();
    await tick(1);
  }
  if (!finished) throw new Error("the review did not finish");
}

const started = (gate: Gate): string[] => gate.calls.map((call) => call.ruleId);

describe("a generator that caches the shared prefix", () => {
  it("finishes the first rule's call before it starts the others", async () => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook }, gate, { concurrency: 4 });

    await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
    await tick(30);
    expect(started(gate)).toEqual(["mutuality"]);

    gate.calls[0]!.resolve();
    await vi.waitFor(() => expect(gate.calls).toHaveLength(5));
    await tick(30);
    expect(started(gate)).toEqual(ruleIds.slice(0, 5));
    expect(gate.inFlight).toBe(4);

    await settleAll(gate, review);
    const { report } = await review;
    expect(report.results).toHaveLength(10);
    expect(gate.maxInFlight).toBe(4);
  });

  it("goes on with the others when the first call fails", async () => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook }, gate, { concurrency: 4 });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
    gate.calls[0]!.reject(new ModelOutputError("no"));
    await vi.waitFor(() => expect(gate.calls).toHaveLength(5));
    await settleAll(gate, review);
    const { report } = await review;
    expect(report.results[0]?.status).toBe("error");
    expect(report.counts.compliant).toBe(9);
  });

  it("sends the first call of every window at once, and no other until its window's first ends", async () => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 16,
      maxContextTokens: manyWindows,
    });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(windowCount));
    await tick(30);
    expect(gate.calls).toHaveLength(windowCount);
    expect(new Set(started(gate))).toEqual(new Set(["mutuality"]));
    expect(new Set(gate.calls.map((c) => c.window)).size).toBe(windowCount);

    const first = gate.calls[0]!;
    first.resolve();
    await vi.waitFor(() => expect(gate.calls.length).toBeGreaterThan(windowCount));
    await tick(30);
    const later = gate.calls.slice(windowCount);
    // Only the window whose first call ended moved on, and in playbook order.
    expect(new Set(later.map((c) => c.window))).toEqual(new Set([first.window]));
    expect(later.map((c) => c.ruleId)).toEqual(ruleIds.slice(1, 1 + later.length));

    await settleAll(gate, review);
    await review;
    expect(gate.calls).toHaveLength(10 * windowCount);
  });

  it("serves the first calls of other windows before the rest of a window, with a small limit", async () => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 2,
      maxContextTokens: manyWindows,
    });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(2));
    gate.calls[0]!.resolve();
    await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
    // The next slot goes to the third window's first call, which was waiting before the rest of
    // the first window's calls were submitted.
    expect(gate.calls[2]).toMatchObject({ ruleId: "mutuality" });
    expect(gate.calls[2]!.window).not.toBe(gate.calls[0]!.window);
    expect(gate.calls[2]!.window).not.toBe(gate.calls[1]!.window);
    await settleAll(gate, review);
    await review;
  });

  it.each([1, 2])("never deadlocks with a limit of %i across several windows", async (limit) => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: limit,
      maxContextTokens: manyWindows,
    });
    await settleAll(gate, review);
    const { report } = await review;
    expect(report.stats.windows).toBe(windowCount);
    expect(gate.calls).toHaveLength(10 * windowCount);
    expect(gate.maxInFlight).toBe(limit);
  });

  it("works for a playbook of a single rule", async () => {
    const gate = gatedGenerator({ cachesSharedPrefix: true });
    const review = reviewContract({ docx: input, playbook: onlyRules(playbook, "term") }, gate, {
      concurrency: 1,
    });
    await settleAll(gate, review);
    expect((await review).report.results).toHaveLength(1);
    expect(gate.calls).toHaveLength(1);
  });
});

describe("a generator that does not cache", () => {
  it("overlaps calls up to the limit, in playbook order", async () => {
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate, { concurrency: 4 });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(4));
    await tick(30);
    expect(started(gate)).toEqual(ruleIds.slice(0, 4));
    expect(gate.inFlight).toBe(4);

    gate.calls[0]!.resolve();
    await vi.waitFor(() => expect(gate.calls).toHaveLength(5));
    expect(gate.calls[4]!.ruleId).toBe(ruleIds[4]);
    await settleAll(gate, review);
    await review;
  });

  it("defaults to four calls at a time", async () => {
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate);
    await vi.waitFor(() => expect(gate.calls).toHaveLength(4));
    await tick(30);
    expect(gate.calls).toHaveLength(4);
    await settleAll(gate, review);
    await review;
    expect(gate.maxInFlight).toBe(4);
  });

  it("shares one limit across all windows and starts the rules in playbook order", async () => {
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 3,
      maxContextTokens: manyWindows,
    });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(3));
    await tick(30);
    expect(gate.calls).toHaveLength(3);
    // Rule by rule: the first rule's windows come before the second rule's.
    expect(new Set(started(gate))).toEqual(new Set(["mutuality"]));
    await settleAll(gate, review);
    await review;
    expect(gate.maxInFlight).toBe(3);
    expect(gate.calls).toHaveLength(10 * windowCount);
  });

  it("never has more calls in flight than the limit while calls settle one by one", async () => {
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 3,
      maxContextTokens: manyWindows,
    });
    let finished = false;
    void review.then(
      () => (finished = true),
      () => (finished = true),
    );
    let settled = 0;
    while (!finished) {
      const next = gate.calls.find((call) => !call.settled);
      if (next !== undefined) {
        next.resolve();
        settled += 1;
      }
      await tick(0);
      expect(gate.inFlight).toBeLessThanOrEqual(3);
    }
    expect(settled).toBe(10 * windowCount);
    expect(gate.maxInFlight).toBe(3);
  });

  it("works with a limit of one", async () => {
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate, { concurrency: 1 });
    await settleAll(gate, review);
    await review;
    expect(gate.maxInFlight).toBe(1);
    expect(started(gate)).toEqual(ruleIds);
  });
});

describe("progress", () => {
  it("reports a rule only when every window has finished it", async () => {
    const events: ProgressEvent[] = [];
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook }, gate, {
      concurrency: 100,
      maxContextTokens: manyWindows,
      onProgress: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(10 * windowCount));
    expect(events.map((e) => e.type)).toEqual(["start"]);

    const forTerm = gate.calls.filter((call) => call.ruleId === "term");
    expect(forTerm).toHaveLength(windowCount);
    forTerm.slice(1).forEach((call) => call.resolve());
    await tick(20);
    expect(events).toHaveLength(1);

    forTerm[0]!.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ type: "rule", ruleId: "term", done: 1, total: 10 });

    await settleAll(gate, review);
    const { report } = await review;
    expect(events).toHaveLength(11);
    events.slice(1).forEach((event, i) => {
      expect(event).toMatchObject({ type: "rule", done: i + 1, total: 10 });
    });
    expect(report.stats.windows).toBe(windowCount);
  });

  it("reports the status a rule ended with, errors included", async () => {
    const events: ProgressEvent[] = [];
    const gate = gatedGenerator();
    const review = reviewContract({ docx: input, playbook: onlyRules(playbook, "term") }, gate, {
      onProgress: (event) => events.push(event),
    });
    await vi.waitFor(() => expect(gate.calls).toHaveLength(1));
    gate.calls[0]!.reject(new ModelOutputError("no"));
    const { report } = await review;
    expect(events).toEqual([
      { type: "start", rules: 1, clauses: 16, windows: 1 },
      { type: "rule", ruleId: "term", status: "error", done: 1, total: 1 },
    ]);
    expect((report as ReviewReport).counts.error).toBe(1);
  });
});
