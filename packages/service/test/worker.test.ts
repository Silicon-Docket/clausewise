import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { ModelRequestError } from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import { createReviewService, processReviewJob, resultKey } from "../src/index.js";
import { memoryBlobs, memoryQueue, memoryRecords } from "../src/memory.js";
import { directoryPlaybooks } from "../src/node.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const alice = { id: "alice" };
const CONTRACT_SECRET = "CONFIDENTIAL-CONTRACT-TEXT";

let fixture: Fixture;

beforeAll(async () => {
  [fixture] = (await loadFixtures(ROOT, ["nda-aggressive.docx"])) as [Fixture];
});

let clock = Date.parse("2026-11-08T12:00:00Z");
const now = () => new Date(clock);

async function queuedReview() {
  const deps = {
    records: memoryRecords(),
    contracts: memoryBlobs(),
    results: memoryBlobs(),
    queue: memoryQueue(),
    playbooks: directoryPlaybooks(join(ROOT, "playbooks")),
    now,
  };
  const service = createReviewService(deps);
  const review = await service.createReview(alice, {
    playbookId: "nda-mutual",
    fileName: fixture.name,
  });
  await service.uploadContract(alice, review.id, fixture.docx);
  await service.startReview(alice, review.id);
  return { deps, service, review, job: { reviewId: review.id } };
}

function failingGenerator(error: () => unknown): ObjectGenerator {
  return {
    provider: "failing",
    model: "failing",
    disclosure: "a scripted test model",
    generate<T>(_request: GenerateObjectRequest<T>): Promise<T> {
      return Promise.reject(error());
    },
  };
}

describe("processReviewJob", () => {
  it("runs a queued review and keeps its three results", async () => {
    const { deps, service, review, job } = await queuedReview();
    const generator = createOracleGenerator(oracleScripts(fixture));
    expect(await processReviewJob(job, { ...deps, generator, now })).toBe("done");
    const done = await service.getReview(alice, review.id);
    expect(done.status).toBe("done");
    expect(done.open).toEqual({
      high: expect.any(Number),
      medium: expect.any(Number),
      low: expect.any(Number),
    });
    expect(done.unchecked).toBe(0);
    expect(deps.results.keys().sort()).toEqual(
      [
        resultKey(review.id, "redlined"),
        resultKey(review.id, "report"),
        resultKey(review.id, "summary"),
      ].sort(),
    );
  });

  it("skips a second delivery of a job that is already done", async () => {
    const { deps, job } = await queuedReview();
    const generator = createOracleGenerator(oracleScripts(fixture));
    await processReviewJob(job, { ...deps, generator, now });
    const again = createOracleGenerator(oracleScripts(fixture));
    expect(await processReviewJob(job, { ...deps, generator: again, now })).toBe("skipped");
    expect(again.calls).toHaveLength(0);
  });

  it("reports a review another worker is running as busy, until that worker's lease runs out", async () => {
    const { deps, job } = await queuedReview();
    await deps.records.claim(job.reviewId, now().toISOString(), now().toISOString());
    const generator = createOracleGenerator(oracleScripts(fixture));
    expect(await processReviewJob(job, { ...deps, generator, now, leaseMs: 60_000 })).toBe("busy");
    clock += 61_000;
    expect(await processReviewJob(job, { ...deps, generator, now, leaseMs: 60_000 })).toBe("done");
  });

  it("skips a job for a review that does not exist", async () => {
    const { deps } = await queuedReview();
    const generator = createOracleGenerator(oracleScripts(fixture));
    expect(await processReviewJob({ reviewId: "gone" }, { ...deps, generator, now })).toBe(
      "skipped",
    );
  });

  it("keeps no results when no rule could be checked, and says why once per reason", async () => {
    const { deps, service, review, job } = await queuedReview();
    const generator = failingGenerator(
      () => new ModelRequestError("The model service is unavailable.", 503, false, "server"),
    );
    expect(
      await processReviewJob(job, { ...deps, generator, now, limits: { concurrency: 1 } }),
    ).toBe("failed");
    const failed = await service.getReview(alice, review.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^No rule could be checked, so nothing was reviewed\. /);
    expect(deps.results.keys()).toEqual([]);
  });

  it("shows a fatal model failure in the review pipeline's own words", async () => {
    const { deps, service, review, job } = await queuedReview();
    const generator = failingGenerator(
      () => new ModelRequestError("The identity was refused.", 401, true, "auth"),
    );
    expect(await processReviewJob(job, { ...deps, generator, now })).toBe("failed");
    // The pipeline words a fatal failure itself and never repeats the provider's text.
    const failed = await service.getReview(alice, review.id);
    expect(failed.error).toMatch(
      /^The model provider answered HTTP 401, so no rule can be checked\./,
    );
    expect(failed.error).not.toContain("The identity was refused.");
  });

  it("puts the review back for another try when storage fails, and keeps the error from it", async () => {
    const { deps, service, review, job } = await queuedReview();
    const exploding = {
      ...deps,
      results: {
        put: () => Promise.reject(new Error(`disk full while writing ${CONTRACT_SECRET}`)),
        get: deps.results.get,
      },
    };
    const generator = createOracleGenerator(oracleScripts(fixture));
    await expect(processReviewJob(job, { ...exploding, generator, now })).rejects.toThrow(
      "disk full",
    );
    const queued = await service.getReview(alice, review.id);
    expect(queued.status).toBe("queued");
    expect(JSON.stringify(queued)).not.toContain(CONTRACT_SECRET);
    // The next delivery can take it at once, without waiting for a lease to run out.
    expect(await processReviewJob(job, { ...deps, generator, now })).toBe("done");
  });

  it("puts the review back when the worker is stopped, for another worker to take at once", async () => {
    const { deps, service, review, job } = await queuedReview();
    const controller = new AbortController();
    const generator = failingGenerator(() => {
      controller.abort(new Error("shutting down"));
      return controller.signal.reason;
    });
    await expect(
      processReviewJob(job, { ...deps, generator, now, signal: controller.signal }),
    ).rejects.toThrow("shutting down");
    expect((await service.getReview(alice, review.id)).status).toBe("queued");
  });

  it("fails a review whose contract has gone missing", async () => {
    const { deps, service, review, job } = await queuedReview();
    const generator = createOracleGenerator(oracleScripts(fixture));
    const empty = { ...deps, contracts: memoryBlobs() };
    expect(await processReviewJob(job, { ...empty, generator, now })).toBe("failed");
    expect((await service.getReview(alice, review.id)).error).toBe(
      "The contract of this review is missing.",
    );
  });

  it("writes the tracked changes with the time it is given", async () => {
    const { deps, service, review, job } = await queuedReview();
    const generator = createOracleGenerator(oracleScripts(fixture));
    await processReviewJob(job, {
      ...deps,
      generator,
      now,
      changeDate: () => new Date("2026-01-02T03:04:05Z"),
    });
    const redlined = await service.getResult(alice, review.id, "redlined");
    const JSZip = (await import("jszip")).default;
    const xml = await (await JSZip.loadAsync(redlined)).file("word/document.xml")!.async("string");
    expect(xml).toContain('w:date="2026-01-02T03:04:05Z"');
  });
});

describe("the job queue", () => {
  it("delivers a released job again after its delay, counting the attempts", async () => {
    const queue = memoryQueue({ releaseDelayMs: 30 });
    await queue.send({ reviewId: "r1" });
    const first = await queue.receive();
    expect(first?.attempt).toBe(1);
    await first?.release();
    expect(await queue.receive()).toBeUndefined();
    expect(queue.size()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await queue.receive();
    expect(second?.job).toEqual({ reviewId: "r1" });
    expect(second?.attempt).toBe(2);
    expect(await queue.receive()).toBeUndefined();
  });
});
