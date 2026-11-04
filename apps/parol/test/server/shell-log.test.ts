import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineMatterRoute, defineRoute } from "../../src/server/matter-route.js";
import { UNMATCHED_ROUTE, formatAccessLine } from "../../src/server/middleware/access-log.js";
import { USERS, addUser, makeMatter, makeShell } from "./support-app.js";

/** A string that must not appear in any log line or in any response that is not about it. */
const MARKER = "LOGMARKER_Qv7731_secret_text";

// Built from code points so this file does not contain the characters it forbids.
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

const GRAMMAR =
  /^req=req_[0-9a-f]{16} method=[A-Z]+ route=\S+ status=\d{3} ms=\d+ user=\S+ matter=\S+( error=[A-Za-z]+)?$/;

afterEach(() => vi.restoreAllMocks());

function world() {
  const shell = makeShell();
  addUser(shell.repo, "usr_synthetic_outsider");
  defineMatterRoute(shell.app, {
    method: "GET",
    path: "/api/matters/:matterId/runs/:runId",
    action: "run.read",
    handler: (c) => c.json({ ok: true }),
  });
  defineMatterRoute(shell.app, {
    method: "POST",
    path: "/api/matters/:matterId/documents",
    action: "document.write",
    handler: async (c) => {
      const body = await c.req.parseBody();
      return c.json({ received: Object.keys(body).length });
    },
  });
  defineMatterRoute(shell.app, {
    method: "GET",
    path: "/matters/:matterId",
    action: "matter.read",
    handler: (c) => c.text("page"),
  });
  defineRoute(shell.app, {
    method: "GET",
    path: "/explode",
    access: "public",
    handler: () => {
      throw new RangeError(`bad value ${MARKER}`);
    },
  });
  const matterId = makeMatter(shell.repo, USERS.associate, { [USERS.reviewer]: "reviewer" });
  return { shell, matterId };
}

describe("the access log", () => {
  it("writes one line per request, in a fixed shape, with the route template and no path", async () => {
    const { shell, matterId } = world();
    const client = await shell.signIn(USERS.associate);
    shell.logs.length = 0;
    await client.get("/healthz");
    await client.get(`/api/matters/${matterId}/runs/run_abc`);
    await client.get("/nowhere/at/all");
    await client.get("/assets/parol.css");
    expect(shell.logs).toHaveLength(4);
    for (const line of shell.logs) expect(line).toMatch(GRAMMAR);
    expect(shell.logs[0]).toMatch(/route=\/healthz status=200 /);
    expect(shell.logs[1]).toMatch(/route=\/api\/matters\/:matterId\/runs\/:runId status=200 /);
    expect(shell.logs[2]).toContain(`route=${UNMATCHED_ROUTE} status=404`);
    expect(shell.logs[3]).toMatch(/route=\/assets\/:name status=200 /);
    // The path the request carried is not in any of them.
    expect(shell.logs.join("\n")).not.toContain("run_abc");
    expect(shell.logs.join("\n")).not.toContain("/nowhere");
  });

  it("names the request id the client was given", async () => {
    const { shell } = world();
    const response = await shell.anonymous().get("/healthz");
    expect(shell.logs.at(-1)).toContain(`req=${response.headers.get("x-request-id")} `);
  });

  it("names the user and the matter for an authorized request, from the database", async () => {
    const { shell, matterId } = world();
    const client = await shell.signIn(USERS.reviewer);
    shell.logs.length = 0;
    await client.get(`/api/matters/${matterId}/runs/run_1`);
    expect(shell.logs).toHaveLength(1);
    expect(shell.logs[0]).toContain(` user=${USERS.reviewer} matter=${matterId}`);
  });

  it("names the user but no matter when authorization fails, and neither when anonymous", async () => {
    const { shell, matterId } = world();
    const outsider = await shell.signIn("usr_synthetic_outsider");
    shell.logs.length = 0;
    await outsider.get(`/api/matters/${matterId}/runs/run_1`);
    await outsider.get(`/api/matters/${MARKER}/runs/run_1`);
    await shell.anonymous().get(`/api/matters/${matterId}/runs/run_1`);
    expect(shell.logs[0]).toMatch(/ user=usr_synthetic_outsider matter=-$/);
    expect(shell.logs[1]).toMatch(/ user=usr_synthetic_outsider matter=-$/);
    expect(shell.logs[2]).toMatch(/ user=- matter=-$/);
    expect(shell.logs.join("\n")).not.toContain(matterId);
    expect(shell.logs.join("\n")).not.toContain(MARKER);
  });

  it("records the status of a refusal and the latency as whole milliseconds", async () => {
    const { shell, matterId } = world();
    const client = await shell.signIn(USERS.reviewer);
    shell.logs.length = 0;
    await client.post(`/api/matters/${matterId}/documents`, {}, false);
    expect(shell.logs[0]).toMatch(/ status=403 ms=\d+ /);
  });

  it("holds none of a marker placed in the body, query, a header, a file name or a path id", async () => {
    const { shell, matterId } = world();
    const client = await shell.signIn(USERS.associate);
    shell.logs.length = 0;
    const token = await client.token();
    shell.logs.length = 0;

    const upload = new FormData();
    upload.set("_csrf", token);
    upload.set(`field_${MARKER}`, MARKER);
    upload.set("file", new File([`document text ${MARKER}`], `${MARKER}.docx`));
    const headers = {
      "user-agent": MARKER,
      referer: `http://localhost/${MARKER}`,
      origin: `http://${MARKER}.example`,
      "x-forwarded-for": MARKER,
      "x-request-id": MARKER,
      "x-anything": MARKER,
      accept: MARKER,
    };
    const responses: Response[] = [];
    responses.push(
      // body, file name, header, query, on an authorized write
      await client.send("POST", `/api/matters/${matterId}/documents?note=${MARKER}`, {
        headers,
        body: upload,
      }),
      // the same on a matter the caller may not see, with the marker as the id
      await client.send("POST", `/api/matters/${MARKER}/documents?note=${MARKER}`, {
        headers: { ...headers, "x-csrf-token": token, "content-type": "application/json" },
        body: JSON.stringify({ note: MARKER }),
      }),
      // path ids on nested routes, on a page, on an asset and on nothing at all
      await client.get(`/api/matters/${matterId}/runs/${MARKER}?x=${MARKER}`, headers),
      await client.get(`/matters/${MARKER}`, headers),
      await client.get(`/assets/${MARKER}.css?v=${MARKER}`, headers),
      await client.get(`/${MARKER}/${MARKER}?${MARKER}=${MARKER}`, headers),
      // a failure whose own message holds the marker
      await client.get(`/explode?x=${MARKER}`, headers),
      // a cookie that holds it
      await client.get("/healthz", {
        ...headers,
        cookie: `parol_session=${MARKER}; ${MARKER}=${MARKER}`,
      }),
      // a refused sign-in that names it
      await client.post("/session", { intent: "sign-in", userId: MARKER }),
    );

    expect(shell.logs.length).toBeGreaterThanOrEqual(responses.length);
    for (const line of shell.logs) {
      expect(line).toMatch(GRAMMAR);
      expect(line).not.toContain(MARKER);
    }
    // Nor does any response give it back, in the body or in a header.
    for (const [index, response] of responses.entries()) {
      const text = await response.text();
      expect(text, `body ${index}`).not.toContain(MARKER);
      response.headers.forEach((value, name) =>
        expect(`${name}: ${value}`, `header ${index}`).not.toContain(MARKER),
      );
    }
  });

  it("logs a server fault by class name only", async () => {
    const { shell } = world();
    shell.logs.length = 0;
    await shell.anonymous().get("/explode");
    expect(shell.logs).toHaveLength(1);
    expect(shell.logs[0]).toMatch(/ status=500 .* error=RangeError$/);
    expect(shell.logs[0]).not.toContain("bad value");
  });

  it("goes to standard output by default and never to console.error", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const shell = makeShell({ app: { log: undefined as never } });
    // `log: undefined` falls back to the default sink.
    await shell.anonymous().get("/healthz");
    const written = out.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(written).toMatch(
      /^req=req_[0-9a-f]{16} method=GET route=\/healthz status=200 ms=\d+ user=- matter=-\n$/,
    );
    expect(err).not.toHaveBeenCalled();
  });

  it("does not fail a request because the log sink fails", async () => {
    const shell = makeShell({
      app: {
        log: () => {
          throw new Error(MARKER);
        },
      },
    });
    const response = await shell.anonymous().get("/healthz");
    expect(response.status).toBe(200);
  });
});

describe("formatAccessLine", () => {
  const base = {
    requestId: "req_0123456789abcdef",
    method: "GET",
    route: "/matters/:matterId",
    status: 200,
    latencyMs: 12.6,
    userId: "usr_demo_associate",
    matterId: "mat_abc",
    errorName: null,
  };

  it("writes the fields in order", () => {
    expect(formatAccessLine(base)).toBe(
      "req=req_0123456789abcdef method=GET route=/matters/:matterId status=200 ms=13 user=usr_demo_associate matter=mat_abc",
    );
  });

  it("replaces anything that is not the kind of value its field holds", () => {
    const line = formatAccessLine({
      ...base,
      requestId: `req ${MARKER}\nforged line`,
      method: MARKER,
      route: `/with space ${MARKER}`,
      userId: `usr x ${MARKER}`,
      matterId: `mat\n${MARKER}`,
      errorName: `Bad Name ${MARKER}`,
      status: Number.NaN,
      latencyMs: Number.POSITIVE_INFINITY,
    });
    expect(line).not.toContain(MARKER);
    expect(line).not.toContain("\n");
    expect(line).toBe(
      `req=- method=OTHER route=${UNMATCHED_ROUTE} status=0 ms=0 user=- matter=- error=Error`,
    );
  });
});

describe("the files that make the shell", () => {
  const roots = [
    join(import.meta.dirname, "..", "..", "src", "auth"),
    join(import.meta.dirname, "..", "..", "src", "server", "middleware"),
    join(import.meta.dirname, "..", "..", "test", "auth"),
  ];
  // Only this module's own files: the rest of test/server belongs to the route modules.
  const ownedTests = readdirSync(import.meta.dirname)
    .filter((name) => name === "support-app.ts" || /^shell.*\.test\.ts$/.test(name))
    .map((name) => join(import.meta.dirname, name));
  const owned = [
    ...roots.flatMap((dir) => files(dir)),
    ...ownedTests,
    ...["app.ts", "http.ts", "matter-route.ts", "assets.ts"].map((name) =>
      join(import.meta.dirname, "..", "..", "src", "server", name),
    ),
    join(import.meta.dirname, "..", "..", "src", "main.ts"),
  ].filter((path) => /\.ts$/.test(path) && existsSync(path));

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  it("never write to the console", () => {
    for (const path of owned.filter((p) => p.includes(`${sep}src${sep}`)))
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\bconsole\./);
  });

  it("use no em dash or en dash", () => {
    // Not an empty scan: the sources and the tests of this module are all in it.
    expect(owned.length).toBeGreaterThan(30);
    for (const path of owned) expect(readFileSync(path, "utf8"), path).not.toMatch(DASHES);
  });
});
