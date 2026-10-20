import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/report.js";
import type { ReviewReport, RuleResult } from "../src/types.js";

function result(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
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
  };
}

function reportOf(results: RuleResult[], overrides: Partial<ReviewReport> = {}): ReviewReport {
  const counts = { compliant: 0, deviation: 0, missing: 0, not_applicable: 0, error: 0 };
  const open = { high: 0, medium: 0, low: 0 };
  for (const r of results) {
    counts[r.status] += 1;
    if (r.status === "deviation" || r.status === "missing") open[r.severity] += 1;
  }
  return {
    document: "contract.docx",
    playbook: { name: "Playbook", contractTypes: ["nda"] },
    model: { provider: "test", model: "model-1", disclosure: "Test server (localhost)" },
    counts,
    open,
    results,
    stats: { paragraphs: 5, clauses: 3, windows: 1, editsApplied: 0 },
    ...overrides,
  };
}

function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`## ${title}\n`);
  if (start === -1) throw new Error(`no section ${title}`);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe("clause names in the report", () => {
  it("names one clause without a number by its opening words", () => {
    const markdown = renderMarkdown(
      reportOf([result({ clauseIds: ["c7"], clauseExcerpts: ["Customer shall not"] })]),
    );
    expect(markdown).toContain(
      '**High** severity, deviation. The clause beginning "Customer shall not".',
    );
    expect(markdown).not.toContain("c7");
  });

  it("names clauses that have numbers by number and the others by their words", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          clauseIds: ["c3", "c7"],
          clauseNumbers: ["3.1"],
          clauseExcerpts: ["Customer shall not"],
        }),
      ]),
    );
    expect(markdown).toContain(
      '**High** severity, deviation. Clause 3.1 and the clause beginning "Customer shall not".',
    );
  });

  it("keeps numbers alone as they were", () => {
    const markdown = renderMarkdown(
      reportOf([result({ clauseIds: ["c3", "c5"], clauseNumbers: ["1.1", "2.1"] })]),
    );
    expect(markdown).toContain("**High** severity, deviation. Clauses 1.1, 2.1.");
  });

  it("never prints an id, even for a result that has no words for its clauses", () => {
    const one = renderMarkdown(reportOf([result({ clauseIds: ["c7"] })]));
    expect(one).toContain("**High** severity, deviation. A clause without a number.");
    expect(one).not.toContain("c7");
    const three = renderMarkdown(reportOf([result({ clauseIds: ["c7", "c8", "c9"] })]));
    expect(three).toContain("**High** severity, deviation. 3 clauses without a number.");
    expect(three).not.toMatch(/\bc[789]\b/);
  });

  it("names the clauses of a compliant result in its list line", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          status: "compliant",
          title: "Fine",
          clauseIds: ["c4"],
          clauseExcerpts: ["Each party shall keep"],
          explanation: "At the standard.",
        }),
      ]),
    );
    expect(section(markdown, "Compliant")).toContain(
      '- **Fine** (the clause beginning "Each party shall keep"): At the standard.',
    );
  });

  it("escapes the words of a clause like any other contract text", () => {
    const markdown = renderMarkdown(
      reportOf([result({ clauseIds: ["c2"], clauseExcerpts: ["*Customer* [shall] # not"] })]),
    );
    expect(markdown).toContain('The clause beginning "\\*Customer\\* \\[shall\\] \\# not".');
  });
});

describe("an empty list of findings when some rules could not be checked", () => {
  const errored = (ruleId: string): RuleResult =>
    result({
      ruleId,
      title: `Rule ${ruleId}`,
      status: "error",
      explanation: "",
      error: "The model declined to check this rule.",
    });
  const compliant = (ruleId: string): RuleResult =>
    result({ ruleId, title: `Rule ${ruleId}`, status: "compliant", clauseIds: ["c1"] });

  it("does not say that nothing needs attention", () => {
    const markdown = renderMarkdown(reportOf([compliant("a"), compliant("b"), errored("c")]));
    const attention = section(markdown, "Needs attention");
    expect(attention).toContain(
      "No deviations or missing clauses among the 2 rules that were checked.",
    );
    expect(attention).not.toContain("Nothing needs attention");
    expect(markdown).not.toContain("Nothing needs attention");
  });

  it("keeps the section for the rules that could not be checked", () => {
    const markdown = renderMarkdown(reportOf([compliant("a"), errored("c")]));
    expect(section(markdown, "Needs attention")).toContain('under "Could not be checked"');
    expect(section(markdown, "Could not be checked")).toContain("- **Rule c** (`c`): The model");
  });

  it("goes by the rules listed when the counts of a report file say none errored", () => {
    const report = reportOf([compliant("a"), errored("c")]);
    const markdown = renderMarkdown({ ...report, counts: { ...report.counts, error: 0 } });
    expect(section(markdown, "Needs attention")).toContain("among the 1 rule that was checked.");
    expect(markdown).not.toContain("Nothing needs attention");
  });

  it("goes by the counts when the results of a report file lack the rules that errored", () => {
    const report = reportOf([compliant("a"), compliant("b")]);
    const markdown = renderMarkdown({ ...report, counts: { ...report.counts, error: 1 } });
    expect(section(markdown, "Needs attention")).toContain("among the 2 rules that were checked.");
  });

  it("counts only the rules that were checked, and says it for one", () => {
    const one = renderMarkdown(reportOf([compliant("a"), errored("b"), errored("c")]));
    expect(section(one, "Needs attention")).toContain("among the 1 rule that was checked.");
  });

  it("counts a rule that does not apply as checked", () => {
    const markdown = renderMarkdown(
      reportOf([result({ ruleId: "n", status: "not_applicable" }), errored("c")]),
    );
    expect(section(markdown, "Needs attention")).toContain("among the 1 rule that was checked.");
  });

  it("says that nothing was checked when every rule errored", () => {
    const markdown = renderMarkdown(reportOf([errored("a"), errored("b")]));
    const attention = section(markdown, "Needs attention");
    expect(attention).toContain("No rule could be checked");
    expect(attention).not.toContain("Nothing needs attention");
    expect(attention).not.toContain("among the 0 rules");
  });

  it("still says that nothing needs attention when every rule was checked", () => {
    const markdown = renderMarkdown(reportOf([compliant("a"), compliant("b")]));
    expect(section(markdown, "Needs attention")).toContain("Nothing needs attention.");
    expect(section(markdown, "Could not be checked")).toContain("None.");
  });

  it("lists the findings and no empty-list sentence when something needs attention", () => {
    const markdown = renderMarkdown(reportOf([result({ ruleId: "d" }), errored("c")]));
    const attention = section(markdown, "Needs attention");
    expect(attention).toContain("### 1. Duration");
    expect(attention).not.toContain("No deviations");
    expect(attention).not.toContain("Nothing needs attention");
  });
});

describe("a rule title with nothing in it", () => {
  const blanks = ["", "   ", "\n\t ", "\u0000\u0007", "\u200b\u200d\ufeff", " \u00ad "];

  it.each(blanks)("is replaced by the rule id (%j)", (title) => {
    const markdown = renderMarkdown(
      reportOf([
        result({ ruleId: "term", title }),
        result({ ruleId: "fine", title, status: "compliant" }),
        result({ ruleId: "bad", title, status: "error", explanation: "", error: "Failed." }),
      ]),
    );
    expect(markdown).toContain("### 1. term\n");
    expect(markdown).toContain("- **fine**");
    expect(markdown).toContain("- **bad** (`bad`): Failed.");
    expect(markdown).not.toMatch(/### 1\. *\n/);
    expect(markdown).not.toContain("- ****");
  });

  it("leaves a title that has something in it alone", () => {
    const markdown = renderMarkdown(reportOf([result({ title: "  Term of the deal  " })]));
    expect(markdown).toContain("### 1. Term of the deal\n");
  });

  it("falls back to the rule id only", () => {
    const markdown = renderMarkdown(reportOf([result({ ruleId: "my-rule", title: " " })]));
    expect(markdown).toContain("### 1. my-rule\n");
  });
});

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

const BARE_ADDRESS = [
  /https?:\/\/[^\s`]/,
  /ftp:\/\/[^\s`]/,
  /(?<![A-Za-z0-9`])www\./i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/,
];

// What is left once the code spans are taken out, which is all a renderer would try to link.
const outsideCode = (markdown: string): string => markdown.replace(/(`+)[\s\S]*?\1/g, "");

function expectNoBareAddress(markdown: string): void {
  const rest = outsideCode(markdown);
  for (const pattern of BARE_ADDRESS) expect(rest).not.toMatch(pattern);
}

const ADDRESSES = [
  "https://example.com/path?q=1",
  "http://x.test",
  "ftp://files.example.org/a",
  "www.example.com",
  "jane.doe@example.com",
  "mailto:jane@example.com",
];

describe("addresses in model and contract text", () => {
  it.each(ADDRESSES)(
    "sets %s in a code span, in every place text comes from outside",
    (address) => {
      const text = `see ${address} now`;
      const markdown = renderMarkdown(
        reportOf(
          [
            result({
              ruleId: "a",
              title: `Title ${address}`,
              explanation: text,
              suggestedClause: `${text}\nand ${address}`,
              status: "missing",
              clauseIds: ["c1"],
              clauseExcerpts: [`Open ${address} words`],
            }),
            result({ ruleId: "b", status: "compliant", explanation: text }),
            result({ ruleId: "c", status: "not_applicable", explanation: text }),
            result({ ruleId: "d", status: "error", explanation: "", error: text }),
            result({
              ruleId: "e",
              edit: {
                kind: "comment-only",
                proposed: { clauseId: "c1", quote: "q", replacement: "r" },
                reason: `the quote ${address} is not found`,
              },
            }),
          ],
          {
            document: `${address}.docx`,
            playbook: { name: `PB ${address}`, contractTypes: [address] },
            model: { provider: "p", model: "m", disclosure: `a server at ${address}` },
            warnings: [text],
          },
        ),
      );
      expectNoBareAddress(markdown);
      const bare = address.startsWith("mailto:") ? address.slice("mailto:".length) : address;
      expect(markdown).toContain(`\`${bare}\``);
    },
  );

  it("keeps the punctuation around an address outside the code span", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          explanation:
            'See (https://example.com/a), "www.example.com", jane@example.com. Then x@y.org; end.',
        }),
      ]),
    );
    expect(markdown).toContain(
      'See (`https://example.com/a`), "`www.example.com`", `jane@example.com`. Then `x@y.org`; end.',
    );
  });

  it("sets only the address in a code span, not the words glued to it", () => {
    const markdown = renderMarkdown(
      reportOf([result({ explanation: "[link](https://example.com) and a*b@example.org" })]),
    );
    // The "*" cannot be part of a local part, so the address begins after it.
    expect(markdown).toContain("\\[link\\](`https://example.com`) and a\\*`b@example.org`");
  });

  it("finds an address after another at sign", () => {
    const markdown = renderMarkdown(reportOf([result({ explanation: "ask @jane@example.com" })]));
    expect(markdown).toContain("@`jane@example.com`");
    expectNoBareAddress(markdown);
  });

  it("widens the fence for an address with a backtick in it", () => {
    const markdown = renderMarkdown(
      reportOf([result({ explanation: "see https://example.com/a`b now" })]),
    );
    expect(markdown).toContain("``https://example.com/a`b``");
  });

  it("leaves text that holds no address as it always was", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          explanation: "Note: call 555-0100 at 5:30pm or write a@b. Section 3.1: see example.com.",
        }),
      ]),
    );
    expect(markdown).toContain(
      "Note: call 555-0100 at 5:30pm or write a@b. Section 3.1: see example.com.",
    );
  });

  it("sets the addresses of a suggested clause line by line inside the block quote", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          status: "missing",
          suggestedClause: "Write to a@b.co.\n\nVisit www.example.com/terms.",
        }),
      ]),
    );
    expect(markdown).toContain("> Write to `a@b.co`.\n>\n> Visit `www.example.com/terms`.");
  });
});

const havePandoc = spawnSync("pandoc", ["--version"]).status === 0;

// pandoc's gfm reader follows the same autolink rules as GitHub's: a scheme with "://", a name
// that starts with "www.", and an e-mail address.
function linksIn(markdown: string): number {
  const run = spawnSync("pandoc", ["-f", "gfm", "-t", "json"], { input: markdown });
  if (run.status !== 0) throw new Error("pandoc failed");
  return (run.stdout.toString().match(/"t":"Link"/g) ?? []).length;
}

describe.skipIf(!havePandoc)("addresses, read by a renderer that links bare addresses", () => {
  const text = `${ADDRESSES.join(" and ")}.`;
  const hostile = (): ReviewReport =>
    reportOf(
      [
        result({
          title: `Title ${text}`,
          explanation: text,
          suggestedClause: text,
          status: "missing",
          clauseIds: ["c1"],
          clauseExcerpts: [text],
        }),
        result({ ruleId: "e", status: "error", explanation: "", error: text }),
      ],
      {
        document: `${text}.docx`,
        model: { provider: "p", model: "m", disclosure: `a server at ${text}` },
        warnings: [text],
      },
    );

  it("finds no link in the report", () => {
    expect(linksIn(renderMarkdown(hostile()))).toBe(0);
  });

  it("would link every one of them if they were written out bare", () => {
    expect(linksIn(ADDRESSES.join("\n\n"))).toBeGreaterThanOrEqual(ADDRESSES.length);
  });
});
