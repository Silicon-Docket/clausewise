import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { getPrompt, listPrompts, promptRecord } from "../../src/prompts/registry.js";
import { toSourceSpans, type StoredSpan } from "../../src/store/index.js";

/** The small functions that join two modules, which neither module could own alone. */

describe("documentTextSha256", () => {
  const p = (...texts: string[]) => texts.map((text) => ({ text }));

  it("is the same for the same paragraph texts, whatever else the paragraphs carry", () => {
    const a = [
      { text: "One.", id: "p:0" },
      { text: "Two.", id: "p:1" },
    ];
    const b = [{ text: "One.", style: "Heading 1" }, { text: "Two." }];
    expect(documentTextSha256(a)).toBe(documentTextSha256(b));
  });

  it("changes with a character, an added paragraph and the order", () => {
    const base = documentTextSha256(p("One.", "Two."));
    expect(documentTextSha256(p("One.", "Two!"))).not.toBe(base);
    expect(documentTextSha256(p("One.", "Two.", ""))).not.toBe(base);
    expect(documentTextSha256(p("Two.", "One."))).not.toBe(base);
  });

  it("cannot be matched by moving text across the boundary between paragraphs", () => {
    expect(documentTextSha256(p("ab", "c"))).not.toBe(documentTextSha256(p("a", "bc")));
    expect(documentTextSha256(p("a\nb"))).not.toBe(documentTextSha256(p("a", "b")));
    expect(documentTextSha256(p('a","b'))).not.toBe(documentTextSha256(p("a", "b")));
  });

  it("is a sha-256 and differs from the hash of the joined text", () => {
    const hash = documentTextSha256(p("One.", "Two."));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(sha256Hex("One.\nTwo."));
    expect(documentTextSha256([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("toSourceSpans", () => {
  const stored = (docLabel: "D1" | "D2" | "D3", paragraphIndex: number): StoredSpan => ({
    id: `dv_${docLabel}:p${paragraphIndex}`,
    label: `${docLabel}-p${paragraphIndex}`,
    documentVersionId: `dv_${docLabel}`,
    docLabel,
    paragraphIndex,
    clauseId: "c1",
    clauseNumber: null,
    heading: null,
    text: "x",
    textSha256: sha256Hex("x"),
    matterId: "mat_x",
    documentId: `doc_${docLabel}`,
    documentTitle: "T",
    documentKind: docLabel === "D1" ? "nda" : "amendment",
    versionNo: 1,
  });

  it("numbers the labels from c1 across the documents, skipping the paragraphs that have no span", () => {
    const spans = toSourceSpans([
      stored("D1", 0),
      stored("D1", 2),
      stored("D1", 7),
      stored("D2", 1),
    ]);
    expect(spans.map((s) => [s.label, s.modelLabel])).toEqual([
      ["D1-p0", "c1"],
      ["D1-p2", "c2"],
      ["D1-p7", "c3"],
      ["D2-p1", "c4"],
    ]);
    expect(spans[0]).not.toHaveProperty("matterId");
    expect(spans[0]).not.toHaveProperty("documentTitle");
  });

  it("refuses a list that is out of order, which would label the spans differently from ingest", () => {
    expect(() => toSourceSpans([stored("D2", 0), stored("D1", 0)])).toThrow(/order/);
    expect(() => toSourceSpans([stored("D1", 3), stored("D1", 1)])).toThrow(/order/);
    expect(() => toSourceSpans([stored("D1", 1), stored("D1", 1)])).toThrow(/order/);
    expect(toSourceSpans([])).toEqual([]);
  });
});

describe("promptRecord", () => {
  it("describes every registered prompt for the store, under the registry's hash", () => {
    for (const prompt of listPrompts()) {
      const record = promptRecord(prompt.definition.id);
      expect(record.sha256).toBe(prompt.sha256);
      expect(record.stage).toBe(prompt.definition.stage);
      const template = JSON.parse(record.template) as Record<string, unknown>;
      expect(Object.keys(template).sort()).toEqual([
        "fragments",
        "schemaName",
        "system",
        "userTemplate",
      ]);
      expect(template["system"]).toBe(prompt.definition.system);
      expect(JSON.parse(record.schemaJson)).toHaveProperty("properties");
    }
  });

  it("holds the fixed prose the analyze stage adds, because it is hashed with the prompt", () => {
    const template = JSON.parse(promptRecord("analyze.p1").template) as {
      fragments: Record<string, string>;
    };
    expect(template.fragments["coverageWhole"]).toContain("every paragraph of every document");
    expect(JSON.parse(promptRecord("extract.p1").template)).toHaveProperty("fragments", {});
  });

  it("refuses an id that is not registered", () => {
    expect(() => promptRecord("analyze.p9")).toThrow(/unknown prompt/);
    expect(getPrompt("analyze.p1").sha256).toBe(promptRecord("analyze.p1").sha256);
  });
});
