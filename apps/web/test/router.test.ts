// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { hrefFor, navigate, parseHash } from "../src/router.js";
import { installCommonHooks } from "./support.js";

installCommonHooks();

describe("parseHash", () => {
  it("reads the start screen from an empty address or a bare slash", () => {
    expect(parseHash("")).toEqual({ name: "start" });
    expect(parseHash("#")).toEqual({ name: "start" });
    expect(parseHash("#/")).toEqual({ name: "start" });
  });

  it("reads a review and its id", () => {
    expect(parseHash("#/reviews/3f2a")).toEqual({ name: "review", id: "3f2a" });
    expect(parseHash("#/reviews/3f2a/")).toEqual({ name: "review", id: "3f2a" });
  });

  it("reads the playbooks screen", () => {
    expect(parseHash("#/playbooks")).toEqual({ name: "playbooks" });
  });

  it("decodes an id that was escaped", () => {
    expect(parseHash("#/reviews/a%20b")).toEqual({ name: "review", id: "a b" });
  });

  it("ignores a query after the path", () => {
    expect(parseHash("#/playbooks?x=1")).toEqual({ name: "playbooks" });
  });

  it.each([
    ["an unknown screen", "#/settings"],
    ["a review with no id", "#/reviews"],
    ["a review with two ids", "#/reviews/a/b"],
    ["a broken escape", "#/reviews/%E0%A4%A"],
    ["playbooks with more after it", "#/playbooks/builtin"],
  ])("calls %s not found", (_name, hash) => {
    expect(parseHash(hash)).toEqual({ name: "not-found" });
  });
});

describe("hrefFor and navigate", () => {
  it("builds addresses that parse back to the same screen", () => {
    for (const route of [
      { name: "start" } as const,
      { name: "playbooks" } as const,
      { name: "review", id: "abc-123" } as const,
      { name: "review", id: "has space/and slash" } as const,
    ]) {
      expect(parseHash(hrefFor(route))).toEqual(route);
    }
  });

  it("changes the address bar", () => {
    navigate({ name: "review", id: "r1" });
    expect(window.location.hash).toBe("#/reviews/r1");
    navigate({ name: "playbooks" });
    expect(window.location.hash).toBe("#/playbooks");
  });
});
