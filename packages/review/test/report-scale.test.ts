import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/report.js";
import type { ReviewReport, RuleResult } from "../src/types.js";

// Written as code points because an editor or formatter may turn the escapes into the characters.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);

function reportOf(
  overrides: Partial<RuleResult> = {},
  extra: Partial<ReviewReport> = {},
): ReviewReport {
  return {
    document: "contract.docx",
    playbook: { name: "Playbook", contractTypes: ["nda"] },
    model: { provider: "test", model: "model-1", disclosure: "Test server (localhost)" },
    counts: { compliant: 0, deviation: 1, missing: 0, not_applicable: 0, error: 0 },
    open: { high: 1, medium: 0, low: 0 },
    results: [
      {
        ruleId: "term",
        title: "Duration",
        severity: "high",
        required: true,
        status: "deviation",
        clauseIds: [],
        clauseNumbers: [],
        explanation: "Too long.",
        comment: "",
        suggestedClause: null,
        edit: { kind: "none" },
        ...overrides,
      },
    ],
    stats: { paragraphs: 5, clauses: 3, windows: 1, editsApplied: 0 },
    ...extra,
  };
}

const commentOnly = (reason: string) =>
  ({
    kind: "comment-only",
    proposed: { clauseId: "c1", quote: "q", replacement: "r" },
    reason,
  }) as const;

// Each shape is text a model could write: a long run of one character that a pattern might rescan
// from every start. The size is the length of the field in characters.
const SHAPES: { name: string; make: (size: number) => ReviewReport }[] = [
  {
    name: "spaces before a dash in a suggested clause",
    make: (n) => reportOf({ status: "missing", suggestedClause: `a${" ".repeat(n)}x${EM_DASH}` }),
  },
  {
    name: "tabs before a dash in a suggested clause",
    make: (n) => reportOf({ status: "missing", suggestedClause: `a${"\t".repeat(n)}x${EN_DASH}` }),
  },
  {
    name: "blank lines made of spaces in a suggested clause",
    make: (n) => reportOf({ status: "missing", suggestedClause: `a${"\n \n".repeat(n / 3)}b` }),
  },
  {
    name: "one line per character in a suggested clause",
    make: (n) => reportOf({ status: "missing", suggestedClause: "a\n".repeat(n / 2) }),
  },
  {
    name: "dots before the end of a disclosure",
    make: (n) =>
      reportOf({}, { model: { provider: "p", model: "m", disclosure: `${".".repeat(n)}x` } }),
  },
  {
    name: "dots and spaces before the end of a reason",
    make: (n) => reportOf({ edit: commentOnly(`${". ".repeat(n / 2)}x`) }),
  },
  {
    name: "spaces and dashes in an explanation",
    make: (n) => reportOf({ explanation: ` ${EN_DASH}`.repeat(n / 2) }),
  },
  {
    name: "backticks in a quoted passage",
    make: (n) =>
      reportOf({
        edit: {
          kind: "applied",
          paragraphId: "p:1",
          start: 0,
          end: 1,
          original: "`".repeat(n),
          replacement: "x",
        },
      }),
  },
  {
    name: "every markup character in an explanation",
    make: (n) => reportOf({ explanation: "*_#|~<>[]\\`".repeat(n / 10) }),
  },
  {
    name: "control characters and line breaks in an explanation",
    make: (n) => reportOf({ explanation: "\u0000\u0001 \n".repeat(n / 4) }),
  },
  {
    name: "dots and spaces in a warning",
    make: (n) => reportOf({}, { warnings: [`${". ".repeat(n / 2)}x ${EM_DASH}`] }),
  },
  {
    name: "at signs in an explanation",
    make: (n) => reportOf({ explanation: `${"@".repeat(n)}.x` }),
  },
  {
    name: "letters and at signs, with a dot at the end, in an explanation",
    make: (n) => reportOf({ explanation: `${"a@".repeat(n / 2)}.x` }),
  },
  {
    name: "a long local part with no at sign in an explanation",
    make: (n) => reportOf({ explanation: `${"a.".repeat(n / 2)}b` }),
  },
  {
    name: "repeated www names in one word",
    make: (n) => reportOf({ explanation: "www.".repeat(n / 4) }),
  },
  {
    name: "repeated scheme separators in one word",
    make: (n) => reportOf({ explanation: "://".repeat(n / 3) }),
  },
  {
    name: "many short addresses in a suggested clause",
    make: (n) => reportOf({ status: "missing", suggestedClause: "a@b.co ".repeat(n / 7) }),
  },
  {
    name: "backticks inside an address",
    make: (n) => reportOf({ explanation: `https://x.test/${"`".repeat(n)}` }),
  },
  {
    name: "a long opening excerpt of a clause",
    make: (n) => reportOf({ clauseIds: ["c1"], clauseExcerpts: ["word ".repeat(n / 5)] }),
  },
  {
    name: "a long title with a list marker",
    make: (n) => reportOf({ title: `- ${"word ".repeat(n / 5)}` }),
  },
];

const time = (report: ReviewReport): number => {
  const started = performance.now();
  renderMarkdown(report);
  return performance.now() - started;
};

describe("renderMarkdown on text a model could use to stall it", () => {
  // A quadratic pass takes seconds at a hundred thousand characters, where a linear one takes
  // milliseconds. The probe comes first so that a regression fails here instead of hanging the
  // run for minutes on the big one.
  it.each(SHAPES)("takes linear time for $name", ({ make }) => {
    expect(time(make(100_000))).toBeLessThan(3000);
    expect(time(make(1_000_000))).toBeLessThan(10_000);
  });

  it("renders a million characters in every field of one report at once", () => {
    const n = 1_000_000;
    const big = `${"word ".repeat(n / 10)}${EM_DASH}${" ".repeat(n / 10)}x`;
    const report = reportOf(
      {
        title: big,
        explanation: big,
        comment: big,
        status: "missing",
        suggestedClause: big,
        clauseNumbers: [big],
        edit: commentOnly(big),
      },
      {
        document: big,
        playbook: { name: big, contractTypes: [big] },
        model: { provider: big, model: big, disclosure: big },
        warnings: [big, big],
      },
    );
    expect(time(report)).toBeLessThan(12_000);
  });
});
