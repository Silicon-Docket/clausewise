import { request as httpRequest, type ClientRequest } from "node:http";
import type {
  ApiError,
  DocumentListResponse,
  DocumentSummary,
  ReviewListResponse,
} from "@clausewise/api";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { documents, reviews } from "../src/db/schema.js";
import { silentLogger } from "../src/log.js";
import { MAX_UPLOADS_IN_FLIGHT } from "../src/routes/documents.js";
import { startServer } from "../src/start.js";
import {
  createHarness,
  fixtureBytes,
  later,
  oracleFor,
  tempDir,
  testConfig,
  type Harness,
} from "./support.js";

const FORM = { "Content-Type": "multipart/form-data; boundary=xyz" };

/** A POST whose body arrives as a stream, which Node's fetch wants to be told is one-way. */
function streamed(body: ReadableStream<Uint8Array>): RequestInit & { duplex: "half" } {
  return { method: "POST", headers: FORM, body, duplex: "half" };
}

/**
 * An upload that has begun and has not finished: the body gives out nothing until the test lets it
 * end or breaks it. `started` resolves when the server first asks it for a byte, which it does
 * only after it has taken a place for the upload.
 */
function stalledUpload() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(c) {
        controller = c;
      },
      pull() {
        begin();
      },
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    started,
    end: () => controller?.close(),
    breakOff: () => controller?.error(new Error("connection lost")),
  };
}

type Request = (path: string, init?: RequestInit) => Promise<Response> | Response;

/**
 * Starts MAX uploads that stall, and says whether the server took all of them. If any one is
 * refused the server answers it at once, which shows as a response before they all started.
 * Afterwards the uploads are let go.
 */
async function serverTakesAllPlaces(request: Request): Promise<string> {
  const held = Array.from({ length: MAX_UPLOADS_IN_FLIGHT }, () => stalledUpload());
  const pending = held.map((upload) =>
    Promise.resolve(request("/api/documents", streamed(upload.stream))),
  );
  const outcome = await Promise.race([
    Promise.all(held.map((upload) => upload.started)).then(() => "all taken"),
    Promise.race(pending).then((response) => `one was refused with ${response.status}`),
  ]);
  for (const upload of held) upload.end();
  await Promise.all(pending);
  return outcome;
}

describe("uploads in flight", () => {
  it("takes four at once and tells the fifth to try again, then takes uploads again when they end", async () => {
    const t = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    const docx = await fixtureBytes("nda-aggressive.docx");
    const held = Array.from({ length: MAX_UPLOADS_IN_FLIGHT }, () => stalledUpload());
    const pending = held.map((upload) => t.request("/api/documents", streamed(upload.stream)));
    await Promise.all(held.map((upload) => upload.started));

    const fifth = await t.upload("nda.docx", docx);
    expect(fifth.status).toBe(429);
    const error = ((await fifth.json()) as ApiError).error;
    expect(error.code).toBe("too_many_requests");
    expect(error.message).toContain("4 documents are being uploaded already");
    expect(error.message).toContain("try again");
    expect(fifth.headers.get("retry-after")).toBe("5");
    // The refused request's body is not read, so the connection is not kept for it.
    expect(fifth.headers.get("connection")).toBe("close");
    expect(fifth.headers.get("cache-control")).toBe("no-store");
    // Nothing was stored for it.
    expect(
      ((await (await t.request("/api/documents")).json()) as DocumentListResponse).documents,
    ).toEqual([]);

    for (const upload of held) upload.end();
    // Their bodies held no form, so each of them ends as a bad request, and not one is lost.
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([
      400, 400, 400, 400,
    ]);

    const next = await t.upload("nda.docx", docx);
    expect(next.status).toBe(201);
  });

  it("answers other kinds of request while the places are taken", async () => {
    const t = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    const held = Array.from({ length: MAX_UPLOADS_IN_FLIGHT }, () => stalledUpload());
    const pending = held.map((upload) => t.request("/api/documents", streamed(upload.stream)));
    await Promise.all(held.map((upload) => upload.started));
    expect((await t.request("/api/documents")).status).toBe(200);
    expect((await t.request("/api/reviews")).status).toBe(200);
    expect((await t.request("/healthz")).status).toBe(200);
    for (const upload of held) upload.end();
    await Promise.all(pending);
  });

  it("does not count a request that is refused before the body is read", async () => {
    const t = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    // Wrong content type: 415, and the place was never taken.
    for (let i = 0; i < 2 * MAX_UPLOADS_IN_FLIGHT; i += 1) {
      const wrong = await t.request("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(wrong.status).toBe(415);
    }
    expect(await serverTakesAllPlaces(t.request)).toBe("all taken");
  });

  describe("gives the place back on every way out", () => {
    interface Exit {
      name: string;
      status: number;
      /** The app the request goes to, when it is not the harness's own. */
      app?: (t: Harness) => Request;
      send: (request: Request, t: Harness) => Promise<number>;
    }

    const upload = (request: Request, name: string, bytes: Uint8Array<ArrayBuffer>) =>
      Promise.resolve(request("/api/documents", uploadInit(bytes, name)));

    const exits: Exit[] = [
      {
        name: "a stored document",
        status: 201,
        send: async (request) =>
          (await upload(request, "nda.docx", await fixtureBytes("nda-aggressive.docx"))).status,
      },
      {
        name: "a form that cannot be read",
        status: 400,
        send: async (request) =>
          (
            await request("/api/documents", {
              method: "POST",
              headers: FORM,
              body: "this is not a form",
            })
          ).status,
      },
      {
        name: "a form with no file in it",
        status: 400,
        send: async (request) => {
          const form = new FormData();
          form.set("other", "text");
          return (await request("/api/documents", { method: "POST", body: form })).status;
        },
      },
      {
        name: "a file that is not a Word file",
        status: 422,
        send: async (request) =>
          (await upload(request, "a.docx", new TextEncoder().encode("plain text"))).status,
      },
      {
        name: "a file over the cap",
        status: 413,
        send: async (request, t) =>
          (await upload(request, "a.docx", new Uint8Array(t.config.maxUploadBytes + 1))).status,
      },
      {
        name: "a body that never ends",
        status: 413,
        send: async (request) => {
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
            },
          });
          return (await request("/api/documents", streamed(body))).status;
        },
      },
      {
        name: "a client that went away in the middle",
        status: 400,
        send: async (request) => {
          const stalled = stalledUpload();
          const answer = Promise.resolve(request("/api/documents", streamed(stalled.stream)));
          await stalled.started;
          stalled.breakOff();
          return (await answer).status;
        },
      },
      {
        name: "a failure of the server's own",
        status: 500,
        // The app is built once, because the places are counted per app.
        app: (t) => {
          const broken = createApp({
            ...t.deps,
            storage: {
              ...t.storage,
              write: async () => {
                throw new Error("the disk is full");
              },
            },
          });
          return (path, init) => broken.request(path, init);
        },
        send: async (request) =>
          (await upload(request, "nda.docx", await fixtureBytes("nda-aggressive.docx"))).status,
      },
    ];

    it.each(exits.map((exit, i) => [exit.name, i] as const))("after %s", async (_name, i) => {
      const t = await createHarness({
        generator: await oracleFor("nda-aggressive.docx"),
        config: { maxUploadBytes: 256 * 1024 },
      });
      const exit = exits[i];
      if (exit === undefined) throw new Error("no such exit");
      const request = exit.app?.(t) ?? t.request;
      // More times than there are places: a place lost on every request would show before the end.
      for (let round = 0; round < MAX_UPLOADS_IN_FLIGHT + 1; round += 1) {
        expect(await exit.send(request, t)).toBe(exit.status);
      }
      expect(await serverTakesAllPlaces(request)).toBe("all taken");
    });
  });
});

function uploadInit(bytes: Uint8Array<ArrayBuffer>, name = "nda.docx"): RequestInit {
  const form = new FormData();
  form.set("file", new File([bytes], name));
  return { method: "POST", body: form };
}

describe("uploads in flight, over a real connection", () => {
  const garbage = (): RequestInit => uploadInit(new TextEncoder().encode("not a Word file"));

  it("frees the place of a client that disconnects in the middle of its upload", async () => {
    const dataDir = await tempDir();
    const server = await startServer({
      config: testConfig(dataDir),
      generator: await oracleFor("nda-aggressive.docx"),
      log: silentLogger,
      database: { kind: "memory" },
    });
    later(() => server.close());

    const open: ClientRequest[] = [];
    for (let i = 0; i < MAX_UPLOADS_IN_FLIGHT; i += 1) {
      const outgoing = httpRequest(`${server.url}/api/documents`, {
        method: "POST",
        headers: { ...FORM, "Content-Length": String(1024 * 1024) },
      });
      outgoing.on("error", () => {});
      // Some of the body, and then silence: the upload is under way and not finished.
      outgoing.write(Buffer.alloc(16 * 1024, 0x61));
      open.push(outgoing);
    }
    later(async () => {
      for (const outgoing of open) outgoing.destroy();
    });

    const statusOfProbe = async (): Promise<number> =>
      (await fetch(`${server.url}/api/documents`, garbage())).status;
    const until = async (status: number): Promise<void> => {
      const seen: number[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const got = await statusOfProbe();
        seen.push(got);
        if (got === status) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(
        `The server never answered ${status}; it answered ${seen.slice(-5).join(", ")}.`,
      );
    };

    // All four places are taken: a probe is told to wait. (Before the four arrive it is read, and
    // refused as the garbage it is, which is why it is polled.)
    await until(429);
    open[0]?.destroy();
    // One place is free again: the probe is read and refused for what it is, not for being too many.
    await until(422);
    // And only one: the other three still hold theirs.
    const [first, second] = [await statusOfProbe(), await statusOfProbe()];
    expect([first, second]).toEqual([422, 422]);
    for (const outgoing of open.slice(1)) outgoing.destroy();
    await until(422);
  });
});

describe("the length of a list", () => {
  async function seed(t: Harness, count: number): Promise<{ ids: string[]; names: string[] }> {
    const base = Date.parse("2026-01-01T00:00:00Z");
    const rows = Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      name: `contract-${String(i + 1).padStart(3, "0")}.docx`,
      at: new Date(base + i * 1000),
    }));
    await t.database.db.insert(documents).values(
      rows.map((row) => ({
        id: row.id,
        fileName: row.name,
        size: 1,
        sha256: "0".repeat(64),
        storageKey: row.id,
        paragraphs: 1,
        createdAt: row.at,
      })),
    );
    await t.database.db.insert(reviews).values(
      rows.map((row) => ({
        id: row.id.replace("-8000-", "-8001-"),
        documentId: row.id,
        playbookName: "Playbook",
        playbookYaml: "name: x",
        status: "failed" as const,
        error: "x",
        createdAt: row.at,
      })),
    );
    return { ids: rows.map((row) => row.id), names: rows.map((row) => row.name) };
  }

  it("answers the newest 100 of a longer list when no limit is given, newest first", async () => {
    const t = await createHarness({});
    const { names } = await seed(t, 130);
    const newestFirst = [...names].reverse();

    const docs = (await t.json<DocumentListResponse>("/api/documents")).body.documents;
    expect(docs.map((d) => d.fileName)).toEqual(newestFirst.slice(0, 100));
    const revs = (await t.json<ReviewListResponse>("/api/reviews")).body.reviews;
    expect(revs.map((r) => r.documentName)).toEqual(newestFirst.slice(0, 100));
    // A document still counts every one of its reviews.
    expect(docs.every((d: DocumentSummary) => d.reviewCount === 1)).toBe(true);
  });

  it("answers as many as were asked for, the newest ones, up to 500", async () => {
    const t = await createHarness({});
    const { names } = await seed(t, 130);
    const newestFirst = [...names].reverse();
    for (const limit of [1, 3, 100, 130, 500]) {
      const docs = (await t.json<DocumentListResponse>(`/api/documents?limit=${limit}`)).body;
      expect(
        docs.documents.map((d) => d.fileName),
        `documents, limit ${limit}`,
      ).toEqual(newestFirst.slice(0, limit));
      const revs = (await t.json<ReviewListResponse>(`/api/reviews?limit=${limit}`)).body;
      expect(
        revs.reviews.map((r) => r.documentName),
        `reviews, limit ${limit}`,
      ).toEqual(newestFirst.slice(0, limit));
    }
  });

  it("breaks a tie in time by id, so that the order never changes between two calls", async () => {
    const t = await createHarness({});
    const at = new Date("2026-02-02T00:00:00Z");
    const ids = [3, 1, 2].map((n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
    await t.database.db.insert(documents).values(
      ids.map((id) => ({
        id,
        fileName: `${id.slice(-1)}.docx`,
        size: 1,
        sha256: "0".repeat(64),
        storageKey: id,
        paragraphs: 1,
        createdAt: at,
      })),
    );
    const docs = (await t.json<DocumentListResponse>("/api/documents?limit=2")).body.documents;
    expect(docs.map((d) => d.fileName)).toEqual(["3.docx", "2.docx"]);
  });

  it("refuses a limit that is not a whole number from 1 to 500, in words, on both lists", async () => {
    const t = await createHarness({});
    const bad = [
      "0",
      "-1",
      "501",
      "1000000",
      "abc",
      "1.5",
      "1e2",
      "0x10",
      "",
      "%205",
      "5%20",
      "+5",
      "99999999999999999999",
    ];
    for (const path of ["/api/documents", "/api/reviews"]) {
      for (const limit of bad) {
        const answer = await t.json<ApiError>(`${path}?limit=${limit}`);
        expect([path, limit, answer.status]).toEqual([path, limit, 400]);
        expect(answer.body.error.code).toBe("bad_request");
        expect(answer.body.error.message).toBe("limit must be a whole number from 1 to 500.");
      }
    }
    // A repeated limit is the first one, and leading zeros are only zeros.
    expect((await t.json("/api/documents?limit=2&limit=abc")).status).toBe(200);
    expect((await t.json("/api/reviews?limit=007")).status).toBe(200);
  });
});
