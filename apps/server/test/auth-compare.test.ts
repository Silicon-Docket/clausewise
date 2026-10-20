import { describe, expect, it, vi } from "vitest";

// The access token is compared through the standard library's constant time function, whatever
// the token that was sent. A check written with === would pass every other test of the token and
// fail this one.
const calls = vi.hoisted(() => [] as [number, number][]);

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      calls.push([a.byteLength, b.byteLength]);
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { tokensMatch } = await import("../src/security.js");
const { createHarness, oracleFor } = await import("./support.js");

const TOKEN = "correct-horse-battery-staple";

describe("comparing the access token", () => {
  it("compares digests of the same length in constant time, for tokens of any length", () => {
    calls.length = 0;
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch("short", TOKEN)).toBe(false);
    expect(tokensMatch(`${TOKEN}${TOKEN}`, TOKEN)).toBe(false);
    expect(tokensMatch("", TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN.replace("c", "d"), TOKEN)).toBe(false);
    // The function throws on buffers of different lengths, so every call must have been given
    // two of the same.
    expect(calls).toHaveLength(5);
    expect(calls.every(([a, b]) => a === b && a === 32)).toBe(true);
  });

  it("goes through that comparison for every request that carries a token", async () => {
    const t = await createHarness({
      generator: await oracleFor("nda-aggressive.docx"),
      config: { accessToken: TOKEN },
    });
    calls.length = 0;
    const statuses: number[] = [];
    for (const token of [TOKEN, "wrong", `${TOKEN}-and-more`, "x".repeat(10_000)]) {
      const response = await t.request("/api/documents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 401, 401, 401]);
    expect(calls).toHaveLength(4);
    expect(calls.every(([a, b]) => a === 32 && b === 32)).toBe(true);
  });
});
