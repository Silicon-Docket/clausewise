/** Runs a task when a slot is free and settles with the task's own result or error. */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Lets at most `concurrency` tasks run at once, starting waiting tasks in the order they were
 * submitted. A finishing task hands its slot straight to the next waiter instead of freeing it,
 * so a task submitted in between cannot jump the queue and the running count never exceeds the
 * limit. A task that throws, or rejects, frees its slot like any other. A task must not wait on
 * another task of the same limiter, or every slot can end up held by a task that needs one more.
 */
export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError("concurrency must be a whole number of at least 1");
  }
  let running = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) running -= 1;
    else next();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < concurrency) {
      running += 1;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
