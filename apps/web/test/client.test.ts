// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  createApiClient,
  errorMessage,
  fileNameFromDisposition,
  isAbortError,
  paths,
} from "../src/api/client.js";

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that records what it was given and answers with the next response in the list. */
function script(...responses: Array<Response | Error | DOMException>) {
  const sent: Sent[] = [];
  let index = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    // Anything that is not a response is thrown, as a fetch that failed would throw it.
    if (!(next instanceof Response)) throw next;
    return next;
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, mock: fetch };
}

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const failure = (status: number, code: string, message: string, extra: object = {}): Response =>
  ok({ error: { code, message, ...extra } }, status);

const headersOf = (sent: Sent): Record<string, string> => ({
  ...(sent.init.headers as Record<string, string>),
});

describe("requests", () => {
  it("send the bearer token that is held at the moment of the request", async () => {
    const s = script(ok({ playbooks: [] }), ok({ playbooks: [] }));
    let token: string | null = null;
    const client = createApiClient({ fetch: s.fetch, getToken: () => token });
    await client.listPlaybooks();
    token = "secret-token-value";
    await client.listPlaybooks();
    expect(headersOf(s.sent[0]!)["Authorization"]).toBeUndefined();
    expect(headersOf(s.sent[1]!)["Authorization"]).toBe("Bearer secret-token-value");
  });

  it("ask for JSON, send no cookies and let nothing be cached", async () => {
    const s = script(ok({ playbooks: [] }));
    await createApiClient({ fetch: s.fetch }).listPlaybooks();
    const sent = s.sent[0]!;
    expect(headersOf(sent)["Accept"]).toBe("application/json");
    expect(sent.init.credentials).toBe("omit");
    expect(sent.init.cache).toBe("no-store");
    expect(sent.init.method).toBe("GET");
    expect(sent.url).toBe("/api/playbooks");
  });

  it("send a JSON body with its content type", async () => {
    const s = script(ok({ id: "r1" }, 202));
    await createApiClient({ fetch: s.fetch }).createReview({
      documentId: "d1",
      playbookId: "builtin:nda-mutual",
      client: "Acme Ltd, the Recipient",
    });
    const sent = s.sent[0]!;
    expect(sent.url).toBe("/api/reviews");
    expect(sent.init.method).toBe("POST");
    expect(headersOf(sent)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(sent.init.body))).toEqual({
      documentId: "d1",
      playbookId: "builtin:nda-mutual",
      client: "Acme Ltd, the Recipient",
    });
  });

  it("upload a file as a form with one field called file, and leave the content type to the browser", async () => {
    const s = script(ok({ id: "d1" }, 201));
    const file = new File(["bytes"], "Acme NDA.docx");
    await createApiClient({ fetch: s.fetch }).uploadDocument(file);
    const sent = s.sent[0]!;
    expect(sent.init.method).toBe("POST");
    expect(sent.init.body).toBeInstanceOf(FormData);
    const sentFile = (sent.init.body as FormData).get("file") as File;
    expect(sentFile.name).toBe("Acme NDA.docx");
    expect([...(sent.init.body as FormData).keys()]).toEqual(["file"]);
    expect(headersOf(sent)["Content-Type"]).toBeUndefined();
  });

  it("use the method and address of each route in the contract", async () => {
    const s = script(
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
      ok({}),
    );
    const api = createApiClient({ fetch: s.fetch });
    await api.getConfig();
    await api.getPlaybook("builtin:nda-mutual");
    await api.validatePlaybook("name: x");
    await api.createPlaybook("name: x");
    await api.updatePlaybook("abc", "name: y");
    await api.getReview("r 1");
    await api.cancelReview("r1");
    await api.patchFinding("r1", "term", { decision: "accepted" });
    await api.bulkDecision("r1", { decision: "rejected", severities: ["low"] });
    await api.listDocuments();
    expect(s.sent.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      "GET /api/config",
      "GET /api/playbooks/builtin%3Anda-mutual",
      "POST /api/playbooks/validate",
      "POST /api/playbooks",
      "PUT /api/playbooks/abc",
      "GET /api/reviews/r%201",
      "POST /api/reviews/r1/cancel",
      "PATCH /api/reviews/r1/findings/term",
      "PATCH /api/reviews/r1/findings",
      "GET /api/documents",
    ]);
    expect(JSON.parse(String(s.sent[7]?.init.body))).toEqual({ decision: "accepted" });
    expect(JSON.parse(String(s.sent[8]?.init.body))).toEqual({
      decision: "rejected",
      severities: ["low"],
    });
  });

  it("send deletes and expect no body back", async () => {
    const s = script(
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    );
    const api = createApiClient({ fetch: s.fetch });
    await expect(api.deletePlaybook("abc")).resolves.toBeUndefined();
    await expect(api.deleteReview("r1")).resolves.toBeUndefined();
    await expect(api.deleteDocument("d1")).resolves.toBeUndefined();
    expect(s.sent.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      "DELETE /api/playbooks/abc",
      "DELETE /api/reviews/r1",
      "DELETE /api/documents/d1",
    ]);
  });

  it("put the base address in front when one is given", async () => {
    const s = script(ok({ playbooks: [] }));
    await createApiClient({ fetch: s.fetch, baseUrl: "http://127.0.0.1:8787" }).listPlaybooks();
    expect(s.sent[0]?.url).toBe("http://127.0.0.1:8787/api/playbooks");
  });

  it("pass an abort signal on, and let the abort error through unchanged", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const s = script(abort);
    const controller = new AbortController();
    const client = createApiClient({ fetch: s.fetch });
    const attempt = client.getReview("r1", controller.signal);
    await expect(attempt).rejects.toBe(abort);
    expect(isAbortError(abort)).toBe(true);
    expect(s.sent[0]?.init.signal).toBe(controller.signal);
  });
});

describe("no retries", () => {
  it("sends a POST once even when the server fails, so that a review is never started twice", async () => {
    const s = script(failure(500, "internal_error", "Down."), ok({ id: "r1" }, 202));
    const client = createApiClient({ fetch: s.fetch });
    await expect(client.createReview({ documentId: "d", playbookId: "p" })).rejects.toBeInstanceOf(
      ApiClientError,
    );
    expect(s.mock).toHaveBeenCalledTimes(1);
  });

  it("sends a POST once when the connection fails", async () => {
    const s = script(new TypeError("Failed to fetch"), ok({ id: "r1" }, 202));
    const client = createApiClient({ fetch: s.fetch });
    await expect(client.uploadDocument(new File(["x"], "a.docx"))).rejects.toMatchObject({
      code: "network",
    });
    expect(s.mock).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  it("carry the server's message, code, status and request id", async () => {
    const s = script(
      failure(422, "invalid_document", "This file is password protected.", { requestId: "req-1" }),
    );
    const error = await createApiClient({ fetch: s.fetch })
      .uploadDocument(new File(["x"], "a.docx"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 422,
      code: "invalid_document",
      message: "This file is password protected.",
      requestId: "req-1",
    });
    expect(errorMessage(error)).toBe("This file is password protected.");
  });

  it("map a failure that has no readable body to a message for a person", async () => {
    const cases: Array<[number, string, RegExp]> = [
      [502, "internal_error", /The server had a problem \(status 502\)/],
      [404, "not_found", /nothing at this address/],
      [413, "payload_too_large", /larger than the server accepts/],
      [429, "too_many_requests", /busy/],
      [418, "unexpected_response", /status 418/],
    ];
    for (const [status, code, message] of cases) {
      const s = script(new Response("<html>Bad gateway</html>", { status }));
      const error = await createApiClient({ fetch: s.fetch })
        .getConfig()
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ status, code });
      expect((error as ApiClientError).message).toMatch(message);
      // Whatever page the proxy sent is not shown.
      expect((error as ApiClientError).message).not.toContain("Bad gateway");
    }
  });

  it("use the status to name the code when the body names none that is known", async () => {
    const s = script(failure(409, "something_new", "The review has ended."));
    const error = await createApiClient({ fetch: s.fetch })
      .cancelReview("r1")
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      status: 409,
      code: "conflict",
      message: "The review has ended.",
    });
  });

  it("say the server could not be reached when the request never got an answer", async () => {
    const s = script(new TypeError("Failed to fetch"));
    const error = await createApiClient({ fetch: s.fetch })
      .getConfig()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 0, code: "network" });
    expect((error as ApiClientError).message).toMatch(/could not be reached/);
    // The browser's own wording is not passed on.
    expect((error as ApiClientError).message).not.toContain("Failed to fetch");
  });

  it("report an answer that is not JSON", async () => {
    const s = script(new Response("not json", { status: 200 }));
    const error = await createApiClient({ fetch: s.fetch })
      .getConfig()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 200, code: "unexpected_response" });
  });

  it("do not quote an error that is not the client's own", () => {
    expect(errorMessage(new Error("secret internals"))).not.toContain("secret internals");
    expect(errorMessage("text")).toMatch(/Reload it and try again/);
  });
});

describe("401 and the access token", () => {
  it("tells the app the token was refused, then throws", async () => {
    const s = script(failure(401, "unauthorized", "The access token is missing or wrong."));
    const onUnauthorized = vi.fn();
    const client = createApiClient({ fetch: s.fetch, getToken: () => "old", onUnauthorized });
    await expect(client.listReviews()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "The access token is missing or wrong.",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("does not call the handler for other failures", async () => {
    const s = script(failure(403, "forbidden", "No."));
    const onUnauthorized = vi.fn();
    await createApiClient({ fetch: s.fetch, onUnauthorized })
      .listReviews()
      .catch(() => undefined);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("checks a token without touching the one that is held", async () => {
    const s = script(failure(401, "unauthorized", "No."), ok({ playbooks: [] }));
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      fetch: s.fetch,
      getToken: () => "held-token",
      onUnauthorized,
    });
    expect(await client.checkToken("typed-token")).toBe(false);
    expect(await client.checkToken("typed-token-2")).toBe(true);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(headersOf(s.sent[0]!)["Authorization"]).toBe("Bearer typed-token");
    expect(headersOf(s.sent[1]!)["Authorization"]).toBe("Bearer typed-token-2");
  });

  it("lets other failures of a token check through", async () => {
    const s = script(failure(500, "internal_error", "Down."));
    await expect(createApiClient({ fetch: s.fetch }).checkToken("x")).rejects.toMatchObject({
      status: 500,
    });
  });
});

describe("files", () => {
  it("are fetched with the token and come back with the name the server suggested", async () => {
    const s = script(
      new Response("docx bytes", {
        status: 200,
        headers: {
          "Content-Disposition": `attachment; filename="redline.docx"; filename*=UTF-8''Acme%20NDA%20%28redline%29.docx`,
        },
      }),
    );
    const client = createApiClient({ fetch: s.fetch, getToken: () => "secret-token-value" });
    const file = await client.fetchFile(paths.docx("r1", "all"));
    expect(s.sent[0]?.url).toBe("/api/reviews/r1/docx?include=all");
    expect(headersOf(s.sent[0]!)["Authorization"]).toBe("Bearer secret-token-value");
    expect(await file.blob.text()).toBe("docx bytes");
    expect(file.fileName).toBe("Acme NDA (redline).docx");
  });

  it("report a failed download with the server's message", async () => {
    const s = script(failure(409, "conflict", "The review is not finished."));
    await expect(
      createApiClient({ fetch: s.fetch }).fetchFile("/api/reviews/r1/docx?include=all"),
    ).rejects.toMatchObject({
      status: 409,
      message: "The review is not finished.",
    });
  });
});

describe("fileNameFromDisposition", () => {
  it.each([
    [`attachment; filename="plain.docx"`, "plain.docx"],
    [`attachment; filename=plain.docx`, "plain.docx"],
    [
      `attachment; filename="ascii.docx"; filename*=UTF-8''caf%C3%A9.docx`,
      `caf${String.fromCodePoint(0xe9)}.docx`,
    ],
    [`attachment; filename*=UTF-8''bad%ZZ.docx`, null],
    [`attachment`, null],
    [null, null],
    [`attachment; filename="../../etc/passwd"`, "....etcpasswd"],
    [`attachment; filename="a\\b.docx"`, "ab.docx"],
    [`attachment; filename=""`, null],
  ])("reads %s as %s", (header, expected) => {
    expect(fileNameFromDisposition(header)).toBe(expected);
  });

  it("cuts a very long name", () => {
    const name = fileNameFromDisposition(`attachment; filename="${"a".repeat(500)}.docx"`);
    expect(name?.length).toBe(200);
  });
});

describe("paths", () => {
  it("build the addresses of the downloads", () => {
    expect(paths.docx("r1", "accepted")).toBe("/api/reviews/r1/docx?include=accepted");
    expect(paths.docx("r1", "all")).toBe("/api/reviews/r1/docx?include=all");
    expect(paths.report("r1", "md")).toBe("/api/reviews/r1/report?format=md");
    expect(paths.report("r1", "json")).toBe("/api/reviews/r1/report?format=json");
    expect(paths.document("d1")).toBe("/api/documents/d1/file");
  });

  it("escape an id that has characters with a meaning in an address", () => {
    expect(paths.docx("a/b?c", "all")).toBe("/api/reviews/a%2Fb%3Fc/docx?include=all");
  });
});
