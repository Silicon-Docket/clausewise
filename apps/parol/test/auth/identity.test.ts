import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  mintSessionValue,
  parseSessionValue,
} from "../../src/auth/identity.js";
import { tokenForBinding } from "../../src/auth/csrf.js";
import { SessionRevocations } from "../../src/auth/revocation.js";
import {
  Client,
  HOUR_MS,
  OTHER_SECRET,
  SECRET,
  START,
  USERS,
  addUser,
  makeShell,
  parseSetCookies,
} from "../server/support-app.js";

/** A client holding exactly this session cookie value, as if the browser had sent it. */
function holding(shell: ReturnType<typeof makeShell>, value: string): Client {
  const client = shell.anonymous();
  client.jar.set(SESSION_COOKIE, value);
  return client;
}

describe("the session cookie", () => {
  it("is issued on sign-in with the attributes the design asks for", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const response = await client.post("/session", { intent: "sign-in", userId: USERS.associate });
    expect(response.status).toBe(303);
    const cookie = parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toBeDefined();
    expect(cookie.attributes.get("httponly")).toBe(true);
    expect(cookie.attributes.get("samesite")).toBe("Strict");
    expect(cookie.attributes.get("path")).toBe("/");
    expect(cookie.attributes.get("max-age")).toBe(String(8 * 60 * 60));
    expect(cookie.attributes.has("secure")).toBe(false);
    expect(cookie.attributes.has("domain")).toBe(false);
    expect(SESSION_MAX_AGE_SECONDS).toBe(28_800);
  });

  it("is Secure when the deployment is https, and not otherwise", async () => {
    const secure = makeShell({ secureCookies: true });
    const response = await secure
      .anonymous()
      .post("/session", { intent: "sign-in", userId: USERS.associate });
    const cookie = parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie.attributes.get("secure")).toBe(true);
  });

  it("makes the request act as the chosen seeded user, read from the database", async () => {
    const shell = makeShell();
    for (const [key, id] of Object.entries(USERS)) {
      const client = await shell.signIn(id);
      const who = await client.whoami();
      const row = shell.repo.getUser(id)!;
      expect(who, key).toEqual({
        userId: row.id,
        displayName: row.displayName,
        globalRole: row.globalRole,
      });
    }
  });

  it("holds no role: a change in the database shows on the next request", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    expect((await client.whoami()).globalRole).toBe("member");
    shell.repo.db
      .prepare("UPDATE users SET global_role = 'admin' WHERE id = ?")
      .run(USERS.associate);
    expect((await client.whoami()).globalRole).toBe("admin");
    const value = client.jar.get(SESSION_COOKIE)!;
    expect(value.toLowerCase()).not.toContain("admin");
    expect(value.toLowerCase()).not.toContain("member");
  });

  it("is anonymous with no cookie", async () => {
    const shell = makeShell();
    expect((await shell.anonymous().whoami()).userId).toBeNull();
  });
});

describe("a cookie that is not ours to accept", () => {
  it("is anonymous when any part of it was changed", async () => {
    const shell = makeShell();
    const good = mintSessionValue(SECRET, USERS.associate, START);
    expect((await holding(shell, good).whoami()).userId).toBe(USERS.associate);

    const [version, user, issued, signature] = good.split(".") as [string, string, string, string];
    const flip = (text: string): string => `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;
    const otherUser = Buffer.from(USERS.admin).toString("base64url");
    const tampered = [
      `${version}.${otherUser}.${issued}.${signature}`, // another user, same signature
      `${version}.${user}.${Number(issued) + 3600}.${signature}`, // a later issue time
      `${version}.${user}.${issued}.${flip(signature)}`, // the signature altered
      `${version}.${user}.${issued}.`, // no signature
      `${version}.${user}.${issued}`, // a part missing
      `${good}.extra`, // a part added
      `v2.${user}.${issued}.${signature}`, // another version
      signature,
      "",
      "garbage",
      `${good}${good}`,
      "x".repeat(2000),
    ];
    for (const value of tampered) {
      const who = await holding(shell, value).whoami();
      expect(who.userId, value.slice(0, 40)).toBeNull();
    }
  });

  it("is anonymous once eight hours have passed, and valid until then", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.reviewer);
    shell.clock.advance(8 * HOUR_MS - 1000);
    expect((await client.whoami()).userId).toBe(USERS.reviewer);
    shell.clock.advance(2000);
    expect((await client.whoami()).userId).toBeNull();
  });

  it("does not accept a cookie issued far in the future", async () => {
    const shell = makeShell();
    const later = new Date(START.getTime() + HOUR_MS);
    expect(
      (await holding(shell, mintSessionValue(SECRET, USERS.associate, later)).whoami()).userId,
    ).toBeNull();
    // A few seconds of clock difference between issuer and checker is tolerated.
    const nearly = new Date(START.getTime() + 30_000);
    expect(
      (await holding(shell, mintSessionValue(SECRET, USERS.associate, nearly)).whoami()).userId,
    ).toBe(USERS.associate);
  });

  it("is anonymous under a different secret, even with a correct signature for that secret", async () => {
    const shell = makeShell();
    const foreign = mintSessionValue(OTHER_SECRET, USERS.admin, START);
    // The value is well formed and signed, but not by us.
    expect(parseSessionValue(OTHER_SECRET, foreign, START)).toBe(USERS.admin);
    expect((await holding(shell, foreign).whoami()).userId).toBeNull();

    // And a cookie our own server issued does not work on a server with another secret.
    const ours = await shell.signIn(USERS.admin);
    const other = makeShell({ cookieSecret: OTHER_SECRET });
    const carried = other.anonymous();
    carried.jar.set(SESSION_COOKIE, ours.jar.get(SESSION_COOKIE)!);
    expect((await carried.whoami()).userId).toBeNull();
  });

  it("is anonymous when the user has been deleted", async () => {
    const shell = makeShell();
    addUser(shell.repo, "usr_synthetic_leaver");
    const client = await shell.signIn("usr_synthetic_leaver");
    expect((await client.whoami()).userId).toBe("usr_synthetic_leaver");
    shell.repo.db.prepare("DELETE FROM users WHERE id = ?").run("usr_synthetic_leaver");
    expect((await client.whoami()).userId).toBeNull();
  });

  it("is not satisfied by a value signed for another purpose", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    const token = await visitor.token();
    const anon = visitor.jar.get("parol_anon")!;
    const user = Buffer.from(USERS.admin).toString("base64url");
    const session = mintSessionValue(SECRET, USERS.associate, START);
    const impostors = [
      anon, // the anonymous sign-in cookie
      token, // a CSRF token
      `v1.${user}.${Math.floor(START.getTime() / 1000)}.${tokenForBinding(SECRET, "anything")}`,
      `v1.${user}.${Math.floor(START.getTime() / 1000)}.${tokenForBinding(SECRET, `v1.${user}.${Math.floor(START.getTime() / 1000)}`)}`,
    ];
    for (const value of impostors) expect((await holding(shell, value).whoami()).userId).toBeNull();
    // And the real session cookie is not an anonymous cookie: a token bound to it as one is refused.
    const confused = shell.anonymous();
    confused.jar.set("parol_anon", session);
    const bound = tokenForBinding(SECRET, `a:${session}`);
    const response = await confused.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      bound,
    );
    expect(response.status).toBe(403);
  });
});

describe("what the request says about who is asking", () => {
  it("is ignored: a user id in a header, a query string or a body does nothing", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const headers = {
      "x-user-id": USERS.admin,
      "x-user": USERS.admin,
      "x-forwarded-user": USERS.admin,
      authorization: `Bearer ${USERS.admin}`,
    };
    expect((await (await client.get("/__test/whoami", headers)).json()) as unknown).toMatchObject({
      userId: null,
    });
    for (const query of [
      `?userId=${USERS.admin}`,
      `?user=${USERS.admin}`,
      `?userId[]=${USERS.admin}`,
    ])
      expect(
        ((await (await client.get(`/__test/whoami${query}`)).json()) as { userId: unknown }).userId,
      ).toBeNull();
    // A body on a read route is not read; a body on a write route is read for its fields only.
    const posted = await client.post("/session", { intent: "sign-out", userId: USERS.admin });
    expect(posted.status).toBe(303);
    expect((await client.whoami()).userId).toBeNull();
    const asJson = await client.json("POST", "/session", {
      intent: "sign-out",
      userId: USERS.admin,
      user: USERS.admin,
    });
    expect(asJson.status).toBe(200);
    expect((await client.whoami()).userId).toBeNull();
  });

  it("does not let a signed-in person become another by sending that person's id", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const response = await client.get("/__test/whoami?userId=" + USERS.admin, {
      "x-user-id": USERS.admin,
    });
    expect(((await response.json()) as { userId: string }).userId).toBe(USERS.associate);
  });
});

describe("signing in and out", () => {
  it("refuses an identity that is not on the list, with a message that does not repeat it", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const marker = "usr_MARKER_not_a_person";
    const response = await client.post("/session", { intent: "sign-in", userId: marker });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(marker);
    expect(parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    const missing = await client.post("/session", { intent: "sign-in" });
    expect(missing.status).toBe(400);
    const odd = await client.post("/session", { intent: "become-root", userId: USERS.admin });
    expect(odd.status).toBe(400);
  });

  it("ends the session: the cookie is cleared and the next request is anonymous", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const response = await client.post("/session/end");
    expect(response.status).toBe(303);
    const cleared = parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)!;
    expect(cleared.attributes.get("max-age")).toBe("0");
    expect(cleared.attributes.get("httponly")).toBe(true);
    expect(cleared.attributes.get("samesite")).toBe("Strict");
    expect((await client.whoami()).userId).toBeNull();
  });

  it("also ends it from the sign-out form, which posts to /session", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const response = await client.post("/session", { intent: "sign-out" });
    expect(response.status).toBe(303);
    expect((await client.whoami()).userId).toBeNull();
  });

  it("ends it on the server too: a copy of the cookie taken before sign-out no longer works", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const copied = client.jar.get(SESSION_COOKIE)!;
    expect((await holding(shell, copied).whoami()).userId).toBe(USERS.associate);
    expect((await client.post("/session/end")).status).toBe(303);
    expect((await client.whoami()).userId).toBeNull();
    // The browser forgot it, but a copy replayed from somewhere else is refused as well.
    expect((await holding(shell, copied).whoami()).userId).toBeNull();
    // And it stays refused, with the signature still valid and the eight hours not yet over.
    shell.clock.advance(HOUR_MS);
    expect((await holding(shell, copied).whoami()).userId).toBeNull();
  });

  it("does the same when the sign-out form posts to /session", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.reviewer);
    const copied = client.jar.get(SESSION_COOKIE)!;
    expect((await client.post("/session", { intent: "sign-out" })).status).toBe(303);
    expect((await holding(shell, copied).whoami()).userId).toBeNull();
  });

  it("ends only the session that signed out, not another one the same person holds", async () => {
    const shell = makeShell();
    const laptop = await shell.signIn(USERS.associate);
    shell.clock.advance(5_000);
    const phone = await shell.signIn(USERS.associate);
    expect(phone.jar.get(SESSION_COOKIE)).not.toBe(laptop.jar.get(SESSION_COOKIE));
    const copiedPhone = phone.jar.get(SESSION_COOKIE)!;
    await laptop.post("/session/end");
    expect((await laptop.whoami()).userId).toBeNull();
    expect((await holding(shell, copiedPhone).whoami()).userId).toBe(USERS.associate);
  });

  it("does not let a replayed copy write: it has no person and no token that fits", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const copied = client.jar.get(SESSION_COOKIE)!;
    const token = await client.token();
    await client.post("/session/end", {}, token);
    const replay = holding(shell, copied);
    const response = await replay.post(
      "/session",
      { intent: "sign-in", userId: USERS.admin },
      token,
    );
    expect(response.status).toBe(403);
    expect((await replay.whoami()).userId).toBeNull();
  });

  it("lets the same person sign straight back in, even within the second they signed out", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const first = client.jar.get(SESSION_COOKIE)!;
    await client.post("/session/end");
    expect((await client.whoami()).userId).toBeNull();
    // The clock has not moved, so the new value is the one that was just ended: it is a new grant.
    await client.post("/session", { intent: "sign-in", userId: USERS.associate });
    expect(client.jar.get(SESSION_COOKIE)).toBe(first);
    expect((await client.whoami()).userId).toBe(USERS.associate);
  });

  it("is also forgotten by a sign-out that arrives with a cookie nobody issued", async () => {
    const shell = makeShell();
    const forged = mintSessionValue(OTHER_SECRET, USERS.admin, START);
    const client = holding(shell, forged);
    expect((await client.post("/session/end")).status).toBe(303);
    // The signature is not ours, so nothing was recorded, and it is anonymous either way.
    expect((await holding(shell, forged).whoami()).userId).toBeNull();
    const ours = mintSessionValue(SECRET, USERS.admin, START);
    expect((await holding(shell, ours).whoami()).userId).toBe(USERS.admin);
  });

  it("lets one person switch to another", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const response = await client.post("/session", { intent: "sign-in", userId: USERS.reviewer });
    expect(response.status).toBe(303);
    expect((await client.whoami()).userId).toBe(USERS.reviewer);
  });

  it("answers a JSON sign-in with the person, not a redirect", async () => {
    const shell = makeShell();
    const client = shell.anonymous();
    const response = await client.json("POST", "/session", { userId: USERS.reviewer });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      user: {
        userId: USERS.reviewer,
        displayName: shell.repo.getUser(USERS.reviewer)!.displayName,
        globalRole: "member",
      },
    });
  });

  it("is switched off with the demo identity: no sign-in, no identity, and sign-out still works", async () => {
    const shell = makeShell({ demoIdentity: false });
    const client = shell.anonymous();
    const response = await client.post("/session", { intent: "sign-in", userId: USERS.admin });
    expect(response.status).toBe(404);
    expect(parseSetCookies(response).find((c) => c.name === SESSION_COOKIE)).toBeUndefined();
    // A correctly signed cookie, with the mechanism off, is still nobody.
    const forged = holding(shell, mintSessionValue(SECRET, USERS.admin, START));
    expect((await forged.whoami()).userId).toBeNull();
    const out = await client.post("/session", { intent: "sign-out" });
    expect(out.status).toBe(303);
  });
});

describe("the record of ended sessions", () => {
  it("keeps a value until it would have expired anyway, and then lets it go", () => {
    const revocations = new SessionRevocations();
    revocations.revoke("v1.a.1.sig", 10_000, 1_000);
    expect(revocations.isRevoked("v1.a.1.sig", 5_000)).toBe(true);
    expect(revocations.isRevoked("v1.b.1.sig", 5_000)).toBe(false);
    expect(revocations.isRevoked("v1.a.1.sig", 10_000)).toBe(false);
    expect(revocations.size).toBe(0);
  });

  it("forgets what has expired when it records something new", () => {
    const revocations = new SessionRevocations();
    revocations.revoke("old", 2_000, 0);
    revocations.revoke("new", 20_000, 5_000);
    expect(revocations.size).toBe(1);
  });

  it("can be released, for a person who signs in again", () => {
    const revocations = new SessionRevocations();
    revocations.revoke("v", 10_000, 0);
    revocations.release("v");
    expect(revocations.isRevoked("v", 1)).toBe(false);
  });

  it("is bounded: past its limit the oldest goes first", () => {
    const revocations = new SessionRevocations(3);
    for (const name of ["a", "b", "c", "d"]) revocations.revoke(name, 100_000, 0);
    expect(revocations.size).toBe(3);
    expect(revocations.isRevoked("a", 1)).toBe(false);
    expect(revocations.isRevoked("d", 1)).toBe(true);
  });
});
