import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ServiceError, createReviewService, type ReviewServiceDeps } from "../src/index.js";
import { memoryBlobs, memoryQueue, memoryRecords } from "../src/memory.js";
import { directoryPlaybooks } from "../src/node.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const alice = { id: "alice" };
const bob = { id: "bob" };

let nda: Uint8Array;

beforeAll(async () => {
  nda = new Uint8Array(await readFile(join(ROOT, "fixtures", "nda-balanced.docx")));
});

function setup(overrides: Partial<ReviewServiceDeps> = {}) {
  const queue = memoryQueue();
  const deps = {
    records: memoryRecords(),
    contracts: memoryBlobs(),
    results: memoryBlobs(),
    queue,
    playbooks: directoryPlaybooks(join(ROOT, "playbooks")),
    newId: (() => {
      let next = 0;
      return () => `review-${(next += 1)}`;
    })(),
    now: () => new Date("2026-11-08T12:00:00Z"),
    ...overrides,
  };
  return { queue, service: createReviewService(deps) };
}

async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ServiceError);
  return error as ServiceError;
}

describe("playbooks", () => {
  it("lists the starter playbooks by id", async () => {
    const { service } = setup();
    const ids = (await service.listPlaybooks()).map((playbook) => playbook.id);
    expect(ids).toEqual(["nda-mutual", "saas-customer"]);
  });

  it.each(["../package", "NDA-MUTUAL", "nda-mutual.yaml", "missing"])(
    "knows no playbook called %j",
    async (playbookId) => {
      const { service } = setup();
      const error = await failure(
        service.createReview(alice, { playbookId, fileName: "nda.docx" }),
      );
      expect(error.code).toBe("invalid");
    },
  );
});

describe("creating a review", () => {
  it("waits for the contract, with the CLI's default author", async () => {
    const { service } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: " nda.docx ",
      client: " Fabrikam Labs LLC, the Recipient ",
    });
    expect(review).toMatchObject({
      id: "review-1",
      owner: "alice",
      status: "awaiting_upload",
      fileName: "nda.docx",
      client: "Fabrikam Labs LLC, the Recipient",
      author: "Clausewise",
    });
  });

  it.each([
    ["nda.pdf", /Only Word .docx/],
    ["nda.doc", /Only Word .docx/],
    ["../nda.docx", /plain name/],
    ["folder\\nda.docx", /plain name/],
    ["nda\n.docx", /plain name/],
    ["", /plain name/],
    [`${"a".repeat(200)}.docx`, /plain name/],
  ])("refuses the file name %j", async (fileName, reason) => {
    const { service } = setup();
    const error = await failure(
      service.createReview(alice, { playbookId: "nda-mutual", fileName }),
    );
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(reason);
  });

  it.each([
    ["client", { client: "   " }],
    ["client", { client: "line\nbreak" }],
    ["author name", { author: "" }],
    ["author name", { author: "x".repeat(201) }],
  ])("refuses an unusable %s", async (what, extra) => {
    const { service } = setup();
    const error = await failure(
      service.createReview(alice, { playbookId: "nda-mutual", fileName: "nda.docx", ...extra }),
    );
    expect(error.message).toContain(what);
  });
});

describe("uploading and starting", () => {
  it("queues the review once the contract is in", async () => {
    const { service, queue } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    await service.uploadContract(alice, review.id, nda);
    const started = await service.startReview(alice, review.id);
    expect(started.status).toBe("queued");
    expect(queue.size()).toBe(1);
  });

  it("will not start a review that has no contract", async () => {
    const { service, queue } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    const error = await failure(service.startReview(alice, review.id));
    expect(error.code).toBe("conflict");
    expect(queue.size()).toBe(0);
  });

  it("refuses a file that is not Word before anything is queued, in the Word engine's words", async () => {
    const { service, queue } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    await service.uploadContract(alice, review.id, new TextEncoder().encode("%PDF-1.7 not word"));
    const error = await failure(service.startReview(alice, review.id));
    expect(error.code).toBe("invalid");
    expect(error.message).toMatch(/^Cannot open nda\.docx: /);
    expect(queue.size()).toBe(0);
    expect((await service.getReview(alice, review.id)).status).toBe("awaiting_upload");
  });

  it("refuses a contract over the size limit", async () => {
    const { service } = setup({ maxContractBytes: 10 });
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    expect((await failure(service.uploadContract(alice, review.id, nda))).code).toBe("too_large");
  });

  it("starts a review once, however often it is asked", async () => {
    const { service, queue } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    await service.uploadContract(alice, review.id, nda);
    await service.startReview(alice, review.id);
    expect((await failure(service.startReview(alice, review.id))).code).toBe("conflict");
    expect((await failure(service.uploadContract(alice, review.id, nda))).code).toBe("conflict");
    expect(queue.size()).toBe(1);
  });

  it("offers no results before the review is done", async () => {
    const { service } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    expect((await failure(service.getResult(alice, review.id, "report"))).code).toBe("conflict");
  });
});

describe("who can see a review", () => {
  it("answers anyone but the owner as if the review did not exist", async () => {
    const { service } = setup();
    const review = await service.createReview(alice, {
      playbookId: "nda-mutual",
      fileName: "nda.docx",
    });
    for (const attempt of [
      service.getReview(bob, review.id),
      service.uploadContract(bob, review.id, nda),
      service.startReview(bob, review.id),
      service.getResult(bob, review.id, "redlined"),
    ]) {
      const error = await failure(attempt);
      expect(error.code).toBe("not_found");
    }
    const missing = await failure(service.getReview(alice, "no-such-review"));
    expect(missing.message).toBe("There is no such review.");
  });
});
