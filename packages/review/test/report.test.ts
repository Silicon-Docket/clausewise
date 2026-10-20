import { beforeAll, describe, expect, it } from "vitest";
import { reviewContract } from "../src/pipeline.js";
import { renderMarkdown } from "../src/report.js";
import { createOracleGenerator } from "../src/testing.js";
import type { ReviewReport, RuleResult } from "../src/types.js";
import { aggressiveScript, fixture, loadPlaybook } from "./pipeline-support.js";

const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const DASHES = new RegExp(`[${EN_DASH}${EM_DASH}]`);
// Written as code points because an editor or formatter may turn the escapes into the characters.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const NEXT_LINE = String.fromCharCode(0x85);

function section(markdown: string, title: string): string {
  const start = markdown.indexOf(`## ${title}\n`);
  if (start === -1) throw new Error(`no section ${title}`);
  const next = markdown.indexOf("\n## ", start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

const headings = (markdown: string): string[] =>
  markdown.split("\n").filter((line) => line.startsWith("#"));

describe("renderMarkdown for the aggressive NDA", () => {
  let markdown: string;
  let report: ReviewReport;

  beforeAll(async () => {
    const review = await reviewContract(
      {
        docx: fixture("nda-aggressive.docx"),
        playbook: loadPlaybook(),
        fileName: "nda-aggressive.docx",
      },
      createOracleGenerator(aggressiveScript()),
    );
    report = review.report;
    markdown = renderMarkdown(review.report);
  });

  it("opens with a title that names the document and the playbook", () => {
    expect(markdown.split("\n")[0]).toBe(
      "# Review of nda-aggressive.docx against Mutual NDA (receiving party)",
    );
  });

  it("says which model reviewed the contract and where the contract text went", () => {
    expect(markdown).toContain("Reviewed by oracle (oracle).");
    expect(markdown).toContain(
      "The contract text was sent to: a scripted test oracle (nothing is sent anywhere).",
    );
  });

  it("summarises the counts by status and the open items by severity", () => {
    const summary = section(markdown, "Summary");
    for (const row of [
      "| Deviations | 9 |",
      "| Missing clauses | 1 |",
      "| Compliant | 0 |",
      "| Not applicable | 0 |",
      "| Could not be checked | 0 |",
      "| High severity | 4 |",
      "| Medium severity | 4 |",
      "| Low severity | 2 |",
    ]) {
      expect(summary).toContain(row);
    }
    expect(summary).toContain("Checked 16 clauses (31 paragraphs) in 1 window.");
    expect(summary).toContain("2 tracked changes were applied.");
  });

  it("has its sections in order", () => {
    expect(headings(markdown).filter((h) => h.startsWith("## "))).toEqual([
      "## Summary",
      "## Needs attention",
      "## Compliant",
      "## Not applicable",
      "## Could not be checked",
    ]);
  });

  it("lists every deviation and missing result, high severity first and then in playbook order", () => {
    const titles = [...section(markdown, "Needs attention").matchAll(/^### \d+\. (.*)$/gm)].map(
      (m) => m[1],
    );
    expect(titles).toEqual([
      // high
      "Obligations bind both parties",
      "Standard exclusions",
      "Duration of confidentiality obligations",
      "No hidden restrictive covenants",
      // medium
      "Definition of Confidential Information",
      "Permitted use and disclosure to representatives",
      "Disclosure required by law",
      "Remedies",
      // low
      "Return or destruction of information",
      "Governing law and venue",
    ]);
    expect(report.open.high + report.open.medium + report.open.low).toBe(titles.length);
  });

  it("shows the severity, status and clause numbers of each item", () => {
    const attention = section(markdown, "Needs attention");
    expect(attention).toContain("**High** severity, deviation. Clause 3.1.");
    expect(attention).toContain("**High** severity, deviation. Clauses 1.1, 2.1.");
    expect(attention).toContain("**Medium** severity, missing.");
    expect(attention).toContain("The obligations are perpetual, with no trade secret limit.");
  });

  it("shows an applied change as before and after", () => {
    expect(markdown).toContain(
      "Changed: `perpetual and shall continue indefinitely` => `end three (3) years after the date of disclosure`",
    );
    expect(markdown).toContain(
      "Changed: `disclosed by or on behalf of Discloser to Recipient` => `disclosed by or on behalf of either party to the other`",
    );
  });

  it("explains an edit that was not made and keeps the wording", () => {
    const attention = section(markdown, "Needs attention");
    expect(attention).toContain("No tracked change was made: the edit overlaps an earlier edit.");
    expect(attention).toMatch(/No tracked change was made: the quote was not found/);
    expect(attention).toMatch(/No tracked change was made: the quote is ambiguous/);
    expect(attention).toContain("Suggested wording: `the State of Delaware`");
    expect(attention).toContain("Suggested wording: `damages as provided by law`");
  });

  it("gives the suggested clause of a missing result as a quotation", () => {
    const text = aggressiveScript()["compelled-disclosure"]?.suggestedClause ?? "";
    expect(section(markdown, "Needs attention")).toContain(`Suggested clause:\n\n> ${text}`);
  });

  it("says when no edit was proposed", () => {
    expect(section(markdown, "Needs attention")).toContain("No edit was proposed.");
  });

  it("shows empty lists as none", () => {
    expect(section(markdown, "Compliant")).toBe("## Compliant\n\nNone.\n");
    expect(section(markdown, "Not applicable")).toContain("None.");
    expect(section(markdown, "Could not be checked")).toContain("None.");
  });

  it("holds no en or em dashes, and ends with one newline", () => {
    expect(markdown).not.toMatch(DASHES);
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });

  it("holds no contract text that no finding quotes", () => {
    for (const sentence of [
      "This Agreement is the entire agreement between the parties on its subject matter",
      "Fabrikam Labs LLC",
      "irreparable harm",
    ]) {
      expect(markdown).not.toContain(sentence);
    }
  });

  it("renders the same report the same way twice", () => {
    expect(renderMarkdown(report)).toBe(markdown);
  });
});

// ---------------------------------------------------------------------------------------------
// Hand-made reports, for the cases a scripted review does not reach
// ---------------------------------------------------------------------------------------------

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

const NASTY = [
  "# Injected heading",
  "- injected item",
  "1. injected number",
  "| a | b |",
  "---",
  "===",
  "> injected quote",
  "```",
  "~~~",
  "<script>alert(1)</script> [link](https://example.com) ![img](x) `code` *bold* _it_ ~~strike~~",
  "    indented code",
].join("\n");

describe("renderMarkdown with hostile text", () => {
  const report = reportOf(
    [
      result({
        title: "Title | with # markup *and* `code`",
        explanation: NASTY,
        edit: {
          kind: "comment-only",
          proposed: { clauseId: "c1", quote: "q", replacement: NASTY },
          reason: "# not a heading | still one line\nsecond line",
        },
      }),
      result({
        ruleId: "gap",
        title: "Gap",
        status: "missing",
        explanation: NASTY,
        suggestedClause: NASTY,
      }),
      result({ ruleId: "fine", status: "compliant", explanation: NASTY, title: NASTY }),
      result({ ruleId: "na", status: "not_applicable", explanation: NASTY }),
      result({ ruleId: "broken", status: "error", explanation: "", error: NASTY }),
    ],
    {
      document: "evil | name #1.docx",
      playbook: { name: "# Playbook | *x*", contractTypes: ["nda | x", "# y"] },
      model: {
        provider: "p|q",
        model: "m_1 *",
        disclosure: "Server <b>(here)</b>\n# not a heading",
      },
    },
  );
  const markdown = renderMarkdown(report);

  it("keeps the headings to the ones the report writes", () => {
    expect(headings(markdown)).toEqual([
      "# Review of evil \\| name \\#1.docx against \\# Playbook \\| \\*x\\*",
      "## Summary",
      "## Needs attention",
      "### 1. Title \\| with \\# markup \\*and\\* \\`code\\`",
      "### 2. Gap",
      "## Compliant",
      "## Not applicable",
      "## Could not be checked",
    ]);
  });

  it("keeps the tables to their own rows", () => {
    const rows = markdown.split("\n").filter((line) => line.startsWith("|"));
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(row.split("|")).toHaveLength(4);
  });

  it("starts no list, quote, rule or code block from model text", () => {
    const body = markdown.split("\n");
    for (const line of body) {
      if (line.startsWith("#") || line.startsWith("|") || line === "") continue;
      // Only the report's own list items and quoted blocks may begin a line with a marker.
      if (/^- \*\*/.test(line)) continue;
      expect(line).not.toMatch(/^\s*([-+*]|\d+[.)])\s/);
      expect(line).not.toMatch(/^\s*(={2,}|-{2,}|`{3,}|~{3,}|<)/);
      expect(line).not.toMatch(/^ {4}/);
      expect(line).not.toMatch(/^>\s*>/);
    }
  });

  it("escapes the control characters wherever model text appears", () => {
    const attention = section(markdown, "Needs attention");
    // Flattened to one line, so only the first character can start anything.
    expect(attention).toContain(
      "\\# Injected heading - injected item 1. injected number \\| a \\| b \\| --- === \\> injected quote",
    );
    expect(attention).toContain(
      "\\<script\\>alert(1)\\</script\\> \\[link\\](https://example.com) !\\[img\\](x)",
    );
    expect(attention).toContain("\\`code\\` \\*bold\\* \\_it\\_ \\~\\~strike\\~\\~");
  });

  it("puts a suggested clause in a block quote, one escaped line at a time", () => {
    const quote = section(markdown, "Needs attention")
      .split("\n")
      .filter((line) => line.startsWith(">"));
    expect(quote).toEqual([
      "> \\# Injected heading",
      "> \\- injected item",
      "> 1\\. injected number",
      "> \\| a \\| b \\|",
      "> \\---",
      "> \\===",
      "> \\> injected quote",
      "> \\`\\`\\`",
      "> \\~\\~\\~",
      "> \\<script\\>alert(1)\\</script\\> \\[link\\](https://example.com) !\\[img\\](x) \\`code\\` \\*bold\\* \\_it\\_ \\~\\~strike\\~\\~",
      "> indented code",
    ]);
  });

  it("quotes words exactly in a code span the text cannot close", () => {
    const attention = section(markdown, "Needs attention");
    const wording = /Suggested wording: (`+) ?(.*?) ?\1(?!`)/.exec(attention);
    expect(wording).not.toBeNull();
    // The nastiest line holds single backticks, so the fence has to be longer than one.
    expect(wording?.[1]?.length).toBeGreaterThanOrEqual(2);
    expect(wording?.[2]).toContain("# Injected heading - injected item");
  });

  it("keeps the other sections to one list line per rule", () => {
    const compliant = section(markdown, "Compliant")
      .split("\n")
      .filter((l) => l !== "");
    expect(compliant).toHaveLength(2);
    expect(compliant[1]).toMatch(/^- \*\*\\# Injected heading /);
    const errors = section(markdown, "Could not be checked")
      .split("\n")
      .filter((l) => l !== "");
    expect(errors).toHaveLength(2);
    expect(errors[1]).toMatch(/^- \*\*Duration\*\* \(`broken`\): \\# Injected heading /);
  });

  it("escapes the model and disclosure lines", () => {
    expect(markdown).toContain("Reviewed by m\\_1 \\* (p\\|q).");
    expect(markdown).toContain(
      "The contract text was sent to: Server \\<b\\>(here)\\</b\\> \\# not a heading.",
    );
  });
});

describe("renderMarkdown details", () => {
  it("writes plain hyphens for en and em dashes, wherever they come from", () => {
    const text = `A ${EM_DASH} B, C${EN_DASH}D, E ${EN_DASH}F`;
    const markdown = renderMarkdown(
      reportOf([
        result({
          title: `Title ${EM_DASH} here`,
          explanation: text,
          edit: {
            kind: "applied",
            paragraphId: "p:1",
            start: 0,
            end: 3,
            original: `2020${EN_DASH}2021`,
            replacement: `x ${EM_DASH} y`,
          },
        }),
      ]),
    );
    expect(markdown).not.toMatch(DASHES);
    expect(markdown).toContain("A - B, C-D, E - F");
    expect(markdown).toContain("Changed: `2020-2021` => `x - y`");
    expect(markdown).toContain("### 1. Title - here");
  });

  it("turns a dash and the blanks around it into one hyphen, or a spaced one if there were any", () => {
    const clause = [
      `a${EN_DASH}b`,
      `c ${EM_DASH} d`,
      `e \t${EN_DASH}\t  f`,
      `g ${EM_DASH}h`,
      `i${EM_DASH} j`,
      `k ${EM_DASH}`,
      `${EN_DASH}l`,
      `m${EN_DASH}${EM_DASH}n`,
    ].join("\n");
    const markdown = renderMarkdown(
      reportOf([result({ status: "missing", suggestedClause: clause })]),
    );
    const quote = section(markdown, "Needs attention")
      .split("\n")
      .filter((line) => line.startsWith("> "));
    expect(quote).toEqual([
      "> a-b",
      "> c - d",
      "> e - f",
      "> g - h",
      "> i - j",
      "> k -",
      "> \\-l",
      "> m--n",
    ]);
  });

  it("does not let a dash at the start of model text become a list marker", () => {
    const markdown = renderMarkdown(
      reportOf([result({ explanation: `${EM_DASH} an item`, title: `${EN_DASH} Dash title` })], {
        warnings: [`${EM_DASH} a warning`],
      }),
    );
    expect(markdown).toContain("### 1. - Dash title");
    expect(markdown).toContain("\n\\- an item\n");
    expect(markdown).toContain("\n- \\- a warning\n");
    expect(markdown).not.toMatch(DASHES);
    // Every line that begins with a list marker is one of the report's own.
    const markers = markdown.split("\n").filter((line) => /^\s*[-+*]\s/.test(line));
    expect(markers).toEqual(["- \\- a warning"]);
  });

  it("flattens line breaks and drops control characters in quoted words", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          edit: {
            kind: "applied",
            paragraphId: "p:1",
            start: 0,
            end: 3,
            original: "line one\n\nline two\u0000\u0007",
            replacement: "a\r\nb\tc",
          },
        }),
      ]),
    );
    expect(markdown).toContain("Changed: `line one line two` => `a b c`");
    expect(markdown).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("widens the code fence for backticks in quoted words", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          edit: {
            kind: "applied",
            paragraphId: "p:1",
            start: 0,
            end: 3,
            original: "say `hi` and ``bye``",
            replacement: "`x",
          },
        }),
      ]),
    );
    expect(markdown).toContain("Changed: ``` say `hi` and ``bye`` ``` => `` `x ``");
  });

  it("shows a deleted passage and omits wording when there is none", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          edit: {
            kind: "applied",
            paragraphId: "p:1",
            start: 0,
            end: 3,
            original: "remove me",
            replacement: "",
          },
        }),
        result({
          ruleId: "other",
          title: "Other",
          edit: {
            kind: "comment-only",
            proposed: { clauseId: "c1", quote: "q", replacement: "  " },
            reason: "the quote is empty.",
          },
        }),
      ]),
    );
    expect(markdown).toContain("Changed: `remove me` => (deleted)");
    expect(markdown).toContain("No tracked change was made: the quote is empty.\n");
    expect(markdown).not.toContain("Suggested wording");
  });

  it("falls back to clause ids when the clauses have no numbers", () => {
    const markdown = renderMarkdown(reportOf([result({ clauseIds: ["c2", "c5"] })]));
    expect(markdown).toContain("**High** severity, deviation. Clauses c2, c5.");
  });

  it("orders items by severity and keeps playbook order within a severity", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({ ruleId: "a", title: "A low", severity: "low" }),
        result({ ruleId: "b", title: "B medium", severity: "medium" }),
        result({ ruleId: "c", title: "C high", severity: "high" }),
        result({ ruleId: "d", title: "D medium", severity: "medium", status: "missing" }),
        result({ ruleId: "e", title: "E high", severity: "high" }),
      ]),
    );
    const titles = [...markdown.matchAll(/^### \d+\. (.*)$/gm)].map((m) => m[1]);
    expect(titles).toEqual(["C high", "E high", "B medium", "D medium", "A low"]);
  });

  it("lists compliant, not applicable and unchecked rules with what is known about them", () => {
    const markdown = renderMarkdown(
      reportOf([
        result({
          ruleId: "ok",
          title: "Fine",
          status: "compliant",
          clauseNumbers: ["2.1"],
          clauseIds: ["c4"],
          explanation: "At the fallback.",
        }),
        result({ ruleId: "skip", title: "Skipped", status: "not_applicable", explanation: "" }),
        result({
          ruleId: "bad",
          title: "Broken",
          status: "error",
          explanation: "",
          error: "The model declined to check this rule (refusal category: cyber).",
        }),
      ]),
    );
    expect(section(markdown, "Compliant")).toContain("- **Fine** (clause 2.1): At the fallback.");
    expect(section(markdown, "Not applicable")).toContain("- **Skipped**\n");
    expect(section(markdown, "Could not be checked")).toContain(
      "- **Broken** (`bad`): The model declined to check this rule (refusal category: cyber).",
    );
    expect(section(markdown, "Needs attention")).toContain("Nothing needs attention.");
  });

  it("copes with a report that has no document name and no results", () => {
    const markdown = renderMarkdown(
      reportOf([], {
        document: undefined,
        stats: { paragraphs: 1, clauses: 1, windows: 3, editsApplied: 1 },
      }),
    );
    expect(markdown.split("\n")[0]).toBe("# Review against Playbook");
    expect(markdown).toContain(
      "Checked 1 clause (1 paragraph) in 3 windows. 1 tracked change was applied.",
    );
    expect(markdown).toContain("Nothing needs attention.");
    expect(markdown.match(/None\./g)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Notes: what the review wants the lawyer to know that is not a finding
// ---------------------------------------------------------------------------------------------

const NOTHING_LEFT_OUT = {
  trackedInsertions: 0,
  trackedDeletions: 0,
  comments: 0,
  footnotes: 0,
  endnotes: 0,
  headerFooterParts: 0,
  hiddenRuns: 0,
  images: 0,
};

const sectionTitles = (markdown: string): string[] =>
  headings(markdown).filter((line) => line.startsWith("## "));

describe("renderMarkdown notes", () => {
  const plain = renderMarkdown(reportOf([result()]));

  it("adds nothing when there are no warnings and nothing was left out", () => {
    for (const extra of [
      {},
      { warnings: [] },
      { notShown: NOTHING_LEFT_OUT },
      { warnings: [], notShown: NOTHING_LEFT_OUT },
    ] satisfies Partial<ReviewReport>[]) {
      expect(renderMarkdown(reportOf([result()], extra))).toBe(plain);
    }
    expect(plain).not.toContain("## Notes");
    expect(plain).not.toContain("The model was not shown");
  });

  it("prints each warning as a bullet of a Notes section between the summary and the findings", () => {
    const markdown = renderMarkdown(
      reportOf([result()], {
        warnings: ["The document has hidden text.", "Two paragraphs could not be read."],
      }),
    );
    expect(section(markdown, "Notes")).toBe(
      "## Notes\n\n- The document has hidden text.\n- Two paragraphs could not be read.\n",
    );
    expect(sectionTitles(markdown)).toEqual([
      "## Summary",
      "## Notes",
      "## Needs attention",
      "## Compliant",
      "## Not applicable",
      "## Could not be checked",
    ]);
  });

  it("escapes a warning like any other model text, whatever it tries to start", () => {
    const markdown = renderMarkdown(
      reportOf([result()], {
        warnings: [
          NASTY,
          "- looks like a nested list",
          "1. looks like a numbered one",
          "+ and another",
          "=== underline",
          "\n## Fake section\n| a | b |\n",
          "Dashes " + EM_DASH + " and" + EN_DASH + "more",
          `Controls\u0000\u0007 and${LINE_SEPARATOR}breaks${NEXT_LINE}here`,
        ],
      }),
    );
    const notes = section(markdown, "Notes").split("\n");
    // The heading, a blank line, then one line per warning and the blank line that ends it.
    expect(notes.filter((line) => line !== "")).toHaveLength(1 + 8);
    expect(notes.slice(2, 10).every((line) => line.startsWith("- "))).toBe(true);
    expect(notes[2]).toContain(
      "\\# Injected heading - injected item 1. injected number \\| a \\| b \\| --- === \\> injected quote",
    );
    expect(notes[3]).toBe("- \\- looks like a nested list");
    expect(notes[4]).toBe("- 1\\. looks like a numbered one");
    expect(notes[5]).toBe("- \\+ and another");
    expect(notes[6]).toBe("- \\=== underline");
    expect(notes[7]).toBe("- \\#\\# Fake section \\| a \\| b \\|");
    expect(notes[8]).toBe("- Dashes - and-more");
    expect(notes[9]).toBe("- Controls and breaks here");
    expect(headings(markdown).filter((line) => line.startsWith("## "))).toEqual(
      sectionTitles(markdown),
    );
    expect(markdown).not.toMatch(DASHES);
    expect(markdown).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("leaves out warnings that say nothing, and the section with them", () => {
    const blank = renderMarkdown(reportOf([result()], { warnings: ["", "   ", "\n\t\u0000"] }));
    expect(blank).toBe(plain);
    const some = renderMarkdown(reportOf([result()], { warnings: ["", "Real note", "  "] }));
    expect(section(some, "Notes")).toBe("## Notes\n\n- Real note\n");
  });

  it("does not let a warning end the section early or reach the next one", () => {
    const markdown = renderMarkdown(
      reportOf([result()], { warnings: ["First\n\n## Needs attention\n\nSecond"] }),
    );
    expect(markdown.match(/^## Needs attention$/gm)).toHaveLength(1);
    expect(section(markdown, "Notes")).toBe("## Notes\n\n- First \\#\\# Needs attention Second\n");
  });
});

describe("renderMarkdown for what the model did not see", () => {
  const sentenceFor = (notShown: Partial<NonNullable<ReviewReport["notShown"]>>): string => {
    const markdown = renderMarkdown(
      reportOf([result()], { notShown: { ...NOTHING_LEFT_OUT, ...notShown } }),
    );
    return markdown
      .split("\n")
      .filter((line) => /^The model (was not shown|read) /.test(line))
      .join("\n");
  };

  it("lists only what is above zero, with the right number words", () => {
    expect(sentenceFor({ footnotes: 1 })).toBe("The model was not shown 1 footnote.");
    expect(sentenceFor({ comments: 2, footnotes: 1, images: 3 })).toBe(
      "The model was not shown 2 comments, 1 footnote and 3 images.",
    );
    expect(sentenceFor({ endnotes: 1, headerFooterParts: 2, hiddenRuns: 1 })).toBe(
      "The model was not shown 1 endnote, 2 headers or footers and 1 run of hidden text.",
    );
    expect(sentenceFor({ headerFooterParts: 1, hiddenRuns: 5 })).toBe(
      "The model was not shown 1 header or footer and 5 runs of hidden text.",
    );
  });

  it("says that tracked deletions were not shown and that insertions were read as accepted", () => {
    expect(sentenceFor({ trackedInsertions: 4 })).toBe(
      "The model read 4 tracked insertions as accepted text.",
    );
    expect(sentenceFor({ trackedInsertions: 1 })).toBe(
      "The model read 1 tracked insertion as accepted text.",
    );
    expect(sentenceFor({ trackedDeletions: 1 })).toBe(
      "The model was not shown 1 tracked deletion.",
    );
    expect(sentenceFor({ trackedInsertions: 1, trackedDeletions: 2, comments: 1 })).toBe(
      "The model was not shown 2 tracked deletions and 1 comment, and it read 1 tracked insertion as accepted text.",
    );
  });

  it("is one sentence in the summary, after the line on what was checked", () => {
    const markdown = renderMarkdown(
      reportOf([result()], {
        notShown: { ...NOTHING_LEFT_OUT, comments: 2, images: 1 },
      }),
    );
    const summary = section(markdown, "Summary");
    expect(summary.endsWith("\nThe model was not shown 2 comments and 1 image.\n")).toBe(true);
    expect(summary.indexOf("Checked 3 clauses")).toBeLessThan(
      summary.indexOf("The model was not shown"),
    );
    expect(markdown.match(/The model was not shown/g)).toHaveLength(1);
    expect(sectionTitles(markdown)).not.toContain("## Notes");
  });

  it("keeps both together, the sentence in the summary and the warnings in the notes", () => {
    const markdown = renderMarkdown(
      reportOf([result()], {
        warnings: ["A warning."],
        notShown: { ...NOTHING_LEFT_OUT, footnotes: 2 },
      }),
    );
    expect(section(markdown, "Summary")).toContain("The model was not shown 2 footnotes.");
    expect(section(markdown, "Notes")).toBe("## Notes\n\n- A warning.\n");
  });

  it("ignores counts that are not whole numbers above zero, whatever the report file held", () => {
    const hostile = {
      trackedInsertions: Number.NaN,
      trackedDeletions: -2,
      comments: 1.5,
      footnotes: Number.POSITIVE_INFINITY,
      endnotes: "3\n# Injected heading",
      headerFooterParts: null,
      hiddenRuns: Number.MAX_VALUE,
      images: undefined,
    } as unknown as NonNullable<ReviewReport["notShown"]>;
    const markdown = renderMarkdown(reportOf([result()], { notShown: hostile }));
    expect(markdown).not.toContain("The model");
    expect(markdown).not.toContain("Injected");
    expect(markdown).toBe(renderMarkdown(reportOf([result()])));
  });

  it("copes with a report file that lacks some of the counts", () => {
    const partial = { comments: 2 } as unknown as NonNullable<ReviewReport["notShown"]>;
    const markdown = renderMarkdown(reportOf([result()], { notShown: partial }));
    expect(markdown).toContain("The model was not shown 2 comments.\n");
  });
});
