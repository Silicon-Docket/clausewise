import type { AnthropicUsage } from "@clausewise/llm";
import { describe, expect, it } from "vitest";
import { createUsageSink, noteModel } from "../../src/usage/metering.js";
import {
  CallCollector,
  callStore,
  createRunScope,
  currentCall,
  currentRun,
  runStore,
} from "../../src/usage/scope.js";
import { pause } from "./support.js";

const usage = (input: number, output = 0, read = 0, write = 0): AnthropicUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});

describe("a call collector", () => {
  it("sums every response of one call, retries and failed attempts included", () => {
    const collector = new CallCollector();
    collector.add(usage(100, 20, 30, 10));
    collector.add(usage(50, 5));
    collector.add(usage(1, 2, 3, 4));
    expect(collector.usage()).toEqual({
      responses: 3,
      inputTokens: 151,
      outputTokens: 27,
      cacheReadTokens: 33,
      cacheWriteTokens: 14,
    });
  });

  it("holds nothing when no response reported usage, which is not the same as zero", () => {
    const collector = new CallCollector();
    expect(collector.usage()).toBeNull();
    collector.add(usage(0, 0, 0, 0));
    expect(collector.usage()).toMatchObject({ responses: 1, inputTokens: 0 });
  });

  it("does not count a response whose numbers are not whole numbers of 0 or more", () => {
    const collector = new CallCollector();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      collector.add(usage(bad, 1, 1, 1));
      collector.add(usage(1, bad, 1, 1));
      collector.add(usage(1, 1, bad, 1));
      collector.add(usage(1, 1, 1, bad));
    }
    expect(collector.usage()).toBeNull();
    collector.add(usage(7, 1, 1, 1));
    expect(collector.usage()).toMatchObject({ responses: 1, inputTokens: 7 });
  });

  it("hands out a copy, so a caller cannot change what was recorded", () => {
    const collector = new CallCollector();
    collector.add(usage(5));
    const copy = collector.usage();
    if (copy !== null) copy.inputTokens = 999;
    expect(collector.usage()?.inputTokens).toBe(5);
  });

  it("lists the distinct model names, sorted", () => {
    const collector = new CallCollector();
    for (const name of ["model-b", "model-a", "model-b"]) collector.addModel(name);
    expect(collector.models()).toEqual(["model-a", "model-b"]);
  });

  it("waits for every read it was told of, and never rejects", async () => {
    const collector = new CallCollector();
    const order: string[] = [];
    collector.track(pause(30).then(() => void order.push("slow")));
    collector.track(Promise.reject(new Error("a read that failed")).catch(() => undefined));
    // A read registered while another is being waited for is waited for too.
    collector.track(
      pause(5).then(() => {
        collector.track(pause(30).then(() => void order.push("late")));
      }),
    );
    await collector.settled();
    expect(order.sort()).toEqual(["late", "slow"]);
    await expect(new CallCollector().settled()).resolves.toBeUndefined();
  });
});

describe("the stores", () => {
  it("keep two calls in flight at once apart, whichever finishes first", async () => {
    const sink = createUsageSink();
    const first = new CallCollector();
    const second = new CallCollector();
    const call = (collector: CallCollector, delay: number, input: number, model: string) =>
      callStore.run(collector, async () => {
        await pause(delay);
        sink(usage(input));
        await pause(delay);
        noteModel(model);
        sink(usage(input));
      });
    // The first call starts first and finishes last, so a shared counter would mix them up.
    await Promise.all([call(first, 30, 100, "model-a"), call(second, 5, 7, "model-b")]);
    expect(first.usage()).toMatchObject({ responses: 2, inputTokens: 200 });
    expect(second.usage()).toMatchObject({ responses: 2, inputTokens: 14 });
    expect(first.models()).toEqual(["model-a"]);
    expect(second.models()).toEqual(["model-b"]);
  });

  it("send a model name to the call and to the run it is made in", async () => {
    const scope = createRunScope("run_x");
    const collector = new CallCollector();
    await runStore.run(scope, () =>
      callStore.run(collector, async () => {
        await pause(1);
        noteModel("model-a");
        expect(currentRun()).toBe(scope);
        expect(currentCall()).toBe(collector);
      }),
    );
    expect(collector.models()).toEqual(["model-a"]);
    expect([...scope.models]).toEqual(["model-a"]);
  });

  it("let a hook called outside any call count it nowhere, and still tell the next consumer", () => {
    const seen: AnthropicUsage[] = [];
    const sink = createUsageSink((u) => seen.push(u));
    expect(currentCall()).toBeUndefined();
    sink(usage(9));
    noteModel("model-a");
    expect(seen).toEqual([usage(9)]);
    const later = new CallCollector();
    callStore.run(later, () => undefined);
    expect(later.usage()).toBeNull();
    expect(later.models()).toEqual([]);
  });

  it("keep the usage of the call being made, and pass it on afterwards", () => {
    const seen: number[] = [];
    const sink = createUsageSink((u) => seen.push(u.inputTokens));
    const collector = new CallCollector();
    callStore.run(collector, () => sink(usage(42)));
    expect(collector.usage()?.inputTokens).toBe(42);
    expect(seen).toEqual([42]);
  });
});
