import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { start, type RunningServer } from "../../src/main.js";
import { urls } from "../../src/server/urls.js";
import { attr, first, parseHtml, readable } from "../pages/html.js";
import { baseWorld } from "../routes/support.js";

/**
 * The server as `pnpm parol` starts it: `main.ts` over a real socket, with the routes it loads by
 * name, the built-in stand-in model (which calls nothing) and a folder of its own. It checks what
 * the in-process tests cannot see: that the routes are installed, and that a sign-in, a form and a
 * multipart upload survive the HTTP adapter, which parses bodies its own way.
 */

const roots: string[] = [];
const running: RunningServer[] = [];
afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SECRET = "server-test-secret-server-test-secret-01";

async function boot(): Promise<{ server: RunningServer; url: string; notices: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "parol-e2e-"));
  roots.push(root);
  const notices: string[] = [];
  const server = await start(
    {
      PAROL_DEMO_IDENTITY: "1",
      PAROL_SCRIPTED: "1",
      PAROL_PORT: "0",
      PAROL_DATA_DIR: join(root, "data"),
      PAROL_COOKIE_SECRET: SECRET,
    },
    { log: () => {}, notice: (line) => notices.push(line) },
  );
  running.push(server);
  return { server, url: `http://127.0.0.1:${server.port}`, notices };
}

/** A browser over fetch: it keeps cookies and does not follow redirects, so each step is seen. */
class Over {
  private readonly jar = new Map<string, string>();
  constructor(private readonly base: string) {}

  async send(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0)
      headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await fetch(`${this.base}${path}`, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "" || /max-age=0/i.test(line)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }
}

const csrfIn = (html: string): string =>
  attr(
    first(parseHtml(html), (el) => el.name === "input" && attr(el, "name") === "_csrf"),
    "value",
  ) ?? "";

describe("main.ts with the routes it loads", () => {
  it("installs the page and API routes, and says nothing about serving the shell only", async () => {
    const { url, notices } = await boot();
    expect(notices.join("\n")).not.toContain("serving the shell only");
    const home = await new Over(url).send("/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Choose a demo identity");
  });

  it("signs in, creates a matter and uploads a document over a real socket", async () => {
    const { server, url } = await boot();
    const browser = new Over(url);
    const start_ = await (await browser.send("/")).text();
    const signedIn = await browser.send("/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfIn(start_),
        intent: "sign-in",
        userId: "usr_demo_associate",
      }).toString(),
    });
    expect(signedIn.status).toBe(303);

    const matters = await (await browser.send(urls.matters())).text();
    const created = await browser.send(urls.matters(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfIn(matters),
        name: "Matter over a socket",
        clientLegalName: baseWorld.manifest.clientLegalName,
      }).toString(),
    });
    expect(created.status).toBe(303);
    const where = created.headers.get("location")!;
    expect(where).toMatch(
      /^\/matters\/mat_[0-9a-f]{16}\?notice=matter-created&nt=\d+\.[A-Za-z0-9_-]{43}$/,
    );
    const matterId = where.slice("/matters/".length).split("?")[0]!;

    const page = await (await browser.send(where)).text();
    expect(readable(parseHtml(page))).toContain("The matter was created.");

    const nda = baseWorld.files.find((f) => f.label === "D1")!;
    const body = new FormData();
    body.set("_csrf", csrfIn(page));
    body.set("title", "Mutual NDA");
    body.set("kind", "nda");
    body.set("statedDate", "2026-02-02");
    body.set("file", new File([new Uint8Array(nda.bytes)], nda.file));
    const uploaded = await browser.send(urls.documents(matterId), { method: "POST", body });
    expect(uploaded.status).toBe(303);
    expect(uploaded.headers.get("location")).toContain("notice=document-added");

    const view = server.repo.listDocuments(matterId);
    expect(view.map((d) => [d.label, d.kind])).toEqual([["D1", "nda"]]);

    // The JSON side works the same way, with the token from the session route.
    const session = (await (await browser.send("/api/session")).json()) as { csrfToken: string };
    const api = await browser.send(`/api/matters/${matterId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ clientLegalName: "Lanternfish Software, Incorporated" }),
    });
    expect(api.status).toBe(200);
    expect(server.repo.getMatter(matterId)?.clientLegalName).toBe(
      "Lanternfish Software, Incorporated",
    );

    // And a request the adapter cannot make sense of is refused by the shell and not by a route.
    const without = await browser.send(`/api/matters/${matterId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(without.status).toBe(403);
  });

  it("refuses an upload past the limit before it reads it, over the socket too", async () => {
    const { url } = await boot();
    const browser = new Over(url);
    const start_ = await (await browser.send("/")).text();
    await browser.send("/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        _csrf: csrfIn(start_),
        intent: "sign-in",
        userId: "usr_demo_associate",
      }).toString(),
    });
    const session = (await (await browser.send("/api/session")).json()) as { csrfToken: string };
    const created = await browser.send("/api/matters", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": session.csrfToken },
      body: JSON.stringify({ name: "Big", clientLegalName: "Big, Inc." }),
    });
    const matterId = ((await created.json()) as { id: string }).id;
    const body = new FormData();
    body.set("title", "Huge");
    body.set("kind", "nda");
    body.set("file", new File([new Uint8Array(11 * 1024 * 1024).fill(0x61)], "huge.txt"));
    const response = await browser.send(`/api/matters/${matterId}/documents`, {
      method: "POST",
      headers: { "x-csrf-token": session.csrfToken },
      body,
    });
    expect(response.status).toBe(413);
  });
});
