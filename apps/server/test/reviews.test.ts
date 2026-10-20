import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApiError,
  ConfigResponse,
  PlaybookDetail,
  ReviewDetail,
  ReviewSummary,
} from "@clausewise/api";
import { ModelRequestError } from "@clausewise/llm";
import { count, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { documents, findings, reviews } from "../src/db/schema.js";
import {
  builtinYaml,
  controllable,
  createHarness,
  decliningModel,
  failingModel,
  fixtureBytes,
  oracleFor,
  tinyDocx,
  type Harness,
} from "./support.js";

const NDA = "builtin:nda-mutual";
const UUID = "00000000-0000-4000-8000-0000000000ab";

async function oracleHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  return createHarness({ generator: await oracleFor("nda-aggressive.docx"), ...options });
}

async function rowCounts(
  t: Harness,
): Promise<{ reviews: number; findings: number; documents: number }> {
  const [r] = await t.database.db.select({ n: count() }).from(reviews);
  const [f] = await t.database.db.select({ n: count() }).from(findings);
  const [d] = await t.database.db.select({ n: count() }).from(documents);
  return { reviews: r?.n ?? 0, findings: f?.n ?? 0, documents: d?.n ?? 0 };
}

describe("starting a review", () => {
  it("answers 503 with the reason, and creates nothing, when the model is not set up", async () => {
    const t = await createHarness({
      model: { problem: "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic." },
    });
    const document = await t.uploadFixture("nda-aggressive.docx");

    const config = await t.json<ConfigResponse>("/api/config");
    expect(config.body.model).toEqual({
      configured: false,
      problem: "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic.",
    });

    const started = await t.send<ApiError>("POST", "/api/reviews", {
      documentId: document.id,
      playbookId: NDA,
    });
    expect(started.status).toBe(503);
    expect(started.body.error.code).toBe("model_not_configured");
    expect(started.body.error.message).toContain("ANTHROPIC_API_KEY is required");
    expect((await rowCounts(t)).reviews).toBe(0);
    // Everything that needs no model still works.
    expect((await t.json("/api/playbooks")).status).toBe(200);
  });

  it("answers 404 for a document or playbook that does not exist, and 400 for a request that is wrong", async () => {
    const t = await oracleHarness();
    const document = await t.uploadFixture("nda-aggressive.docx");
    const body = (patch: Record<string, unknown>) => ({
      documentId: document.id,
      playbookId: NDA,
      ...patch,
    });

    for (const patch of [
      { documentId: UUID },
      { documentId: "not-a-uuid" },
      { playbookId: "builtin:nope" },
      { playbookId: "abc123" },
      { playbookId: "../../etc/passwd" },
    ]) {
      const response = await t.send<ApiError>("POST", "/api/reviews", body(patch));
      expect(response.status, JSON.stringify(patch)).toBe(404);
      expect(response.body.error.code).toBe("not_found");
    }
    for (const patch of [
      { documentId: undefined },
      { playbookId: 5 },
      { client: 5 },
      { client: "x".repeat(301) },
      { client: "a\u0000b" },
      { surprise: true },
    ]) {
      const response = await t.send<ApiError>("POST", "/api/reviews", body(patch));
      expect(response.status, JSON.stringify(patch)).toBe(400);
      expect(response.body.error.code).toBe("bad_request");
    }
    expect(
      (
        await t.request("/api/reviews", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "[",
        })
      ).status,
    ).toBe(400);
    expect((await rowCounts(t)).reviews).toBe(0);
  });

  it("queues the review, and passes the client's description on to the model", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");

    const started = await t.startReview(document.id, NDA, "  Fabrikam Labs LLC, the Recipient  ");
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      status: "queued",
      documentId: document.id,
      documentName: "nda-aggressive.docx",
      playbookName: "Mutual NDA (receiving party)",
      client: "Fabrikam Labs LLC, the Recipient",
      progress: { done: 0, total: 10 },
      error: null,
      open: null,
      startedAt: null,
      finishedAt: null,
    });

    await control.calls(1);
    const running = await t.waitFor(started.body.id, ["running"]);
    expect(running.startedAt).not.toBeNull();
    expect(running.findings).toEqual([]);
    expect(control.prompts[0]).toContain("Fabrikam Labs LLC, the Recipient");

    control.release();
    const done = await t.waitFor(started.body.id);
    expect(done.status).toBe("done");

    // No client: none is stored, and a blank one is none.
    const blank = await t.startReview(document.id, NDA, "   ");
    expect(blank.body.client).toBeNull();
    await t.waitFor(blank.body.id);
  });

  it("keeps the playbook as it was when the review began", async () => {
    const t = await oracleHarness();
    const document = await t.uploadFixture("nda-aggressive.docx");
    const yaml = (await builtinYaml()).replace(
      "name: Mutual NDA (receiving party)",
      "name: House NDA v1",
    );
    const created = await t.send<PlaybookDetail>("POST", "/api/playbooks", { yaml });
    expect(created.status).toBe(201);

    const started = await t.startReview(document.id, created.body.id);
    expect(started.body.playbookName).toBe("House NDA v1");
    const done = await t.waitFor(started.body.id);
    expect(done.status).toBe("done");

    // The lawyer edits the playbook, and then deletes it. The review keeps what it was run with.
    const edited = await t.send("PUT", `/api/playbooks/${created.body.id}`, {
      yaml: yaml.replace("House NDA v1", "House NDA v2"),
    });
    expect(edited.status).toBe(200);
    expect((await t.json<ReviewDetail>(`/api/reviews/${done.id}`)).body.playbookName).toBe(
      "House NDA v1",
    );
    expect((await t.send("DELETE", `/api/playbooks/${created.body.id}`)).status).toBe(204);
    const after = await t.json<ReviewDetail>(`/api/reviews/${done.id}`);
    expect(after.body.playbookName).toBe("House NDA v1");
    expect(after.body.findings).toHaveLength(10);
  });

  it("stores what the screen shows, so that it does not change if the segmenter does", async () => {
    const t = await oracleHarness();
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    const [row] = await t.database.db.select().from(reviews).where(eq(reviews.id, review.id));
    const context = row?.context;
    expect(Object.keys(context?.results ?? {}).sort()).toEqual(
      [...review.findings.map((f) => f.ruleId), ...review.results.map((r) => r.ruleId)].sort(),
    );
    expect(context?.results.term?.paragraphText).toContain(
      "are perpetual and shall continue indefinitely",
    );

    // What the API shows comes from the stored context, not from reading the file again.
    const changed = structuredClone(context);
    if (changed === null || changed === undefined) throw new Error("no context");
    const first = changed.results.term?.clauses[0];
    if (first === undefined) throw new Error("no clause");
    first.text = "THE TEXT AS IT WAS STORED";
    await t.database.db.update(reviews).set({ context: changed }).where(eq(reviews.id, review.id));
    const shown = await t.json<ReviewDetail>(`/api/reviews/${review.id}`);
    expect(t.finding(shown.body, "term").clauses[0]?.text).toBe("THE TEXT AS IT WAS STORED");
  });
});

describe("limits on reviews", () => {
  it("allows a document only so many reviews, and counts them per document", async () => {
    const t = await oracleHarness({ config: { maxReviewsPerDocument: 2 } });
    const a = await t.uploadFixture("nda-aggressive.docx");
    const b = await t.uploadFixture("nda-aggressive.docx");

    for (let i = 0; i < 2; i += 1) {
      expect((await t.startReview(a.id, NDA)).status).toBe(202);
    }
    const third = await t.send<ApiError>("POST", "/api/reviews", {
      documentId: a.id,
      playbookId: NDA,
    });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe("too_many_requests");
    expect(third.body.error.message).toContain("2 reviews");
    expect((await rowCounts(t)).reviews).toBe(2);
    // Another document has its own count.
    expect((await t.startReview(b.id, NDA)).status).toBe(202);

    // Deleting a review makes room.
    const list = await t.json<{ reviews: ReviewSummary[] }>("/api/reviews");
    const mine = list.body.reviews.find((r) => r.documentId === a.id);
    await t.waitFor(mine?.id ?? "");
    expect((await t.send("DELETE", `/api/reviews/${mine?.id}`)).status).toBe(204);
    expect((await t.startReview(a.id, NDA)).status).toBe(202);
  });

  it("answers 429 when more reviews wait than the queue holds, and runs the others in order", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator, config: { maxQueued: 2 } });
    const document = await t.uploadFixture("nda-aggressive.docx");

    const first = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(first.body.id, ["running"]);
    const second = await t.startReview(document.id, NDA);
    const third = await t.startReview(document.id, NDA);
    expect([second.status, third.status]).toEqual([202, 202]);
    expect(t.runner.waiting()).toBe(2);

    const fourth = await t.send<ApiError>("POST", "/api/reviews", {
      documentId: document.id,
      playbookId: NDA,
    });
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe("too_many_requests");
    expect(fourth.body.error.message).toContain("waiting");
    expect((await rowCounts(t)).reviews).toBe(3);

    control.release();
    const done = [
      await t.waitFor(first.body.id),
      await t.waitFor(second.body.id),
      await t.waitFor(third.body.id),
    ];
    expect(done.map((r) => r.status)).toEqual(["done", "done", "done"]);
    // One at a time, in the order they were made.
    const starts = done.map((r) => Date.parse(r.startedAt ?? ""));
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    // Room again.
    expect((await t.startReview(document.id, NDA)).status).toBe(202);
  });

  it("holds the room for a review that is being saved, so that a burst cannot pass the cap", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator, config: { maxQueued: 1 } });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const first = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(first.body.id, ["running"]);

    const burst = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.send("POST", "/api/reviews", { documentId: document.id, playbookId: NDA }),
      ),
    );
    expect(burst.filter((r) => r.status === 202)).toHaveLength(1);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(5);
    control.release();
  });

  it("runs as many reviews at once as it is told to", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({
      generator: control.generator,
      config: { reviewConcurrency: 2 },
    });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await t.startReview(document.id, NDA)).body.id);
    await control.calls(2);

    const statuses = async () =>
      (await Promise.all(ids.map((id) => t.json<ReviewDetail>(`/api/reviews/${id}`)))).map(
        (r) => r.body.status,
      );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await statuses()).filter((s) => s === "running").length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await statuses()).sort()).toEqual(["queued", "running", "running"]);
    control.release();
    for (const id of ids) expect((await t.waitFor(id)).status).toBe("done");
  });
});

describe("cancelling and deleting", () => {
  it("cancels a review that is waiting, which then never runs", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const running = await t.startReview(document.id, NDA);
    await control.calls(1);
    const waiting = await t.startReview(document.id, NDA);

    const cancelled = await t.send<ReviewSummary>("POST", `/api/reviews/${waiting.body.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", error: null });
    expect(cancelled.body.finishedAt).not.toBeNull();

    control.release();
    expect((await t.waitFor(running.body.id)).status).toBe("done");
    await t.runner.idle();
    const after = await t.json<ReviewDetail>(`/api/reviews/${waiting.body.id}`);
    expect(after.body.status).toBe("cancelled");
    expect(after.body.startedAt).toBeNull();
    // Only the first review's ten rule checks reached the model.
    expect(control.signals).toHaveLength(10);
  });

  it("aborts the model calls of a review that is running, and goes on to the next", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const first = await t.startReview(document.id, NDA);
    const second = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(first.body.id, ["running"]);
    expect(control.signals.every((signal) => !signal.aborted)).toBe(true);

    const cancelled = await t.send<ReviewSummary>("POST", `/api/reviews/${first.body.id}/cancel`);
    expect(cancelled.body.status).toBe("cancelled");
    // The signal the model call was handed is the review's own.
    expect(control.signals.length).toBeGreaterThan(0);
    expect(control.signals.every((signal) => signal.aborted)).toBe(true);

    // The runner is free again: the next review starts, and is not harmed by the cancel.
    await control.calls(control.signals.length + 1);
    control.release();
    expect((await t.waitFor(second.body.id)).status).toBe("done");
    const stayed = await t.json<ReviewDetail>(`/api/reviews/${first.body.id}`);
    expect(stayed.body.status).toBe("cancelled");
    expect(stayed.body.findings).toEqual([]);
    expect((await rowCounts(t)).findings).toBe(10);
  });

  it("does not turn a review that was cancelled while its last step ran into a result", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const started = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(started.body.id, ["running"]);

    // The row says cancelled, but the model calls were not told: the stop did not reach them.
    await t.database.db
      .update(reviews)
      .set({ status: "cancelled", finishedAt: t.clock.now() })
      .where(eq(reviews.id, started.body.id));
    control.release();
    await t.runner.idle();

    const after = await t.json<ReviewDetail>(`/api/reviews/${started.body.id}`);
    expect(after.body.status).toBe("cancelled");
    expect(after.body.findings).toEqual([]);
    expect(after.body.open).toBeNull();
    expect((await rowCounts(t)).findings).toBe(0);
    const [row] = await t.database.db.select().from(reviews).where(eq(reviews.id, started.body.id));
    expect(row?.report).toBeNull();
  });

  it("refuses to cancel a review that is over, and one that does not exist", async () => {
    const t = await oracleHarness();
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    const over = await t.send<ApiError>("POST", `/api/reviews/${review.id}/cancel`);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("conflict");
    expect((await t.send("POST", `/api/reviews/${UUID}/cancel`)).status).toBe(404);
    expect((await t.send("POST", "/api/reviews/nope/cancel")).status).toBe(404);
    expect((await t.json<ReviewDetail>(`/api/reviews/${review.id}`)).body.status).toBe("done");
  });

  it("deletes a finished or waiting review with its findings, and refuses one that is running", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const running = await t.startReview(document.id, NDA);
    await control.calls(1);
    const waiting = await t.startReview(document.id, NDA);

    const refused = await t.send<ApiError>("DELETE", `/api/reviews/${running.body.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("conflict");

    expect((await t.send("DELETE", `/api/reviews/${waiting.body.id}`)).status).toBe(204);
    expect((await t.send("GET", `/api/reviews/${waiting.body.id}`)).status).toBe(404);

    control.release();
    expect((await t.waitFor(running.body.id)).status).toBe("done");
    await t.runner.idle();
    expect((await rowCounts(t)).findings).toBe(10);
    // The waiting review was taken out of the queue: it never ran.
    expect(control.signals).toHaveLength(10);

    expect((await t.send("DELETE", `/api/reviews/${running.body.id}`)).status).toBe(204);
    expect((await rowCounts(t)).findings).toBe(0);
    expect((await t.send("DELETE", `/api/reviews/${running.body.id}`)).status).toBe(404);
    // The document is still there.
    expect((await t.json<{ documents: unknown[] }>("/api/documents")).body.documents).toHaveLength(
      1,
    );
  });

  it("deletes a document with its reviews, findings and stored file", async () => {
    const t = await oracleHarness();
    const { document } = await t.reviewedFixture("nda-aggressive.docx");
    expect(await rowCounts(t)).toEqual({ reviews: 1, findings: 10, documents: 1 });
    const [row] = await t.database.db.select().from(documents);
    expect(await t.storage.read(row?.storageKey ?? "")).toBeDefined();

    expect((await t.send("DELETE", `/api/documents/${document.id}`)).status).toBe(204);
    expect(await rowCounts(t)).toEqual({ reviews: 0, findings: 0, documents: 0 });
    expect(await t.storage.read(row?.storageKey ?? "")).toBeUndefined();
    expect((await t.send("DELETE", `/api/documents/${document.id}`)).status).toBe(404);
  });

  it("stops the review that is running on a document when the document is deleted", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const running = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(running.body.id, ["running"]);

    expect((await t.send("DELETE", `/api/documents/${document.id}`)).status).toBe(204);
    expect(control.signals.every((signal) => signal.aborted)).toBe(true);
    control.release();
    await t.runner.idle();
    expect(await rowCounts(t)).toEqual({ reviews: 0, findings: 0, documents: 0 });
    expect((await t.send("GET", `/api/reviews/${running.body.id}`)).status).toBe(404);
  });

  it("does not mind that the stored file is already gone when it deletes a document", async () => {
    const t = await oracleHarness();
    const document = await t.uploadFixture("nda-aggressive.docx");
    const [row] = await t.database.db.select().from(documents);
    await rm(join(t.dataDir, "documents", row?.storageKey ?? ""));

    const file = await t.request(`/api/documents/${document.id}/file`);
    expect(file.status).toBe(404);
    expect(((await file.json()) as ApiError).error.message).toContain("missing");
    expect((await t.send("DELETE", `/api/documents/${document.id}`)).status).toBe(204);
    expect((await rowCounts(t)).documents).toBe(0);
  });
});

describe("a review that cannot finish", () => {
  const key = "sk-ant-api03-SECRET-KEY-VALUE";

  it("fails with the advice the command line gives for a rejected key, and the runner goes on", async () => {
    const real = await oracleFor("nda-aggressive.docx");
    let broken = true;
    const flaky = {
      ...real,
      generate: ((request: Parameters<typeof real.generate>[0]) => {
        if (broken) {
          throw new ModelRequestError(
            `401 invalid x-api-key ${key} for the contract text Indemnity`,
            401,
          );
        }
        return real.generate(request);
      }) as typeof real.generate,
    };
    const t = await createHarness({ generator: flaky });
    const document = await t.uploadFixture("nda-aggressive.docx");

    const started = await t.startReview(document.id, NDA);
    const failed = await t.waitFor(started.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("The model provider answered HTTP 401");
    expect(failed.error).toContain("Check the API key: the provider rejected it");
    expect(failed.error).toContain("model: oracle");
    // Nothing from the provider's own text, which can quote the request.
    expect(JSON.stringify(failed)).not.toContain(key);
    expect(JSON.stringify(failed)).not.toContain("Indemnity");
    expect(failed.findings).toEqual([]);
    expect(failed.finishedAt).not.toBeNull();
    expect(t.lines.join("\n")).not.toContain(key);

    // The runner did not crash: with the key fixed, the next review runs.
    broken = false;
    const next = await t.startReview(document.id, NDA);
    expect((await t.waitFor(next.body.id)).status).toBe("done");
    const list = await t.json<{ reviews: ReviewSummary[] }>("/api/reviews");
    expect(list.body.reviews.map((r) => r.status)).toEqual(["done", "failed"]);
  });

  it("words a quota error and a model that cannot be found as the command line does", async () => {
    const billing = await createHarness({
      generator: failingModel(() => new ModelRequestError("credit balance is too low", 402)),
    });
    const doc = await billing.uploadFixture("nda-aggressive.docx");
    const a = await billing.waitFor((await billing.startReview(doc.id, NDA)).body.id);
    expect(a.status).toBe("failed");
    expect(a.error).toContain("Check the account behind the API key");
    expect(a.error).toContain("credit balance");

    const missing = await createHarness({
      generator: failingModel(() => new ModelRequestError("no such model", 404)),
    });
    const doc2 = await missing.uploadFixture("nda-aggressive.docx");
    const b = await missing.waitFor((await missing.startReview(doc2.id, NDA)).body.id);
    expect(b.error).toContain("Check the model name (failing-model)");
  });

  it("leaves the other rules' results alone when the model declines one", async () => {
    const t = await createHarness({
      generator: decliningModel(await oracleFor("nda-aggressive.docx"), new Set(["term"])),
    });
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    expect(review.status).toBe("done");
    expect(review.counts).toMatchObject({ error: 1, deviation: 8, missing: 1 });
    expect(review.findings.map((f) => f.ruleId)).not.toContain("term");
    expect(review.findings).toHaveLength(9);
    const declined = review.results.find((r) => r.ruleId === "term");
    expect(declined).toMatchObject({ status: "error" });
    expect(declined?.error).toContain("The model declined to check this rule");
    expect(review.progress).toEqual({ done: 10, total: 10 });
  });

  it("fails, saying why, when no rule could be checked", async () => {
    const t = await createHarness({
      generator: decliningModel(
        await oracleFor("nda-aggressive.docx"),
        new Set(
          (
            await import("./support.js").then((m) => m.fixture("nda-aggressive.docx"))
          ).playbook.rules.map((r) => r.id),
        ),
      ),
    });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const failed = await t.waitFor((await t.startReview(document.id, NDA)).body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("No rule could be checked, so nothing was reviewed.");
    expect(failed.error).toContain(
      "10 rules: The model declined to check this rule (refusal category: policy).",
    );
    expect(failed.findings).toEqual([]);
    expect((await rowCounts(t)).findings).toBe(0);
  });

  it("fails with the reviewer's own words when the document has no text to review", async () => {
    const t = await oracleHarness();
    const upload = await t.upload("empty.docx", await tinyDocx("Hello."));
    expect(upload.status).toBe(201);
    const { id } = (await upload.json()) as { id: string };
    const failed = await t.waitFor((await t.startReview(id, NDA)).body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("almost no text to review");
  });

  it("fails, without the details, on a mistake of the server's own, and logs only its kind", async () => {
    const t = await oracleHarness();
    const document = await t.uploadFixture("nda-aggressive.docx");
    const original = t.storage.read.bind(t.storage);
    t.storage.read = async () => {
      throw Object.assign(
        new Error("EIO reading /data/documents/secret-contract Indemnity clause"),
        {
          code: "EIO",
        },
      );
    };
    const failed = await t.waitFor((await t.startReview(document.id, NDA)).body.id);
    t.storage.read = original;

    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("unexpected error (Error)");
    expect(failed.error).toContain("bug in Clausewise");
    expect(failed.error).not.toContain("EIO");
    expect(failed.error).not.toContain("Indemnity");
    const logged = t.lines.join("\n");
    expect(logged).toContain('"code":"EIO"');
    expect(logged).not.toContain("Indemnity");
    expect(logged).not.toContain("secret-contract");
  });

  it("fails when the stored file has gone missing", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"), { open: true });
    const t = await createHarness({ generator: control.generator, startRunner: false });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const [row] = await t.database.db.select().from(documents);
    const started = await t.startReview(document.id, NDA);
    await rm(join(t.dataDir, "documents", row?.storageKey ?? ""));
    await t.runner.start();
    const failed = await t.waitFor(started.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("stored file for this document is missing");
    expect(control.signals).toHaveLength(0);
  });

  it("stores what a model wrote even when it holds a character Postgres cannot keep", async () => {
    const inner = await oracleFor("nda-aggressive.docx");
    const t = await createHarness({
      generator: {
        ...inner,
        generate: (async (request: Parameters<typeof inner.generate>[0]) => {
          const answer = (await inner.generate(request)) as { explanation?: string };
          return { ...answer, explanation: `${answer.explanation ?? ""}before\u0000after` };
        }) as typeof inner.generate,
      },
    });
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    expect(review.error).toBeNull();
    expect(review.status).toBe("done");
    expect(review.findings[0]?.explanation).toContain("before\ufffdafter");
  });

  it("stores what a model wrote even when it ends in half of a character outside the basic plane", async () => {
    // A character that takes two units of UTF-16, cut after the first, or begun before the second.
    // The database refuses such text in JSON, and the review must not be lost to it.
    const inner = await oracleFor("nda-aggressive.docx");
    const t = await createHarness({
      generator: {
        ...inner,
        generate: (async (request: Parameters<typeof inner.generate>[0]) => {
          const answer = (await inner.generate(request)) as { explanation?: string };
          return {
            ...answer,
            explanation: `${answer.explanation ?? ""}cut \ud83d | begun \ude00 | whole \u{1F600}`,
          };
        }) as typeof inner.generate,
      },
    });
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    expect(review.error).toBeNull();
    expect(review.status).toBe("done");
    expect(review.findings[0]?.explanation).toContain(
      "cut \ufffd | begun \ufffd | whole \u{1F600}",
    );
  });
});

describe("progress", () => {
  it("shows how many rules have been checked while the review runs", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({
      generator: control.generator,
      config: { progressIntervalMs: 0 },
    });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const started = await t.startReview(document.id, NDA);
    control.allow(3);

    let seen: ReviewDetail | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      seen = (await t.json<ReviewDetail>(`/api/reviews/${started.body.id}`)).body;
      if (seen.progress.done === 3) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seen?.status).toBe("running");
    expect(seen?.progress).toEqual({ done: 3, total: 10 });

    control.release();
    const done = await t.waitFor(started.body.id);
    expect(done.progress).toEqual({ done: 10, total: 10 });
  });
});

describe("after a restart", () => {
  it("fails the review the last process was running, and runs the ones it left waiting", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"), { open: true });
    const t = await createHarness({ generator: control.generator, startRunner: false });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const interrupted = await t.startReview(document.id, NDA);
    const waiting = await t.startReview(document.id, NDA);
    const finished = await t.startReview(document.id, NDA);
    // What the database holds after a crash in the middle of a review.
    await t.database.db
      .update(reviews)
      .set({ status: "running", startedAt: t.clock.now() })
      .where(eq(reviews.id, interrupted.body.id));
    await t.database.db
      .update(reviews)
      .set({ status: "cancelled" })
      .where(eq(reviews.id, finished.body.id));

    await t.runner.start();
    const failed = await t.waitFor(interrupted.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(
      "The server restarted while this review was running. Start it again.",
    );
    expect(failed.finishedAt).not.toBeNull();
    expect((await t.waitFor(waiting.body.id)).status).toBe("done");
    expect((await t.json<ReviewDetail>(`/api/reviews/${finished.body.id}`)).body.status).toBe(
      "cancelled",
    );
    // The interrupted review was not run again: only the waiting one reached the model.
    expect(control.signals).toHaveLength(10);
  });

  it("fails the waiting reviews, with the reason, when the model has not been set up since", async () => {
    const t = await createHarness({
      model: { problem: "ANTHROPIC_API_KEY is required when CLAUSEWISE_PROVIDER is anthropic." },
      startRunner: false,
    });
    const document = await t.uploadFixture("nda-aggressive.docx");
    // A review made while a model was set up, as it would be before the settings changed.
    await t.database.db.insert(reviews).values({
      id: UUID,
      documentId: document.id,
      playbookId: NDA,
      playbookName: "Mutual NDA (receiving party)",
      playbookYaml: await builtinYaml(),
      status: "queued",
      progressDone: 0,
      progressTotal: 10,
      createdAt: t.clock.now(),
    });
    await t.runner.start();
    const failed = await t.waitFor(UUID);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("The model is not configured");
    expect(failed.error).toContain("ANTHROPIC_API_KEY is required");
  });

  it("marks the reviews that are running as cancelled when the runner is stopped, and leaves the waiting ones", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const running = await t.startReview(document.id, NDA);
    const waiting = await t.startReview(document.id, NDA);
    await control.calls(1);
    await t.waitFor(running.body.id, ["running"]);

    await t.runner.stop();
    expect(control.signals.every((signal) => signal.aborted)).toBe(true);
    expect((await t.json<ReviewDetail>(`/api/reviews/${running.body.id}`)).body.status).toBe(
      "cancelled",
    );
    expect((await t.json<ReviewDetail>(`/api/reviews/${waiting.body.id}`)).body.status).toBe(
      "queued",
    );
    expect((await t.json<ReviewDetail>(`/api/reviews/${running.body.id}`)).body.findings).toEqual(
      [],
    );
  });
});

describe("reading what is not there", () => {
  it("answers 404 for a review or document that does not exist, or whose id is not one", async () => {
    const t = await oracleHarness();
    for (const path of [
      `/api/reviews/${UUID}`,
      "/api/reviews/not-a-uuid",
      `/api/reviews/${UUID}/report`,
      `/api/documents/${UUID}/file`,
      "/api/documents/not-a-uuid/file",
    ]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe("not_found");
    }
    expect((await t.send("DELETE", `/api/documents/${UUID}`)).status).toBe(404);
    expect(
      (await t.send("PATCH", `/api/reviews/${UUID}/findings/term`, { decision: "accepted" }))
        .status,
    ).toBe(404);
  });

  it("answers 409 for a decision or a report on a review that has not finished", async () => {
    const control = controllable(await oracleFor("nda-aggressive.docx"));
    const t = await createHarness({ generator: control.generator });
    const document = await t.uploadFixture("nda-aggressive.docx");
    const started = await t.startReview(document.id, NDA);
    await control.calls(1);

    const decision = await t.send<ApiError>(
      "PATCH",
      `/api/reviews/${started.body.id}/findings/term`,
      { decision: "accepted" },
    );
    expect(decision.status).toBe(409);
    const bulk = await t.send("PATCH", `/api/reviews/${started.body.id}/findings`, {
      decision: "accepted",
    });
    expect(bulk.status).toBe(409);
    const report = await t.request(`/api/reviews/${started.body.id}/report`);
    expect(report.status).toBe(409);
    control.release();
    await t.waitFor(started.body.id);
  });
});

describe("the files of a review", () => {
  it("serves the original file byte for byte", async () => {
    const t = await oracleHarness();
    const { document } = await t.reviewedFixture("nda-aggressive.docx");
    const file = await t.request(`/api/documents/${document.id}/file`);
    expect(
      Buffer.compare(
        new Uint8Array(await file.arrayBuffer()),
        await fixtureBytes("nda-aggressive.docx"),
      ),
    ).toBe(0);
  });
});
