import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOracleGenerator } from "@clausewise/review/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import {
  createReviewService,
  runWorker,
  type BlobStore,
  type Delivery,
  type JobOutcome,
  type JobQueue,
} from "../src/index.js";
import { memoryBlobs, memoryQueue, memoryRecords } from "../src/memory.js";
import { directoryPlaybooks } from "../src/node.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const alice = { id: "alice" };

let fixture: Fixture;
beforeAll(async () => {
  [fixture] = (await loadFixtures(ROOT, ["nda-aggressive.docx"])) as [Fixture];
});

/** A queue that records what the loop does with each delivery. */
function recordingQueue(inner: JobQueue) {
  const actions: string[] = [];
  const queue: JobQueue = {
    send: (job) => inner.send(job),
    async receive(): Promise<Delivery | undefined> {
      const delivery = await inner.receive();
      if (delivery === undefined) return undefined;
      return {
        ...delivery,
        complete: async () => {
          actions.push(`complete ${delivery.attempt}`);
          await delivery.complete();
        },
        release: async () => {
          actions.push(`release ${delivery.attempt}`);
          await delivery.release();
        },
      };
    },
  };
  return { queue, actions };
}

async function setup(results: BlobStore = memoryBlobs()) {
  const deps = {
    records: memoryRecords(),
    contracts: memoryBlobs(),
    results,
    queue: memoryQueue({ releaseDelayMs: 0 }),
    playbooks: directoryPlaybooks(join(ROOT, "playbooks")),
  };
  const service = createReviewService(deps);
  const review = await service.createReview(alice, {
    playbookId: "nda-mutual",
    fileName: fixture.name,
  });
  await service.uploadContract(alice, review.id, fixture.docx);
  await service.startReview(alice, review.id);
  return { deps, service, review };
}

/** Runs the loop until `done` says so, then stops it. */
async function runUntil(
  options: Omit<Parameters<typeof runWorker>[0], "signal">,
  done: () => boolean,
): Promise<void> {
  const stop = new AbortController();
  const loop = runWorker({ ...options, signal: stop.signal, idleMs: 1 });
  for (let waited = 0; !done() && waited < 5000; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  stop.abort(new Error("stop"));
  await loop;
}

describe("runWorker", () => {
  it("completes a job whose review reached an outcome", async () => {
    const { deps, service, review } = await setup();
    const { queue, actions } = recordingQueue(deps.queue);
    const outcomes: JobOutcome[] = [];
    await runUntil(
      {
        queue,
        deps: { ...deps, generator: createOracleGenerator(oracleScripts(fixture)) },
        onOutcome: (_id, outcome) => outcomes.push(outcome),
      },
      () => outcomes.length > 0,
    );
    expect(outcomes).toEqual(["done"]);
    expect(actions).toEqual(["complete 1"]);
    expect((await service.getReview(alice, review.id)).status).toBe("done");
  });

  it("releases, rather than completes, a job whose review another worker holds", async () => {
    const { deps, review } = await setup();
    const at = new Date().toISOString();
    await deps.records.claim(review.id, at, at);
    const { queue, actions } = recordingQueue(deps.queue);
    const outcomes: JobOutcome[] = [];
    await runUntil(
      {
        queue,
        deps: { ...deps, generator: createOracleGenerator(oracleScripts(fixture)) },
        onOutcome: (_id, outcome) => outcomes.push(outcome),
      },
      () => outcomes.length >= 2,
    );
    expect(outcomes.slice(0, 2)).toEqual(["busy", "busy"]);
    expect(actions.slice(0, 2)).toEqual(["release 1", "release 2"]);
    expect(deps.queue.size()).toBe(1);
  });

  it("fails the review after the last attempt that broke for a reason outside it", async () => {
    const broken: BlobStore = {
      put: () => Promise.reject(new Error("storage unreachable")),
      get: () => Promise.reject(new Error("storage unreachable")),
    };
    const { deps, service, review } = await setup();
    const { queue, actions } = recordingQueue(deps.queue);
    const errors: unknown[] = [];
    await runUntil(
      {
        queue,
        deps: {
          ...deps,
          contracts: broken,
          generator: createOracleGenerator(oracleScripts(fixture)),
        },
        maxAttempts: 3,
        onError: (_id, error) => errors.push(error),
      },
      () => actions.length >= 3,
    );
    expect(actions).toEqual(["release 1", "release 2", "complete 3"]);
    const failed = await service.getReview(alice, review.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(
      "The review could not be run after several tries. Start it again later.",
    );
    expect(errors).toHaveLength(3);
  });

  it("does not count a review that failed on its own merits as a broken job", async () => {
    const { deps, service, review } = await setup();
    const { queue, actions } = recordingQueue(deps.queue);
    const outcomes: JobOutcome[] = [];
    await runUntil(
      {
        queue,
        deps: {
          ...deps,
          contracts: memoryBlobs(),
          generator: createOracleGenerator(oracleScripts(fixture)),
        },
        onOutcome: (_id, outcome) => outcomes.push(outcome),
      },
      () => outcomes.length > 0,
    );
    expect(outcomes).toEqual(["failed"]);
    expect(actions).toEqual(["complete 1"]);
    expect((await service.getReview(alice, review.id)).error).toBe(
      "The contract of this review is missing.",
    );
  });
});
