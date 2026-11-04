import { createHash } from "node:crypto";
import { segment } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import { DOC_LABELS, spanIdOf, type DocLabel } from "../../src/contracts.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { UploadError } from "../../src/module-contracts.js";
import { verifyQuote } from "../../src/quotes.js";
import {
  AMENDMENT_NO_1,
  SHORT_NDA,
  documentFrom,
  ingestTexts,
  paragraph,
  paragraphsOf,
  spanByLabel,
} from "./support.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("the documents it accepts", () => {
  const nda = documentFrom("D1", SHORT_NDA);
  const am1 = documentFrom("D2", AMENDMENT_NO_1);
  const am2 = documentFrom("D3", "1. A second amendment changes Section 9.3 of the Agreement.");

  it("takes one, two or three documents in order", () => {
    expect(() => buildIngest({ documents: [nda] })).not.toThrow();
    expect(() => buildIngest({ documents: [nda, am1] })).not.toThrow();
    expect(() => buildIngest({ documents: [nda, am1, am2] })).not.toThrow();
  });

  // These are programming errors, not user errors: a plain Error, never an UploadError.
  it.each<[string, () => unknown]>([
    ["no documents", () => buildIngest({ documents: [] })],
    [
      "a second amendment labelled D2 again",
      () => buildIngest({ documents: [nda, am1, { ...am2, label: "D2" }] }),
    ],
    ["a gap in the labels", () => buildIngest({ documents: [nda, { ...am2, label: "D3" }] })],
    ["labels out of order", () => buildIngest({ documents: [am1, nda] })],
    ["a repeated D1", () => buildIngest({ documents: [nda, { ...am1, label: "D1" }] })],
    [
      "a fourth document",
      () => buildIngest({ documents: [nda, am1, am2, { ...am2, label: "D4" as DocLabel }] }),
    ],
    [
      "an NDA that is not first",
      () => buildIngest({ documents: [{ ...nda, kind: "amendment" }, am1] }),
    ],
    [
      "a second document that is an NDA",
      () => buildIngest({ documents: [nda, { ...am1, kind: "nda" }] }),
    ],
    [
      "a repeated document version id",
      () => buildIngest({ documents: [nda, { ...am1, documentVersionId: nda.documentVersionId }] }),
    ],
    [
      "paragraph indexes out of order",
      () =>
        buildIngest({
          documents: [documentFrom("D1", [paragraph(1, "Some text."), paragraph(0, "More text.")])],
        }),
    ],
    [
      "a repeated paragraph index",
      () =>
        buildIngest({
          documents: [documentFrom("D1", [paragraph(0, "Some text."), paragraph(0, "More text.")])],
        }),
    ],
  ])("refuses %s with a plain Error", (_name, build) => {
    let thrown: unknown;
    try {
      build();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(UploadError);
    expect((thrown as Error).message).toMatch(/^buildIngest:/);
  });

  it("does not put document text in the error", () => {
    const secret = "SECRET-PARAGRAPH-TEXT-3391";
    const bad = documentFrom("D1", [paragraph(1, secret), paragraph(0, secret)]);
    expect(() => buildIngest({ documents: [bad] })).toThrow(/ascending/);
    try {
      buildIngest({ documents: [bad] });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it("does not change its input", () => {
    const frozen = [nda, am1].map((d) =>
      Object.freeze({
        ...d,
        paragraphs: Object.freeze(
          d.paragraphs.map((p) => Object.freeze({ ...p })),
        ) as typeof d.paragraphs,
      }),
    );
    expect(() => buildIngest({ documents: frozen })).not.toThrow();
  });
});

describe("one span per paragraph that has text", () => {
  it("names each span by document and paragraph index", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1);
    const first = out.spans[0]!;
    expect(first.id).toBe(spanIdOf("dv_d1", 0));
    expect(first.id).toBe("dv_d1:p0");
    expect(first.label).toBe("D1-p0");
    expect(first.docLabel).toBe("D1");
    expect(first.documentVersionId).toBe("dv_d1");
    expect(first.paragraphIndex).toBe(0);
    const last = out.spans[out.spans.length - 1]!;
    expect(last.id).toBe("dv_d2:p5");
    expect(last.label).toBe("D2-p5");
    expect(last.docLabel).toBe("D2");
  });

  it("uses the paragraph's own index, not its position, when indexes have gaps", () => {
    const paragraphs = [
      paragraph(0, "First paragraph."),
      paragraph(4, "Second paragraph."),
      paragraph(9, "Third paragraph."),
    ];
    const out = buildIngest({ documents: [documentFrom("D1", paragraphs)] });
    expect(out.spans.map((s) => s.id)).toEqual(["dv_d1:p0", "dv_d1:p4", "dv_d1:p9"]);
    expect(out.spans.map((s) => s.label)).toEqual(["D1-p0", "D1-p4", "D1-p9"]);
    expect(out.spans.map((s) => s.paragraphIndex)).toEqual([0, 4, 9]);
  });

  it("skips paragraphs with no text, no visible text and table of contents lines", () => {
    const out = buildIngest({
      documents: [
        documentFrom("D1", [
          paragraph(0, "First paragraph with words."),
          paragraph(1, ""),
          paragraph(2, "   \t "),
          paragraph(3, "\u200b\u200d\ufeff"),
          paragraph(4, "1. Definitions .......... 3", { isTocEntry: true }),
          paragraph(5, "Second paragraph with words."),
        ]),
      ],
    });
    expect(out.spans.map((s) => s.label)).toEqual(["D1-p0", "D1-p5"]);
  });

  it("stores the paragraph text exactly: no trimming, no normalising", () => {
    const texts = [
      "  leading and trailing  ",
      "double  spaces\tand a tab",
      "curly \u201cquotes\u201d and \u2019 apostrophes and an \u2026 ellipsis",
      "zero\u200bwidth and soft\u00adhyphen and nbsp\u00a0here",
      "line one\nline two",
    ];
    const out = buildIngest({
      documents: [
        documentFrom(
          "D1",
          texts.map((t, i) => paragraph(i, t)),
        ),
      ],
    });
    expect(out.spans.map((s) => s.text)).toEqual(texts);
    expect(out.spans.map((s) => s.textSha256)).toEqual(texts.map(sha256));
  });

  it("hashes the text with SHA-256 over its UTF-8 bytes", () => {
    const out = ingestTexts("Caf\u00e9 \u{1f600} text is long enough here.");
    expect(out.spans[0]!.textSha256).toBe(sha256(out.spans[0]!.text));
    expect(out.spans[0]!.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("counts model labels c1, c2, ... across documents in order", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1, "1. Amendment two changes Section 9.3.");
    expect(out.spans.map((s) => s.modelLabel)).toEqual(out.spans.map((_, i) => `c${i + 1}`));
    const d2 = out.spans.filter((s) => s.docLabel === "D2");
    const d3 = out.spans.filter((s) => s.docLabel === "D3");
    const d1 = out.spans.filter((s) => s.docLabel === "D1");
    expect(d2[0]!.modelLabel).toBe(`c${d1.length + 1}`);
    expect(d3[0]!.modelLabel).toBe(`c${d1.length + d2.length + 1}`);
    expect(new Set(out.spans.map((s) => s.modelLabel)).size).toBe(out.spans.length);
  });

  it("does not spend a model label on a skipped paragraph", () => {
    const out = buildIngest({
      documents: [
        documentFrom("D1", [
          paragraph(0, "First paragraph with words."),
          paragraph(1, "Contents line", { isTocEntry: true }),
          paragraph(2, ""),
          paragraph(3, "Second paragraph with words."),
        ]),
        documentFrom("D2", [paragraph(0, "Third paragraph with words.")]),
      ],
    });
    expect(out.spans.map((s) => [s.label, s.modelLabel])).toEqual([
      ["D1-p0", "c1"],
      ["D1-p3", "c2"],
      ["D2-p0", "c3"],
    ]);
  });

  it("lists spans by document, then paragraph", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1);
    const order = out.spans.map((s) => [DOC_LABELS.indexOf(s.docLabel), s.paragraphIndex]);
    expect(order).toEqual([...order].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
  });
});

describe("the clause a span belongs to", () => {
  it("takes the clause id, number and heading from segment", () => {
    const nda = documentFrom("D1", SHORT_NDA);
    const clauses = segment(nda.paragraphs);
    const out = buildIngest({ documents: [nda] });
    for (const clause of clauses) {
      for (const part of clause.paragraphs) {
        const index = Number(part.id.slice(2));
        const span = out.spans.find((s) => s.paragraphIndex === index)!;
        expect(span.clauseId).toBe(clause.id);
        expect(span.clauseNumber).toBe(clause.number ?? null);
        expect(span.heading).toBe(clause.heading ?? null);
      }
    }
    expect(spanByLabel(out, "D1-p3").clauseNumber).toBe("1.2");
    expect(spanByLabel(out, "D1-p3").heading).toBe("1. DEFINITIONS");
  });

  it("gives the sub-items of a clause the clause's id and number", () => {
    const out = ingestTexts(
      "1. The Receiving Party shall:\n(a) keep it secret;\n(b) use it only for the Purpose.\n2. Second clause text here.",
    );
    expect(out.spans.map((s) => [s.clauseId, s.clauseNumber])).toEqual([
      ["c1", "1"],
      ["c1", "1"],
      ["c1", "1"],
      ["c2", "2"],
    ]);
  });

  it("attaches a heading to the clause it introduces, with no clause number", () => {
    const out = ingestTexts(SHORT_NDA);
    const heading = spanByLabel(out, "D1-p4");
    expect(heading.text).toBe("4. OBLIGATIONS");
    expect(heading.clauseNumber).toBeNull();
    expect(heading.heading).toBe("4. OBLIGATIONS");
    expect(heading.clauseId).toBe(spanByLabel(out, "D1-p5").clauseId);
  });

  it("attaches a paragraph after the last clause to the one before", () => {
    const out = buildIngest({
      documents: [
        documentFrom("D1", [
          paragraph(0, "1.1 The Receiving Party shall keep information secret."),
          paragraph(1, "By: ______________________", { inTable: true }),
        ]),
      ],
    });
    expect(out.spans[1]!.clauseId).toBe(out.spans[0]!.clauseId);
    expect(out.spans[1]!.clauseNumber).toBeNull();
  });

  it("uses c0 for a document that has no clause at all", () => {
    const out = ingestTexts("TITLE OF THE DOCUMENT ONLY");
    expect(out.spans).toHaveLength(1);
    expect(out.spans[0]!.clauseId).toBe("c0");
    expect(out.spans[0]!.clauseNumber).toBeNull();
  });

  it("numbers clauses within each document, not across them", () => {
    const out = ingestTexts("1.1 First clause of the NDA.", "1.1 First clause of the amendment.");
    expect(out.spans.map((s) => [s.label, s.clauseId, s.modelLabel])).toEqual([
      ["D1-p0", "c1", "c1"],
      ["D2-p0", "c1", "c2"],
    ]);
  });
});

describe("determinism", () => {
  it("gives byte-identical output for the same input", () => {
    const run = () => JSON.stringify(ingestTexts(SHORT_NDA, AMENDMENT_NO_1));
    expect(run()).toBe(run());
  });

  it("does not depend on the order of an input object's keys", () => {
    const a = documentFrom("D1", SHORT_NDA);
    const reversed = {
      ...Object.fromEntries(Object.entries(a).reverse()),
      paragraphs: a.paragraphs.map((p) => Object.fromEntries(Object.entries(p).reverse())),
    } as typeof a;
    expect(JSON.stringify(buildIngest({ documents: [reversed] }))).toBe(
      JSON.stringify(buildIngest({ documents: [a] })),
    );
  });

  it("does not depend on the machine's locale", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("localeCompare must not be used");
    };
    try {
      expect(() => ingestTexts(SHORT_NDA, AMENDMENT_NO_1)).not.toThrow();
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});

describe("a quote taken from a span's text round-trips through the offsets", () => {
  it("verifies, and the offsets slice back to the quote, for every span", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1);
    let checked = 0;
    for (const span of out.spans) {
      const words = span.text.split(" ");
      for (let from = 0; from + 4 <= words.length; from += 3) {
        const quote = words.slice(from, from + 4).join(" ");
        const result = verifyQuote(span.text, quote);
        if (result.check !== "verified") continue;
        expect(span.text.slice(result.offsets!.start, result.offsets!.end)).toBe(quote);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("holds for text with characters the matcher normalises", () => {
    const text =
      "The \u201cReceiving\u00a0Party\u201d shall  keep Confi\u200bdential\tInformation secret.";
    const out = buildIngest({ documents: [documentFrom("D1", [paragraph(0, text)])] });
    const span = out.spans[0]!;
    expect(span.text).toBe(text);
    const result = verifyQuote(span.text, '"Receiving Party" shall keep Confidential Information');
    expect(result.check).toBe("verified");
    expect(span.text.slice(result.offsets!.start, result.offsets!.end)).toBe(
      "\u201cReceiving\u00a0Party\u201d shall  keep Confi\u200bdential\tInformation",
    );
  });
});

describe("paragraphs parsed from text", () => {
  it("keeps the TXT reader's ids and indexes in the spans", () => {
    const paragraphs = paragraphsOf("1. First clause text.\n\n2. Second clause text.");
    const out = buildIngest({ documents: [documentFrom("D1", paragraphs)] });
    expect(out.spans.map((s) => s.id)).toEqual(["dv_d1:p0", "dv_d1:p1"]);
  });
});
