import { describe, expect, it } from "vitest";
import {
  STORAGE_API_VERSION,
  StorageError,
  azureBlobStore,
  azureStorageQueue,
  normalizeEndpoint,
} from "../src/index.js";

const TOKEN = "eyJ0eXAiOiJKV1QifQ.storage-token-that-must-not-leak";
const tokens = { token: async () => TOKEN };
const BLOBS = "https://contosolegal.blob.core.windows.net/";
const QUEUES = "https://contosoqueue.queue.core.windows.net/";

interface Sent {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array | string | undefined;
  redirect: RequestRedirect | undefined;
}

function scripted(answer: (sent: Sent, call: number) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const request: Sent = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: init?.body as Uint8Array | string | undefined,
      redirect: init?.redirect,
    };
    sent.push(request);
    return answer(request, sent.length);
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const azureError = (status: number, code: string) =>
  new Response(`<Error><Code>${code}</Code><Message>${TOKEN}</Message></Error>`, {
    status,
    headers: { "x-ms-error-code": code },
  });

async function storageError(promise: Promise<unknown>): Promise<StorageError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(StorageError);
  expect((error as Error).message).not.toContain(TOKEN);
  return error as StorageError;
}

describe("normalizeEndpoint", () => {
  it("writes an endpoint with one trailing slash", () => {
    expect(normalizeEndpoint("https://contosolegal.blob.core.windows.net", "x")).toBe(BLOBS);
    expect(normalizeEndpoint(BLOBS, "x")).toBe(BLOBS);
  });

  it.each([
    ["http://contosolegal.blob.core.windows.net/", /https/],
    ["https://contosolegal.blob.core.windows.net/?sv=2023&sig=abc", /query/],
    ["https://user:pass@contosolegal.blob.core.windows.net/", /credentials/],
    ["not a url", /not a valid URL/],
  ])("refuses %j", (raw, reason) => {
    expect(() => normalizeEndpoint(raw, "The blob endpoint")).toThrow(reason);
  });
});

describe("azureBlobStore", () => {
  it("stores a file as a block blob, signed in with the identity's token", async () => {
    const { fetch, sent } = scripted(() => new Response(null, { status: 201 }));
    const store = azureBlobStore({ endpoint: BLOBS, container: "contracts", tokens, fetch });
    const data = new Uint8Array([0x50, 0x4b, 3, 4]);
    await store.put("review-1/contract.docx", data);
    const [request] = sent;
    expect(request?.method).toBe("PUT");
    expect(request?.url.href).toBe(`${BLOBS}contracts/review-1/contract.docx`);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get("x-ms-version")).toBe(STORAGE_API_VERSION);
    expect(request?.headers.get("x-ms-blob-type")).toBe("BlockBlob");
    expect(request?.headers.get("x-ms-date")).toMatch(/GMT$/);
    expect(request?.body).toBe(data);
    expect(request?.redirect).toBe("manual");
  });

  it("encodes each part of a key but keeps its slashes", async () => {
    const { fetch, sent } = scripted(() => new Response(null, { status: 201 }));
    const store = azureBlobStore({ endpoint: BLOBS, container: "results", tokens, fetch });
    await store.put("a b/c#d?.docx", new Uint8Array());
    expect(sent[0]?.url.pathname).toBe("/results/a%20b/c%23d%3F.docx");
  });

  it("reads a file back", async () => {
    const { fetch } = scripted(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const store = azureBlobStore({ endpoint: BLOBS, container: "contracts", tokens, fetch });
    expect(await store.get("review-1/contract.docx")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("says a missing blob is not there, but a missing container is a broken deployment", async () => {
    const missingBlob = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: scripted(() => azureError(404, "BlobNotFound")).fetch,
    });
    expect(await missingBlob.get("review-1/contract.docx")).toBeUndefined();

    const missingContainer = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: scripted(() => azureError(404, "ContainerNotFound")).fetch,
    });
    const error = await storageError(missingContainer.get("review-1/contract.docx"));
    expect(error.code).toBe("ContainerNotFound");
  });

  it("reports a refusal with its status and code, and nothing from the body", async () => {
    const store = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: scripted(() => azureError(403, "AuthorizationPermissionMismatch")).fetch,
    });
    const error = await storageError(store.put("review-1/contract.docx", new Uint8Array()));
    expect(error.message).toBe(
      "Storing a file failed with HTTP 403 (AuthorizationPermissionMismatch).",
    );
  });

  it("does not repeat an error code that is not a plain identifier", async () => {
    const store = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: scripted(() => azureError(500, `${TOKEN} injected`)).fetch,
    });
    const error = await storageError(store.get("k"));
    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Reading a file failed with HTTP 500.");
  });

  it("refuses to follow a redirect", async () => {
    const store = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: scripted(
        () =>
          new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } }),
      ).fetch,
    });
    expect((await storageError(store.get("k"))).status).toBe(307);
  });

  it("does not repeat the cause of a connection failure", async () => {
    const store = azureBlobStore({
      endpoint: BLOBS,
      container: "contracts",
      tokens,
      fetch: (async () => {
        throw new TypeError("getaddrinfo ENOTFOUND 10.1.2.3");
      }) as typeof globalThis.fetch,
    });
    const error = await storageError(store.get("k"));
    expect(error.message).toBe(
      "Reading a file failed: Azure Storage could not be reached (TypeError).",
    );
  });

  it.each(["Contracts", "ab", "a--b", "-contracts", "con_tracts"])(
    "refuses the container name %j",
    (container) => {
      expect(() => azureBlobStore({ endpoint: BLOBS, container, tokens })).toThrow(
        /container name/,
      );
    },
  );
});

const messageList = (messages: { id: string; pop: string; count: number; text: string }[]) =>
  new Response(
    `<?xml version="1.0" encoding="utf-8"?><QueueMessagesList>${messages
      .map(
        (m) =>
          `<QueueMessage><MessageId>${m.id}</MessageId><InsertionTime>Mon, 09 Nov 2026 10:00:00 GMT</InsertionTime><ExpirationTime>Fri, 31 Dec 9999 23:59:59 GMT</ExpirationTime><PopReceipt>${m.pop}</PopReceipt><TimeNextVisible>Mon, 09 Nov 2026 10:10:00 GMT</TimeNextVisible><DequeueCount>${m.count}</DequeueCount><MessageText>${m.text}</MessageText></QueueMessage>`,
      )
      .join("")}</QueueMessagesList>`,
    { status: 200, headers: { "content-type": "application/xml" } },
  );

const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

describe("azureStorageQueue", () => {
  it("queues a job as base64 JSON that never expires", async () => {
    const { fetch, sent } = scripted(() => new Response(null, { status: 201 }));
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    await queue.send({ reviewId: "review-1" });
    const [request] = sent;
    expect(request?.method).toBe("POST");
    expect(request?.url.href).toBe(`${QUEUES}reviews/messages?messagettl=-1`);
    expect(request?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request?.body).toBe(
      `<?xml version="1.0" encoding="utf-8"?><QueueMessage><MessageText>${encoded({ reviewId: "review-1" })}</MessageText></QueueMessage>`,
    );
  });

  it("takes one job, hidden from other workers while it runs", async () => {
    const { fetch, sent } = scripted(() =>
      messageList([
        { id: "m-1", pop: "pop/1+=", count: 3, text: encoded({ reviewId: "review-1" }) },
      ]),
    );
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    const delivery = await queue.receive();
    expect(sent[0]?.url.href).toBe(
      `${QUEUES}reviews/messages?numofmessages=1&visibilitytimeout=600`,
    );
    expect(delivery?.job).toEqual({ reviewId: "review-1" });
    expect(delivery?.attempt).toBe(3);
  });

  it("completes a job by deleting it, and releases one by hiding it for a while", async () => {
    const { fetch, sent } = scripted((request) =>
      request.method === "GET"
        ? messageList([{ id: "m-1", pop: "pop/1+=", count: 1, text: encoded({ reviewId: "r1" }) }])
        : new Response(null, { status: 204 }),
    );
    const queue = azureStorageQueue({
      endpoint: QUEUES,
      queue: "reviews",
      tokens,
      fetch,
      retryDelaySeconds: 45,
    });
    const delivery = await queue.receive();
    await delivery?.release();
    await delivery?.complete();
    expect(sent[1]?.method).toBe("PUT");
    expect(sent[1]?.url.href).toBe(
      `${QUEUES}reviews/messages/m-1?popreceipt=pop%2F1%2B%3D&visibilitytimeout=45`,
    );
    expect(sent[2]?.method).toBe("DELETE");
    expect(sent[2]?.url.href).toBe(`${QUEUES}reviews/messages/m-1?popreceipt=pop%2F1%2B%3D`);
  });

  it("treats a job that is already gone as done", async () => {
    const { fetch } = scripted((request) =>
      request.method === "GET"
        ? messageList([{ id: "m-1", pop: "p", count: 1, text: encoded({ reviewId: "r1" }) }])
        : azureError(404, "MessageNotFound"),
    );
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    const delivery = await queue.receive();
    await expect(delivery?.complete()).resolves.toBeUndefined();
    await expect(delivery?.release()).resolves.toBeUndefined();
  });

  it("has nothing to hand over when the queue is empty", async () => {
    const { fetch } = scripted(() => messageList([]));
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    expect(await queue.receive()).toBeUndefined();
  });

  it.each([
    ["text that is not base64 JSON", "%%%not-json%%%"],
    ["JSON without a review id", encoded({ something: "else" })],
    ["a review id that is not an id", encoded({ reviewId: "../../etc/passwd" })],
  ])("removes a message holding %s, which nothing could ever handle", async (_label, text) => {
    let invalid = 0;
    const { fetch, sent } = scripted((request) =>
      request.method === "GET"
        ? messageList([{ id: "m-9", pop: "p", count: 1, text }])
        : new Response(null, { status: 204 }),
    );
    const queue = azureStorageQueue({
      endpoint: QUEUES,
      queue: "reviews",
      tokens,
      fetch,
      onInvalid: () => (invalid += 1),
    });
    expect(await queue.receive()).toBeUndefined();
    expect(sent[1]?.method).toBe("DELETE");
    expect(invalid).toBe(1);
  });

  it("reports an answer that is not XML without repeating it", async () => {
    const { fetch } = scripted(
      () => new Response(`<QueueMessagesList><broken ${TOKEN}`, { status: 200 }),
    );
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    const error = await storageError(queue.receive());
    expect(error.message).toBe("Azure Storage answered with invalid XML.");
  });

  it("reports a refusal to take jobs with its status and code", async () => {
    const { fetch } = scripted(() => azureError(403, "AuthorizationPermissionMismatch"));
    const queue = azureStorageQueue({ endpoint: QUEUES, queue: "reviews", tokens, fetch });
    expect((await storageError(queue.receive())).code).toBe("AuthorizationPermissionMismatch");
  });

  it.each(["Reviews", "re", "re--views"])("refuses the queue name %j", (name) => {
    expect(() => azureStorageQueue({ endpoint: QUEUES, queue: name, tokens })).toThrow(
      /queue name/,
    );
  });
});
