import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * What the segmenter leaves out: the table of contents, which is neither a heading nor a clause,
 * and the signature block, which carries no obligations whether it sits in a table or is typed
 * as lines at the end of the contract.
 */

interface Spec {
  text: string;
  styleName?: string;
  toc?: boolean;
  row?: number;
}

function build(items: (string | Spec)[]): DocxParagraph[] {
  return items.map((item, index) => {
    const spec: Spec = typeof item === "string" ? { text: item } : item;
    return {
      id: `p:${index}`,
      index,
      text: spec.text,
      style: undefined,
      numbering: undefined,
      inTable: spec.row !== undefined,
      tableRow: spec.row,
      label: undefined,
      level: undefined,
      isBullet: false,
      styleName: spec.styleName,
      outlineLevel: undefined,
      isTocEntry: spec.toc ?? false,
    };
  });
}

const texts = (clauses: Clause[]): string[] =>
  clauses.flatMap((c) => c.paragraphs.map((p) => p.text));
const toc = (text: string): Spec => ({ text, toc: true, styleName: "toc 1" });
const heading = (text: string): Spec => ({ text, styleName: "heading 1" });

describe("table of contents entries", () => {
  const contents = [
    { text: "Contents", toc: true, styleName: "TOC Heading" },
    toc("1.\tDefinitions\t3"),
    toc("2.\tSubscription and Access\t3"),
    toc("11.\tGeneral\t8"),
  ];

  it("are neither headings nor clauses", () => {
    const clauses = segment(
      build([
        heading("SUBSCRIPTION TERMS"),
        ...contents,
        "These Terms are entered into on 1 October 2026.",
        heading("1. Definitions"),
        "1.1 In these Terms the following words apply.",
      ]),
    );
    expect(texts(clauses)).toEqual([
      "These Terms are entered into on 1 October 2026.",
      "1.1 In these Terms the following words apply.",
    ]);
  });

  it("do not poison the section of the preamble with the last entry", () => {
    const clauses = segment(
      build([
        heading("SUBSCRIPTION TERMS"),
        ...contents,
        "These Terms are entered into on 1 October 2026.",
        "The Customer wishes to subscribe.",
      ]),
    );
    expect(clauses.map((c) => c.heading)).toEqual(["SUBSCRIPTION TERMS", "SUBSCRIPTION TERMS"]);
  });

  it("do not become clauses with the numbers of the real clauses", () => {
    const clauses = segment(
      build([
        { text: "1.1\tScope of Services\t3", toc: true, styleName: "toc 2" },
        { text: "2.1\tFees\t4", toc: true, styleName: "toc 2" },
        { text: "Definitions\t3", toc: true, styleName: "toc 1" },
        "1.1 Provider shall deliver the Services.",
      ]),
    );
    expect(clauses.map((c) => [c.number, c.text])).toEqual([
      ["1.1", "1.1 Provider shall deliver the Services."],
    ]);
  });

  it("leave the clause and the section that are open as they were", () => {
    const clauses = segment(
      build([
        heading("Services"),
        "1.1 Provider shall:",
        toc("2.\tFees\t4"),
        "(a) deliver the Services;",
        "(b) report monthly.",
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading, c.paragraphs.length])).toEqual([
      ["1.1", "Services", 3],
    ]);
  });

  it("are skipped even when the entry looks like a heading or a clause", () => {
    const clauses = segment(
      build([toc("ARTICLE I"), toc("3. Term"), toc("3.1 Term of the Agreement")]),
    );
    expect(clauses).toEqual([]);
  });
});

describe("signature lines at the end of the document", () => {
  const body = [
    "1.1 The Supplier shall deliver the Services.",
    "1.2 The Customer shall pay for them.",
  ];

  it.each([
    "By: ______________",
    "Name: Jane Smith",
    "Title: Chief Executive Officer",
    "Date: 1 March 2026",
    "DATE:",
    "Signature: ____",
    "Signed: Jo",
    "name :",
  ])("drops the line %j outside a table, among the last fifteen paragraphs", (line) => {
    expect(texts(segment(build([...body, "Signed on the date above.", line])))).toEqual([
      ...body,
      "Signed on the date above.",
    ]);
  });

  it("drops a whole typed signature block", () => {
    const clauses = segment(
      build([
        ...body,
        "For the Supplier",
        "By: ____________",
        "Name: Jane Smith",
        "Title: Director",
        "Date:",
        "For the Customer",
        "By: ____________",
        "Name:",
        "Title:",
        "Date:",
      ]),
    );
    expect(texts(clauses)).toEqual([...body, "For the Supplier", "For the Customer"]);
  });

  it("stops at the last fifteen paragraphs", () => {
    const filler = Array.from({ length: 15 }, (_, i) => `${i + 3}.1 Clause ${i + 3}.`);
    const early = segment(build(["Name: Jane Smith", ...filler]));
    expect(early[0]?.text).toBe("Name: Jane Smith");
    const late = segment(build(["Name: Jane Smith", ...filler.slice(1)]));
    expect(late[0]?.text).toBe(filler[1]);
  });

  it("keeps a line that starts like a label but is a sentence", () => {
    const sentences = [
      "Date: the Effective Date is 1 March 2026.",
      "Title: the Supplier shall retain title to the goods until payment.",
      "Name: the Supplier may use the Customer name in its customer list.",
      `Signed: ${"a very long line ".repeat(6)}`,
    ];
    expect(texts(segment(build([...body, ...sentences])))).toEqual([...body, ...sentences]);
  });

  it("keeps a label word that is part of another word or has no colon", () => {
    const lines = [
      "Bylaws of the company",
      "Names of the parties",
      "Title to the goods passes on delivery",
    ];
    expect(texts(segment(build(lines)))).toEqual(lines);
  });

  it("still drops rules and blanks anywhere", () => {
    const clauses = segment(build(["1.1 One.", "__________", "- - - - -", "", "1.2 Two."]));
    expect(texts(clauses)).toEqual(["1.1 One.", "1.2 Two."]);
  });

  it("keeps the table rule: a label line in a table is dropped wherever the table is", () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}.1 Clause ${i + 1}.`);
    const clauses = segment(build([{ text: "By: ____", row: 0 }, ...many]));
    expect(texts(clauses)).toEqual(many);
  });

  it("does not let a dropped line end the clause that is open", () => {
    const clauses = segment(
      build(["3.1 Intro:", ...Array.from({ length: 3 }, () => ""), "Name:", "(a) limb"]),
    );
    expect(clauses.map((c) => c.paragraphs.length)).toEqual([2]);
  });
});
