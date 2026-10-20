import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * Contracts laid out as a table with one clause per row keep the number in a cell of its own: as
 * typed text ("1.1"), or as an empty paragraph that Word numbers. That number belongs to the
 * clause in the next cell of the same row, and the cell that only holds the number is not a clause.
 */

interface Spec {
  text: string;
  styleName?: string;
  outline?: number;
  list?: string;
  level?: number;
  label?: string | undefined;
  row?: number;
  table?: boolean;
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
      style: undefined,
      numbering: listed ? { id: spec.list!, level: spec.level! } : undefined,
      inTable: spec.row !== undefined || spec.table === true,
      tableRow: spec.row,
      label: spec.label,
      level: listed ? spec.level : undefined,
      isBullet: spec.bullet ?? false,
      styleName: spec.styleName,
      outlineLevel: spec.outline,
      isTocEntry: false,
    };
  });
}

const shape = (clauses: Clause[]) =>
  clauses.map((c) => ({
    number: c.number,
    heading: c.heading,
    ids: c.paragraphs.map((p) => Number(p.id.slice(2))),
    text: c.text,
  }));

/** A cell of row `row`. */
const cell = (row: number, text: string, extra: Partial<Spec> = {}): Spec => ({
  text,
  row,
  ...extra,
});
/** A number cell Word fills in: an empty paragraph with a list label. */
const numberCell = (row: number, label: string, level: number, extra: Partial<Spec> = {}): Spec =>
  cell(row, "", { list: "1", level, label, ...extra });

describe("a number typed in a cell of its own", () => {
  it("goes to the clause in the next cell, and the number cell is not a clause", () => {
    const clauses = segment(
      build([
        cell(0, "1.1"),
        cell(0, "In this Lease the Landlord may terminate on notice."),
        cell(1, "1.2"),
        cell(1, "The Tenant shall pay the Rent."),
      ]),
    );
    expect(shape(clauses)).toEqual([
      {
        number: "1.1",
        heading: undefined,
        ids: [1],
        text: "In this Lease the Landlord may terminate on notice.",
      },
      { number: "1.2", heading: undefined, ids: [3], text: "The Tenant shall pay the Rent." },
    ]);
  });

  it("reads a numbered title row as a heading and gives its clauses the section", () => {
    const clauses = segment(
      build([
        cell(0, "1."),
        cell(0, "Definitions"),
        cell(1, "1.1"),
        cell(1, "In this Lease:"),
        cell(2, "2."),
        cell(2, "Grant of Lease"),
        cell(3, "2.1"),
        cell(3, "Landlord lets the Premises to Tenant."),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "1. Definitions"],
      ["2.1", "2. Grant of Lease"],
    ]);
  });

  it("reads an article row as a heading, whether the title is in capitals or not", () => {
    const clauses = segment(
      build([
        cell(0, "ARTICLE 2"),
        cell(0, "TERM"),
        cell(1, "2.1"),
        cell(1, "The term is five years."),
        cell(2, "Article 3"),
        cell(2, "Rent and Payments"),
        cell(3, "3.1"),
        cell(3, "The Tenant shall pay quarterly."),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["2.1", "ARTICLE 2 TERM"],
      ["3.1", "Article 3 Rent and Payments"],
    ]);
  });

  it("keeps items in the same row with the clause", () => {
    const clauses = segment(
      build([
        cell(0, "4.1"),
        cell(0, "Tenant shall:"),
        cell(0, "(a) keep the Premises in repair;"),
        cell(0, "(b) decorate them every five years."),
        cell(1, "4.2"),
        cell(1, "Tenant shall not sublet."),
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([
      ["4.1", [1, 2, 3]],
      ["4.2", [5]],
    ]);
  });

  it("gives the number to the first text of the row when other cells are empty", () => {
    const clauses = segment(
      build([cell(0, "5.1"), cell(0, ""), cell(0, "   "), cell(0, "Landlord shall insure.")]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([["5.1", [3]]]);
  });

  it("accepts the other ways a number is typed", () => {
    const rows = [
      ["3.1.2", "3.1.2"],
      ["12.", "12"],
      ["4)", "4"],
      ["Section 5.2", "5.2"],
      ["Clause 6", "6"],
    ] as const;
    for (const [typed, number] of rows) {
      const clauses = segment(build([cell(0, typed), cell(0, "The Tenant shall pay the Rent.")]));
      expect(clauses.map((c) => c.number)).toEqual([number]);
    }
  });

  it("lets an item marker in its own cell join the clause that is open", () => {
    const clauses = segment(
      build([
        cell(0, "4.1"),
        cell(0, "Tenant shall:"),
        cell(1, "(a)"),
        cell(1, "keep the Premises in repair;"),
        cell(2, "(b)"),
        cell(2, "decorate them."),
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([["4.1", [1, 3, 5]]]);
  });

  it("leaves a lone number cell as it was: a clause of its own", () => {
    const clauses = segment(build([cell(0, "1.1"), cell(1, "The Tenant shall pay.")]));
    expect(shape(clauses).map((c) => [c.number, c.text])).toEqual([
      ["1.1", "1.1"],
      [undefined, "The Tenant shall pay."],
    ]);
  });

  it("does not take a number from one row for the text of the next", () => {
    const clauses = segment(build([cell(0, "1.1"), cell(0, ""), cell(1, "The Tenant shall pay.")]));
    expect(clauses.map((c) => c.number)).toEqual(["1.1", undefined]);
  });

  it("does not take a bare integer or a figure in a data table for a clause number", () => {
    const clauses = segment(
      build([cell(0, "5"), cell(0, "Setup"), cell(0, "500"), cell(1, "12"), cell(1, "Support")]),
    );
    expect(clauses.map((c) => [c.number, c.text])).toEqual([
      [undefined, "5"],
      [undefined, "Setup"],
      [undefined, "500"],
      [undefined, "12"],
      [undefined, "Support"],
    ]);
  });

  it("only hands a number over from the first paragraph of a row", () => {
    const clauses = segment(
      build([cell(0, "Ref"), cell(0, "1.1"), cell(0, "The Tenant shall pay the Rent.")]),
    );
    expect(clauses.map((c) => c.number)).toEqual([undefined, "1.1", undefined]);
  });

  it("reads a part of the contract named in its own cell as a title row", () => {
    const clauses = segment(
      build([
        cell(0, "Part A"),
        cell(0, "Services"),
        cell(1, "1.1"),
        cell(1, "Provider shall deliver the Services."),
        cell(2, "Schedule 1"),
        cell(2, "Fees"),
        cell(3, "1."),
        cell(3, "Customer shall pay the Fees."),
        cell(4, "Article IV"),
        cell(4, "Termination"),
        cell(5, "4.1"),
        cell(5, "Either party may terminate."),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "Part A Services"],
      ["1", "Schedule 1 Fees"],
      ["4.1", "Article IV Termination"],
    ]);
  });

  it("does not take a cell that holds a number and then text for a number cell", () => {
    const clauses = segment(build([cell(0, "3.1 Fees"), cell(0, "Notes on payment")]));
    expect(clauses.map((c) => [c.number, c.text])).toEqual([
      ["3.1", "3.1 Fees"],
      [undefined, "Notes on payment"],
    ]);
  });

  it("keeps both numbers when the text cell has a number of its own", () => {
    const clauses = segment(build([cell(0, "1.1"), cell(0, "1.2 The Tenant shall pay.")]));
    expect(clauses.map((c) => c.number)).toEqual(["1.1", "1.2"]);
  });

  it("does not hand a number to a signature line", () => {
    const clauses = segment(build([cell(0, "1."), cell(0, "By: ______")]));
    expect(clauses.map((c) => c.text)).toEqual(["1."]);
  });
});

describe("a number Word fills in, in a cell of its own", () => {
  it("goes to the clause in the next cell", () => {
    const clauses = segment(
      build([
        numberCell(0, "1.1", 1),
        cell(0, "In this Lease:"),
        numberCell(1, "1.2", 1),
        cell(1, "The Tenant shall pay the Rent."),
      ]),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: undefined, ids: [1], text: "In this Lease:" },
      { number: "1.2", heading: undefined, ids: [3], text: "The Tenant shall pay the Rent." },
    ]);
  });

  it("makes a heading of a title row in a heading style", () => {
    const clauses = segment(
      build([
        numberCell(0, "1.", 0, { styleName: "heading 1" }),
        cell(0, "Definitions"),
        numberCell(1, "1.1", 1),
        cell(1, "In this Lease:"),
        numberCell(2, "2.", 0, { styleName: "heading 1" }),
        cell(2, "Grant of Lease"),
        numberCell(3, "2.1", 1),
        cell(3, "Landlord lets the Premises."),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([
      ["1.1", "1. Definitions"],
      ["2.1", "2. Grant of Lease"],
    ]);
  });

  it("makes a heading of a title row by the style or outline level of the number cell", () => {
    const clauses = segment(
      build([
        numberCell(0, "1.1", 1, { styleName: "heading 2" }),
        cell(0, "Scope of services"),
        numberCell(1, "1.2", 1, { outline: 1 }),
        cell(1, "Rent and review"),
        numberCell(2, "1.3", 1),
        cell(2, "Landlord lets the Premises."),
      ]),
    );
    expect(shape(clauses)).toEqual([
      {
        number: "1.3",
        heading: "1.2 Rent and review",
        ids: [5],
        text: "Landlord lets the Premises.",
      },
    ]);
  });

  it("takes the row for a numbered clause even when its text is a bulleted paragraph", () => {
    const clauses = segment(
      build([
        "The Customer shall not:",
        numberCell(0, "4.1", 1),
        cell(0, "Premises means the second floor suite.", { list: "30", level: 0, bullet: true }),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual([undefined, "4.1"]);
  });

  it("keeps the label of a text cell that is numbered itself", () => {
    const clauses = segment(
      build([
        numberCell(0, "1.1", 1),
        cell(0, "Tenant shall pay the Rent.", { list: "1", level: 2, label: "(i)" }),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["(i)"]);
  });

  it("joins item rows to the clause row above them by the level of their number cells", () => {
    const clauses = segment(
      build([
        numberCell(0, "4.1", 1),
        cell(0, "Tenant shall keep the Premises in repair and"),
        numberCell(1, "(a)", 2),
        cell(1, "decorate them every five years;"),
        numberCell(2, "(b)", 2),
        cell(2, "permit entry on notice."),
        numberCell(3, "4.2", 1),
        cell(3, "Tenant shall not sublet."),
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([
      ["4.1", [1, 3, 5]],
      ["4.2", [7]],
    ]);
  });

  it("makes a heading of a short title behind a level 0 number, without any style", () => {
    const clauses = segment(
      build([
        numberCell(0, "ARTICLE III", 0),
        cell(0, "Rent"),
        numberCell(1, "3.1", 1),
        cell(1, "The Tenant shall pay quarterly."),
      ]),
    );
    expect(clauses.map((c) => [c.number, c.heading])).toEqual([["3.1", "ARTICLE III Rent"]]);
  });

  it("uses the level of the number cell, so items in the row stay with the clause", () => {
    const clauses = segment(
      build([
        numberCell(0, "4.1", 1),
        cell(0, "Tenant shall:"),
        cell(0, "keep the Premises in repair;", { list: "1", level: 2, label: "(a)" }),
        cell(0, "decorate them.", { list: "1", level: 2, label: "(b)" }),
        numberCell(1, "4.2", 1),
        cell(1, "Tenant shall not sublet."),
      ]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([
      ["4.1", [1, 2, 3]],
      ["4.2", [5]],
    ]);
  });

  it("numbers recitals laid out in rows", () => {
    const clauses = segment(
      build([
        numberCell(0, "(A)", 0, { list: "2" }),
        cell(0, "Landlord owns the freehold of the building."),
        numberCell(1, "(B)", 0, { list: "2" }),
        cell(1, "Landlord has agreed to let the Premises."),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["(A)", "(B)"]);
  });

  it("skips an empty paragraph that carries no label", () => {
    const clauses = segment(
      build([cell(0, "", { list: "1", level: 0 }), cell(0, "The Tenant shall pay.")]),
    );
    expect(shape(clauses).map((c) => [c.number, c.ids])).toEqual([[undefined, [1]]]);
  });

  it("skips an empty bullet and an empty numbered line outside a table", () => {
    const clauses = segment(
      build([
        cell(0, "", { list: "1", level: 0, bullet: true }),
        cell(0, "A bulleted cell."),
        { text: "", list: "1", level: 0, label: "7." },
        "The Tenant shall pay.",
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual([undefined, undefined]);
  });
});

describe("the same lease laid out either way", () => {
  const rows = [
    ["1.", "Definitions"],
    ["1.1", "In this Lease the Premises means the second floor suite."],
    ["1.2", "Landlord and Tenant include their successors in title."],
    ["2.", "Grant of Lease"],
    ["2.1", "Landlord lets the Premises to Tenant for five years."],
  ] as const;

  it("gives the same clauses from typed numbers and from Word's numbers", () => {
    const typed = rows.flatMap(([number, text], row) => [cell(row, number), cell(row, text)]);
    const auto = rows.flatMap(([number, text], row) => {
      const isArticle = !number.includes(".") || number.endsWith(".");
      return [
        numberCell(row, number, isArticle ? 0 : 1, isArticle ? { styleName: "heading 1" } : {}),
        cell(row, text),
      ];
    });
    const summary = (clauses: Clause[]) => clauses.map((c) => [c.number, c.heading, c.text]);
    expect(summary(segment(build(typed)))).toEqual(summary(segment(build(auto))));
    expect(summary(segment(build(typed)))).toEqual([
      ["1.1", "1. Definitions", rows[1][1]],
      ["1.2", "1. Definitions", rows[2][1]],
      ["2.1", "2. Grant of Lease", rows[4][1]],
    ]);
  });
});
