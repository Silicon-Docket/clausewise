import { describe, expect, it } from "vitest";
import { PlaybookError, parsePlaybook } from "../src/index.js";

const valid = `
name: Test playbook
contractTypes: [nda]
perspective: We are the receiving party.
rules:
  - id: term
    title: Term
    severity: high
    required: true
    standard: No more than three years.
    fallback: Up to five years.
    unacceptable: Perpetual.
    guidance: Prefer a fixed term.
  - id: law
    title: Governing law
    severity: low
    standard: A US state we operate in.
`;

describe("parsePlaybook", () => {
  it("parses a valid playbook and defaults required to false", () => {
    const pb = parsePlaybook(valid);
    expect(pb.name).toBe("Test playbook");
    expect(pb.rules.map((r) => [r.id, r.required])).toEqual([
      ["term", true],
      ["law", false],
    ]);
    expect(pb.rules[1]?.fallback).toBeUndefined();
  });

  it("lists every problem with a path", () => {
    const bad = `
name: ""
contractTypes: []
perspective: x
rules:
  - id: Bad_ID
    title: T
    severity: critical
    standard: s
`;
    const err = catchError(() => parsePlaybook(bad, "bad.yaml"));
    expect(err).toBeInstanceOf(PlaybookError);
    const problems = (err as PlaybookError).problems.join("\n");
    expect(problems).toMatch(/^name:/m);
    expect(problems).toMatch(/^contractTypes:/m);
    expect(problems).toMatch(/^rules\[0\]\.id:/m);
    expect(problems).toMatch(/^rules\[0\]\.severity:/m);
    expect((err as PlaybookError).message).toContain("bad.yaml is invalid");
  });

  it("rejects duplicate rule ids", () => {
    const err = catchError(() => parsePlaybook(valid.replace("id: law", "id: term")));
    expect((err as PlaybookError).problems).toContain('rules[1].id: duplicate rule id "term"');
  });

  it("rejects unknown keys, so a typo is not silently ignored", () => {
    const err = catchError(() =>
      parsePlaybook(valid.replace("severity: low", "severity: low\n    sevrity: x")),
    );
    expect(err).toBeInstanceOf(PlaybookError);
  });

  it("rejects an empty rules list and malformed YAML", () => {
    expect(() => parsePlaybook("name: x\ncontractTypes: [a]\nperspective: p\nrules: []")).toThrow(
      PlaybookError,
    );
    expect(() => parsePlaybook("name: [unclosed")).toThrow(/not valid YAML/);
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}
