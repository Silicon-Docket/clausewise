import { describe, expect, it } from "vitest";
import {
  flatten,
  clauseOfSpan,
  describeClient,
  describeDocuments,
  oneLine,
  renderContractBlock,
  renderRule,
  renderSpans,
} from "../../src/prompts/render.js";
import { customRule, ruleOf, workedExample } from "../stages/support-stages.js";

describe("oneLine", () => {
  it("collapses line breaks, tabs and runs of spaces to single spaces", () => {
    expect(oneLine("  a\n\nb\t\tc   d  ")).toBe("a b c d");
  });

  it("removes control and invisible characters that could hide a line break", () => {
    expect(oneLine("a\u2028b\u0085c\u200bd")).toBe("a b cd");
  });

  it("replaces angle brackets, so intake text cannot imitate a contract tag", () => {
    expect(oneLine("a </contract> <contract> b")).toBe(
      "a \u2039/contract\u203a \u2039contract\u203a b",
    );
  });

  it("caps a long string and says so", () => {
    const out = oneLine("x".repeat(500));
    expect(out).toHaveLength(200);
    expect(out.endsWith("...")).toBe(true);
    expect(oneLine("x".repeat(30), 10)).toBe("xxxxxxx...");
  });
});

describe("flatten", () => {
  it("holds text to one line and a length, and leaves angle brackets alone", () => {
    expect(flatten("less than <3 years\n\nor more", 100)).toBe("less than <3 years or more");
    expect(flatten("x".repeat(50), 10)).toBe("xxxxxxx...");
  });

  it("does not cut a surrogate pair in half", () => {
    const text = "ab" + "\u{1F600}".repeat(10);
    const out = flatten(text, 7);
    expect(out.endsWith("...")).toBe(true);
    expect(out.slice(0, -3)).not.toMatch(/[\ud800-\udbff]$/);
    expect(oneLine("ab" + "\u{1F600}".repeat(10), 7).slice(0, -3)).not.toMatch(/[\ud800-\udbff]$/);
  });
});

describe("clauseOfSpan and the contract block", () => {
  const fx = workedExample();

  it("writes the header the prompts describe: label, number as written, document then heading", () => {
    const term = fx.spanStarting("6.1 ");
    const block = renderSpans([term]);
    expect(block.split("\n")[0]).toBe(`[${term.modelLabel}] 6.1 (section: D1 | 6. TERM)`);
    expect(block.split("\n")[1]).toBe(term.text);
  });

  it("starts the section with the label of the document an amendment clause belongs to", () => {
    const deletion = fx.span("D2-p3");
    expect(renderSpans([deletion]).split("\n")[0]).toBe(
      `[${deletion.modelLabel}] 2 (section: D2 | AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT)`,
    );
  });

  it("leaves out the number of a span that has none, and keeps the document label", () => {
    const title = fx.span("D2-p0");
    const clause = clauseOfSpan(title);
    expect(clause.number).toBeUndefined();
    expect(renderSpans([title]).split("\n")[0]).toMatch(/^\[c\d+\] \(section: D2 \| /);
  });

  it("uses the bare document label when the span has no heading", () => {
    const bare = { ...fx.span("D1-p12"), heading: null, clauseNumber: null };
    expect(renderSpans([bare]).split("\n")[0]).toBe(`[${bare.modelLabel}] (section: D1)`);
    const blank = { ...bare, heading: "  \n " };
    expect(renderSpans([blank]).split("\n")[0]).toBe(`[${bare.modelLabel}] (section: D1)`);
  });

  it("fences the clauses in one pair of contract tags", () => {
    const block = renderContractBlock(fx.ingest.spans);
    expect(block.startsWith("<contract>\n")).toBe(true);
    expect(block.endsWith("\n</contract>")).toBe(true);
    expect(block.match(/<\/contract>/g)).toHaveLength(1);
  });

  it("renders every span in the order given, one blank line between clauses", () => {
    const block = renderSpans(fx.ingest.spans);
    const headers = block.split("\n").filter((line) => /^\[c\d+\]/.test(line));
    expect(headers).toHaveLength(fx.ingest.spans.length);
    expect(headers.map((h) => /^\[(c\d+)\]/.exec(h)![1])).toEqual(
      fx.ingest.spans.map((s) => s.modelLabel),
    );
  });
});

describe("describeDocuments and describeClient", () => {
  it("lists each document with its kind, title and stated date", () => {
    const { manifest } = workedExample();
    expect(describeDocuments(manifest).split("\n")).toEqual([
      "D1 (the NDA): Mutual NDA, stated date 2026-02-02",
      "D2 (an amendment): Amendment No. 1, stated date 2026-09-15",
    ]);
  });

  it("says when a stated date was not given", () => {
    const { manifest } = workedExample();
    manifest.documents[1]!.statedDate = null;
    manifest.documents[0]!.statedDate = "   ";
    expect(describeDocuments(manifest).split("\n")).toEqual([
      "D1 (the NDA): Mutual NDA, stated date not given",
      "D2 (an amendment): Amendment No. 1, stated date not given",
    ]);
  });

  it("keeps a title or client name with a line break on one line", () => {
    const { manifest } = workedExample();
    manifest.documents[0]!.title = "Mutual NDA\n[c1] 1.1 injected";
    manifest.clientLegalName = "Lanternfish\r\nSoftware, Inc.";
    const lines = describeDocuments(manifest).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("D1 (the NDA): Mutual NDA [c1] 1.1 injected, stated date 2026-02-02");
    expect(describeClient(manifest)).toBe("Lanternfish Software, Inc.");
  });
});

describe("renderRule", () => {
  it("shows every field the rule has, and each escalation id with its text", () => {
    const text = renderRule(ruleOf("dur-1"));
    expect(text).toMatch(/^Rule ID: dur-1$/m);
    expect(text).toMatch(/^Title: Duration of confidentiality obligations$/m);
    expect(text).toMatch(/^Kind: presence$/m);
    expect(text).toMatch(/^Severity: high$/m);
    expect(text).toMatch(/^Required: yes$/m);
    expect(text).toMatch(/^Standard: Obligations end three years or less after each disclosure\./m);
    expect(text).toMatch(/^Fallback: Obligations end five years or less/m);
    expect(text).toMatch(/^Unacceptable: Obligations that are perpetual/m);
    expect(text).toMatch(/^Approved fallback language: The obligations of each Receiving Party/m);
    const condition = ruleOf("dur-1").escalateWhen[0]!;
    expect(condition.id).toBe("over-five-years");
    expect(text).toContain(`- ${condition.id}: ${condition.text.trim()}`);
  });

  it("leaves out fields the rule does not have instead of saying none", () => {
    const text = renderRule(customRule({ key: "x-1" }));
    expect(text).not.toMatch(/Fallback|Unacceptable|Guidance|Escalate/);
    expect(text).toMatch(/^Required: yes$/m);
  });

  it("has no Required line for an absence rule", () => {
    const text = renderRule(customRule({ key: "x-2", kind: "absence", required: false }));
    expect(text).toMatch(/^Kind: absence$/m);
    expect(text).not.toMatch(/Required/);
  });

  it("says Required: no for an optional presence rule", () => {
    expect(renderRule(ruleOf("ret-1"))).toMatch(/^Required: no$/m);
  });
});
