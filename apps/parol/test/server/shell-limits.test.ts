import { describe, expect, it } from "vitest";
import { UPLOAD_MARGIN_BYTES } from "../../src/server/app.js";
import { PUBLIC_BODY_LIMIT_BYTES, defineRoute } from "../../src/server/matter-route.js";
import { USERS, makeShell } from "./support-app.js";

const UPLOAD_LIMIT = 1000;
const LIMIT = UPLOAD_LIMIT + UPLOAD_MARGIN_BYTES;

function world(maxUploadBytes = UPLOAD_LIMIT) {
  const shell = makeShell({ maxUploadBytes });
  const seen: number[] = [];
  for (const path of ["/api/take", "/take"])
    defineRoute(shell.app, {
      method: "POST",
      path,
      access: "principal",
      handler: async (c) => {
        const bytes = (await c.req.arrayBuffer()).byteLength;
        seen.push(bytes);
        return c.json({ bytes });
      },
    });
  return { shell, seen };
}

const bytes = (n: number): string => "x".repeat(n);

describe("the body size limit", () => {
  it("is the upload limit plus a small margin, and the margin is small", () => {
    expect(UPLOAD_MARGIN_BYTES).toBeGreaterThan(0);
    expect(UPLOAD_MARGIN_BYTES).toBeLessThanOrEqual(256 * 1024);
  });

  it("accepts a body of exactly the limit and refuses one byte more", async () => {
    const { shell, seen } = world();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    const headers = { "content-type": "text/plain", "x-csrf-token": token };
    const atLimit = await client.send("POST", "/api/take", { headers, body: bytes(LIMIT) });
    expect(atLimit.status).toBe(200);
    expect(await atLimit.json()).toEqual({ bytes: LIMIT });
    const over = await client.send("POST", "/api/take", { headers, body: bytes(LIMIT + 1) });
    expect(over.status).toBe(413);
    expect(seen).toEqual([LIMIT]);
  });

  it("answers 413 as JSON under /api and as a page elsewhere, with the usual headers", async () => {
    const { shell, seen } = world();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    const api = await client.send("POST", "/api/take", {
      headers: { "content-type": "text/plain", "x-csrf-token": token },
      body: bytes(LIMIT + 10),
    });
    expect(api.status).toBe(413);
    expect(api.headers.get("content-type")).toMatch(/application\/json/);
    expect(await api.json()).toEqual({
      error: { kind: "too_large", message: "The request body is too large." },
    });
    expect(api.headers.get("x-request-id")).toMatch(/^req_/);
    expect(api.headers.get("content-security-policy")).toBeTruthy();
    expect(api.headers.get("cache-control")).toBe("no-store");

    const page = await client.send("POST", "/take", {
      headers: { "content-type": "text/plain", "x-csrf-token": token },
      body: bytes(LIMIT + 10),
    });
    expect(page.status).toBe(413);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(seen).toEqual([]);
  });

  it("refuses by the declared length without reading the body", async () => {
    const { shell, seen } = world();
    const client = await shell.signIn(USERS.associate);
    const response = await client.send("POST", "/api/take", {
      headers: {
        "content-type": "text/plain",
        "content-length": String(LIMIT + 1),
        "x-csrf-token": await client.token(),
      },
      body: "short",
    });
    expect(response.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("refuses a body that grows past the limit without declaring its length", async () => {
    const { shell, seen } = world();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    const chunk = new TextEncoder().encode(bytes(10_000));
    const stream = (chunks: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < chunks; i += 1) controller.enqueue(chunk);
          controller.close();
        },
      });
    const send = (body: ReadableStream<Uint8Array>) =>
      shell.app.request("/api/take", {
        method: "POST",
        headers: {
          cookie: client.cookieHeader(),
          "content-type": "text/plain",
          "x-csrf-token": token,
        },
        body,
        duplex: "half",
      } as RequestInit);
    const big = await send(stream(10)); // 100 000 bytes, over the limit
    expect(big.status).toBe(413);
    const small = await send(stream(6)); // 60 000 bytes, under it
    expect(small.status).toBe(200);
    expect(await small.json()).toEqual({ bytes: 60_000 });
    expect(seen).toEqual([60_000]);
  });

  it("refuses an oversized multipart upload before it looks for the token or the person", async () => {
    const { shell, seen } = world();
    const form = new FormData();
    form.set("_csrf", "irrelevant");
    form.set("file", new File([bytes(LIMIT + 100)], "synthetic.txt"));
    // Not signed in and no valid token: the size is checked first, so the answer is 413.
    const anonymous = await shell.anonymous().send("POST", "/api/take", { body: form });
    expect(anonymous.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it("applies to every method that carries a body", async () => {
    const { shell } = world();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      defineRoute(shell.app, {
        method: method as "POST",
        path: `/api/m/${method}`,
        access: "principal",
        handler: (c) => c.text("ok"),
      });
    }
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await client.send(method, `/api/m/${method}`, {
        headers: { "content-type": "text/plain", "x-csrf-token": token },
        body: bytes(LIMIT + 1),
      });
      expect(response.status, method).toBe(413);
    }
  });

  it("is logged as a request like any other", async () => {
    const { shell } = world();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    shell.logs.length = 0;
    await client.send("POST", "/api/take", {
      headers: { "content-type": "text/plain", "x-csrf-token": token },
      body: bytes(LIMIT + 1),
    });
    expect(shell.logs).toHaveLength(1);
    expect(shell.logs[0]).toMatch(/ status=413 /);
  });
});

describe("a write from someone with no session", () => {
  it("is held to a much smaller body than an upload, however large uploads may be", async () => {
    const shell = makeShell({ maxUploadBytes: 10 * 1024 * 1024 });
    const visitor = shell.anonymous();
    const token = await visitor.token();
    const headers = { "content-type": "application/x-www-form-urlencoded" };
    const fits = await visitor.send("POST", "/session", {
      headers,
      body: new URLSearchParams({
        _csrf: token,
        intent: "sign-in",
        userId: USERS.reviewer,
      }).toString(),
    });
    expect(fits.status).toBe(303);
    const outsider = shell.anonymous();
    const over = await outsider.send("POST", "/session", {
      headers,
      body: new URLSearchParams({
        _csrf: await outsider.token(),
        intent: "sign-in",
        userId: bytes(PUBLIC_BODY_LIMIT_BYTES),
      }).toString(),
    });
    expect(over.status).toBe(413);
  });
});
