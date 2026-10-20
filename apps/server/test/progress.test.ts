import { describe, expect, it } from "vitest";
import { createProgressWriter, type ProgressTimers } from "../src/progress.js";

/** A clock and timers that the test moves by hand. */
function manual() {
  let now = 1000;
  const timers: { at: number; run: () => void; handle: number }[] = [];
  let next = 1;
  const api: ProgressTimers = {
    now: () => now,
    setTimer: (run, ms) => {
      const handle = next;
      next += 1;
      timers.push({ at: now + ms, run, handle });
      return handle;
    },
    clearTimer: (handle) => {
      const at = timers.findIndex((timer) => timer.handle === handle);
      if (at !== -1) timers.splice(at, 1);
    },
  };
  return {
    api,
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const due of timers.filter((timer) => timer.at <= now)) {
        timers.splice(timers.indexOf(due), 1);
        due.run();
      }
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("the progress writer", () => {
  it("writes the first value at once and no more than one per interval after it", async () => {
    const clock = manual();
    const written: [number, number][] = [];
    const writer = createProgressWriter({
      intervalMs: 500,
      timers: clock.api,
      write: async (done, total) => {
        written.push([done, total]);
      },
    });

    writer.update(0, 10);
    await flush();
    expect(written).toEqual([[0, 10]]);

    // A burst inside the interval: nothing is written yet, and one timer is set.
    clock.advance(100);
    for (let done = 1; done <= 6; done += 1) writer.update(done, 10);
    await flush();
    expect(written).toEqual([[0, 10]]);
    expect(clock.pending()).toBe(1);

    // When the interval is over the latest value is written, and only that.
    clock.advance(400);
    await flush();
    expect(written).toEqual([
      [0, 10],
      [6, 10],
    ]);

    // Later than the interval after the last write, a value goes straight out.
    clock.advance(600);
    writer.update(7, 10);
    await flush();
    expect(written.at(-1)).toEqual([7, 10]);
    expect(written).toHaveLength(3);
  });

  it("does not write after it has settled, and waits for the write in flight", async () => {
    const clock = manual();
    const written: number[] = [];
    let finish: () => void = () => {};
    const writer = createProgressWriter({
      intervalMs: 500,
      timers: clock.api,
      write: (done) =>
        new Promise<void>((resolve) => {
          written.push(done);
          finish = resolve;
        }),
    });
    writer.update(1, 10);
    await flush();
    clock.advance(10);
    writer.update(2, 10);
    expect(clock.pending()).toBe(1);

    let settled = false;
    const done = writer.settle().then(() => {
      settled = true;
    });
    await flush();
    // The pending write was cancelled, and settling waits for the one that is running.
    expect(clock.pending()).toBe(0);
    expect(settled).toBe(false);
    finish();
    await done;
    expect(settled).toBe(true);

    writer.update(3, 10);
    clock.advance(5000);
    await flush();
    expect(written).toEqual([1]);
  });

  it("goes on after a write fails", async () => {
    const clock = manual();
    const written: number[] = [];
    const writer = createProgressWriter({
      intervalMs: 0,
      timers: clock.api,
      write: async (done) => {
        written.push(done);
        if (done === 1) throw new Error("the database was busy");
      },
    });
    writer.update(1, 3);
    writer.update(2, 3);
    await writer.settle();
    expect(written).toEqual([1, 2]);
  });
});
