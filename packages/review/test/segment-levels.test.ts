import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * Where a clause starts and stops when Word does the numbering: the effective list level of each
 * paragraph decides, not whether its text begins with a number. The paragraphs are written the way
 * parseDocx returns them, with the label Word prints and the list level beside it.
 */

interface Spec {
  text: string;
  style?: string;
  styleName?: string;
  outline?: number;
  /** The list the paragraph belongs to, and its level there. */
  list?: string;
  level?: number;
  label?: string | undefined;
  bullet?: boolean;
}

function build(items: (string | Spec)[]): DocxParagraph[] {
  return items.map((item, index) => {
    const spec: Spec = typeof item === "string" ? { text: item } : item;
    const listed = spec.list !== undefined && spec.level !== undefined;
    return {
      id: `p:${index}`,
      index,
      text: spec.text,
      style: spec.style,
      numbering: listed ? { id: spec.list!, level: spec.level! } : undefined,
      inTable: false,
      tableRow: undefined,
      label: spec.label,
      level: listed ? spec.level : undefined,
      isBullet: spec.bullet ?? false,
      styleName: spec.styleName,
      outlineLevel: spec.outline,
      isTocEntry: false,
    };
  });
}

/** Clause number, section heading and the indexes of the paragraphs, one entry per clause. */
const shape = (clauses: Clause[]) =>
  clauses.map((c) => ({
    number: c.number,
    heading: c.heading,
    ids: c.paragraphs.map((p) => Number(p.id.slice(2))),
  }));

const article = (label: string, title: string): Spec => ({
  text: title,
  style: "Heading1",
  styleName: "heading 1",
  outline: 0,
  list: "1",
  level: 0,
  label,
});
const clauseAt = (label: string, text: string, level: number, list = "1"): Spec => ({
  text,
  list,
  level,
  label,
});

describe("an article with numbered clauses beneath it", () => {
  const services = [
    article("1.", "Services"),
    clauseAt("1.1", "Provider shall deliver the Services.", 1),
    clauseAt("1.2", "Each Statement of Work shall state:", 1),
    clauseAt("(a)", "the scope of the Services;", 2),
    clauseAt("(b)", "the timetable.", 2),
    clauseAt("1.3", "Provider shall invoice monthly in arrears.", 1),
  ];

  it("gives one clause per level 1 paragraph and keeps the level 2 items with their lead-in", () => {
    expect(shape(segment(build(services)))).toEqual([
      { number: "1.1", heading: "1. Services", ids: [1] },
      { number: "1.2", heading: "1. Services", ids: [2, 3, 4] },
      { number: "1.3", heading: "1. Services", ids: [5] },
    ]);
  });

  it("does the same when the article title has no heading style but is a short level 0 title", () => {
    const plain: Spec = { text: "Services", list: "1", level: 0, label: "1." };
    const clauses = segment(build([plain, ...services.slice(1)]));
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "1. Services"],
      ["1.2", "1. Services"],
      ["1.3", "1. Services"],
    ]);
  });

  it("starts the next article with its own heading and its own clause numbers", () => {
    const clauses = segment(
      build([
        ...services,
        article("2.", "Fees"),
        clauseAt("2.1", "Customer shall pay the Fees.", 1),
        clauseAt("2.2", "Fees are exclusive of tax.", 1),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "1. Services"],
      ["1.2", "1. Services"],
      ["1.3", "1. Services"],
      ["2.1", "2. Fees"],
      ["2.2", "2. Fees"],
    ]);
  });

  it("works without any label, as when numbering.xml could not be read", () => {
    const unlabelled = services.map((s) => ({ ...s, label: undefined }));
    expect(segment(build(unlabelled)).map((c) => c.paragraphs.length)).toEqual([1, 3, 1]);
  });

  it("keeps a clause a level 3 sub-item sits in with its level 2 parent", () => {
    const clauses = segment(
      build([
        article("1.", "Services"),
        clauseAt("1.1", "Provider shall:", 1),
        clauseAt("(a)", "supply the Services, including:", 2),
        clauseAt("(i)", "hosting;", 3),
        clauseAt("(ii)", "support.", 3),
        clauseAt("(b)", "keep records.", 2),
        clauseAt("1.2", "Provider may subcontract.", 1),
      ]),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: "1. Services", ids: [1, 2, 3, 4, 5] },
      { number: "1.2", heading: "1. Services", ids: [6] },
    ]);
  });
});

describe("the clause level of a section", () => {
  it("is the level of the first numbered paragraph after the heading", () => {
    const clauses = segment(
      build([
        article("ARTICLE I", "Definitions"),
        clauseAt("Section 1.01", "In this Agreement:", 1),
        clauseAt("Section 1.02", "Headings do not affect meaning.", 1),
        article("ARTICLE II", "Services"),
        clauseAt("1.", "Provider shall deliver the Services.", 0, "2"),
        clauseAt("(a)", "on time;", 1, "2"),
        clauseAt("2.", "Customer shall pay.", 0, "2"),
      ]),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.01", heading: "ARTICLE I Definitions", ids: [1] },
      { number: "1.02", heading: "ARTICLE I Definitions", ids: [2] },
      { number: "1", heading: "ARTICLE II Services", ids: [4, 5] },
      { number: "2", heading: "ARTICLE II Services", ids: [6] },
    ]);
  });

  it("opens a clause for a paragraph shallower than the open one, and its deeper paragraphs join it", () => {
    const clauses = segment(
      build([
        clauseAt("1.1", "First sentence of the clause.", 1),
        clauseAt("(a)", "an item;", 2),
        clauseAt("2.", "A paragraph at level 0 is not an item of the one above.", 0),
        clauseAt("2.1", "Second sentence of the clause.", 1),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });

  it("makes a level 0 full sentence a clause and a level 0 short title a heading", () => {
    const clauses = segment(
      build([
        clauseAt("1.", "Term", 0),
        clauseAt("1.1", "This Agreement lasts for two years.", 1),
        clauseAt("2.", "The Recipient shall keep the information secret.", 0),
        clauseAt("(a)", "at all times;", 1),
      ]),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: "1. Term", ids: [1] },
      { number: "2", heading: "1. Term", ids: [2, 3] },
    ]);
  });

  it("starts afresh after each heading, so lettered clauses under a heading are clauses", () => {
    const clauses = segment(
      build([
        article("1.", "Term"),
        clauseAt("1.1", "This Agreement lasts for two years.", 1),
        clauseAt("1.2", "Either party may renew it.", 1),
        { text: "Notices", style: "Heading1", styleName: "heading 1" },
        clauseAt("(a)", "A notice must be in writing.", 2),
        clauseAt("(b)", "A notice is given on delivery.", 2),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "1. Term"],
      ["1.2", "1. Term"],
      ["(a)", "Notices"],
      ["(b)", "Notices"],
    ]);
  });

  it("never attaches an item to a clause across a heading", () => {
    const clauses = segment(
      build([
        clauseAt("1.1", "A clause.", 1),
        { text: "Notices", style: "Heading1", styleName: "heading 1" },
        clauseAt("(a)", "an orphan item;", 2),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0], [2]]);
  });
});

describe("the clause level of a section, in detail", () => {
  it("is the shallowest level seen in the section, so items two levels down still join", () => {
    const clauses = segment(
      build([
        clauseAt("(a)", "an orphan item.", 2),
        clauseAt("1.1", "The first clause.", 1),
        "An unnumbered paragraph.",
        clauseAt("(i)", "an item of another list.", 2, "2"),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0], [1], [2, 3]]);
  });

  it("is forgotten at a heading", () => {
    const clauses = segment(
      build([
        clauseAt("1.", "A clause at level zero.", 0),
        { text: "Notices", style: "Heading1", styleName: "heading 1" },
        "An unnumbered paragraph.",
        clauseAt("(a)", "an item of another list.", 1, "2"),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0], [2], [3]]);
  });

  it("is not decided by a bullet or by a list line that shows no number", () => {
    for (const first of [
      { text: "A bulleted line.", list: "30", level: 0, bullet: true },
      { text: "An unlabelled line.", list: "40", level: 0 },
    ]) {
      const clauses = segment(
        build([first, "An unnumbered paragraph.", clauseAt("(a)", "an item of a list.", 1, "2")]),
      );
      expect(shape(clauses).map((c) => c.ids)).toEqual([[0], [1], [2]]);
    }
  });

  it("does not take a list for the items of an unnumbered paragraph just because it held items once", () => {
    const clauses = segment(
      build([
        clauseAt("1.", "The Receiving Party shall:", 0, "10"),
        clauseAt("1.", "keep the information secret.", 0, "20"),
        "The parties agree.",
        clauseAt("2.", "A stray paragraph of the other list.", 0, "20"),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1], [2], [3]]);
  });
});

describe("a short run of numbered lines is a list, not a stack of headings", () => {
  it("keeps level 0 numbered short lines as clauses when the next line is one too", () => {
    const clauses = segment(
      build([
        clauseAt("1.", "Evaluation of a transaction", 0),
        clauseAt("2.", "Negotiation of a contract", 0),
        clauseAt("3.", "Administration of the Purpose", 0),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.text])).toEqual([
      ["1", "Evaluation of a transaction"],
      ["2", "Negotiation of a contract"],
      ["3", "Administration of the Purpose"],
    ]);
  });

  it("does not take a lowercase or bracketed item for a title", () => {
    const clauses = segment(
      build([
        "1.1 The parties intend:",
        clauseAt("(a)", "Evaluation", 0, "2"),
        clauseAt("(b)", "Negotiation", 0, "2"),
        clauseAt("a.", "support", 0, "3"),
      ]),
    );
    expect(clauses.flatMap((c) => c.paragraphs.map((p) => p.text))).toEqual([
      "1.1 The parties intend:",
      "Evaluation",
      "Negotiation",
      "support",
    ]);
  });
});

describe("items from another list than the clause they belong to", () => {
  // python-docx: "List Number" holds the clauses and "List Number 2" the items, both at level 0.
  const nda = [
    { text: "Obligations", style: "Heading1", styleName: "heading 1", outline: 0 },
    clauseAt("4.", "The Receiving Party shall:", 0, "10"),
    clauseAt("1.", "keep the information confidential;", 0, "20"),
    clauseAt("2.", "use it only for the Purpose.", 0, "20"),
    clauseAt("5.", "The Receiving Party may disclose it if:", 0, "10"),
    clauseAt("3.", "the Representative needs to know;", 0, "20"),
    clauseAt("4.", "the Representative is bound by confidence.", 0, "20"),
    clauseAt("6.", "The Receiving Party shall return it on request.", 0, "10"),
    clauseAt("7.", "The Receiving Party shall certify the return.", 0, "10"),
    clauseAt("5.", "Where law requires retention, copies may be kept.", 0, "20"),
  ];

  it("keeps the items after a lead-in sentence with the lead-in", () => {
    const clauses = segment(build(nda));
    expect(shape(clauses)).toEqual([
      { number: "4", heading: "Obligations", ids: [1, 2, 3] },
      { number: "5", heading: "Obligations", ids: [4, 5, 6] },
      { number: "6", heading: "Obligations", ids: [7] },
      { number: "7", heading: "Obligations", ids: [8, 9] },
    ]);
  });

  it("remembers which list holds items, so a lone item without a colon still joins", () => {
    const clauses = segment(build(nda));
    expect(clauses.at(-1)?.paragraphs.map((p) => p.id)).toEqual(["p:8", "p:9"]);
  });

  it("makes the first paragraph of another list a clause when nothing introduces it", () => {
    const clauses = segment(
      build([
        clauseAt("1.", "The Supplier shall deliver the goods.", 0, "10"),
        clauseAt("1.", "The Customer shall pay for them.", 0, "20"),
      ]),
    );
    expect(clauses).toHaveLength(2);
  });

  it("keeps bullets under a lead-in sentence and makes bullets without one clauses", () => {
    const bullet = (text: string): Spec => ({ text, list: "30", level: 0, bullet: true });
    const clauses = segment(
      build([
        clauseAt("1.", "In this Lease:", 0, "10"),
        bullet("Premises means the second floor suite;"),
        bullet("Term means five years."),
        clauseAt("2.", "Landlord lets the Premises to Tenant.", 0, "10"),
        bullet("Rent is payable quarterly."),
        bullet("Rent is reviewed yearly."),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1, 2], [3], [4], [5]]);
  });

  it("keeps a whole run of bullets under an unnumbered lead-in sentence", () => {
    const bullet = (text: string): Spec => ({ text, list: "30", level: 0, bullet: true });
    const clauses = segment(
      build([
        "Customer shall not:",
        bullet("sublicense the Platform;"),
        bullet("resell the Platform;"),
        bullet("reverse engineer the Platform."),
        "Customer shall pay the Fees.",
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1, 2, 3], [4]]);
  });

  it("takes a dash at the end of a sentence for a lead-in too", () => {
    const dash = String.fromCharCode(0x2014);
    const clauses = segment(
      build([
        clauseAt("1.", `Either party may terminate this Agreement if the other${dash}`, 0, "10"),
        clauseAt("1.", "commits a material breach; or", 0, "20"),
        clauseAt("2.", "becomes insolvent.", 0, "20"),
        clauseAt("2.", "This Agreement is governed by Singapore law.", 0, "10"),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1, 2], [3]]);
  });

  it("keeps bracketed items of a list under an unnumbered lead-in sentence", () => {
    const clauses = segment(
      build([
        "The Customer shall not:",
        clauseAt("(a)", "sublicense the Platform;", 0, "20"),
        clauseAt("(b)", "resell the Platform.", 0, "20"),
        "The Customer shall pay.",
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1, 2], [3]]);
  });

  it("takes a full-width colon for a lead-in too", () => {
    const colon = String.fromCharCode(0xff1a);
    const clauses = segment(
      build([
        clauseAt("1.", `Either party may terminate if${colon}`, 0, "10"),
        clauseAt("1.", "the other commits a breach.", 0, "20"),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1]]);
  });

  it("reads the level from the paragraph when it carries no numbering", () => {
    const [first, second] = build(["A clause.", "A sub-item."]);
    const clauses = segment([
      { ...first!, level: 0 },
      { ...second!, level: 1 },
    ]);
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0, 1]]);
  });

  it("does not let an unnumbered sentence ending in a colon swallow the numbered clauses", () => {
    const clauses = segment(
      build([
        "The parties agree as follows:",
        clauseAt("1.1", "Provider shall deliver the Services.", 1),
        clauseAt("1.2", "Customer shall pay for them.", 1),
      ]),
    );
    expect(shape(clauses).map((c) => c.ids)).toEqual([[0], [1], [2]]);
  });

  it("keeps lettered items with a typed clause number that introduces them", () => {
    const clauses = segment(
      build([
        "3.1 The Recipient shall",
        clauseAt("(a)", "keep it secret; and", 1),
        clauseAt("(b)", "return it.", 1),
        "3.2 Next clause.",
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([
      ["3.1", [0, 1, 2]],
      ["3.2", [3]],
    ]);
  });

  it("does not merge a clause of the main list into an unnumbered paragraph before it", () => {
    const clauses = segment(
      build([
        article("1.", "Services"),
        clauseAt("1.1", "Provider shall deliver the Services.", 1),
        { text: "For this clause, Provider includes its affiliates." },
        clauseAt("1.2", "Customer shall pay for them.", 1),
        clauseAt("(a)", "monthly in arrears;", 2),
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([
      ["1.1", [1]],
      [undefined, [2]],
      ["1.2", [3, 4]],
    ]);
  });
});
