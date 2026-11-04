import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { segment } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import type { IngestOutput } from "../../src/contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { verifyQuote } from "../../src/quotes.js";
import { annotationsOn, documentFrom, encode } from "./support.js";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`../../../../fixtures/${name}`, import.meta.url))),
  );

async function load(name: string) {
  return parseDocument({ bytes: fixture(name), mediaType: "docx" });
}

const termsOf = (out: IngestOutput, kind: "defines_term" | "uses_term", label: string): string[] =>
  annotationsOn(out, label, kind).map((a) => (a as { term: string }).term);

describe("fixtures/nda-balanced.docx", async () => {
  const parsed = await load("nda-balanced.docx");
  const out = buildIngest({
    documents: [documentFrom("D1", parsed.paragraphs, { inspection: parsed.inspection })],
  });

  it("has one span per paragraph that has text", () => {
    const withText = parsed.paragraphs.filter((p) => p.text.trim() !== "");
    expect(out.spans).toHaveLength(withText.length);
    expect(out.spans.map((s) => s.text)).toEqual(withText.map((p) => p.text));
    expect(out.spans.map((s) => s.paragraphIndex)).toEqual(withText.map((p) => p.index));
  });

  it("takes clause numbers and headings from segment", () => {
    const byNumber = new Map(
      out.spans.filter((s) => s.clauseNumber).map((s) => [s.clauseNumber, s]),
    );
    expect(byNumber.get("5.1")?.heading).toBe("5. Term");
    expect(byNumber.get("7.2")?.heading).toBe("7. General");
    expect(byNumber.get("1.2")?.text.startsWith('1.2 "Confidential Information" means')).toBe(true);
  });

  it("finds the defined terms, including those introduced without brackets", () => {
    const defined = out.annotations
      .filter((a) => a.kind === "defines_term")
      .map((a) => (a as { term: string }).term)
      .sort();
    expect(defined).toEqual([
      "Agreement",
      "Confidential Information",
      "Disclosing Party",
      "Effective Date",
      "Purpose",
      "Receiving Party",
    ]);
    expect(termsOf(out, "uses_term", "D1-p9")).toEqual([
      "Confidential Information",
      "Purpose",
      "Receiving Party",
    ]);
  });

  it("hints the clauses a reviewer would look at for each category", () => {
    const hinted = (category: string): string[] =>
      out.annotations
        .filter((a) => a.kind === "keyword_hint" && a.category === category)
        .map(
          (a) =>
            out.spans.find((s) => s.id === a.spanId)!.clauseNumber ??
            out.spans.find((s) => s.id === a.spanId)!.label,
        );
    expect(hinted("duration")).toContain("5.1");
    expect(hinted("governing-law")).toContain("7.2");
    expect(hinted("exclusions")).toContain("2.1");
    expect(hinted("permitted-disclosures")).toEqual(expect.arrayContaining(["3.2", "4.1"]));
    expect(hinted("parties")).toContain("D1-p1");
  });

  it("holds nothing to warn about", () => {
    expect(out.warnings).toEqual([]);
    expect(parsed.inspection).not.toBeNull();
  });

  it("yields quotes that verify against the stored text", () => {
    const span = out.spans.find((s) => s.clauseNumber === "5.1")!;
    const quote = "continue for three (3) years after its disclosure";
    const result = verifyQuote(span.text, quote);
    expect(result.check).toBe("verified");
    expect(span.text.slice(result.offsets!.start, result.offsets!.end)).toBe(quote);
  });
});

describe("fixtures/nda-aggressive.docx", async () => {
  const parsed = await load("nda-aggressive.docx");
  const out = buildIngest({
    documents: [documentFrom("D1", parsed.paragraphs, { inspection: parsed.inspection })],
  });

  it("finds the defined terms in its own style", () => {
    const defined = out.annotations
      .filter((a) => a.kind === "defines_term")
      .map((a) => (a as { term: string }).term)
      .sort();
    expect(defined).toEqual([
      "Agreement",
      "Confidential Information",
      "Discloser",
      "Purpose",
      "Recipient",
    ]);
  });

  it("hints perpetual duration, the backup destruction and the Singapore forum", () => {
    const category = (label: string): string[] =>
      annotationsOn(out, label, "keyword_hint").map((a) => (a as { category: string }).category);
    const span = (n: string) => out.spans.find((s) => s.clauseNumber === n)!.label;
    expect(category(span("3.1"))).toContain("duration");
    expect(category(span("4.1"))).toContain("return-destruction");
    expect(category(span("7.1"))).toContain("governing-law");
    expect(category(span("2.2"))).toContain("permitted-disclosures");
    expect(category(span("1.2"))).toContain("exclusions");
  });

  it("holds no cross-reference and no instruction-like text", () => {
    expect(out.annotations.filter((a) => a.kind === "cross_reference")).toEqual([]);
    expect(out.annotations.filter((a) => a.kind === "instruction_like")).toEqual([]);
  });
});

describe("two fixtures in one run", async () => {
  const balanced = await load("nda-balanced.docx");
  const aggressive = await load("nda-aggressive.docx");

  it("labels D1 then D2 and carries a defined term across", () => {
    const out = buildIngest({
      documents: [
        documentFrom("D1", balanced.paragraphs, { inspection: balanced.inspection }),
        documentFrom("D2", aggressive.paragraphs, { inspection: aggressive.inspection }),
      ],
    });
    const d1 = out.spans.filter((s) => s.docLabel === "D1");
    const d2 = out.spans.filter((s) => s.docLabel === "D2");
    expect(d1.length + d2.length).toBe(out.spans.length);
    expect(d2[0]!.modelLabel).toBe(`c${d1.length + 1}`);
    // "Confidential Information" is defined in both, and "Receiving Party" only in D1.
    const uses = annotationsOn(out, "D2-p7", "uses_term").map((a) => (a as { term: string }).term);
    expect(uses).toContain("Confidential Information");
  });
});

describe("a fixture's text saved as plain text", async () => {
  const parsed = await load("nda-balanced.docx");
  const text = parsed.paragraphs
    .map((p) => p.text)
    .filter((t) => t.trim() !== "")
    .join("\n\n");

  it("is cut into the same clause numbers as the Word file", async () => {
    const asText = await parseDocument({ bytes: encode(text), mediaType: "txt" });
    const numbers = (paragraphs: typeof parsed.paragraphs) =>
      segment(paragraphs).map((c) => c.number);
    expect(numbers(asText.paragraphs)).toEqual(numbers(parsed.paragraphs));
  });
});
