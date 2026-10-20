import { describe, expect, it } from "vitest";
import { createLimiter } from "../src/concurrency.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A small seeded generator, so a failure can be reproduced.
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("createLimiter", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a limit of %s, which would run nothing or never limit",
    (limit) => {
      expect(() => createLimiter(limit)).toThrow(RangeError);
    },
  );

  it("runs tasks up to the limit and holds the rest back", async () => {
    const limit = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      limit(async () => {
        started.push(i);
        await gate.promise;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);

    gates[1]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);

    gates[0]!.resolve();
    gates[2]!.resolve();
    await tick();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[3]!.resolve();
    await Promise.all(runs);
  });

  it("starts waiting tasks in the order they were submitted", async () => {
    for (const size of [1, 2, 3]) {
      const limit = createLimiter(size);
      const order: number[] = [];
      const runs = Array.from({ length: 12 }, (_, i) =>
        limit(async () => {
          order.push(i);
          await tick(i % 3);
        }),
      );
      await Promise.all(runs);
      expect(order).toEqual(Array.from({ length: 12 }, (_, i) => i));
    }
  });

  it("gives each caller its own task's result, whatever order the tasks finish in", async () => {
    const limit = createLimiter(3);
    const results = await Promise.all(
      [30, 1, 20, 2, 10, 0].map((delay, i) =>
        limit(async () => {
          await tick(delay);
          return `task ${i}`;
        }),
      ),
    );
    expect(results).toEqual(["task 0", "task 1", "task 2", "task 3", "task 4", "task 5"]);
  });

  it("passes a task's error to its own caller and nobody else", async () => {
    const limit = createLimiter(2);
    const boom = new Error("boom");
    const settled = await Promise.allSettled([
      limit(async () => "first"),
      limit(async () => {
        await tick();
        throw boom;
      }),
      limit(async () => "third"),
    ]);
    expect(settled).toEqual([
      { status: "fulfilled", value: "first" },
      { status: "rejected", reason: boom },
      { status: "fulfilled", value: "third" },
    ]);
  });

  it("frees the slot of a task that fails, so the queue keeps moving", async () => {
    const limit = createLimiter(1);
    const order: string[] = [];
    const settled = await Promise.allSettled([
      limit(async () => {
        order.push("a");
        throw new Error("a failed");
      }),
      limit(async () => {
        order.push("b");
        throw new Error("b failed");
      }),
      limit(async () => {
        order.push("c");
        return "c done";
      }),
    ]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected", "fulfilled"]);
    // Nothing is left held: a task submitted now starts at once.
    let ran = false;
    const later = limit(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await later;
  });

  it("turns a task that throws before returning a promise into a rejection", async () => {
    const limit = createLimiter(1);
    const boom = new Error("sync");
    const throwing = limit((): Promise<never> => {
      throw boom;
    });
    const next = limit(async () => "next");
    await expect(throwing).rejects.toBe(boom);
    await expect(next).resolves.toBe("next");
  });

  it("does not let a task submitted as one finishes jump ahead of those already waiting", async () => {
    const limit = createLimiter(1);
    const gate = deferred();
    const order: string[] = [];
    const first = limit(async () => {
      order.push("first");
      await gate.promise;
    });
    const waiting = limit(async () => {
      order.push("waiting");
    });
    // Submitted from a continuation of the first task, in the same turn that releases its slot.
    const late = first.then(() =>
      limit(async () => {
        order.push("late");
      }),
    );
    gate.resolve();
    await Promise.all([first, waiting, late]);
    expect(order).toEqual(["first", "waiting", "late"]);
  });

  it("never runs more than the limit under a load of tasks that finish at random", async () => {
    const next = random(20240613);
    const limit = createLimiter(7);
    let running = 0;
    let most = 0;
    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        limit(async () => {
          running += 1;
          most = Math.max(most, running);
          await tick(Math.floor(next() * 3));
          if (next() < 0.1) {
            running -= 1;
            throw new Error(`task ${i}`);
          }
          running -= 1;
          return i;
        }).catch((error: unknown) => (error as Error).message),
      ),
    );
    expect(most).toBe(7);
    expect(running).toBe(0);
    results.forEach((result, i) => {
      expect(result === i || result === `task ${i}`).toBe(true);
    });
  });

  it("runs one task at a time with a limit of one", async () => {
    const limit = createLimiter(1);
    let running = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limit(async () => {
          running += 1;
          most = Math.max(most, running);
          await tick();
          running -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
  });

  it("keeps separate limiters independent of each other", async () => {
    const one = createLimiter(1);
    const other = createLimiter(1);
    const gate = deferred();
    const blocked = one(() => gate.promise);
    let ran = false;
    await other(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    gate.resolve();
    await blocked;
  });

  it("hands out a queue of 200,000 tasks in order and in linear time", async () => {
    const limit = createLimiter(4);
    const count = 200_000;
    const started: number[] = [];
    let running = 0;
    let most = 0;
    const began = performance.now();
    // All submitted at once, as a review does, so nearly all of them wait.
    const runs = Array.from({ length: count }, (_, i) =>
      limit(async () => {
        running += 1;
        most = Math.max(most, running);
        started.push(i);
        await Promise.resolve();
        running -= 1;
        return i;
      }),
    );
    const results = await Promise.all(runs);
    const elapsed = performance.now() - began;

    expect(results[0]).toBe(0);
    expect(results.at(-1)).toBe(count - 1);
    expect(started.length).toBe(count);
    expect(started.every((id, position) => id === position)).toBe(true);
    expect(most).toBe(4);
    // Shifting the head of a long array made this quadratic: over ten seconds at this size.
    expect(elapsed).toBeLessThan(4000);
  }, 120_000);

  it("keeps its order when a long queue drains and fills again", async () => {
    const limit = createLimiter(2);
    const order: number[] = [];
    const wave = (from: number, size: number): Promise<unknown> =>
      Promise.all(
        Array.from({ length: size }, (_, i) =>
          limit(async () => {
            order.push(from + i);
            await Promise.resolve();
          }),
        ),
      );
    await wave(0, 3000);
    await wave(3000, 1);
    await Promise.all([wave(3001, 2000), wave(5001, 2000)]);
    expect(order).toEqual(Array.from({ length: 7001 }, (_, i) => i));
    // A task submitted now starts at once, so nothing is left held.
    let ran = false;
    const later = limit(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await later;
  });

  it("accepts tasks while others are running and after the queue has emptied", async () => {
    const limit = createLimiter(2);
    const log: string[] = [];
    const slow = limit(async () => {
      await tick(5);
      log.push("slow");
    });
    await tick(1);
    await limit(async () => {
      log.push("while running");
    });
    await slow;
    await limit(async () => {
      log.push("after");
    });
    expect(log).toEqual(["while running", "slow", "after"]);
  });
});
