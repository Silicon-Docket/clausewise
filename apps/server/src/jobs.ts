import { parsePlaybook } from "@clausewise/playbook";
import { reviewContract, type ProgressEvent, type ReviewReport } from "@clausewise/review";
import { and, asc, eq, inArray } from "drizzle-orm";
import { buildContext } from "./context.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { documents, findings, reviews } from "./db/schema.js";
import type { Clock, ModelSetup } from "./deps.js";
import {
  RESTART_MESSAGE,
  allRulesFailed,
  describeReviewFailure,
  nothingChecked,
} from "./failure.js";
import type { Logger } from "./log.js";
import { createProgressWriter } from "./progress.js";
import type { DocumentStorage } from "./storage.js";

/** A place held in the queue between checking that there is room and the review being saved. */
export interface Reservation {
  release(): void;
}

export interface JobRunner {
  /** Holds a place in the queue, or returns undefined when `maxQueued` reviews already wait. */
  reserve(): Reservation | undefined;
  /** Adds a saved review to the queue. Hands in the reservation made for it. */
  enqueue(reviewId: string, reservation?: Reservation): void;
  /** Takes the review out of the queue, or aborts it if it is running. Says which it was. */
  abort(reviewId: string): "queued" | "running" | "none";
  /** Reviews that wait for a place to run, reserved places included. */
  waiting(): number;
  /** Marks reviews the last process left running as failed, queues the ones it left waiting, and starts. */
  start(): Promise<void>;
  /** Aborts the running reviews, marks them cancelled, and waits for them to finish. */
  stop(): Promise<void>;
  /** Resolves when nothing waits and nothing runs. */
  idle(): Promise<void>;
}

/** The text of a NUL character cannot be stored in Postgres, in text or in JSON. */
function withoutNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "\ufffd") as T;
  if (Array.isArray(value)) return value.map((item) => withoutNul(item)) as T;
  if (value !== null && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = withoutNul(item);
    return copy as T;
  }
  return value;
}

export function createJobRunner(args: {
  db: Db;
  storage: DocumentStorage;
  model: ModelSetup;
  config: ServerConfig;
  clock: Clock;
  log: Logger;
}): JobRunner {
  const { db, storage, model, config, clock, log } = args;

  const queue: string[] = [];
  const running = new Map<string, AbortController>();
  const active = new Set<Promise<void>>();
  let reserved = 0;
  let started = false;
  let idleWaiters: (() => void)[] = [];

  const isIdle = (): boolean => queue.length === 0 && running.size === 0;
  const notifyIdle = (): void => {
    if (!isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  // The conditional `where status = 'running'` on every write below is what makes a cancel, a
  // delete or a stop final: once the row is no longer running, a review that is still winding
  // down changes nothing.
  async function fail(reviewId: string, message: string): Promise<void> {
    await db
      .update(reviews)
      .set({ status: "failed", error: message, finishedAt: clock.now() })
      .where(and(eq(reviews.id, reviewId), eq(reviews.status, "running")));
  }

  async function complete(
    reviewId: string,
    report: ReviewReport,
    context: Awaited<ReturnType<typeof buildContext>>,
  ): Promise<void> {
    const now = clock.now();
    const flagged = report.results.filter(
      (result) => result.status === "deviation" || result.status === "missing",
    );
    await db.transaction(async (tx) => {
      const [done] = await tx
        .update(reviews)
        .set({
          status: "done",
          error: null,
          report: withoutNul(report),
          context: withoutNul(context),
          modelProvider: report.model.provider,
          modelName: report.model.model,
          progressDone: report.results.length,
          progressTotal: report.results.length,
          finishedAt: now,
        })
        .where(and(eq(reviews.id, reviewId), eq(reviews.status, "running")))
        .returning({ id: reviews.id });
      // Cancelled or deleted while the last step ran: there is nothing to attach findings to.
      if (done === undefined || flagged.length === 0) return;
      await tx
        .insert(findings)
        .values(
          flagged.map((result) => ({
            reviewId,
            ruleId: result.ruleId,
            decision: "pending" as const,
            editedReplacement: null,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing();
    });
  }

  async function run(reviewId: string, controller: AbortController): Promise<void> {
    const [claimed] = await db
      .update(reviews)
      .set({
        status: "running",
        startedAt: clock.now(),
        ...("generator" in model
          ? { modelProvider: model.generator.provider, modelName: model.generator.model }
          : {}),
      })
      .where(and(eq(reviews.id, reviewId), eq(reviews.status, "queued")))
      .returning({
        documentId: reviews.documentId,
        playbookYaml: reviews.playbookYaml,
        client: reviews.client,
      });
    // Cancelled or deleted while it waited.
    if (claimed === undefined) return;
    if (controller.signal.aborted) return;

    if (!("generator" in model)) {
      await fail(
        reviewId,
        `The model is not configured, so the review could not run. ${model.problem} Fix the settings, restart the server and start the review again.`,
      );
      return;
    }
    const { generator, limits } = model;

    const [document] = await db
      .select({ storageKey: documents.storageKey, fileName: documents.fileName })
      .from(documents)
      .where(eq(documents.id, claimed.documentId));
    const bytes = document === undefined ? undefined : await storage.read(document.storageKey);
    if (document === undefined || bytes === undefined) {
      await fail(
        reviewId,
        "The stored file for this document is missing, so it cannot be reviewed. Upload the document again.",
      );
      return;
    }

    const progress = createProgressWriter({
      intervalMs: config.progressIntervalMs,
      write: async (done, total) => {
        await db
          .update(reviews)
          .set({ progressDone: done, progressTotal: total })
          .where(and(eq(reviews.id, reviewId), eq(reviews.status, "running")));
      },
    });

    try {
      const playbook = parsePlaybook(claimed.playbookYaml, "The playbook");
      const onProgress = (event: ProgressEvent): void => {
        if (event.type === "start") progress.update(0, event.rules);
        else progress.update(event.done, event.total);
      };
      const { report } = await reviewContract(
        { docx: bytes, playbook, fileName: document.fileName },
        generator,
        {
          ...limits,
          signal: controller.signal,
          onProgress,
          ...(claimed.client === null ? {} : { client: claimed.client }),
        },
      );
      controller.signal.throwIfAborted();
      if (allRulesFailed(report)) {
        await progress.settle();
        await fail(reviewId, nothingChecked(report));
        return;
      }
      const context = await buildContext(bytes, report);
      await progress.settle();
      await complete(reviewId, report, context);
    } catch (error) {
      await progress.settle();
      // A cancel, a delete or a stop has already set the final state of the row.
      if (controller.signal.aborted) return;
      const failure = describeReviewFailure(error);
      if (!failure.expected) log.error("a review stopped unexpectedly", error);
      await fail(reviewId, failure.message);
    } finally {
      await progress.settle();
    }
  }

  function pump(): void {
    while (started && running.size < config.reviewConcurrency && queue.length > 0) {
      const reviewId = queue.shift();
      if (reviewId === undefined) break;
      const controller = new AbortController();
      running.set(reviewId, controller);
      const job: Promise<void> = run(reviewId, controller)
        .catch(async (error: unknown) => {
          log.error("a review could not be run", error);
          // Best effort: the database may be what failed.
          await fail(reviewId, describeReviewFailure(error).message).catch(() => {});
        })
        .finally(() => {
          running.delete(reviewId);
          active.delete(job);
          pump();
          notifyIdle();
        });
      active.add(job);
    }
  }

  return {
    reserve() {
      // Waiting reviews are the ones beyond the places that can run at once.
      const inSystem = queue.length + reserved + running.size;
      if (inSystem >= config.reviewConcurrency + config.maxQueued) return undefined;
      reserved += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          reserved -= 1;
        },
      };
    },

    enqueue(reviewId, reservation) {
      reservation?.release();
      queue.push(reviewId);
      pump();
    },

    abort(reviewId) {
      const at = queue.indexOf(reviewId);
      if (at !== -1) {
        queue.splice(at, 1);
        notifyIdle();
        return "queued";
      }
      const controller = running.get(reviewId);
      if (controller === undefined) return "none";
      controller.abort(new Error("The review was cancelled."));
      return "running";
    },

    waiting() {
      return queue.length + reserved;
    },

    async start() {
      const now = clock.now();
      await db
        .update(reviews)
        .set({ status: "failed", error: RESTART_MESSAGE, finishedAt: now })
        .where(eq(reviews.status, "running"));
      // They were accepted and never started, so nothing is lost by running them now.
      const waiting = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.status, "queued"))
        .orderBy(asc(reviews.createdAt), asc(reviews.id));
      for (const { id } of waiting) if (!queue.includes(id)) queue.push(id);
      started = true;
      pump();
    },

    async stop() {
      started = false;
      const ids = [...running.keys()];
      for (const controller of running.values()) {
        controller.abort(new Error("The server is stopping."));
      }
      if (ids.length > 0) {
        await db
          .update(reviews)
          .set({ status: "cancelled", finishedAt: clock.now() })
          .where(and(inArray(reviews.id, ids), eq(reviews.status, "running")));
      }
      await Promise.allSettled([...active]);
    },

    idle() {
      if (isIdle()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}
