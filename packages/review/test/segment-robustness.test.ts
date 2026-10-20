import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";

/**
 * The segmenter runs on every file a user hands over, so it must never throw, must keep every
 * paragraph it does not skip exactly once and in order, and must take time in proportion to the
 * size of the document, whatever the numbering and table metadata say.
 */

/** A small deterministic generator, so a failure can be replayed from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = [
  "",
  "   ",
  "1.1 The Supplier shall deliver the Services.",
  "3.1",
  "12.",
  "(a) an item;",
  "(iv)",
  "4) Next clause.",
  "Section 5.2 Fees are payable monthly.",
  "Clause 7 Term",
  "Schedule 1 Fees",
  "Part A",
  "ARTICLE IV",
  "3. Term",
  "Definitions",
  "Limitation of Liability",
  "In this Agreement:",
  "The Receiving Party shall keep the information secret.",
  "By: ______________",
  "Name:",
  "Date: 1 March 2026",
  "_____",
  "- - -",
  "1.\tDefinitions\t3",
  "(the Agreement) is governed by Delaware law.",
  "\ud800 lone surrogate",
  "\u0000 control character",
  "A".repeat(500),
  "word ".repeat(300),
  "\u00a7 5 Fees",
  "\u00b64",
];
const LABELS = [
  undefined,
  undefined,
  "1.",
  "3.1",
  "(a)",
  "iv.",
  "Section 1.01",
  "ARTICLE II",
  "Schedule 2",
  "",
  " ",
  "***",
  "9".repeat(300),
  ".".repeat(300),
  "(",
  "\u2022",
];
const STYLE_NAMES = [
  undefined,
  undefined,
  "heading 1",
  "Heading 2",
  "Title",
  "Schedule Heading",
  "Table Heading",
  "toc 1",
  "Normal",
  "",
];
const LEVELS = [0, 0, 1, 2, 3, 8, 9999, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
const OUTLINES = [undefined, undefined, undefined, 0, 1, 8, 9, -3, Number.NaN];

function randomDocument(seed: number, size: number): DocxParagraph[] {
  const next = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  let row = 0;
  let inRow = false;
  return Array.from({ length: size }, (_, index) => {
    const listed = next() < 0.5;
    const table = next() < 0.3;
    if (table) {
      if (!inRow || next() < 0.5) row++;
      inRow = true;
    } else {
      inRow = false;
    }
    const level = listed ? pick(LEVELS) : undefined;
    return {
      id: `p:${index}`,
      index,
      text: pick(TEXTS),
      style: next() < 0.2 ? pick(["Heading1", "Title", "Titre1", ""]) : undefined,
      numbering: level === undefined ? undefined : { id: pick(["1", "2", "3", ""]), level },
      inTable: table,
      tableRow: table && next() < 0.95 ? row : undefined,
      label: pick(LABELS),
      level,
      isBullet: next() < 0.1,
      styleName: pick(STYLE_NAMES),
      outlineLevel: pick(OUTLINES),
      isTocEntry: next() < 0.1,
    };
  });
}

describe("random documents", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => i + 1);

  it("never throw, and keep each paragraph at most once, in order, with its own text", () => {
    for (const seed of seeds) {
      const input = randomDocument(seed, seed % 70);
      const clauses = segment(input);

      const used: number[] = [];
      for (const clause of clauses) {
        expect(clause.paragraphs.length).toBeGreaterThan(0);
        expect(clause.text).toBe(clause.paragraphs.map((p) => p.text).join("\n"));
        for (const piece of clause.paragraphs) {
          const index = Number(piece.id.slice(2));
          expect(piece.text).toBe(input[index]!.text);
          expect(input[index]!.isTocEntry).toBe(false);
          used.push(index);
        }
      }
      expect(used).toEqual([...used].sort((a, b) => a - b));
      expect(new Set(used).size).toBe(used.length);
      expect(clauses.map((c) => c.id)).toEqual(clauses.map((_, i) => `c${i + 1}`));
    }
  });

  it("give the same clauses every time and leave the input alone", () => {
    for (const seed of seeds.slice(0, 60)) {
      const input = randomDocument(seed, 50);
      const before = JSON.stringify(input);
      const first = segment(input);
      expect(segment(input)).toEqual(first);
      expect(JSON.stringify(input)).toBe(before);
    }
  });

  it("leave out every table of contents entry and every empty paragraph", () => {
    for (const seed of seeds.slice(0, 100)) {
      const input = randomDocument(seed, 60);
      const kept = new Set(
        segment(input).flatMap((c) => c.paragraphs.map((p) => Number(p.id.slice(2)))),
      );
      for (const p of input) {
        if (p.isTocEntry || p.text.trim() === "") expect(kept.has(p.index)).toBe(false);
      }
    }
  });
});

describe("a large document", () => {
  /** Headings, numbered clauses with items, table rows with the number apart, bullets, noise. */
  function contract(paragraphs: number): DocxParagraph[] {
    const out: DocxParagraph[] = [];
    const add = (spec: Partial<DocxParagraph> & { text: string }): void => {
      const index = out.length;
      out.push({
        id: `p:${index}`,
        index,
        style: undefined,
        numbering: undefined,
        inTable: false,
        tableRow: undefined,
        label: undefined,
        level: undefined,
        isBullet: false,
        styleName: undefined,
        outlineLevel: undefined,
        isTocEntry: false,
        ...spec,
      });
    };
    let row = 0;
    for (let i = 0; out.length < paragraphs; i++) {
      const list = { id: "1", level: 0 };
      add({
        text: `Article ${i}`,
        styleName: "heading 1",
        numbering: list,
        level: 0,
        label: `${i}.`,
      });
      add({
        text: `Lead-in sentence ${i}:`,
        numbering: { id: "1", level: 1 },
        level: 1,
        label: `${i}.1`,
      });
      add({ text: "an item;", numbering: { id: "1", level: 2 }, level: 2, label: "(a)" });
      add({ text: "another item.", numbering: { id: "1", level: 2 }, level: 2, label: "(b)" });
      add({ text: `${i}.2`, inTable: true, tableRow: row });
      add({
        text: "A clause whose number sits in the cell before it.",
        inTable: true,
        tableRow: row,
      });
      row++;
      add({
        text: "",
        inTable: true,
        tableRow: row,
        numbering: { id: "1", level: 1 },
        level: 1,
        label: `${i}.3`,
      });
      add({ text: "Another row clause.", inTable: true, tableRow: row });
      row++;
      add({
        text: "An item in a bullet list",
        numbering: { id: "2", level: 0 },
        level: 0,
        isBullet: true,
      });
      add({ text: "Contents entry\t3", isTocEntry: true });
      add({ text: "" });
    }
    return out;
  }

  it("is cut in proportion to its size", () => {
    const time = (n: number): number => {
      const input = contract(n);
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const start = performance.now();
        segment(input);
        best = Math.min(best, performance.now() - start);
      }
      return best;
    };
    const small = time(10_000);
    const large = time(100_000);
    // Linear work takes ten times as long; quadratic work would take a hundred times as long.
    expect(large).toBeLessThan(Math.max(small, 5) * 40);
  });

  it("holds 100,000 paragraphs of every kind and gives each clause its number", () => {
    const input = contract(100_000);
    const clauses = segment(input);
    expect(clauses.length).toBeGreaterThan(30_000);
    const numbers = new Set(clauses.map((c) => c.number));
    expect(numbers.has("7.1")).toBe(true);
    expect(numbers.has("7.2")).toBe(true);
    expect(numbers.has("7.3")).toBe(true);
    expect(clauses.at(-1)?.id).toBe(`c${clauses.length}`);
  });

  it("copes with one table row of 100,000 empty cells before its text", () => {
    const input: DocxParagraph[] = Array.from({ length: 100_002 }, (_, index) => ({
      id: `p:${index}`,
      index,
      text: index === 0 ? "1.1" : index === 100_001 ? "The Tenant shall pay." : "",
      style: undefined,
      numbering: undefined,
      inTable: true,
      tableRow: 0,
      label: undefined,
      level: undefined,
      isBullet: false,
      styleName: undefined,
      outlineLevel: undefined,
      isTocEntry: false,
    }));
    const clauses = segment(input);
    expect(clauses.map((c) => [c.number, c.text])).toEqual([["1.1", "The Tenant shall pay."]]);
  });
});

describe("hostile single paragraphs", () => {
  const one = (spec: Partial<DocxParagraph> & { text: string }): DocxParagraph => ({
    id: "p:0",
    index: 0,
    style: undefined,
    numbering: undefined,
    inTable: false,
    tableRow: undefined,
    label: undefined,
    level: undefined,
    isBullet: false,
    styleName: undefined,
    outlineLevel: undefined,
    isTocEntry: false,
    ...spec,
  });

  it("takes about as long as the text is, for every pattern the segmenter applies", () => {
    const big = 1_000_000;
    const cases: DocxParagraph[] = [
      one({ text: "\u00a7".repeat(big) }),
      one({ text: `Section${" ".repeat(big)}x` }),
      one({ text: `${".".repeat(big)}x` }),
      one({ text: `${":".repeat(big)}x`, label: "1." }),
      one({ text: "A ".repeat(big / 2), styleName: "heading 1", outlineLevel: 0 }),
      one({ text: "A".repeat(big), styleName: "Heading ".repeat(1000), style: "H".repeat(big) }),
      one({ text: "x", label: ".".repeat(big), numbering: { id: "1", level: 0 }, level: 0 }),
      one({ text: "x", label: `${")".repeat(big)}x`, numbering: { id: "1", level: 0 }, level: 0 }),
      one({ text: "x", label: "(".repeat(big), numbering: { id: "1", level: 0 }, level: 0 }),
      one({ text: `${"By: ".repeat(big / 4)}`, id: "p:0" }),
      one({ text: "1.".repeat(big / 2), inTable: true, tableRow: 0 }),
      one({ text: "(a)".repeat(big / 3), inTable: true, tableRow: 0 }),
    ];
    const start = performance.now();
    expect(() => segment(cases)).not.toThrow();
    expect(performance.now() - start).toBeLessThan(20_000);
  });

  it("reads no number from a label that is not one", () => {
    const labels = ["9".repeat(100), ".".repeat(100), "(".repeat(100), "A".repeat(30)];
    for (const label of labels) {
      const [clause] = segment([
        one({
          text: "The Supplier shall deliver.",
          label,
          numbering: { id: "1", level: 0 },
          level: 0,
        }),
      ]);
      expect(clause?.number).toBeUndefined();
    }
  });
});
