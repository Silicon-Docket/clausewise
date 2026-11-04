import { describe, expect, it } from "vitest";
import { ANON_COOKIE, ANON_MAX_AGE_SECONDS, tokenForBinding } from "../../src/auth/csrf.js";
import { SESSION_COOKIE } from "../../src/auth/identity.js";
import { defineMatterRoute, defineRoute, type RouteMethod } from "../../src/server/matter-route.js";
import {
  HOUR_MS,
  OTHER_SECRET,
  SECRET,
  USERS,
  makeMatter,
  makeShell,
  mountActionRoutes,
  parseSetCookies,
} from "../server/support-app.js";

const UNSAFE: RouteMethod[] = ["POST", "PUT", "PATCH", "DELETE"];

/** A shell with a write route of each kind for every unsafe method, counting how often each ran. */
function shellWithWrites() {
  const shell = makeShell();
  const hits: string[] = [];
  for (const method of UNSAFE) {
    defineRoute(shell.app, {
      method,
      path: "/api/__t/public",
      access: "public",
      handler: (c) => {
        hits.push(`public ${method}`);
        return c.json({ ok: true });
      },
    });
    defineRoute(shell.app, {
      method,
      path: "/api/__t/principal",
      access: "principal",
      handler: (c) => {
        hits.push(`principal ${method}`);
        return c.json({ ok: true });
      },
    });
    defineMatterRoute(shell.app, {
      method,
      path: "/api/matters/:matterId/__t",
      action: "matter.read",
      handler: (c) => {
        hits.push(`matter ${method}`);
        return c.json({ ok: true });
      },
    });
  }
  const matterId = makeMatter(shell.repo, USERS.associate);
  return { shell, hits, matterId };
}

describe("the token on every write", () => {
  it("is required by every unsafe method on every kind of route", async () => {
    const { shell, hits, matterId } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const paths = ["/api/__t/public", "/api/__t/principal", `/api/matters/${matterId}/__t`];
    for (const method of UNSAFE) {
      for (const path of paths) {
        const response = await client.post(path, {}, false, method);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(await response.json()).toMatchObject({ error: { kind: "csrf" } });
      }
    }
    expect(hits).toEqual([]);
  });

  it("is accepted from the header, from a url-encoded field and from a multipart field", async () => {
    const { shell, hits, matterId } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const paths = ["/api/__t/public", "/api/__t/principal", `/api/matters/${matterId}/__t`];
    for (const method of UNSAFE) {
      for (const path of paths) {
        const token = await client.token();
        const header = await client.json(method, path, {}, token);
        expect(header.status, `header ${method} ${path}`).toBe(200);
        const field = await client.post(path, { note: "x" }, token, method);
        expect(field.status, `field ${method} ${path}`).toBe(200);
        const form = new FormData();
        form.set("_csrf", token);
        form.set("file", new File(["synthetic text"], "nda.txt", { type: "text/plain" }));
        const multipart = await client.send(method, path, { body: form });
        expect(multipart.status, `multipart ${method} ${path}`).toBe(200);
      }
    }
    expect(hits).toHaveLength(UNSAFE.length * paths.length * 3);
  });

  it("is refused when it is wrong, whatever way it is wrong", async () => {
    const { shell, hits } = shellWithWrites();
    const alice = await shell.signIn(USERS.associate);
    const dana = await shell.signIn(USERS.reviewer);
    const good = await alice.token();
    const flipped = `${good.slice(0, -1)}${good.endsWith("A") ? "B" : "A"}`;
    const wrong = [
      "",
      "x",
      flipped,
      good + good,
      await dana.token(), // another session's token
      tokenForBinding(OTHER_SECRET, `s:${alice.jar.get(SESSION_COOKIE)}`), // the right binding, signed by someone else
      tokenForBinding(SECRET, "none"),
      tokenForBinding(SECRET, alice.jar.get(SESSION_COOKIE)!), // the session value without the prefix
      tokenForBinding(SECRET, `a:${alice.jar.get(SESSION_COOKIE)}`), // bound as if anonymous
      alice.jar.get(SESSION_COOKIE)!, // the cookie itself
    ];
    for (const token of wrong) {
      for (const path of ["/api/__t/public", "/api/__t/principal"]) {
        const asField = await alice.post(path, {}, token);
        expect(asField.status, `field ${token.slice(0, 12)}`).toBe(403);
        const asHeader = await alice.json("POST", path, {}, token);
        expect(asHeader.status, `header ${token.slice(0, 12)}`).toBe(403);
      }
    }
    expect(hits).toEqual([]);
  });

  it("is read from the header or the form only: not the query, a cookie or a JSON body", async () => {
    const { shell, hits } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    const inQuery = await client.send("POST", `/api/__t/principal?_csrf=${token}`, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(inQuery.status).toBe(403);
    const inCookie = await client.send("POST", "/api/__t/principal", {
      headers: { cookie: `${client.cookieHeader()}; _csrf=${token}`, "content-type": "text/plain" },
      body: "a=b",
    });
    expect(inCookie.status).toBe(403);
    const inJson = await client.send("POST", "/api/__t/principal", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ _csrf: token }),
    });
    expect(inJson.status).toBe(403);
    const inPlainText = await client.send("POST", "/api/__t/principal", {
      headers: { "content-type": "text/plain" },
      body: `_csrf=${token}`,
    });
    expect(inPlainText.status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("lets a wrong header decide: the right form field does not rescue it", async () => {
    const { shell, hits } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    const response = await client.send("POST", "/api/__t/principal", {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": "not-the-token",
      },
      body: new URLSearchParams({ _csrf: token }).toString(),
    });
    expect(response.status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("is not needed for GET or HEAD, which change nothing", async () => {
    const { shell } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    expect((await client.send("GET", "/__test/whoami")).status).toBe(200);
    expect((await client.send("HEAD", "/__test/whoami")).status).toBe(200);
    expect((await client.send("GET", "/healthz")).status).toBe(200);
    expect((await client.send("HEAD", "/healthz")).status).toBe(200);
  });

  it("answers a failed page post with an HTML page, not JSON", async () => {
    const { shell } = shellWithWrites();
    defineRoute(shell.app, {
      method: "POST",
      path: "/pages/__t",
      access: "public",
      handler: (c) => c.text("ran"),
    });
    const response = await shell.anonymous().post("/pages/__t", {}, false);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
  });

  it("reaches the handler's own read of the body after the check read it", async () => {
    const shell = makeShell();
    let seen: unknown;
    defineRoute(shell.app, {
      method: "POST",
      path: "/__t/form",
      access: "principal",
      handler: async (c) => {
        seen = await c.req.parseBody();
        return c.text("ok");
      },
    });
    const client = await shell.signIn(USERS.associate);
    const response = await client.post("/__t/form", { name: "Synthetic" });
    expect(response.status).toBe(200);
    expect(seen).toMatchObject({ name: "Synthetic" });
  });

  it("answers a body that cannot be parsed with 400 and says nothing about it", async () => {
    const { shell } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const marker = "BODY_MARKER_7731";
    const response = await client.send("POST", "/api/__t/principal", {
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: `--zzz\r\nContent-Disposition: form-data; name="${marker}"\r\n\r\n`,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(marker);
  });
});

describe("binding to the session", () => {
  it("gives the same token for the same session and different tokens for different people", async () => {
    const shell = makeShell();
    const alice = await shell.signIn(USERS.associate);
    const dana = await shell.signIn(USERS.reviewer);
    expect(await alice.token()).toBe(await alice.token());
    expect(await alice.token()).not.toBe(await dana.token());
  });

  it("makes a token from before sign-in useless afterwards, and from before sign-out too", async () => {
    const { shell, hits } = shellWithWrites();
    const client = shell.anonymous();
    const before = await client.token();
    await client.post("/session", { intent: "sign-in", userId: USERS.associate });
    const afterIn = await client.token();
    expect(afterIn).not.toBe(before);
    expect((await client.json("POST", "/api/__t/principal", {}, before)).status).toBe(403);
    expect((await client.json("POST", "/api/__t/principal", {}, afterIn)).status).toBe(200);
    await client.post("/session/end");
    expect((await client.json("POST", "/api/__t/public", {}, afterIn)).status).toBe(403);
    expect(hits).toEqual(["principal POST"]);
  });

  it("does not move between browsers: a token is worth nothing without its cookie", async () => {
    const { shell, hits } = shellWithWrites();
    const victim = await shell.signIn(USERS.associate);
    const attacker = await shell.signIn(USERS.reviewer);
    const theirs = await attacker.token();
    // The victim's browser holds the victim's cookie; the attacker's token does not fit it.
    expect((await victim.json("POST", "/api/__t/principal", {}, theirs)).status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("stops working with the session it belonged to", async () => {
    const { shell } = shellWithWrites();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    shell.clock.advance(9 * HOUR_MS);
    // The session has expired: the person is anonymous, so a principal route says so first.
    expect((await client.json("POST", "/api/__t/principal", {}, token)).status).toBe(401);
    expect((await client.json("POST", "/api/__t/public", {}, token)).status).toBe(403);
  });
});

describe("the sign-in form (login CSRF)", () => {
  it("cannot be posted without a token or a cookie", async () => {
    const shell = makeShell();
    const response = await shell
      .anonymous()
      .post("/session", { intent: "sign-in", userId: USERS.admin }, false);
    expect(response.status).toBe(403);
    expect(parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
  });

  it("cannot be posted with the right token but no cookie, as a hostile page would", async () => {
    const shell = makeShell();
    const attacker = shell.anonymous();
    const theirToken = await attacker.token();
    // The victim's browser sends no cookie: the page the attacker controls cannot set one.
    const victim = shell.anonymous();
    const response = await victim.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      theirToken,
    );
    expect(response.status).toBe(403);
    expect(parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    expect((await victim.whoami()).userId).toBeNull();
  });

  it("cannot be posted with the attacker's token against the victim's own cookie", async () => {
    const shell = makeShell();
    const attacker = shell.anonymous();
    const theirToken = await attacker.token();
    const victim = shell.anonymous();
    await victim.token(); // the victim has visited the sign-in page, so holds an anonymous cookie
    expect(victim.jar.has(ANON_COOKIE)).toBe(true);
    const response = await victim.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      theirToken,
    );
    expect(response.status).toBe(403);
    expect((await victim.whoami()).userId).toBeNull();
  });

  it("works for the visitor who was given the form, and retires the anonymous cookie", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    const page = await visitor.get("/__test/csrf");
    const anon = parseSetCookies(page).find((c) => c.name === ANON_COOKIE)!;
    expect(anon.attributes.get("httponly")).toBe(true);
    expect(anon.attributes.get("samesite")).toBe("Strict");
    expect(anon.attributes.get("path")).toBe("/");
    expect(anon.attributes.get("max-age")).toBe(String(ANON_MAX_AGE_SECONDS));
    expect(ANON_MAX_AGE_SECONDS).toBeLessThanOrEqual(60 * 60);
    const response = await visitor.post("/session", { intent: "sign-in", userId: USERS.reviewer });
    expect(response.status).toBe(303);
    expect(visitor.jar.has(ANON_COOKIE)).toBe(false);
    expect((await visitor.whoami()).userId).toBe(USERS.reviewer);
  });

  it("does not issue a second anonymous cookie to a visitor who already holds a valid one", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    const first = await visitor.token();
    const again = await visitor.get("/__test/csrf");
    expect(parseSetCookies(again).find((c) => c.name === ANON_COOKIE)).toBeUndefined();
    expect(((await again.json()) as { token: string }).token).toBe(first);
  });

  it("runs out: a form kept open for more than an hour is refused", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    const token = await visitor.token();
    shell.clock.advance(HOUR_MS + 1000);
    const response = await visitor.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      token,
    );
    expect(response.status).toBe(403);
    // A fresh page gives a fresh cookie and token.
    const fresh = await visitor.post("/session", { intent: "sign-in", userId: USERS.admin });
    expect(fresh.status).toBe(303);
  });

  it("refuses an anonymous cookie that was altered or signed by someone else", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    const token = await visitor.token();
    const cookie = visitor.jar.get(ANON_COOKIE)!;
    const altered = `${cookie.slice(0, -1)}${cookie.endsWith("A") ? "B" : "A"}`;
    for (const value of [altered, cookie.replace(/^v1/, "v2"), "", "junk"]) {
      const probe = shell.anonymous();
      probe.jar.set(ANON_COOKIE, value);
      const response = await probe.post(
        "/session",
        { intent: "sign-in", userId: USERS.admin },
        token,
      );
      expect(response.status, value.slice(0, 20)).toBe(403);
    }
    const foreign = makeShell({ cookieSecret: OTHER_SECRET });
    const abroad = foreign.anonymous();
    abroad.jar.set(ANON_COOKIE, cookie);
    const response = await abroad.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      token,
    );
    expect(response.status).toBe(403);
  });

  it("is also protected for the sign-out routes", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    expect((await client.post("/session/end", {}, false)).status).toBe(403);
    expect((await client.post("/session", { intent: "sign-out" }, false)).status).toBe(403);
    expect((await client.whoami()).userId).toBe(USERS.associate);
    expect((await client.post("/session/end")).status).toBe(303);
    expect((await client.whoami()).userId).toBeNull();
  });
});

describe("a write to a matter by someone with no session", () => {
  it("is answered with 401 before the token matters, for the API and for pages", async () => {
    const shell = makeShell();
    const { calls } = mountActionRoutes(shell.app);
    defineMatterRoute(shell.app, {
      method: "POST",
      path: "/matters/:matterId/notes",
      action: "matter.update",
      handler: (c) => c.text("ran"),
    });
    const matterId = makeMatter(shell.repo, USERS.associate);
    const api = await shell
      .anonymous()
      .post(`/api/matters/${matterId}/do/matter.update`, {}, false);
    expect(api.status).toBe(401);
    const page = await shell.anonymous().post(`/matters/${matterId}/notes`, {}, false);
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/");
    expect(calls).toEqual([]);
  });
});
