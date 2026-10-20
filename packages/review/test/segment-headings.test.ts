import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * What is a section title and what is a clause. Word says so through the name of the paragraph's
 * style and its outline level, which survive a localised installation and a custom template, and
 * the text is only a fallback. A style or an outline level is believed only for a line that reads
 * as a title: law-firm templates give whole sentences a heading style, and those are clauses.
 */

interface Spec {
  text: string;
  style?: string;
  styleName?: string;
  outline?: number;
  list?: string;
  level?: number;
  label?: string | undefined;
  bullet?: boolean;
  row?: number;
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
      inTable: spec.row !== undefined,
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
  }));

const SIGN = String.fromCharCode(0xa7);
const BODY = "Provider shall deliver the Services on time.";

/** The one clause after a heading candidate, or undefined when the candidate was a clause. */
function headingOf(candidate: Spec): string | undefined {
  const clauses = segment(build([candidate, BODY]));
  return clauses.length === 1 ? clauses[0]?.heading : undefined;
}

describe("the style name decides, not the style id", () => {
  it.each([
    ["heading 1", "Word writes the name in lower case"],
    ["Heading 2", "other producers capitalise it"],
    ["HEADING 3", "or shout it"],
    ["  heading 4  ", "or pad it"],
    ["Title", "the document title"],
    ["title", "in lower case"],
    ["Schedule Heading", "a custom style with heading in its name"],
    ["Article Heading", "likewise"],
    ["Heading Level 1", "likewise"],
  ])("treats a paragraph in the style named %j as a heading (%s)", (styleName) => {
    expect(headingOf({ text: "Fees and Payment", style: "Custom7", styleName })).toBe(
      "Fees and Payment",
    );
  });

  it.each(["Titre1", "berschrift1", "Ttulo1", "Titolo1", "Kop1"])(
    "reads the localised style id %j through its name",
    (style) => {
      expect(headingOf({ text: "Fees and Payment", style, styleName: "heading 1" })).toBe(
        "Fees and Payment",
      );
    },
  );

  it("still reads the style id when the document has no name for it", () => {
    expect(headingOf({ text: "Fees and Payment", style: "Heading1" })).toBe("Fees and Payment");
  });

  it.each([
    "Normal",
    "Body Text",
    "List Paragraph",
    "Subtitle",
    "Table Heading",
    "TOC Heading",
    "Contents Heading",
    "Heading 1 Char",
  ])("does not treat a paragraph in the style named %j as a heading", (styleName) => {
    const clauses = segment(
      build([{ text: "Fees and Payment", style: "Custom7", styleName }, BODY]),
    );
    expect(clauses).toHaveLength(2);
  });

  it("keeps a whole sentence in a heading style as a clause", () => {
    const sentence = "Customer shall pay all undisputed invoices within thirty days of receipt.";
    const clauses = segment(
      build([
        { text: "Payment", style: "Heading1", styleName: "heading 1" },
        { text: sentence, style: "Heading2", styleName: "heading 2" },
      ]),
    );
    expect(shape(clauses)).toEqual([{ number: undefined, heading: "Payment", ids: [1] }]);
    expect(clauses[0]?.text).toBe(sentence);
  });

  it.each([
    ["has a verb", "Customer shall pay promptly"],
    ["ends with a full stop", "Payment Terms."],
    ["ends with a colon", "Customer pays as follows:"],
    [
      "is long",
      "Payment and Invoicing Arrangements for Services Provided Under Each Statement of Work",
    ],
    ["has ten words", "One Two Three Four Five Six Seven Eight Nine Ten"],
    ["holds a semicolon", "Fees; Payment"],
    ["ends with and", "Payment and"],
  ])("keeps a styled line that %s as a clause", (_why, text) => {
    const clauses = segment(build([{ text, style: "Heading1", styleName: "heading 1" }]));
    expect(clauses).toHaveLength(1);
  });

  it("holds the title shape at 79 characters and fewer than ten words", () => {
    const nine = "One Two Three Four Five Six Seven Eight Nine";
    expect(headingOf({ text: nine, style: "Heading1", styleName: "heading 1" })).toBe(nine);
    const long = "A".repeat(80);
    expect(headingOf({ text: long, style: "Heading1", styleName: "heading 1" })).toBe(long);
    const tooLong = "A".repeat(81);
    expect(headingOf({ text: tooLong, style: "Heading1", styleName: "heading 1" })).toBeUndefined();
  });
});

describe("the outline level", () => {
  it("makes a short title with an outline level a heading, whatever its style", () => {
    expect(headingOf({ text: "Fees and Payment", styleName: "Body Text", outline: 0 })).toBe(
      "Fees and Payment",
    );
    expect(headingOf({ text: "Fees and Payment", styleName: "Body Text", outline: 8 })).toBe(
      "Fees and Payment",
    );
  });

  it("does not take a sentence with an outline level for a heading", () => {
    const text = "The Supplier shall deliver the Services in accordance with this Agreement.";
    expect(segment(build([{ text, outline: 1 }]))).toHaveLength(1);
    expect(segment(build([{ text: "Supplier shall deliver", outline: 1 }]))).toHaveLength(1);
  });

  it("does not take body text, a bullet or a lowercase item for a heading", () => {
    expect(segment(build([{ text: "Fees and Payment" }]))).toHaveLength(1);
    expect(segment(build([{ text: "Fees and Payment", outline: 9 }]))).toHaveLength(1);
    expect(
      segment(build([{ text: "Fees and Payment", outline: 1, list: "1", level: 0, bullet: true }])),
    ).toHaveLength(1);
    expect(segment(build([{ text: "the timetable and milestones", outline: 2 }]))).toHaveLength(1);
  });
});

describe("a heading carries the number Word prints before it", () => {
  it("puts the label in front of the title, as the lawyer reads it", () => {
    const clauses = segment(
      build([
        { text: "Definitions", styleName: "heading 1", list: "1", level: 0, label: "1." },
        BODY,
        { text: "Services", styleName: "heading 1", list: "1", level: 0, label: "ARTICLE II" },
        BODY,
        { text: "Fees", styleName: "Schedule Heading", list: "2", level: 0, label: "Schedule 1" },
        BODY,
      ]),
    );
    expect(clauses.map((c) => c.heading)).toEqual([
      "1. Definitions",
      "ARTICLE II Services",
      "Schedule 1 Fees",
    ]);
  });

  it("does not repeat a label that the text starts with", () => {
    const clauses = segment(
      build([
        {
          text: "Schedule 1 Fees",
          styleName: "Schedule Heading",
          list: "2",
          level: 0,
          label: "Schedule 1",
        },
        BODY,
      ]),
    );
    expect(clauses[0]?.heading).toBe("Schedule 1 Fees");
  });

  it("prefers the number typed in the text to a different label", () => {
    const clauses = segment(
      build([
        { text: "1. Definitions", styleName: "heading 1", list: "1", level: 0, label: "A." },
        BODY,
      ]),
    );
    expect(clauses[0]?.heading).toBe("1. Definitions");
  });

  it("does not repeat a number that is also typed in the text", () => {
    const clauses = segment(
      build([
        { text: "1. Definitions", styleName: "heading 1", list: "1", level: 0, label: "1." },
        BODY,
      ]),
    );
    expect(clauses[0]?.heading).toBe("1. Definitions");
  });

  it("does not put a bullet or a missing label in front", () => {
    expect(headingOf({ text: "Definitions", styleName: "heading 1" })).toBe("Definitions");
  });
});

describe("a numbered level 0 paragraph that is a short title", () => {
  const level0 = (text: string, label = "1."): Spec => ({ text, list: "1", level: 0, label });

  it("is a heading, wherever it is", () => {
    expect(headingOf(level0("Limitation of Liability"))).toBe("1. Limitation of Liability");
    expect(headingOf(level0("Term", "ARTICLE IV"))).toBe("ARTICLE IV Term");
    expect(headingOf(level0("Fees", "Schedule 2"))).toBe("Schedule 2 Fees");
  });

  it("is a clause when it is a sentence", () => {
    for (const text of [
      "The Receiving Party shall keep it secret.",
      "The Receiving Party shall keep it secret",
      "Fees are payable monthly",
      "Provider provides technology consulting and implementation services.",
      "In this Agreement:",
      "Each party warrants that:",
    ]) {
      expect(segment(build([level0(text)]))).toHaveLength(1);
    }
  });

  it("is a clause when it does not start with a capital, is long, or has ten words", () => {
    expect(segment(build([level0("keep it secret")]))).toHaveLength(1);
    expect(segment(build([level0("A".repeat(81))]))).toHaveLength(1);
    expect(
      segment(build([level0("One Two Three Four Five Six Seven Eight Nine Ten")])),
    ).toHaveLength(1);
  });

  it("is a clause when its label is a list marker, a bullet or nothing", () => {
    expect(segment(build([level0("Evaluation", "(a)")]))).toHaveLength(1);
    expect(segment(build([level0("Evaluation", "a.")]))).toHaveLength(1);
    expect(segment(build([{ ...level0("Evaluation"), bullet: true }]))).toHaveLength(1);
    expect(segment(build([{ ...level0("Evaluation"), label: undefined }]))).toHaveLength(1);
  });

  it("is a clause at level 1 or deeper, as a short multi-level clause is", () => {
    expect(
      segment(build([{ text: "Interpretation", list: "1", level: 1, label: "1.1" }])),
    ).toHaveLength(1);
  });
});

describe("typed labels", () => {
  it.each([
    "Schedule 1 Fees",
    "Schedule 1",
    "Part A Services",
    "Part II General Terms",
    "Exhibit B Form of Notice",
    "Annex 2 Data Processing",
    "Annexure 3 Rates",
    "Appendix A Rate Card",
    "Clause 3 Term",
    "Section 5 - Remedies",
    "Article IV: Termination",
    `${SIGN} 5 Fees`,
    `${SIGN}5 Fees`,
  ])("recognises %j as a heading", (text) => {
    const clauses = segment(build([text, BODY]));
    expect(shape(clauses)).toEqual([{ number: undefined, heading: text, ids: [1] }]);
  });

  it.each([
    "Schedule 1 sets out the fees",
    "Part of the fee is refundable",
    "Part A applies to every Order.",
    "Exhibit B, attached, forms part of this Agreement",
    "Annex 2 and Annex 3 apply",
  ])("keeps %j as a clause", (text) => {
    expect(segment(build([text]))).toHaveLength(1);
  });

  it.each([
    ["Clause 3.1 Renewal applies.", "3.1"],
    ["clause 3.1.2 The Tenant shall pay.", "3.1.2"],
    [`${SIGN} 3.1 Fees are due on receipt.`, "3.1"],
    [`${SIGN}4 Payment is due on receipt.`, "4"],
    ["Clause 3.1 Renewal", "3.1"],
  ])("reads the number of %j as %j", (text, number) => {
    const clauses = segment(build([text]));
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.number).toBe(number);
  });

  it.each(["Schedule 1 sets out the fees.", "Part A applies to every Order.", "Annex 2 applies."])(
    "never makes a number of the part named by %j",
    (text) => {
      expect(segment(build([text]))[0]?.number).toBeUndefined();
    },
  );
});

describe("headings in table cells", () => {
  it("accepts a heading style or a level 0 title, and nothing else", () => {
    const clauses = segment(
      build([
        { text: "Fees", styleName: "heading 1", row: 0 },
        { text: "Annual subscription is 48,000 EUR.", row: 1 },
        { text: "Term", list: "1", level: 0, label: "2.", row: 2 },
        { text: "The Initial Term is twelve months.", row: 3 },
        { text: "ACME LTD", row: 4 },
        { text: "3. Term", row: 5 },
      ]),
    );
    expect(shape(clauses)).toEqual([
      { number: undefined, heading: "Fees", ids: [1] },
      { number: undefined, heading: "2. Term", ids: [3] },
      { number: undefined, heading: "2. Term", ids: [4] },
      { number: "3", heading: "2. Term", ids: [5] },
    ]);
  });

  it("does not take a column title in a Table Heading style for a section", () => {
    const clauses = segment(
      build([
        { text: "Fees and Payment", styleName: "heading 1" },
        { text: "Annual Fee", styleName: "Table Heading", row: 0 },
        { text: "48,000", row: 0 },
      ]),
    );
    expect(clauses.map((c) => c.heading)).toEqual(["Fees and Payment", "Fees and Payment"]);
  });
});
