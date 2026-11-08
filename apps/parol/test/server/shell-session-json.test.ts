import { describe, expect, it } from "vitest";
import { USERS, makeShell } from "./support-app.js";

/**
 * The sign-in and sign-out routes take a form or JSON, and answer in the form the caller used. A
 * script that posts JSON gets a JSON error it can read the code from; a browser that posts a form
 * keeps the HTML page. Errors under /api were always JSON.
 */

const MESSAGE_MARKER = "MARKER_session_json_do_not_repeat";

async function expectJsonError(
  response: Response,
  status: number,
  expected: Record<string, unknown>,
): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  const body = (await response.json()) as { error: Record<string, unknown> };
  expect(body.error).toMatchObject(expected);
  expect(JSON.stringify(body)).not.toContain(MESSAGE_MARKER);
}

describe("POST /session with a JSON body", () => {
  it("answers an identity that does not exist with a JSON error that has a code", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const response = await client.json("POST", "/session", {
      intent: "sign-in",
      userId: "usr_nobody",
    });
    await expectJsonError(response, 400, { kind: "invalid_request", code: "unknown_identity" });
    expect(await client.whoami()).toMatchObject({ userId: null });
  });

  it("answers a missing token with a JSON error", async () => {
    const shell = makeShell();
    const response = await shell
      .anonymous()
      .json("POST", "/session", { intent: "sign-in", userId: USERS.associate }, false);
    await expectJsonError(response, 403, { kind: "csrf" });
  });

  it("answers an intent it does not know with a JSON error that has a code", async () => {
    const shell = makeShell();
    const response = await shell.anonymous().json("POST", "/session", { intent: MESSAGE_MARKER });
    await expectJsonError(response, 400, { kind: "invalid_request", code: "bad_intent" });
  });

  it("answers a body that is not JSON with a JSON error that has a code", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const token = await client.token();
    const response = await client.send("POST", "/session", {
      headers: { "content-type": "application/json", "x-csrf-token": token },
      body: `{ ${MESSAGE_MARKER}`,
    });
    await expectJsonError(response, 400, { kind: "invalid_request", code: "bad_body" });
  });

  it("answers a sign-in with the demo identity off with a JSON not-found", async () => {
    const shell = makeShell({ demoIdentity: false });
    const response = await shell.anonymous().json("POST", "/session", {
      intent: "sign-in",
      userId: USERS.associate,
    });
    await expectJsonError(response, 404, { kind: "not_found" });
  });

  it("still answers a sign-in that works, and a sign-out, in JSON", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const signedIn = await client.json("POST", "/session", {
      intent: "sign-in",
      userId: USERS.associate,
    });
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toMatchObject({ user: { userId: USERS.associate } });
    const signedOut = await client.json("POST", "/session", { intent: "sign-out" });
    expect(signedOut.status).toBe(200);
    expect(await signedOut.json()).toEqual({ ok: true });
  });

  it("answers the sign-out route in JSON when its token is missing", async () => {
    const shell = makeShell();
    const response = await shell.anonymous().json("POST", "/session/end", {}, false);
    await expectJsonError(response, 403, { kind: "csrf" });
  });
});

describe("POST /session with a form", () => {
  it("keeps the HTML error page", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const response = await client.post("/session", { intent: "sign-in", userId: "usr_nobody" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await response.text()).toContain("That request was not valid");
  });

  it("keeps the HTML error page for a missing token", async () => {
    const shell = makeShell();
    const response = await shell
      .anonymous()
      .post("/session", { intent: "sign-in", userId: USERS.associate }, false);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  });
});

describe("a JSON body sent to a page", () => {
  it("does not turn the page's errors into JSON", async () => {
    const shell = makeShell();
    const response = await shell.anonymous().json("POST", "/nowhere", {}, false);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  });
});
