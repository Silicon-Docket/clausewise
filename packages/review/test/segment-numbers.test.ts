import type { DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

/**
 * Clause.number is the clause's own number as the lawyer sees it: the typed number when the text
 * starts with one, otherwise the label Word prints before the paragraph that opens the clause,
 * reduced to the bare number. It is never invented.
 */

interface Spec {
  text: string;
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
      style: undefined,
      numbering: listed ? { id: spec.list!, level: spec.level! } : undefined,
      inTable: false,
      tableRow: undefined,
      label: spec.label,
      level: listed ? spec.level : undefined,
      isBullet: spec.bullet ?? false,
      styleName: undefined,
      outlineLevel: undefined,
      isTocEntry: false,
    };
  });
}

const labelled = (text: string, label: string | undefined, level = 1): Spec => ({
  text,
  list: "1",
  level,
  ...(label === undefined ? {} : { label }),
});

function only(spec: string | Spec): Clause {
  const clauses = segment(build([spec]));
  expect(clauses).toHaveLength(1);
  return clauses[0]!;
}

const SENTENCE = "The Supplier shall deliver the Services.";

describe("the number of an auto-numbered clause", () => {
  it.each([
    ["3.1", "3.1"],
    ["12", "12"],
    ["12.", "12"],
    ["3.1.2", "3.1.2"],
    ["4)", "4"],
    ["Section 1.01", "1.01"],
    ["section 2.3", "2.3"],
    ["Article IV", "IV"],
    ["ARTICLE II", "II"],
    ["Clause 7", "7"],
    ["(a)", "(a)"],
    ["(iv)", "(iv)"],
    ["(A)", "(A)"],
    ["[b]", "[b]"],
    ["a)", "a"],
    ["iv.", "iv"],
    ["A.", "A"],
    ["1.1.1(a)", "1.1.1(a)"],
    ["  3.1  ", "3.1"],
  ])("reads the label %j as %j", (label, number) => {
    expect(only(labelled(SENTENCE, label)).number).toBe(number);
  });

  it("leaves the number undefined when Word prints nothing", () => {
    expect(only(labelled(SENTENCE, undefined)).number).toBeUndefined();
    expect(only({ text: SENTENCE }).number).toBeUndefined();
    expect(only({ text: SENTENCE, list: "1", level: 0, bullet: true }).number).toBeUndefined();
  });

  it.each(["", "   ", ".", "-", "***", "()", "Article", "A".repeat(40), "1.".repeat(20)])(
    "does not make a number of the label %j",
    (label) => {
      expect(only(labelled(SENTENCE, label)).number).toBeUndefined();
    },
  );

  it("keeps the name of a part with its number, and nothing else with two words", () => {
    expect(only(labelled(SENTENCE, "Schedule 1")).number).toBe("Schedule 1");
    expect(only(labelled(SENTENCE, "Part A")).number).toBe("Part A");
    expect(only(labelled(SENTENCE, "Hello 1")).number).toBeUndefined();
    expect(only(labelled(SENTENCE, "Section Hello 1")).number).toBeUndefined();
  });

  it("takes the label of the paragraph that opens the clause, not of its items", () => {
    const clauses = segment(
      build([
        labelled("The Receiving Party shall:", "2.2"),
        labelled("keep it secret;", "(a)", 2),
        labelled("use it only for the Purpose.", "(b)", 2),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["2.2"]);
  });

  it("numbers every clause of a list the way Word shows the list", () => {
    const clauses = segment(
      build([
        labelled("In this Agreement:", "1.1"),
        labelled("Headings do not affect meaning.", "1.2"),
        labelled("The Supplier shall deliver the Services.", "2.1"),
        labelled("The Supplier shall invoice monthly.", "2.2"),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["1.1", "1.2", "2.1", "2.2"]);
  });
});

describe("a typed number wins over the label", () => {
  it("takes the number written in the text", () => {
    expect(only(labelled("3.1 The Supplier shall deliver.", "7.7")).number).toBe("3.1");
    expect(only(labelled("Section 4.2 Fees are payable monthly.", "(a)")).number).toBe("4.2");
  });

  it("opens a new clause for a typed number even inside a deeper level", () => {
    const clauses = segment(
      build([
        labelled("The Receiving Party shall:", "1.1"),
        labelled("3.1.2 A typed child.", "(a)", 2),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["1.1", "3.1.2"]);
  });

  it("gives a typed list marker no number, as before", () => {
    const clauses = segment(build(["1. Remedies", "(a) First remedy;"]));
    expect(clauses.map((c) => c.number)).toEqual([undefined]);
  });
});

describe("numbers are not invented", () => {
  it("leaves a paragraph with a digit-led sentence unnumbered", () => {
    expect(
      only("30 days after the Effective Date, the Supplier shall pay.").number,
    ).toBeUndefined();
  });

  it("leaves unnumbered definitions, parties and recitals unnumbered", () => {
    const clauses = segment(
      build([
        labelled("In this Agreement:", "1.1"),
        { text: '"Affiliate" means a related company.' },
        { text: '"Business Day" means a weekday.' },
        labelled("Headings do not affect meaning.", "1.2"),
      ]),
    );
    expect(clauses.map((c) => c.number)).toEqual(["1.1", undefined, undefined, "1.2"]);
  });
});
