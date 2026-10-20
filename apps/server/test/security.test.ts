import type { ApiError } from "@clausewise/api";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { controllable, createHarness, oracleFor, type Harness } from "./support.js";

const TOKEN = "correct-horse-battery-staple";
const UUID = "00000000-0000-4000-8000-0000000000ab";

/** The headers every answer carries, whatever it is. */
function expectHardened(response: Response): void {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-request-id")).toMatch(/^req-\d+$/);
  // No CORS header of any kind: a page on another site can send a request but never read the answer.
  for (const [name] of response.headers) expect(name.startsWith("access-control-")).toBe(false);
}

const jsonInit = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("without an access token", () => {
  let t: Harness;
  beforeAll(async () => {
    t = await createHarness({ generator: await oracleFor("nda-aggressive.docx"), scope: "file" });
  });

  describe("the Host check against DNS rebinding", () => {
    it("answers 421 for a name that is not this machine", async () => {
      for (const host of [
        "evil.example",
        "evil.example:8787",
        "localhost.evil.example",
        "127.0.0.1.evil.example",
        "10.0.0.5:8787",
        "[::2]",
        "localhost:notaport",
        "localhost:8787@evil.example",
      ]) {
        const response = await t.request("/api/documents", { headers: { Host: host } });
        expect(response.status, host).toBe(421);
        const body = (await response.json()) as ApiError;
        expect(body.error.code).toBe("wrong_host");
        expect(body.error.message).toContain("CLAUSEWISE_ALLOWED_HOSTS");
        // The message never echoes what the client sent.
        expect(JSON.stringify(body)).not.toContain("evil");
        expectHardened(response);
      }
      // The health check and the config are no exception: nothing is answered to a rebound name.
      expect((await t.request("/healthz", { headers: { Host: "evil.example" } })).status).toBe(421);
      expect((await t.request("/api/config", { headers: { Host: "evil.example" } })).status).toBe(
        421,
      );
    });

    it("answers for localhost, 127.0.0.1 and [::1], with or without a port, in any case", async () => {
      for (const host of [
        "localhost",
        "localhost:8787",
        "LOCALHOST:8787",
        "127.0.0.1",
        "127.0.0.1:54321",
        "[::1]",
        "[::1]:8787",
      ]) {
        const response = await t.request("/api/documents", { headers: { Host: host } });
        expect(response.status, host).toBe(200);
      }
    });

    it("answers for the hosts the owner listed, and still refuses the others", async () => {
      const proxied = await createHarness({
        generator: await oracleFor("nda-aggressive.docx"),
        config: { allowedHosts: ["clausewise.example.org", "internal:9000"] },
      });
      for (const host of [
        "clausewise.example.org",
        "clausewise.example.org:443",
        "internal:9000",
      ]) {
        expect((await proxied.request("/healthz", { headers: { Host: host } })).status, host).toBe(
          200,
        );
      }
      for (const host of [
        "internal:9001",
        "other.example.org",
        "clausewise.example.org.evil.example",
      ]) {
        expect((await proxied.request("/healthz", { headers: { Host: host } })).status, host).toBe(
          421,
        );
      }
    });
  });

  describe("the Origin check against requests from other sites", () => {
    const here = { Host: "localhost:8787" };

    it("answers 403 to a change that comes from a page on another origin", async () => {
      for (const origin of [
        "http://evil.example",
        "http://localhost:9999",
        "https://localhost:8787.evil.example",
        "null",
        "not a url",
      ]) {
        const post = await t.request(
          "/api/reviews",
          jsonInit(
            { documentId: UUID, playbookId: "builtin:nda-mutual" },
            { ...here, Origin: origin },
          ),
        );
        expect(post.status, origin).toBe(403);
        expect(((await post.json()) as ApiError).error.code).toBe("forbidden");
        expectHardened(post);
      }
      // Every method that changes something, before the route is even looked up.
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const response = await t.request(`/api/reviews/${UUID}/findings/term`, {
          method,
          headers: { ...here, Origin: "http://evil.example", "Content-Type": "application/json" },
          body: method === "DELETE" ? null : "{}",
        });
        expect(response.status, method).toBe(403);
      }
    });

    it("lets through a request from this server's own page, and reads that never change anything", async () => {
      const own = await t.request(
        "/api/reviews",
        jsonInit(
          { documentId: UUID, playbookId: "builtin:nda-mutual" },
          { ...here, Origin: "http://localhost:8787" },
        ),
      );
      // Past the check: the document does not exist, which is a 404 of the route.
      expect(own.status).toBe(404);

      for (const method of ["GET", "HEAD"]) {
        const read = await t.request("/api/documents", {
          method,
          headers: { ...here, Origin: "http://evil.example" },
        });
        expect(read.status, method).toBe(200);
        // The answer is not readable by that page: no Access-Control-Allow-Origin.
        expect(read.headers.get("access-control-allow-origin")).toBeNull();
      }
    });

    it("sets no CORS header, not even for a preflight", async () => {
      const preflight = await t.request("/api/reviews", {
        method: "OPTIONS",
        headers: {
          Origin: "http://evil.example",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      expect(preflight.status).toBe(404);
      expectHardened(preflight);
    });
  });

  describe("the content type of a body", () => {
    it("refuses a body that a form on another site could send without asking", async () => {
      for (const type of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "text/plain;charset=UTF-8",
        "application/xml",
      ]) {
        for (const [method, path] of [
          ["POST", "/api/reviews"],
          ["POST", "/api/playbooks"],
          ["POST", "/api/playbooks/validate"],
          ["PUT", "/api/playbooks/abc"],
          ["PATCH", `/api/reviews/${UUID}/findings`],
          ["PATCH", `/api/reviews/${UUID}/findings/term`],
          ["POST", "/api/documents"],
        ] as const) {
          const response = await t.request(path, {
            method,
            headers: { "Content-Type": type },
            body: '{"documentId":"x"}',
          });
          expect(response.status, `${method} ${path} as ${type}`).toBe(415);
          expect(((await response.json()) as ApiError).error.code).toBe("unsupported_media_type");
          expectHardened(response);
        }
      }
    });

    it("refuses a JSON route with no type, or with the type of an upload, and an upload that is not one", async () => {
      const noType = await t.request("/api/reviews", {
        method: "POST",
        body: JSON.stringify({ documentId: UUID, playbookId: "x" }),
      });
      expect(noType.status).toBe(415);

      const form = new FormData();
      form.set("file", new File(["x"], "a.docx"));
      expect((await t.request("/api/reviews", { method: "POST", body: form })).status).toBe(415);

      const asJson = await t.request("/api/documents", jsonInit({ file: "x" }));
      expect(asJson.status).toBe(415);
    });

    it("refuses a body of the wrong type even on a route that never reads one, so a form cannot forge a cancel", async () => {
      const control = controllable(await oracleFor("nda-aggressive.docx"));
      const u = await createHarness({ generator: control.generator });
      const document = await u.uploadFixture("nda-aggressive.docx");
      const started = await u.startReview(document.id, "builtin:nda-mutual");
      await control.calls(1);

      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        for (const [method, path] of [
          ["POST", `/api/reviews/${started.body.id}/cancel`],
          ["DELETE", `/api/reviews/${started.body.id}`],
          ["DELETE", `/api/documents/${document.id}`],
        ] as const) {
          const response = await u.request(path, {
            method,
            headers: { "Content-Type": type },
            body: "cancel=1",
          });
          expect(response.status, `${method} ${path} as ${type}`).toBe(415);
        }
      }
      // Nothing was stopped or deleted by any of them.
      const running = await u.json<{ status: string }>(`/api/reviews/${started.body.id}`);
      expect(running.body.status).toBe("running");
      expect(control.signals.every((signal) => !signal.aborted)).toBe(true);
      expect(
        (await u.json<{ documents: unknown[] }>("/api/documents")).body.documents,
      ).toHaveLength(1);

      // The same request without a body type is the real one.
      const cancelled = await u.request(`/api/reviews/${started.body.id}/cancel`, {
        method: "POST",
      });
      expect(cancelled.status).toBe(200);
    });

    it("accepts application/json with a charset, and a request with no body at all", async () => {
      const ok = await t.request(
        "/api/playbooks/validate",
        jsonInit({ yaml: "name: x" }, { "Content-Type": "application/json; charset=utf-8" }),
      );
      expect(ok.status).toBe(200);
      // Cancel has no body and so no type.
      expect((await t.request(`/api/reviews/${UUID}/cancel`, { method: "POST" })).status).toBe(404);
    });
  });

  describe("headers and the shape of errors on every answer", () => {
    it("carries the security headers on successes, errors and downloads alike", async () => {
      const { document } = await t.reviewedFixture("nda-aggressive.docx");
      const api: [string, Response][] = [
        ["200", await t.request("/api/config")],
        ["204", await t.request("/api/playbooks/missing", { method: "DELETE" })],
        ["404 route", await t.request("/api/nothing/here")],
        ["400", await t.request("/api/playbooks", jsonInit({}))],
        ["400 body", await t.request("/api/playbooks", { ...jsonInit({}), body: "{not json" })],
        ["409", await t.request(`/api/reviews/${UUID}/cancel`, { method: "POST" })],
        [
          "415",
          await t.request("/api/playbooks", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: "x",
          }),
        ],
        ["421", await t.request("/api/config", { headers: { Host: "evil.example" } })],
        ["403", await t.request("/api/playbooks", jsonInit({}, { Origin: "http://evil.example" }))],
        ["download", await t.request(`/api/documents/${document.id}/file`)],
      ];
      const elsewhere: [string, Response][] = [
        ["healthz", await t.request("/healthz")],
        ["404 post", await t.request("/nothing", { method: "POST" })],
        ["404 static", await t.request("/nothing.js")],
      ];
      for (const [name, response] of [...api, ...elsewhere]) {
        expectHardened(response);
        await response.arrayBuffer();
        expect(response.status, name).toBeGreaterThan(0);
      }
      // What the API answers is never kept by a browser or a proxy: it is the client's material.
      for (const [name, response] of api) {
        expect(response.headers.get("cache-control"), name).toBe("no-store");
      }
    });

    it("gives every error the same shape, in words a person can read, with nothing internal in them", async () => {
      const { review } = await t.reviewedFixture("nda-aggressive.docx");
      const failing = [
        await t.request("/api/nothing/here"),
        await t.request("/api/playbooks", jsonInit({})),
        await t.request(`/api/reviews/not-a-uuid`),
        await t.request(`/api/reviews/${UUID}`),
        await t.request("/api/config", { headers: { Host: "evil.example" } }),
        await t.request("/api/playbooks", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "x",
        }),
        await t.request(`/api/reviews/${review.id}/cancel`, { method: "POST" }),
        await t.request(
          "/api/reviews",
          jsonInit({ documentId: UUID, playbookId: "builtin:nda-mutual" }),
        ),
      ];
      const codes = new Set<string>();
      for (const response of failing) {
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.headers.get("content-type")).toContain("application/json");
        const body = (await response.json()) as ApiError;
        expect(Object.keys(body)).toEqual(["error"]);
        expect(Object.keys(body.error).sort()).toEqual(["code", "message"]);
        expect(body.error.message.length).toBeGreaterThan(10);
        codes.add(body.error.code);
        const text = JSON.stringify(body);
        expect(text).not.toMatch(/\bat \S+\.(?:ts|js):\d+/);
        expect(text).not.toContain("/home/");
        expect(text).not.toMatch(/\b(?:select|insert|update|delete) .* from\b/i);
      }
      expect([...codes].sort()).toEqual(
        ["bad_request", "conflict", "not_found", "unsupported_media_type", "wrong_host"].sort(),
      );
    });

    it("answers an unexpected failure with a request id and none of the detail, which goes to the log", async () => {
      const secret = "Indemnity of the Recipient under /home/lawyer/clients/acme-merger.docx";
      const broken = createApp({
        ...t.deps,
        playbooks: {
          ...t.deps.playbooks,
          list: async () => {
            throw Object.assign(new Error(`select * from reviews where text = '${secret}'`), {
              code: "XX000",
            });
          },
        },
      });
      const before = t.lines.length;
      const response = await broken.request("/api/playbooks");
      expect(response.status).toBe(500);
      const body = (await response.json()) as ApiError;
      expect(body.error.code).toBe("internal_error");
      expect(body.error.requestId).toBe(response.headers.get("x-request-id"));
      expect(body.error.message).toContain(body.error.requestId ?? "missing");
      const text = JSON.stringify(body);
      for (const word of ["Indemnity", "acme-merger", "/home/", "select", "XX000"]) {
        expect(text).not.toContain(word);
      }
      expectHardened(response);

      const logged = t.lines.slice(before).join("\n");
      expect(logged).toContain(body.error.requestId);
      expect(logged).toContain('"level":"error"');
      expect(logged).toContain('"code":"XX000"');
      // The kind and the call stack are logged, the message is not: it can quote a contract.
      for (const word of ["Indemnity", "acme-merger", "select * from"]) {
        expect(logged).not.toContain(word);
      }
    });

    it("gives each request an id of its own making and ignores the one a client sends", async () => {
      const a = await t.request("/healthz", {
        headers: { "X-Request-Id": "attacker-chosen <script>" },
      });
      const b = await t.request("/healthz");
      expect(a.headers.get("x-request-id")).toMatch(/^req-\d+$/);
      expect(a.headers.get("x-request-id")).not.toBe(b.headers.get("x-request-id"));
      expect(t.lines.join("\n")).not.toContain("attacker-chosen");
    });
  });
});

describe("with an access token", () => {
  let t: Harness;
  beforeAll(async () => {
    t = await createHarness({
      generator: await oracleFor("nda-aggressive.docx"),
      config: { accessToken: TOKEN },
      scope: "file",
    });
  });

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  it("refuses every API request without the token, and says nothing about the token", async () => {
    const requests: [string, string][] = [
      ["GET", "/api/playbooks"],
      ["POST", "/api/playbooks/validate"],
      ["GET", "/api/documents"],
      ["POST", "/api/documents"],
      ["GET", `/api/documents/${UUID}/file`],
      ["DELETE", `/api/documents/${UUID}`],
      ["GET", "/api/reviews"],
      ["POST", "/api/reviews"],
      ["GET", `/api/reviews/${UUID}/report`],
      ["PATCH", `/api/reviews/${UUID}/findings`],
      ["GET", "/api/no/such/route"],
      ["GET", "/api"],
    ];
    const bodies = new Set<string>();
    for (const [method, path] of requests) {
      const response = await t.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expectHardened(response);
      bodies.add(await response.text());
    }
    // The same words for a missing token as for a wrong one: nothing to learn from the difference.
    for (const header of [
      bearer("wrong-token-of-the-same-length!"),
      bearer(TOKEN.slice(0, -1)),
      bearer(`${TOKEN}x`),
      bearer(""),
      { Authorization: `Basic ${TOKEN}` },
      { Authorization: TOKEN },
    ]) {
      const response = await t.request("/api/documents", { headers: header });
      expect(response.status, JSON.stringify(header)).toBe(401);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    const [only] = [...bodies];
    expect(JSON.parse(only ?? "{}")).toEqual({
      error: { code: "unauthorized", message: "Sign in with the access token to use Clausewise." },
    });
  });

  it("answers requests that carry the token, whatever the Host, and the scheme in any case", async () => {
    expect((await t.request("/api/documents", { headers: bearer(TOKEN) })).status).toBe(200);
    expect(
      (await t.request("/api/documents", { headers: { Authorization: `bearer ${TOKEN}` } })).status,
    ).toBe(200);
    // The token is the defence, so the Host check is off: a reverse proxy needs no allowed-hosts list.
    expect(
      (
        await t.request("/api/documents", {
          headers: { ...bearer(TOKEN), Host: "clausewise.example.org" },
        })
      ).status,
    ).toBe(200);
    const created = await t.request(
      "/api/playbooks/validate",
      jsonInit({ yaml: "x: 1" }, bearer(TOKEN)),
    );
    expect(created.status).toBe(200);
  });

  it("needs no token for the health check, the config and the web app", async () => {
    expect((await t.request("/healthz")).status).toBe(200);
    const config = await t.request("/api/config");
    expect(config.status).toBe(200);
    expect(((await config.json()) as { authRequired: boolean }).authRequired).toBe(true);
    // Not 401: a path outside /api is the web app's, and it answers 404 here because no web folder exists.
    expect((await t.request("/index.html")).status).toBe(404);
    // The config is public only for reads.
    expect((await t.request("/api/config", { method: "POST" })).status).toBe(401);
  });

  it("never lets the token into a response or a log line", async () => {
    await t.request("/api/documents", { headers: { Authorization: `Bearer ${TOKEN}` } });
    await t.request("/api/documents", { headers: { Authorization: `Bearer ${TOKEN}-wrong` } });
    expect(t.lines.join("\n")).not.toContain(TOKEN);
    const config = await t.request("/api/config");
    expect(await config.text()).not.toContain(TOKEN);
  });
});
