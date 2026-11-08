import type { JobQueue } from "./types.js";
import { processReviewJob, type JobOutcome, type ReviewWorkerDeps } from "./worker.js";

export interface WorkerLoopOptions {
  queue: JobQueue;
  deps: Omit<ReviewWorkerDeps, "signal">;
  /** Stops the loop. A job in progress is released for another worker to take over. */
  signal: AbortSignal;
  /** How long to wait when the queue is empty. Default 1 second. */
  idleMs?: number;
  /** Told about each finished job, for logs. Never given contract text. */
  onOutcome?: (reviewId: string, outcome: JobOutcome) => void;
  /** Told about a job the worker could not handle; the job comes back later. */
  onError?: (reviewId: string, error: unknown) => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Takes jobs off the queue one at a time until stopped. A job whose review has an outcome is
 * completed; one that failed for a reason outside the review, such as storage being unreachable,
 * is released and comes back later. A review is never left half done: its record says running
 * until the lease runs out and another worker takes it over.
 */
export async function runWorker(options: WorkerLoopOptions): Promise<void> {
  const { queue, signal } = options;
  while (!signal.aborted) {
    let delivery;
    try {
      delivery = await queue.receive();
    } catch (error) {
      options.onError?.("", error);
      await sleep(options.idleMs ?? 1000, signal);
      continue;
    }
    if (delivery === undefined) {
      await sleep(options.idleMs ?? 1000, signal);
      continue;
    }
    const { reviewId } = delivery.job;
    try {
      const outcome = await processReviewJob(delivery.job, { ...options.deps, signal });
      await delivery.complete();
      options.onOutcome?.(reviewId, outcome);
    } catch (error) {
      await delivery.release().catch(() => {});
      if (signal.aborted) break;
      options.onError?.(reviewId, error);
    }
  }
}
