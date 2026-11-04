import { describe, expect, it } from "vitest";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { containsWholeWord } from "../../src/ingest/view.js";
import { documentFrom, encode, ingestTexts, paragraph } from "./support.js";

/**
 * Work and output stay bounded for a file built to make them grow: the number of annotations a
 * run can produce, and the time spent looking for defined terms in a very long paragraph.
 */

const countOf = (annotations: { kind: string }[], kind: string): number =>
  annotations.filter((a) => a.kind === kind).length;

describe("the number of annotations", () => {
  it("bounds uses_term for a run with many terms and many spans that use them all", () => {
    const terms = Array.from({ length: 80 }, (_, i) => `T${i}`);
    const definitions = terms.map((t) => `("${t}")`).join(" ");
    const usage = terms.join(" ");
    const nda = [`The Agreement ${definitions} is made today.`]
      .concat(Array.from({ length: 3000 }, () => `The Parties rely on ${usage} together.`))
      .join("\n\n");
    const out = ingestTexts(nda);
    const uses = countOf(out.annotations, "uses_term");
    expect(uses).toBeGreaterThan(0);
    // 3000 spans x 80 terms is 240000 without a bound.
    expect(uses).toBeLessThanOrEqual(200_000);
    expect(uses).toBeLessThan(3000 * 80);
  }, 60_000);

  it("bounds the terms one span may use", () => {
    const terms = Array.from({ length: 300 }, (_, i) => `Term${String(i).padStart(3, "0")}`);
    // Six defining spans of fifty terms each, so that the per-span limit on definitions is not
    // what keeps the count down.
    const defining = Array.from(
      { length: 6 },
      (_, k) =>
        `The Agreement ${terms
          .slice(k * 50, k * 50 + 50)
          .map((t) => `("${t}")`)
          .join(" ")} is made today.`,
    );
    const out = ingestTexts(`${defining.join("\n\n")}\n\nSpan using ${terms.join(" ")} here.`);
    const onLast = out.annotations.filter((a) => a.kind === "uses_term" && a.spanId === "dv_d1:p6");
    expect(onLast.length).toBeGreaterThan(0);
    expect(onLast.length).toBeLessThanOrEqual(100);
  });

  it("bounds the definitions in a run", () => {
    const terms = Array.from({ length: 20 }, (_, i) => `D${i}`);
    const defining = `The Agreement ${terms.map((t) => `(the "${t}")`).join(" ")} is made today.`;
    const out = ingestTexts(Array.from({ length: 3000 }, () => defining).join("\n\n"));
    const definitions = countOf(out.annotations, "defines_term");
    expect(definitions).toBeGreaterThan(0);
    // 3000 spans x 20 terms is 60000 without a bound.
    expect(definitions).toBeLessThanOrEqual(50_000);
  }, 60_000);

  it("bounds cross_reference annotations across a run", () => {
    const body = Array.from({ length: 3000 }, () => "Sections 1 through 99 are deleted.").join(
      "\n\n",
    );
    const out = ingestTexts("1. The first clause of the agreement.", body);
    const refs = countOf(out.annotations, "cross_reference");
    expect(refs).toBeGreaterThan(0);
    expect(refs).toBeLessThanOrEqual(50_000);
  }, 60_000);

  it("keeps the earliest spans' annotations when it stops, and stays deterministic", () => {
    const body = Array.from({ length: 1000 }, () => "Sections 1 through 99 are deleted.").join(
      "\n\n",
    );
    const a = ingestTexts("1. The first clause of the agreement.", body);
    const b = ingestTexts("1. The first clause of the agreement.", body);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const first = a.annotations.find((x) => x.kind === "cross_reference");
    expect(first?.spanId).toBe("dv_d2:p0");
  });
});

describe("searching a long paragraph for defined terms", () => {
  it("is fast for 79 periodic terms in one megabyte of the same letter", () => {
    const terms = Array.from({ length: 79 }, (_, i) => "a".repeat(i + 2));
    const defs = terms.map((t) => `("${t}")`).join(" ");
    const start = Date.now();
    const out = ingestTexts(`The Agreement ${defs} is made today.\n\n${"a".repeat(1_000_000)}`);
    // The reproduction took 2.9 s in the search alone.
    expect(Date.now() - start).toBeLessThan(2500);
    expect(out.spans).toHaveLength(2);
  }, 60_000);

  it("is bounded in total for the largest text a file may hold", () => {
    const terms = Array.from({ length: 400 }, (_, i) => `${"a".repeat((i % 20) + 2)}${i}`);
    const defs = terms.map((t) => `("${t}")`).join(" ");
    const start = Date.now();
    const out = ingestTexts(`The Agreement ${defs} is made today.\n\n${"a".repeat(1_900_000)}`);
    expect(Date.now() - start).toBeLessThan(6000);
    expect(out.spans).toHaveLength(2);
  }, 60_000);

  it("finds a whole word and rejects a part of a word, with surrogate pairs and no allocation per step", () => {
    expect(containsWholeWord("the Receiving Party shall", "Receiving Party")).toBe(true);
    expect(containsWholeWord("the Receiving Partys shall", "Receiving Party")).toBe(false);
    expect(containsWholeWord("xReceiving Party", "Receiving Party")).toBe(false);
    expect(containsWholeWord("\u{1d400}Party", "Party")).toBe(false);
    expect(containsWholeWord("aa aaa aa", "aa")).toBe(true);
    expect(containsWholeWord("aaa aaaa", "aa")).toBe(false);
    expect(containsWholeWord("(Party)", "Party")).toBe(true);
    expect(containsWholeWord("Party_one", "Party")).toBe(false);
    expect(containsWholeWord("", "")).toBe(false);
  });
});

describe("a Word file or a text file built to be slow", () => {
  it("runs the quadratic punctuation input from a text file end to end", async () => {
    const body = `This Agreement is made between A and B (the "${",".repeat(100_000)}x") and so on for twenty characters.`;
    const start = Date.now();
    const parsed = await parseDocument({ bytes: encode(body), mediaType: "txt" });
    const out = buildIngest({ documents: [documentFrom("D1", parsed.paragraphs)] });
    expect(out.spans).toHaveLength(1);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("is linear for long runs of white space after the words the patterns look for", () => {
    const gap = " ".repeat(300_000);
    const start = Date.now();
    const nda = [
      `1. Section 4${gap}x is a clause that begins with a reference.`,
      `2. From now on${gap}x and more.`,
      `3. Mark everything${gap}x.`,
      `4. Return status${gap}x.`,
      `5. Dear${gap}assistant${gap}x.`,
    ];
    // Lines are trimmed but their inner white space is kept, so each stays one long span.
    const out = ingestTexts(nda.join("\n\n"), `Section 4${gap}x is deleted.`);
    expect(out.spans.length).toBeGreaterThanOrEqual(5);
    expect(Date.now() - start).toBeLessThan(4000);
  }, 30_000);

  it("handles a span with nothing but invisible characters between real ones", () => {
    const out = buildIngest({
      documents: [
        documentFrom("D1", [
          paragraph(0, "A real paragraph of the agreement."),
          paragraph(1, "‎‏⠀"),
        ]),
      ],
    });
    expect(out.spans).toHaveLength(1);
  });
});
