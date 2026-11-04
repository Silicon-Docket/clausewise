import { ModelRequestError } from "@clausewise/llm";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import { describe, expect, it } from "vitest";
import {
  RUN_ERROR_KINDS,
  RunStopped,
  fatalKindOf,
  mapLimited,
  watchGenerator,
} from "../../src/services/run-support.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("fatalKindOf", () => {
  const cases: [
    number | undefined,
    boolean | undefined,
    ModelRequestError["kind"] | undefined,
    string,
  ][] = [
    [401, undefined, undefined, "provider_auth"],
    [403, undefined, undefined, "provider_permission"],
    [404, undefined, undefined, "provider_model"],
    [402, undefined, undefined, "provider_billing"],
    [301, true, "other", "provider_redirect"],
    [307, true, "other", "provider_redirect"],
    // Fatal for a reason the closed set has no name of its own for.
    [500, true, "server", "internal"],
  ];
  it.each(cases)("maps status %s to %s", (status, fatal, kind, expected) => {
    const error = new ModelRequestError("provider words", status, fatal, kind);
    expect(fatalKindOf(error)).toBe(expected);
    expect(RUN_ERROR_KINDS).toContain(expected);
  });
});

describe("watchGenerator", () => {
  it("notes a fatal provider error and rethrows it unchanged, and notes nothing else", async () => {
    const seen: string[] = [];
    const failures: unknown[] = [
      new ModelRequestError("busy", 429),
      new Error("plain"),
      new ModelRequestError("no key", 401),
    ];
    const base = createScriptedGenerator(() => {
      throw failures.shift();
    });
    const watched = watchGenerator(base, (kind) => seen.push(kind));
    const request = { system: "s", prompt: "p", schema: (await import("zod")).z.object({}) };
    await expect(watched.generate(request)).rejects.toMatchObject({ statusCode: 429 });
    await expect(watched.generate(request)).rejects.toThrow("plain");
    const last = watched.generate(request);
    await expect(last).rejects.toBeInstanceOf(ModelRequestError);
    expect(seen).toEqual(["provider_auth"]);
  });

  it("says what the real generator says about itself", () => {
    const base = createScriptedGenerator(() => ({}), {
      provider: "p",
      model: "m",
      disclosure: "somewhere",
      cachesSharedPrefix: true,
      minCacheableChars: 100,
    });
    const watched = watchGenerator(base, () => undefined);
    expect(watched).toMatchObject({
      provider: "p",
      model: "m",
      disclosure: "somewhere",
      cachesSharedPrefix: true,
      minCacheableChars: 100,
    });
  });
});

describe("mapLimited", () => {
  it("returns the results in order, whatever order they finish in", async () => {
    const out = await mapLimited([30, 5, 20, 1], 4, async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it("never has more than the limit in flight", async () => {
    let inFlight = 0;
    let most = 0;
    await mapLimited(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await sleep(3);
        inFlight -= 1;
      },
    );
    expect(most).toBe(3);
  });

  it("runs the first alone when asked to warm up", async () => {
    const events: string[] = [];
    await mapLimited(
      ["a", "b", "c"],
      3,
      async (item) => {
        events.push(`start ${item}`);
        await sleep(item === "a" ? 10 : 1);
        events.push(`end ${item}`);
      },
      { warmUp: true },
    );
    expect(events.slice(0, 2)).toEqual(["start a", "end a"]);
    expect(events).toHaveLength(6);
  });

  it("stops starting items after a failure, tells the caller, waits for those in flight, and throws the first failure", async () => {
    const started: number[] = [];
    const told: unknown[] = [];
    const first = new Error("first");
    await expect(
      mapLimited(
        Array.from({ length: 10 }, (_, i) => i),
        2,
        async (i) => {
          started.push(i);
          await sleep(5);
          if (i === 1) throw first;
          if (i === 0) await sleep(20);
        },
        { onFail: (error) => told.push(error) },
      ),
    ).rejects.toBe(first);
    expect(told).toEqual([first]);
    // Items 0 and 1 were in flight; once 1 failed, nothing else began.
    expect(started).toEqual([0, 1]);
  });

  it("fails on the first item when warming up, without starting the rest", async () => {
    const started: number[] = [];
    await expect(
      mapLimited(
        [0, 1, 2],
        3,
        async (i) => {
          started.push(i);
          throw new RunStopped("cancelled");
        },
        { warmUp: true },
      ),
    ).rejects.toBeInstanceOf(RunStopped);
    expect(started).toEqual([0]);
  });

  it("handles an empty list and a single item", async () => {
    expect(await mapLimited([], 3, async () => 1)).toEqual([]);
    expect(await mapLimited([7], 3, async (x) => x * 2, { warmUp: true })).toEqual([14]);
  });
});
