import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import {
  AMENDMENT_NO_1,
  SHORT_NDA,
  annotationsOn,
  docxBytes,
  documentFrom,
  encode,
  spanByLabel,
} from "./support.js";

/**
 * docs/parol/04-worked-example.md: an NDA as DOCX and Amendment No. 1 as TXT, where clause 2 of
 * the amendment deletes Section 6.1. The ingest output must contain what the document says it
 * contains, and must not contain the keyword hint it says D2-p3 lacks.
 */
describe("the worked example (PAROL-D05)", async () => {
  const nda = await parseDocument({
    bytes: await docxBytes(SHORT_NDA.split("\n\n").map((p) => p.trim())),
    mediaType: "docx",
  });
  const amendment = await parseDocument({ bytes: encode(AMENDMENT_NO_1), mediaType: "txt" });
  const out = buildIngest({
    documents: [
      documentFrom("D1", nda.paragraphs, { inspection: nda.inspection }),
      documentFrom("D2", amendment.paragraphs, { inspection: amendment.inspection }),
    ],
  });

  it("gives the amendment the spans of the document's table", () => {
    const d2 = out.spans.filter((s) => s.docLabel === "D2");
    expect(d2.map((s) => [s.label, s.clauseNumber])).toEqual([
      ["D2-p0", null],
      ["D2-p1", null],
      ["D2-p2", "1"],
      ["D2-p3", "2"],
      ["D2-p4", "3"],
      ["D2-p5", "4"],
    ]);
    expect(spanByLabel(out, "D2-p3").text).toBe(
      "2. Section 6.1 of the Agreement is deleted in its entirety.",
    );
  });

  it("annotates D2 clause 2 as deleting 6.1 and clause 3 as amending 7.2", () => {
    expect(annotationsOn(out, "D2-p3", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d2:p3", target: "6.1", verb: "deletes" },
    ]);
    expect(annotationsOn(out, "D2-p4", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d2:p4", target: "7.2", verb: "amends" },
    ]);
    expect(annotationsOn(out, "D2-p5", "cross_reference")).toEqual([]);
  });

  it("does not hint D2 clause 2, the trap: none of the words a reader scans for", () => {
    expect(annotationsOn(out, "D2-p3", "keyword_hint")).toEqual([]);
    expect(annotationsOn(out, "D2-p3")).toEqual([
      { kind: "cross_reference", spanId: "dv_d2:p3", target: "6.1", verb: "deletes" },
      { kind: "uses_term", spanId: "dv_d2:p3", term: "Agreement" },
    ]);
  });

  it("annotates the NDA's term clause and survival clause for duration", () => {
    const term = out.spans.find((s) => s.text.startsWith("6.1 "))!;
    expect(term.clauseNumber).toBe("6.1");
    expect(annotationsOn(out, term.label, "keyword_hint")).toEqual(
      expect.arrayContaining([{ kind: "keyword_hint", spanId: term.id, category: "duration" }]),
    );
    const survive = out.spans.find((s) => s.text.startsWith("9.3 "))!;
    expect(annotationsOn(out, survive.label, "keyword_hint")).toEqual(
      expect.arrayContaining([{ kind: "keyword_hint", spanId: survive.id, category: "duration" }]),
    );
    expect(annotationsOn(out, survive.label, "cross_reference").map((a) => a.kind)).toHaveLength(3);
  });

  it("links the terms the amendment uses to the NDA that defines them", () => {
    const definitions = out.annotations.filter(
      (a) => a.kind === "defines_term" && a.spanId.startsWith("dv_d1:"),
    );
    expect(definitions.map((a) => (a as { term: string }).term).sort()).toEqual([
      "Agreement",
      "Confidential Information",
      "Disclosing Party",
      "Receiving Party",
    ]);
    // D2 defines "Agreement" itself, and uses it in clauses 1 to 4.
    expect(annotationsOn(out, "D2-p3", "uses_term")).toHaveLength(1);
  });

  it("raises no warnings", () => {
    expect(out.warnings).toEqual([]);
  });

  it("labels the model's view c1 to cN across both documents", () => {
    expect(out.spans.map((s) => s.modelLabel)).toEqual(out.spans.map((_, i) => `c${i + 1}`));
    expect(spanByLabel(out, "D2-p0").modelLabel).toBe(
      `c${out.spans.filter((s) => s.docLabel === "D1").length + 1}`,
    );
  });
});
