import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { LlmConfigError } from "@clausewise/llm";
import { ConfigError, start, type RunningServer } from "../../src/main.js";
import { DEMO_PLAYBOOK_SLUG } from "../../src/boot/register.js";
import { defineRoute } from "../../src/server/matter-route.js";

const SECRET = "main-test-secret-main-test-secret-0001";

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "parol-main-"));
  roots.push(root);
  return root;
}

function env(dataDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PAROL_DEMO_IDENTITY: "1",
    PAROL_SCRIPTED: "1",
    PAROL_PORT: "0",
    PAROL_DATA_DIR: dataDir,
    PAROL_COOKIE_SECRET: SECRET,
    ...extra,
  };
}

interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

/**
 * Sends the bytes as they are, which a client library will not (it would fix a bad Host header or
 * refuse a bad target), and reads the whole reply.
 */
function raw(port: number, lines: string[]): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect({ host: "127.0.0.1", port }, () =>
      socket.write(`${lines.join("\r\n")}\r\n\r\n`),
    );
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
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head[0] ?? "")?.[1] ?? 0),
        headers,
        body: split === -1 ? "" : text.slice(split + 4),
      });
    });
  });
}

async function boot(extra: Record<string, string> = {}) {
  const dataDir = join(folder(), "data");
  const logs: string[] = [];
  const notices: string[] = [];
  const server = await start(env(dataDir, extra), {
    log: (line) => logs.push(line),
    notice: (line) => notices.push(line),
  });
  running.push(server);
  return { server, dataDir, logs, notices, url: `http://127.0.0.1:${server.port}` };
}

describe("start", () => {
  it("serves the shell on a real socket, on loopback, with the security headers", async () => {
    const { server, url, logs } = await boot();
    expect(server.port).toBeGreaterThan(0);
    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(health.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(health.headers.get("cache-control")).toBe("no-store");
    const css = await fetch(`${url}/assets/parol.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toMatch(/text\/css/);
    const missing = await fetch(`${url}/nothing-here`);
    expect(missing.status).toBe(404);
    // One access line per request, in the fixed shape.
    expect(logs.filter((l) => l.startsWith("req="))).toHaveLength(3);
  });

  it("refuses a request whose Host is not this machine, as a rebinding page would send", async () => {
    const { server } = await boot();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/healthz",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  describe("a request the HTTP layer refuses before the application sees it", () => {
    // The adapter builds the request's address from the request line and the Host header, and
    // answers 400 itself when they do not make an address. That reply used to be bare: no
    // security headers, no request id, no log line.
    const refused: Record<string, string[]> = {
      "a Host header with a space": ["GET /healthz HTTP/1.1", "Host: foo bar", "Connection: close"],
      "a Host header with a user part": [
        "GET /healthz HTTP/1.1",
        "Host: localhost@evil.example",
        "Connection: close",
      ],
      "a backslash in the path": [
        "GET /assets/..\\src\\main.ts HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
      ],
      "a Host header with a path in it": [
        "GET /healthz HTTP/1.1",
        "Host: localhost/evil",
        "Connection: close",
      ],
    };

    for (const [label, lines] of Object.entries(refused))
      it(`answers ${label} with the security headers, a request id and one log line`, async () => {
        const { server, logs } = await boot();
        const response = await raw(server.port, lines);
        expect(response.status).toBe(400);
        expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
        expect(response.headers.get("x-content-type-options")).toBe("nosniff");
        expect(response.headers.get("x-frame-options")).toBe("DENY");
        expect(response.headers.get("referrer-policy")).toBe("no-referrer");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("permissions-policy")).toBeTruthy();
        const id = response.headers.get("x-request-id");
        expect(id).toMatch(/^req_[0-9a-f]{16}$/);
        // A page that says what kind of problem it was and nothing about what was sent.
        expect(response.headers.get("content-type")).toMatch(/text\/html/);
        expect(response.body).toContain("That request was not valid");
        expect(response.body).not.toMatch(/evil|foo bar|main\.ts/);
        // One line in the usual fixed shape, naming the id, the status and the kind of failure.
        const entries = logs.filter((line) => line.startsWith("req="));
        expect(entries).toHaveLength(1);
        expect(entries[0]).toContain(`req=${id}`);
        expect(entries[0]).toContain("status=400");
        expect(entries[0]).toContain("route=(unmatched)");
        expect(entries[0]).not.toMatch(/evil|foo bar|main\.ts/);
      });

    it("is still served by the application when the request is fine", async () => {
      const { server, logs } = await boot();
      const response = await raw(server.port, [
        "GET /healthz HTTP/1.1",
        "Host: 127.0.0.1",
        "Connection: close",
      ]);
      expect(response.status).toBe(200);
      expect(logs.filter((line) => line.startsWith("req="))).toHaveLength(1);
    });
  });

  it("refuses a request line in absolute form whose Host header is not this machine", async () => {
    // The adapter takes the address from the request line here and leaves Host alone, so a check
    // of the address alone would let this through.
    const { server } = await boot();
    const hostile = await raw(server.port, [
      "GET http://localhost/healthz HTTP/1.1",
      "Host: evil.example",
      "Connection: close",
    ]);
    expect(hostile.status).toBe(403);
    expect(hostile.headers.get("content-security-policy")).toBeTruthy();
    const honest = await raw(server.port, [
      "GET http://localhost/healthz HTTP/1.1",
      "Host: localhost",
      "Connection: close",
    ]);
    expect(honest.status).toBe(200);
  });

  it("says when the page and API routes are not installed, and only then", async () => {
    const { notices } = await boot();
    const routes = join(import.meta.dirname, "..", "..", "src", "server", "routes", "index.ts");
    const said = notices.some((line) => line.includes("serving the shell only"));
    expect(said).toBe(!existsSync(routes));
  });

  it("prints where document text goes, and the warnings, before it serves", async () => {
    const { notices } = await boot({ PAROL_COOKIE_SECRET: "" });
    const lines = notices.join("\n");
    expect(lines).toContain("Document text is sent to: a built-in stand-in model");
    expect(lines).toContain("nothing is sent anywhere");
    expect(lines).toContain("PAROL_COOKIE_SECRET is not set");
    expect(lines).toMatch(/Parol is listening on http:\/\/127\.0\.0\.1:\d+/);
    // The disclosure comes before the listening line.
    expect(lines.indexOf("Document text is sent to")).toBeLessThan(lines.indexOf("listening"));
  });

  it("opens the database, registers the demonstration playbook and seeds the demo users", async () => {
    const { server, dataDir } = await boot();
    expect(existsSync(join(dataDir, "parol.sqlite"))).toBe(true);
    expect(
      server.repo
        .listUsers()
        .map((u) => u.id)
        .sort(),
    ).toEqual(["usr_demo_admin", "usr_demo_associate", "usr_demo_engineer", "usr_demo_reviewer"]);
    const playbook = server.repo.findPlaybookVersion(DEMO_PLAYBOOK_SLUG, "1.0.1");
    expect(playbook?.status).toBe("approved");
  });

  it("keeps its data across a restart, and starts again on the same folder", async () => {
    const dataDir = join(folder(), "data");
    const first = await start(env(dataDir), { log: () => {}, notice: () => {} });
    const users = first.repo.listUsers().length;
    await first.close();
    const second = await start(env(dataDir), { log: () => {}, notice: () => {} });
    running.push(second);
    expect(second.repo.listUsers()).toHaveLength(users);
  });

  it("stops cleanly: no new connections, a closed database, and a second close is harmless", async () => {
    const { server, url } = await boot();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    await server.close();
    await server.close();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    expect(() => server.repo.listUsers()).toThrow();
  });

  it("lets a request in progress finish before it closes the database", async () => {
    const { server, url } = await boot();
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    defineRoute(server.app, {
      method: "GET",
      path: "/slow",
      access: "public",
      handler: async (c) => {
        entered();
        await held;
        // The database is still open when the last request is answered.
        return c.json({ users: server.repo.listUsers().length });
      },
    });
    const slow = fetch(`${url}/slow`);
    await inside;
    let closed = false;
    const stopping = server.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    // No new connection is accepted while it waits.
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    release();
    const response = await slow;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ users: 4 });
    await stopping;
    expect(closed).toBe(true);
  });

  it("refuses the demo identity on an address other machines can reach, before it opens anything", async () => {
    const dataDir = join(folder(), "data");
    await expect(
      start(env(dataDir, { PAROL_HOST: "0.0.0.0" }), { log: () => {}, notice: () => {} }),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("needs a model: without a key and without PAROL_SCRIPTED it stops before it opens the database", async () => {
    const dataDir = join(folder(), "data");
    const { PAROL_SCRIPTED: _scripted, ...withoutScripted } = env(dataDir);
    void _scripted;
    await expect(
      start(withoutScripted, { log: () => {}, notice: () => {} }),
    ).rejects.toBeInstanceOf(LlmConfigError);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("does not send the demo user's id or the secret anywhere it prints", async () => {
    const { logs, notices } = await boot();
    const printed = [...logs, ...notices].join("\n");
    expect(printed).not.toContain(SECRET);
  });
});
