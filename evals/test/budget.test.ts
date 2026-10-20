import { describe, expect, it } from "vitest";
import { BudgetExceeded, createBudget, worstCaseUsd } from "../src/budget.js";
import type { Price } from "../src/prices.js";

const price: Price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const body = (maxTokens: number, pad = 0): string =>
  JSON.stringify({ max_tokens: maxTokens, messages: [{ role: "user", content: "x".repeat(pad) }] });

const ok = (): Response => new Response("{}", { status: 200 });

describe("the worst case of a request", () => {
  it("prices every output token it may generate and the whole body at the dearer prompt rate", () => {
    const text = body(1000, 3000);
    const bytes = Buffer.byteLength(text);
    const expected = (Math.ceil(bytes / 3) * 2.5 + 1000 * 10) / 1_000_000;
    expect(worstCaseUsd(text, price)).toBeCloseTo(expected, 12);
  });

  it("counts bytes, so a script of several bytes per character is not undercounted", () => {
    const ascii = JSON.stringify({ max_tokens: 1, p: "a".repeat(300) });
    const cjk = JSON.stringify({ max_tokens: 1, p: String.fromCodePoint(0x4e2d).repeat(300) });
    expect(worstCaseUsd(cjk, price)).toBeGreaterThan(worstCaseUsd(ascii, price) * 2);
  });

  it("is unbounded when the request cannot be read, which refuses it", () => {
    expect(worstCaseUsd(undefined, price)).toBe(Number.POSITIVE_INFINITY);
    expect(worstCaseUsd("not json", price)).toBe(Number.POSITIVE_INFINITY);
    expect(worstCaseUsd("{}", price)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("the request budget", () => {
  it("holds a request back while requests under way could use up the room, and sends it after", async () => {
    const worst = worstCaseUsd(body(16000), price);
    let sent = 0;
    const budget = createBudget({
      price,
      maxCostUsd: worst * 2.5,
      spentUsd: () => 0,
      stop: () => {},
      inner: () => {
        sent += 1;
        return Promise.resolve(ok());
      },
    });
    await budget.fetch("https://example.invalid", { body: body(16000) });
    await budget.fetch("https://example.invalid", { body: body(16000) });
    const third = budget.fetch("https://example.invalid", { body: body(16000) });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toBe(2);

    // The first response arrives and its real cost replaces its reservation.
    budget.settled();
    await third;
    expect(sent).toBe(3);
  });

  it("ends the run when a request would not fit even with nothing else under way", async () => {
    const worst = worstCaseUsd(body(16000), price);
    let stopped: BudgetExceeded | undefined;
    const budget = createBudget({
      price,
      maxCostUsd: worst * 1.5,
      spentUsd: () => worst,
      stop: (reason) => {
        stopped = reason;
      },
      inner: () => Promise.resolve(ok()),
    });
    await expect(
      budget.fetch("https://example.invalid", { body: body(16000) }),
    ).rejects.toBeInstanceOf(BudgetExceeded);
    expect(stopped?.message).toContain("--max-cost");
  });

  it("stops waiting when the run is aborted", async () => {
    const worst = worstCaseUsd(body(16000), price);
    const controller = new AbortController();
    const budget = createBudget({
      price,
      maxCostUsd: worst * 1.5,
      spentUsd: () => 0,
      stop: () => {},
      inner: () => Promise.resolve(ok()),
    });
    await budget.fetch("https://example.invalid", { body: body(16000) });
    const waiting = budget.fetch("https://example.invalid", {
      body: body(16000),
      signal: controller.signal,
    });
    controller.abort(new Error("Interrupted"));
    await expect(waiting).rejects.toThrow("Interrupted");
  });

  it("gives the reservation back when the request fails or the server answers with an error", async () => {
    const worst = worstCaseUsd(body(16000), price);
    let mode: "throw" | "status" | "ok" = "throw";
    const budget = createBudget({
      price,
      maxCostUsd: worst * 1.5,
      spentUsd: () => 0,
      stop: () => {},
      inner: () => {
        if (mode === "throw") return Promise.reject(new Error("no connection"));
        return Promise.resolve(new Response("{}", { status: mode === "status" ? 529 : 200 }));
      },
    });
    await expect(budget.fetch("https://example.invalid", { body: body(16000) })).rejects.toThrow(
      "no connection",
    );
    mode = "status";
    await budget.fetch("https://example.invalid", { body: body(16000) });
    mode = "ok";
    await budget.fetch("https://example.invalid", { body: body(16000) });
    expect(budget.reservedUsd()).toBeCloseTo(worst, 9);
  });
});
