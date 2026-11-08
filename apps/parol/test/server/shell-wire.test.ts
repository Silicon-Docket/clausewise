import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { start, type RunningServer } from "../../src/main.js";

/**
 * What the real server puts on the wire for requests that no client library will send: a request
 * line with a user part, a Transfer-Encoding nobody knows, a missing Host, a header too large.
 * Every one of them must get a complete answer (the security headers, a request id) and exactly one
 * access line whose status is the status the client received, and none may echo what was sent.
 */

const SECRET = "wire-test-secret-wire-test-secret-0001";

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
  /** Everything the server wrote, for a check that nothing was echoed. */
  text: string;
}

/** Sends the bytes exactly as given and reads until the server closes the connection. */
function rawBytes(port: number, bytes: string | Buffer): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port }, () => socket.write(bytes));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const head = (split === -1 ? text : text.slice(0, split)).split("\r\n");
      const headers = new Map<string, string>();
      for (const line of head.slice(1)) {
        const colon = line.indexOf(":");
        if (colon > 0)
          headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
      }
      resolve({
        status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1] ?? 0),
        headers,
        body: split === -1 ? "" : text.slice(split + 4),
        text,
      });
    });
  });
}

const request = (lines: string[]): string => `${lines.join("\r\n")}\r\n\r\n`;

async function boot(extra: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "parol-wire-"));
  roots.push(root);
  const logs: string[] = [];
  const server = await start(
    {
      PAROL_DEMO_IDENTITY: "1",
      PAROL_SCRIPTED: "1",
      PAROL_PORT: "0",
      PAROL_DATA_DIR: join(root, "data"),
      PAROL_COOKIE_SECRET: SECRET,
      ...extra,
    },
    { log: (line) => logs.push(line), notice: () => {} },
  );
  running.push(server);
  const lines = (): string[] => logs.filter((line) => line.startsWith("req="));
  return { server, lines };
}

/** The checks every complete answer passes, whatever the request was. */
function expectComplete(response: RawResponse, status: number): string {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const id = response.headers.get("x-request-id");
  expect(id).toMatch(/^req_[0-9a-f]{16}$/);
  return id as string;
}

describe("a request target that carries a user part", () => {
  // The adapter accepts `http://user:pw@host/` and then fails when the request is first read, so
  // a malformed request used to be answered as a server fault, with a logged TypeError.
  const targets = ["http://user:pw@localhost", "http://user@localhost", "http://:pw@localhost"];

  for (const target of targets)
    for (const [method, path] of [
      ["GET", "/healthz"],
      ["GET", "/api/matters"],
      ["POST", "/session"],
    ] as const)
      it(`answers ${method} ${target}${path} with a plain 400 and no server fault`, async () => {
        const { server, lines } = await boot();
        const response = await rawBytes(
          server.port,
          request([
            `${method} ${target}${path} HTTP/1.1`,
            "Host: 127.0.0.1",
            "Content-Length: 0",
            "Connection: close",
          ]),
        );
        const id = expectComplete(response, 400);
        // Nothing of what was sent comes back, and it is not reported as a fault of ours.
        expect(response.text).not.toMatch(/user|pw@|Reference/);
        const logged = lines();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(`req=${id}`);
        expect(logged[0]).toContain("status=400");
        expect(logged[0]).not.toContain("error=");
        expect(logged[0]).not.toMatch(/user@|:pw|pw@/);
        if (path.startsWith("/api")) {
          expect(response.headers.get("content-type")).toMatch(/application\/json/);
          expect(JSON.parse(response.body)).toMatchObject({ error: { kind: "invalid_request" } });
        }
      });

  it("refuses it with the demo identity off as well", async () => {
    const { server, lines } = await boot({ PAROL_DEMO_IDENTITY: "0" });
    const response = await rawBytes(
      server.port,
      request([
        "GET http://user:pw@localhost/healthz HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
      ]),
    );
    expectComplete(response, 400);
    expect(lines()).toHaveLength(1);
  });

  it("still serves a target whose user part is empty, which names no user", async () => {
    const { server } = await boot();
    const response = await rawBytes(
      server.port,
      request(["GET http://:@localhost/healthz HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]),
    );
    expect(response.status).toBe(200);
  });
});

describe("a request the HTTP parser refuses before the application sees it", () => {
  const tooLong = "a".repeat(20_000);
  const cases: [string, string | Buffer, number][] = [
    ["no Host header", request(["GET /api/matters HTTP/1.1", "Connection: close"]), 400],
    ["an unknown method", request(["FOO / HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]), 400],
    [
      "a path past the header limit",
      request([`GET /${tooLong} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close"]),
      431,
    ],
    [
      "a Cookie header past the header limit",
      request([
        "GET /healthz HTTP/1.1",
        "Host: 127.0.0.1",
        `Cookie: a=${tooLong}`,
        "Connection: close",
      ]),
      431,
    ],
    [
      "a bare line feed for a line ending",
      "GET /healthz HTTP/1.1\nHost: 127.0.0.1\nConnection: close\n\n",
      400,
    ],
    [
      "a NUL byte in a header",
      Buffer.from(
        "GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-A: a\u0000b\r\nConnection: close\r\n\r\n",
      ),
      400,
    ],
    [
      "a negative Content-Length",
      request([
        "POST /session HTTP/1.1",
        "Host: 127.0.0.1",
        "Content-Length: -1",
        "Connection: close",
      ]),
      400,
    ],
    [
      "an unrecognised Transfer-Encoding on a POST",
      "POST /session HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: xchunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
      400,
    ],
    [
      "an unrecognised Transfer-Encoding on a GET",
      request([
        "GET /healthz HTTP/1.1",
        "Host: 127.0.0.1",
        "Transfer-Encoding: xchunked",
        "Connection: close",
      ]),
      400,
    ],
    [
      // The parser hands this request on and fails only when it reads the body, so the
      // application has started on it. Its own line, 500 or otherwise, describes an answer that
      // was never sent.
      "a chunked body with a chunk size that is not a number",
      "POST /session HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nzz\r\nabc\r\n0\r\n\r\n",
      400,
    ],
    [
      "an unrecognised Transfer-Encoding on a route that does not exist",
      "POST /nonexistent HTTP/1.1\r\nHost: 127.0.0.1\r\nTransfer-Encoding: xchunked\r\nConnection: close\r\n\r\n0\r\n\r\n",
      400,
    ],
  ];

  for (const [label, bytes, status] of cases)
    it(`answers ${label} completely, with one log line that says what was sent`, async () => {
      const { server, lines } = await boot();
      const response = await rawBytes(server.port, bytes);
      const id = expectComplete(response, status);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      expect(response.text).not.toMatch(/xchunked|FOO|nonexistent|aaaaaaaa|X-A/);
      // The log line is written as the answer goes out; give a late one a moment to show up.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const logged = lines();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain(`req=${id}`);
      expect(logged[0]).toContain(`status=${status}`);
      expect(logged[0]).toContain("route=(unmatched)");
      expect(logged[0]).not.toMatch(/xchunked|FOO|nonexistent|aaaaaaaa|X-A/);
    });

  it("does not refuse a Transfer-Encoding that ends in chunked, or a body sent that way", async () => {
    const { server } = await boot();
    const response = await rawBytes(
      server.port,
      "POST /session HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\n\r\n",
    );
    // The application sees it: a sign-in without a token is its own refusal, not the wire's.
    expect(response.status).toBe(403);
  });

  it("still serves an HTTP/1.0 request that has no Host header", async () => {
    const { server } = await boot();
    const response = await rawBytes(server.port, "GET /healthz HTTP/1.0\r\n\r\n");
    expect(response.status).toBe(200);
  });

  it("keeps serving the next connection after it refused one", async () => {
    const { server, lines } = await boot();
    await rawBytes(server.port, request(["FOO / HTTP/1.1", "Host: 127.0.0.1"]));
    const next = await rawBytes(
      server.port,
      request(["GET /healthz HTTP/1.1", "Host: 127.0.0.1", "Connection: close"]),
    );
    expect(next.status).toBe(200);
    expect(lines()).toHaveLength(2);
  });
});
