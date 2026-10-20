// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyBulk } from "../src/lib/findings.js";
import { isSameJson, shareUnchanged } from "../src/lib/share.js";
import { appliedFinding, commentOnlyFinding, missingFinding, reviewDetail } from "./fixtures.js";

/** What a second read of the same review looks like: equal in content, new in every object. */
const reread = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("isSameJson", () => {
  it.each([
    [1, 1],
    ["a", "a"],
    [null, null],
    [[], []],
    [{}, {}],
    [
      [1, [2, { a: 3 }]],
      [1, [2, { a: 3 }]],
    ],
    [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ],
  ])("finds %j and %j the same", (a, b) => {
    expect(isSameJson(a, b)).toBe(true);
  });

  it.each([
    [1, 2],
    ["a", "b"],
    [null, {}],
    [null, undefined],
    [[], {}],
    [[1], [1, 2]],
    [
      [1, 2],
      [2, 1],
    ],
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: 2 }, { a: 1 }],
    [{ a: 1 }, { b: 1 }],
    [{ a: { b: [1] } }, { a: { b: [2] } }],
    [{ a: undefined }, { b: undefined }],
  ])("finds %j and %j different", (a, b) => {
    expect(isSameJson(a, b)).toBe(false);
  });
});

describe("shareUnchanged", () => {
  const detail = () =>
    reviewDetail({
      findings: [
        appliedFinding({ ruleId: "a" }),
        commentOnlyFinding({ ruleId: "b" }),
        missingFinding({ ruleId: "c" }),
      ],
    });

  it("takes the first read as it is", () => {
    const first = detail();
    expect(shareUnchanged(null, first)).toBe(first);
  });

  it("gives back the very same review when a read learned nothing", () => {
    const before = detail();
    expect(shareUnchanged(before, reread(before))).toBe(before);
  });

  it("keeps the list of findings and every finding when only the progress changed", () => {
    const before = detail();
    const next = { ...reread(before), progress: { done: 3, total: 9 } };
    const shared = shareUnchanged(before, next);
    expect(shared).not.toBe(before);
    expect(shared.progress).toEqual({ done: 3, total: 9 });
    expect(shared.findings).toBe(before.findings);
  });

  it("keeps the findings that did not change and takes the one that did", () => {
    const before = detail();
    const next = reread(before);
    next.findings[1] = {
      ...(next.findings[1] as (typeof next.findings)[number]),
      decision: "accepted",
    };
    const shared = shareUnchanged(before, next);
    expect(shared.findings).not.toBe(before.findings);
    expect(shared.findings[0]).toBe(before.findings[0]);
    expect(shared.findings[2]).toBe(before.findings[2]);
    expect(shared.findings[1]).not.toBe(before.findings[1]);
    expect(shared.findings[1]?.decision).toBe("accepted");
  });

  it("notices a change deep inside a finding, such as one word of a clause", () => {
    const before = detail();
    const next = reread(before);
    const first = next.findings[0] as (typeof next.findings)[number];
    first.clauses[0] = {
      ...(first.clauses[0] as (typeof first.clauses)[number]),
      text: "Changed.",
    };
    const shared = shareUnchanged(before, next);
    expect(shared.findings[0]).not.toBe(before.findings[0]);
    expect(shared.findings[0]?.clauses[0]?.text).toBe("Changed.");
    expect(shared.findings[1]).toBe(before.findings[1]);
  });

  it("follows the server's order and its additions and removals, reusing what it can", () => {
    const before = detail();
    const next = reread(before);
    next.findings = [next.findings[2], next.findings[0]] as typeof next.findings;
    const shared = shareUnchanged(before, next);
    expect(shared.findings.map((f) => f.ruleId)).toEqual(["c", "a"]);
    expect(shared.findings[0]).toBe(before.findings[2]);
    expect(shared.findings[1]).toBe(before.findings[0]);
  });

  it("does not mistake a finding with another rule id for the one before", () => {
    const before = detail();
    const next = reread(before);
    next.findings = next.findings.map((f) => ({ ...f, ruleId: `${f.ruleId}2` }));
    const shared = shareUnchanged(before, next);
    for (const finding of shared.findings) expect(before.findings).not.toContain(finding);
  });
});

describe("applyBulk", () => {
  it("leaves a finding that already has the decision, and one out of scope, as the same object", () => {
    const findings = [
      appliedFinding({ ruleId: "a", decision: "accepted" }),
      commentOnlyFinding({ ruleId: "b" }),
      missingFinding({ ruleId: "c" }),
    ];
    const result = applyBulk(findings, "accepted", ["high", "medium"]);
    expect(result[0]).toBe(findings[0]);
    expect(result[1]).not.toBe(findings[1]);
    expect(result[1]?.decision).toBe("accepted");
    // Low severity is out of scope.
    expect(result[2]).toBe(findings[2]);
  });
});
