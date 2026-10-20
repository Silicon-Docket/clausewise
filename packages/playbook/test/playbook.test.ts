import { describe, expect, it } from "vitest";
import { PlaybookError, hasVisibleText, parsePlaybook } from "../src/index.js";

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

// Characters that draw nothing, by code point so that this file stays plain ASCII.
const INVISIBLE: [string, number][] = [
  ["a space", 0x20],
  ["a tab", 0x09],
  ["a line break", 0x0a],
  ["a no-break space", 0xa0],
  ["an ideographic space", 0x3000],
  ["a line separator", 0x2028],
  ["a soft hyphen", 0x00ad],
  ["a zero-width space", 0x200b],
  ["a zero-width non-joiner", 0x200c],
  ["a zero-width joiner", 0x200d],
  ["a word joiner", 0x2060],
  ["a byte order mark", 0xfeff],
  ["a left-to-right mark", 0x200e],
  ["a right-to-left mark", 0x200f],
  ["a left-to-right embedding", 0x202a],
  ["a right-to-left override", 0x202e],
  ["a left-to-right isolate", 0x2066],
  ["a pop directional isolate", 0x2069],
  ["an Arabic letter mark", 0x061c],
  ["a combining grapheme joiner", 0x034f],
  ["a variation selector", 0xfe0f],
  ["a Mongolian vowel separator", 0x180e],
  ["a Hangul filler", 0x3164],
  ["a blank braille pattern", 0x2800],
  ["a tag character", 0xe0041],
  ["a lone combining mark", 0x0301],
  ["a control character", 0x07],
];

const char = (codePoint: number): string => String.fromCodePoint(codePoint);

// A YAML double-quoted scalar, so that a line break or a tab survives as a value.
const quoted = (value: string): string => JSON.stringify(value);

function problemsOf(yamlText: string): string[] {
  return (catchError(() => parsePlaybook(yamlText)) as PlaybookError).problems;
}

function withField(field: "name" | "perspective" | "title" | "standard", value: string): string {
  const lines = valid.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith(`${field}:`));
  const indent = /^\s*/.exec(lines[at] ?? "")?.[0] ?? "";
  lines[at] = `${indent}${field}: ${quoted(value)}`;
  return lines.join("\n");
}

const PATHS = {
  name: "name",
  perspective: "perspective",
  title: "rules[0].title",
  standard: "rules[0].standard",
} as const;

describe("text that is blank to the eye", () => {
  describe.each(INVISIBLE)("made only of %s", (_label, codePoint) => {
    const blank = char(codePoint).repeat(3);

    it.each(Object.entries(PATHS))("is rejected as the %s", (field, path) => {
      const err = catchError(() =>
        parsePlaybook(withField(field as keyof typeof PATHS, blank), "blank.yaml"),
      );
      expect(err).toBeInstanceOf(PlaybookError);
      expect((err as PlaybookError).problems).toEqual([
        `${path}: must contain a visible character, not only spaces or invisible ones`,
      ]);
    });
  });

  it("is rejected when invisible characters of different kinds are mixed", () => {
    const mixed = [0x20, 0x200b, 0x00ad, 0x200e, 0xfeff, 0x0a].map(char).join("");
    expect(() => parsePlaybook(withField("title", mixed))).toThrow(PlaybookError);
  });

  it("is rejected in the optional texts too, so no prompt line is blank", () => {
    for (const key of ["fallback", "unacceptable", "guidance"]) {
      const text = valid.replace("  - id: law", `  - id: law\n    ${key}: ${quoted(char(0x200b))}`);
      const err = catchError(() => parsePlaybook(text));
      expect((err as PlaybookError).problems.join("\n"), key).toMatch(
        new RegExp(`^rules\\[1\\]\\.${key}: must contain a visible character`, "m"),
      );
    }
    const description = valid.replace(
      "name: Test playbook",
      `name: Test playbook\ndescription: ${quoted("  ")}`,
    );
    expect(problemsOf(description)).toContain(
      "description: must contain a visible character, not only spaces or invisible ones",
    );
    const type = valid.replace("contractTypes: [nda]", `contractTypes: [${quoted(char(0x200b))}]`);
    expect(problemsOf(type)).toContain(
      "contractTypes[0]: must contain a visible character, not only spaces or invisible ones",
    );
  });

  it("is rejected as a rule id, which has a stricter pattern anyway", () => {
    for (const [, codePoint] of INVISIBLE) {
      const id = char(codePoint).repeat(2);
      const err = catchError(() => parsePlaybook(valid.replace("id: law", `id: ${quoted(id)}`)));
      expect(err, String(codePoint)).toBeInstanceOf(PlaybookError);
      expect((err as PlaybookError).problems.join("\n")).toMatch(/^rules\[1\]\.id: /m);
    }
  });

  it("accepts a title that has a visible character among invisible ones, and keeps it as written", () => {
    const title = `${char(0x200b)}Term${char(0x00ad)} `;
    expect(parsePlaybook(withField("title", title)).rules[0]?.title).toBe(title);
  });

  it.each([
    ["a word", "Term"],
    ["one letter", "x"],
    ["a digit", "1"],
    ["Chinese characters", "\u{6761}\u{6b3e}"],
    ["an emoji", "\u{1f512}"],
    ["a letter with a combining accent", "e\u{301}"],
  ])("sees %s", (_label, text) => {
    expect(hasVisibleText(text)).toBe(true);
  });

  it.each([
    ["nothing", ""],
    ["a space", " "],
    ["a zero-width space", "\u{200b}"],
    ["a soft hyphen and a no-break space", "\u{ad}\u{a0}"],
    ["a lone combining accent", "\u{301}"],
  ])("sees nothing in %s", (_label, text) => {
    expect(hasVisibleText(text)).toBe(false);
  });
});

describe("rule kind", () => {
  const withKind = (kind: string, required = "false"): string =>
    valid.replace(
      "    standard: A US state we operate in.",
      `    kind: ${kind}\n    required: ${required}\n    standard: The agreement contains no foreign courts.`,
    );

  it("is optional, and a rule without one has none recorded", () => {
    expect(parsePlaybook(valid).rules.map((r) => r.kind)).toEqual([undefined, undefined]);
  });

  it("accepts presence and absence", () => {
    expect(parsePlaybook(withKind("absence")).rules[1]?.kind).toBe("absence");
    expect(parsePlaybook(withKind("presence", "true")).rules[1]?.kind).toBe("presence");
  });

  it("accepts a required presence rule but not a required absence rule", () => {
    expect(parsePlaybook(withKind("presence", "true")).rules[1]?.required).toBe(true);
    const err = catchError(() => parsePlaybook(withKind("absence", "true")));
    expect((err as PlaybookError).problems).toEqual([
      'rules[1].required: rule "law" is an absence rule, which passes when the clause is not there, so it cannot be required',
    ]);
  });

  it("rejects any other kind", () => {
    const err = catchError(() => parsePlaybook(withKind("prohibition")));
    expect((err as PlaybookError).problems.join("\n")).toMatch(/^rules\[1\]\.kind:/m);
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
