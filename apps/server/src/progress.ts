/**
 * Writes a review's progress to the database no more often than every `intervalMs`, whatever the
 * rate of the events: rules finish in bursts, and one write per rule would cost more than the
 * screen can show, which polls once a second. The last value is always written: when a burst ends
 * inside the interval, a timer writes it when the interval is over.
 */
export interface ProgressWriter {
  update(done: number, total: number): void;
  /** Cancels a pending write and waits for the one in flight, so that nothing writes afterwards. */
  settle(): Promise<void>;
}

export interface ProgressTimers {
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const realTimers: ProgressTimers = {
  now: () => performance.now(),
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function createProgressWriter(args: {
  write: (done: number, total: number) => Promise<void>;
  intervalMs: number;
  timers?: ProgressTimers;
}): ProgressWriter {
  const timers = args.timers ?? realTimers;
  let latest: { done: number; total: number } | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let inFlight: Promise<void> = Promise.resolve();
  let closed = false;

  const flush = (): void => {
    timer = undefined;
    if (closed || latest === undefined) return;
    const { done, total } = latest;
    latest = undefined;
    lastWriteAt = timers.now();
    // One write at a time, in order. A failed write loses a progress number, which the next one
    // replaces, so the error stops here.
    inFlight = inFlight.then(() => args.write(done, total)).catch(() => {});
  };

  return {
    update(done, total) {
      if (closed) return;
      latest = { done, total };
      if (timer !== undefined) return;
      const wait = args.intervalMs - (timers.now() - lastWriteAt);
      if (wait <= 0) flush();
      else timer = timers.setTimer(flush, wait);
    },
    async settle() {
      closed = true;
      if (timer !== undefined) timers.clearTimer(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
