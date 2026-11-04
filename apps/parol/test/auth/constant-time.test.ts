import { describe, expect, it, vi } from "vitest";

/**
 * Cookies and tokens are compared with `timingSafeEqual`, never with `===`. A timing test would be
 * flaky in a unit suite, so this proves the next best thing: every place a signature or a token is
 * checked goes through `timingSafeEqual`, for a wrong value as well as a right one, and a value
 * that differs from the first byte is compared to the end like any other.
 */
const spy = vi.hoisted(() => ({ calls: [] as { equalLength: boolean }[] }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      spy.calls.push({ equalLength: a.byteLength === b.byteLength });
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { safeEqual } = await import("../../src/auth/crypto.js");
const { SESSION_COOKIE, mintSessionValue, parseSessionValue } =
  await import("../../src/auth/identity.js");
const { ANON_COOKIE, isValidAnonValue, tokenForBinding } = await import("../../src/auth/csrf.js");
const { SECRET, START, USERS, makeShell } = await import("../server/support-app.js");

describe("constant-time comparison", () => {
  it("safeEqual compares equal-length strings with timingSafeEqual and says which are equal", () => {
    spy.calls.length = 0;
    expect(safeEqual("abcdef", "abcdef")).toBe(true);
    expect(safeEqual("abcdef", "abcdeg")).toBe(false);
    expect(safeEqual("zbcdef", "abcdef")).toBe(false);
    expect(spy.calls).toHaveLength(3);
  });

  it("safeEqual does not throw on strings of different length, and still does the work", () => {
    spy.calls.length = 0;
    expect(safeEqual("short", "a much longer string")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("é", "e")).toBe(false);
    expect(spy.calls.length).toBe(3);
  });

  it("checks a session signature with it, whether the signature is right or wrong", () => {
    const good = mintSessionValue(SECRET, USERS.associate, START);
    spy.calls.length = 0;
    expect(parseSessionValue(SECRET, good, START)).toBe(USERS.associate);
    expect(spy.calls).toHaveLength(1);
    spy.calls.length = 0;
    const parts = good.split(".");
    parts[3] = `${parts[3]!.slice(0, -1)}${parts[3]!.endsWith("A") ? "B" : "A"}`;
    expect(parseSessionValue(SECRET, parts.join("."), START)).toBeNull();
    expect(spy.calls).toEqual([{ equalLength: true }]);
  });

  it("checks an anonymous cookie signature with it", async () => {
    const shell = makeShell();
    const visitor = shell.anonymous();
    await visitor.token();
    const value = visitor.jar.get(ANON_COOKIE)!;
    spy.calls.length = 0;
    expect(isValidAnonValue(SECRET, value, START)).toBe(true);
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("checks a CSRF token with it, for a right token, a wrong one and a missing one", async () => {
    const shell = makeShell();
    const client = await shell.signIn(USERS.associate);
    const token = await client.token();
    for (const [label, provided] of [
      ["right", token],
      ["wrong", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`],
      ["short", "x"],
      ["empty header, so the form is read", ""],
    ] as const) {
      spy.calls.length = 0;
      await client.json("POST", "/session/end", {}, provided === "" ? false : provided);
      expect(spy.calls.length, label).toBeGreaterThanOrEqual(1);
      // Put the session back for the next round.
      await client.post("/session", { intent: "sign-in", userId: USERS.associate });
    }
    // A token cannot be derived from the cookie alone.
    expect(tokenForBinding(SECRET, `s:${client.jar.get(SESSION_COOKIE)}`)).toBe(
      await client.token(),
    );
  });

  it("still compares when there is no cookie at all, so a missing cookie and a wrong token take alike", async () => {
    const shell = makeShell();
    spy.calls.length = 0;
    const response = await shell
      .anonymous()
      .post("/session", { intent: "sign-in", userId: USERS.admin }, "guess");
    expect(response.status).toBe(403);
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
  });
});
