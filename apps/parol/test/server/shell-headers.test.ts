import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../../src/services/errors.js";
import { csrfToken } from "../../src/auth/csrf.js";
import { defineMatterRoute, defineRoute } from "../../src/server/matter-route.js";
import { USERS, makeMatter, makeShell, parseSetCookies } from "./support-app.js";

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function expectSecurityHeaders(response: Response, label: string): void {
  const h = response.headers;
  expect(h.get("content-security-policy"), label).toBe(CSP);
  expect(h.get("x-content-type-options"), label).toBe("nosniff");
  expect(h.get("referrer-policy"), label).toBe("no-referrer");
  expect(h.get("x-frame-options"), label).toBe("DENY");
  expect(h.get("cross-origin-opener-policy"), label).toBe("same-origin");
  expect(h.get("x-request-id"), label).toMatch(/^req_[0-9a-f]{16}$/);
}

describe("security headers", () => {
  it("are on a success, an error, a 404, a redirect and a refusal alike", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/boom",
      access: "public",
      handler: () => {
        throw new TypeError("a defect");
      },
    });
    defineRoute(shell.app, {
      method: "GET",
      path: "/forbidden",
      access: "public",
      handler: () => {
        throw new ForbiddenError("matter.read");
      },
    });
    defineMatterRoute(shell.app, {
      method: "GET",
      path: "/matters/:matterId",
      action: "matter.read",
      handler: (c) => c.text("page"),
    });
    const matterId = makeMatter(shell.repo, USERS.associate);
    const client = await shell.signIn(USERS.associate);
    const visitor = shell.anonymous();
    const responses: [string, Response][] = [
      ["200 json", await client.get("/healthz")],
      ["200 page", await client.get(`/matters/${matterId}`)],
      ["404 unknown route", await client.get("/no/such/route")],
      ["404 api", await client.get("/api/no/such/route")],
      ["404 matter", await client.get("/matters/mat_missing")],
      ["404 asset", await client.get("/assets/missing.css")],
      ["403", await client.get("/forbidden")],
      ["403 csrf", await client.post("/session/end", {}, false)],
      ["500", await client.get("/boom")],
      ["303", await visitor.get(`/matters/${matterId}`)],
      ["400", await client.post("/session", { intent: "sign-in", userId: "nobody" })],
      ["asset", await client.get("/assets/parol.css")],
      ["head", await client.send("HEAD", "/healthz")],
    ];
    for (const [label, response] of responses) expectSecurityHeaders(response, label);
    expect(responses.map(([, r]) => r.status)).toEqual([
      200, 200, 404, 404, 404, 404, 403, 403, 500, 303, 400, 200, 200,
    ]);
  });

  it("deny every browser feature", async () => {
    const shell = makeShell();
    const policy = (await shell.anonymous().get("/healthz")).headers.get("permissions-policy")!;
    const entries = policy.split(", ");
    expect(entries.length).toBeGreaterThan(20);
    for (const entry of entries) expect(entry).toMatch(/^[a-z-]+=\(\)$/);
    for (const feature of ["camera", "microphone", "geolocation", "payment", "usb", "fullscreen"])
      expect(entries).toContain(`${feature}=()`);
  });

  it("name no feature that Chromium does not recognise, since it warns on every page for each", async () => {
    // Seen in the console of Chromium 1xx on every page of a browser walk-through. The warnings
    // are harmless but they bury a real one, and denying a feature nobody can grant gains nothing.
    const shell = makeShell();
    const policy = (await shell.anonymous().get("/healthz")).headers.get("permissions-policy")!;
    const names = policy.split(", ").map((entry) => entry.split("=")[0]);
    for (const unknown of [
      "ambient-light-sensor",
      "battery",
      "bluetooth",
      "document-domain",
      "web-share",
    ])
      expect(names).not.toContain(unknown);
  });

  it("keep their values when a handler tries to set its own", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/loose",
      access: "public",
      handler: (c) =>
        c.text("x", 200, {
          "Content-Security-Policy": "default-src *",
          "X-Frame-Options": "ALLOWALL",
          "Cache-Control": "public, max-age=31536000",
        }),
    });
    const response = await shell.anonymous().get("/loose");
    expect(response.headers.get("content-security-policy")).toBe(CSP);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("add Strict-Transport-Security only for an https deployment", async () => {
    const plain = await makeShell().anonymous().get("/healthz");
    expect(plain.headers.has("strict-transport-security")).toBe(false);
    const secure = await makeShell({ secureCookies: true }).anonymous().get("/healthz");
    expect(secure.headers.get("strict-transport-security")).toMatch(/^max-age=\d+/);
  });

  it("reach a response whose own headers are read-only", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/frozen",
      access: "public",
      handler: () => Response.redirect("http://localhost/elsewhere", 302),
    });
    const response = await shell.anonymous().get("/frozen");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/elsewhere");
    expectSecurityHeaders(response, "frozen");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("caching", () => {
  it("is switched off for everything except a static asset", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    for (const path of [
      "/healthz",
      "/__test/whoami",
      "/nowhere",
      "/api/nowhere",
      "/assets/nowhere",
    ])
      expect((await client.get(path)).headers.get("cache-control"), path).toBe("no-store");
    expect((await client.send("HEAD", "/healthz")).headers.get("cache-control")).toBe("no-store");
    const asset = await client.get("/assets/parol.css");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("is not granted to a page that claims the asset header outside /assets", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/cheat",
      access: "public",
      handler: (c) => c.text("x", 200, { "Cache-Control": "public, max-age=86400" }),
    });
    expect((await shell.anonymous().get("/cheat")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("the request id", () => {
  it("is new for every request and is never taken from the client", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const response = await client.get("/healthz", { "x-request-id": "req_00000000deadbeef" });
      const id = response.headers.get("x-request-id")!;
      expect(id).toMatch(/^req_[0-9a-f]{16}$/);
      expect(id).not.toBe("req_00000000deadbeef");
      seen.add(id);
    }
    expect(seen.size).toBe(20);
  });
});

describe("cookies the shell issues", () => {
  it("reach the client even when the handler returns a bare Response", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/bare",
      access: "public",
      handler: (c) => {
        csrfToken(c);
        return new Response("form", { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    const response = await shell.anonymous().get("/bare");
    expect(parseSetCookies(response).map((c) => c.name)).toEqual(["parol_anon"]);
  });

  it("reach the client on an error response too", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/bare-fail",
      access: "public",
      handler: (c) => {
        csrfToken(c);
        throw new ForbiddenError("matter.read");
      },
    });
    const response = await shell.anonymous().get("/bare-fail");
    expect(response.status).toBe(403);
    expect(parseSetCookies(response).map((c) => c.name)).toEqual(["parol_anon"]);
  });

  it("send one cookie per name even when a handler issues and clears in one request", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const response = await client.post("/session", { intent: "sign-in", userId: USERS.reviewer });
    const names = parseSetCookies(response).map((c) => c.name);
    expect(names.filter((n) => n === "parol_session")).toHaveLength(1);
  });
});
