import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocx, type DocxParagraph } from "@clausewise/docx";
import { describe, expect, it } from "vitest";
import { segment } from "../src/segment.js";
import type { Clause } from "../src/types.js";

const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
const FIXTURES = ["nda-aggressive", "nda-balanced", "saas-vendor-friendly"] as const;

async function load(name: string): Promise<DocxParagraph[]> {
  const buf = new Uint8Array(await readFile(join(fixtures, `${name}.docx`)));
  return (await parseDocx(buf)).paragraphs;
}

interface Spec {
  text: string;
  style?: string;
  level?: number;
  table?: boolean;
}

const styled = (text: string, style: string): Spec => ({ text, style });
const auto = (text: string, level: number): Spec => ({ text, level });
const cell = (text: string): Spec => ({ text, table: true });

/** Builds parsed paragraphs the way parseDocx would, ids following position. */
function doc(...items: (string | Spec)[]): DocxParagraph[] {
  return docOf(items);
}

function docOf(items: (string | Spec)[]): DocxParagraph[] {
  return items.map((item, index) => {
    const spec: Spec = typeof item === "string" ? { text: item } : item;
    return {
      id: `p:${index}`,
      index,
      text: spec.text,
      style: spec.style,
      numbering: spec.level === undefined ? undefined : { id: "1", level: spec.level },
      inTable: spec.table ?? false,
    };
  });
}

const shape = (clauses: Clause[]) =>
  clauses.map((c) => ({
    number: c.number,
    heading: c.heading,
    ids: c.paragraphs.map((p) => p.id),
  }));

/** Segments a single paragraph and returns the one clause it must produce. */
function only(item: string | Spec): Clause {
  const clauses = segment(doc(item));
  expect(clauses).toHaveLength(1);
  return clauses[0]!;
}

// Independent of the implementation: these are the only kinds of noise and headings the
// shipped fixtures contain.
const isFixtureNoise = (p: DocxParagraph): boolean =>
  p.text.trim() === "" || (p.inTable && /^(By|Name|Title):/.test(p.text));
const isFixtureHeading = (p: DocxParagraph): boolean =>
  p.style === "Heading1" || p.style === "Title";

describe("segment on nda-aggressive.docx", () => {
  it("drops the blank line and the signature labels", async () => {
    const clauses = segment(await load("nda-aggressive"));
    const texts = clauses.flatMap((c) => c.paragraphs.map((p) => p.text));
    expect(texts.filter((t) => /^(By|Name|Title):|_{3}/.test(t) || t.trim() === "")).toEqual([]);
  });

  it("keeps the party names in the signature table as ordinary unnumbered clauses", async () => {
    const clauses = segment(await load("nda-aggressive"));
    const [first, second] = clauses.slice(-2);
    expect(first).toMatchObject({ text: "Northwind Holdings, Inc.", number: undefined });
    expect(second).toMatchObject({ text: "Fabrikam Labs LLC", number: undefined });
    expect(first?.heading).toBe("7. General");
  });

  it("gives clause 3.1 its heading and its paragraph id", async () => {
    const paragraphs = await load("nda-aggressive");
    const term = segment(paragraphs).find((c) => c.number === "3.1");
    expect(term).toBeDefined();
    expect(term?.id).toBe("c7");
    expect(term?.heading).toBe("3. Term");
    expect(term?.paragraphs.map((p) => p.id)).toEqual(["p:10"]);
    expect(term?.paragraphs[0]?.text).toBe(paragraphs[10]?.text);
    expect(term?.text).toContain("perpetual and shall continue indefinitely");
  });

  it("numbers the clauses 1.1 through 7.2 in document order", async () => {
    const clauses = segment(await load("nda-aggressive"));
    expect(clauses.map((c) => c.number).filter((n) => n !== undefined)).toEqual([
      "1.1",
      "1.2",
      "2.1",
      "2.2",
      "3.1",
      "4.1",
      "5.1",
      "5.2",
      "5.3",
      "6.1",
      "7.1",
      "7.2",
    ]);
  });

  it("makes each intro paragraph its own unnumbered clause", async () => {
    const clauses = segment(await load("nda-aggressive"));
    expect(shape(clauses.slice(0, 2))).toEqual([
      { number: undefined, heading: "CONFIDENTIALITY AGREEMENT", ids: ["p:1"] },
      { number: undefined, heading: "CONFIDENTIALITY AGREEMENT", ids: ["p:2"] },
    ]);
    expect(clauses[0]?.text).toMatch(/^This Confidentiality Agreement/);
    expect(clauses[1]?.text).toMatch(/^The parties wish to explore/);
  });

  it("never returns a heading as a clause", async () => {
    const paragraphs = await load("nda-aggressive");
    const headings = paragraphs.filter(isFixtureHeading);
    expect(headings).toHaveLength(8);
    const clauses = segment(paragraphs);
    const headingIds = new Set(headings.map((p) => p.id));
    const headingTexts = new Set(headings.map((p) => p.text));
    for (const clause of clauses) {
      expect(clause.paragraphs.some((p) => headingIds.has(p.id))).toBe(false);
      expect(headingTexts.has(clause.text)).toBe(false);
      expect(clause.heading === undefined || headingTexts.has(clause.heading)).toBe(true);
    }
  });
});

describe("segment on every shipped fixture", () => {
  it.each(FIXTURES)(
    "%s: each kept paragraph is in exactly one clause, ids run c1..cN",
    async (name) => {
      const paragraphs = await load(name);
      const clauses = segment(paragraphs);

      const expected = paragraphs
        .filter((p) => !isFixtureNoise(p) && !isFixtureHeading(p))
        .map((p) => ({ id: p.id, text: p.text }));
      expect(clauses.flatMap((c) => c.paragraphs)).toEqual(expected);

      expect(clauses.map((c) => c.id)).toEqual(clauses.map((_, i) => `c${i + 1}`));
      for (const clause of clauses) {
        expect(clause.text).toBe(clause.paragraphs.map((p) => p.text).join("\n"));
      }
    },
  );

  it.each(FIXTURES)("%s: each clause carries its heading and its typed number", async (name) => {
    const paragraphs = await load(name);
    const headingAbove = new Map<string, string | undefined>();
    let current: string | undefined;
    for (const p of paragraphs) {
      if (isFixtureHeading(p)) current = p.text.trim();
      headingAbove.set(p.id, current);
    }

    for (const clause of segment(paragraphs)) {
      const first = clause.paragraphs[0]!;
      expect(clause.heading).toBe(headingAbove.get(first.id));
      expect(clause.number).toBe(/^(\d+(?:\.\d+)*)\s/.exec(first.text)?.[1]);
    }
  });
});

describe("skipping noise (rule 1)", () => {
  it("skips empty and whitespace-only paragraphs", () => {
    const clauses = segment(doc("", "   ", "\t\u00a0\n", "1.1 Real clause."));
    expect(shape(clauses)).toEqual([{ number: "1.1", heading: undefined, ids: ["p:3"] }]);
  });

  it.each([
    "By: ______________",
    "Name:",
    "Title :",
    "DATE: 1 March 2026",
    "signature: x",
    "Signed: Jo",
  ])("skips the table line %j", (text) => {
    expect(segment(doc(cell(text)))).toEqual([]);
  });

  it("keeps the same words outside a table", () => {
    expect(only("Date: the Effective Date is 1 March 2026.").text).toMatch(/^Date:/);
  });

  it("keeps table text that only starts like a label", () => {
    const clauses = segment(doc(cell("Bylaws of the company"), cell("Names of the parties")));
    expect(clauses).toHaveLength(2);
  });

  it.each([
    ["underscores", "____________"],
    ["spaced hyphens", "- - - - -"],
    ["mixed", "_ - _ -"],
    ["em dashes", "\u2014\u2014\u2014"],
    ["en dashes", "\u2013 \u2013"],
  ])("skips a line of only %s, in or out of a table", (_label, text) => {
    expect(segment(doc(text, cell(text)))).toEqual([]);
  });

  it("keeps a line that has words next to its dashes", () => {
    expect(only("-- see Schedule 1").text).toBe("-- see Schedule 1");
  });

  it("does not let skipped paragraphs break a clause", () => {
    const clauses = segment(doc("3.1 Intro:", "", cell("By: ____"), "(a) limb"));
    expect(shape(clauses)).toEqual([{ number: "3.1", heading: undefined, ids: ["p:0", "p:3"] }]);
  });
});

describe("headings (rule 2)", () => {
  it.each(["Heading1", "Heading 2", "heading3", "HEADING 4", "Title"])(
    "treats the style %j as a heading",
    (style) => {
      const clauses = segment(doc(styled("Mixed case words here", style), "1.1 Body text."));
      expect(shape(clauses)).toEqual([
        { number: "1.1", heading: "Mixed case words here", ids: ["p:1"] },
      ]);
    },
  );

  it.each(["Heading", "Subtitle", "Title2", "Heading1Char", "ListParagraph", "Normal"])(
    "does not treat the style %j as a heading",
    (style) => {
      const clause = only(styled("Mixed case words here", style));
      expect(clause.text).toBe("Mixed case words here");
    },
  );

  it.each([
    "3. Term",
    "12. Limitation of Liability",
    "4 Return of Information",
    "5) Fees and Payment",
    "ARTICLE IV",
    "DEFINITIONS AND INTERPRETATION",
    "3. TERM",
    "5. Fees & Payment",
    "6. Phase 2 Deliverables",
    "7. Waiver and/or Release",
    "8. Term (Duration)",
    "Section 5 - Remedies",
    "Section 5 \u2013 Remedies",
    "Article IV: Termination",
    "Article 4 Confidentiality",
  ])("recognises %j as a heading", (text) => {
    const clauses = segment(doc(text, "Following clause text."));
    expect(shape(clauses)).toEqual([{ number: undefined, heading: text, ids: ["p:1"] }]);
  });

  it("records the trimmed heading text", () => {
    const clauses = segment(doc("  3. Term\t", "Following clause text."));
    expect(clauses[0]?.heading).toBe("3. Term");
  });

  it("holds a heading's limits at 80 characters and fewer than 10 words", () => {
    const at80 = `3. A${"a".repeat(76)}`;
    expect(at80).toHaveLength(80);
    expect(segment(doc(at80))).toEqual([]);
    expect(only(`${at80}a`).number).toBe("3");

    const nineWords = "3. Term Of This Agreement And Its Renewal Options";
    expect(segment(doc(nineWords))).toEqual([]);
    expect(only(`${nineWords} Here`).number).toBe("3");
  });

  it("applies a heading to the clauses after it until the next heading", () => {
    const clauses = segment(
      doc(
        "Preamble text before any heading.",
        styled("Parties", "Heading1"),
        "1.1 One.",
        "1.2 Two.",
        "2. Fees",
        "2.1 Three.",
      ),
    );
    expect(clauses.map((c) => c.heading)).toEqual([undefined, "Parties", "Parties", "2. Fees"]);
  });

  it("lets a later heading replace an earlier one with nothing between", () => {
    const clauses = segment(doc("2. Fees", "3. Term", "3.1 Body."));
    expect(shape(clauses)).toEqual([{ number: "3.1", heading: "3. Term", ids: ["p:2"] }]);
  });

  describe("false positives stay clauses", () => {
    it("a long numbered sentence is a clause", () => {
      const text =
        "1. This Agreement is made on 1 March 2026 between Northwind Holdings, Inc. and Fabrikam Labs LLC for the purpose below";
      expect(only(text)).toMatchObject({ number: "1", heading: undefined, text });
    });

    it("a short numbered sentence is a clause, because its words are not a title", () => {
      expect(only("1. This Agreement is made on 1 March 2026").number).toBe("1");
      expect(only("3. Recipient shall comply").number).toBe("3");
    });

    it.each(["3. Term.", "3. Term;", "3. Term,", "ARTICLE IV."])(
      "%j ends like a sentence",
      (text) => {
        expect(only(text).text).toBe(text);
      },
    );

    it("a title-case line over 80 characters is a clause", () => {
      const text = `3. ${"Confidentiality ".repeat(5).trim()}`;
      expect(text.length).toBeGreaterThan(80);
      expect(only(text).number).toBe("3");
    });

    it("a number must be followed by a capitalised word to make a title", () => {
      expect(only("3. the Term").number).toBe("3");
      expect(only("3. of Liability").number).toBe("3");
      expect(only("3. 30 Day Notice").number).toBe("3");
    });

    it("a multi-level number is a clause even when short", () => {
      expect(only("3.1 Term").number).toBe("3.1");
      expect(only("1.1 Definitions").number).toBe("1.1");
      expect(only("Section 3.1 Term").number).toBe("3.1");
    });

    it("a labelled line followed by prose is a clause", () => {
      expect(only("Article 4 Confidentiality obligations survive termination").number).toBe("4");
    });

    it("unnumbered mixed-case lines are clauses", () => {
      expect(only("Governing law").text).toBe("Governing law");
    });

    it("capitals that end with a full stop, or are too short or too long, are clauses", () => {
      expect(only("NORTHWIND HOLDINGS, INC.").text).toBe("NORTHWIND HOLDINGS, INC.");
      expect(only("N/A").text).toBe("N/A");
      expect(only("IV").text).toBe("IV");
      const tenWords = "THE PARTIES HAVE AGREED TO THE FOLLOWING TERMS AND CONDITIONS";
      expect(only(tenWords).text).toBe(tenWords);
    });

    it("a title-looking line in a table cell is content", () => {
      expect(only(cell("ACME LTD")).text).toBe("ACME LTD");
      expect(only(cell("3. Term")).number).toBe("3");
    });

    it("a capitalised list marker is an item, not a title", () => {
      const clauses = segment(doc("1.1 Intro:", "(A) PARTIES", "(IV)"));
      expect(shape(clauses)).toEqual([
        { number: "1.1", heading: undefined, ids: ["p:0", "p:1", "p:2"] },
      ]);
    });
  });

  it("returns nothing for a document of headings only", () => {
    expect(segment(doc("ARTICLE I", styled("Definitions", "Heading1"), "2. Term"))).toEqual([]);
  });
});

describe("clause numbers (rule 3)", () => {
  it.each([
    ["3.1 The Recipient shall hold it.", "3.1"],
    ["3.1.2 A deeper clause.", "3.1.2"],
    ["12. Governing law applies to this Agreement and every dispute under it.", "12"],
    ["4) The Supplier shall deliver.", "4"],
    ["3. The Recipient shall hold it.", "3"],
    ["Section 3.1 The Recipient shall hold it.", "3.1"],
    ["section 3.1 The Recipient shall hold it.", "3.1"],
    ["SECTION 3.1. Fees are payable monthly.", "3.1"],
    ["Article 4 applies to every dispute.", "4"],
    ["3.1.\tTab separated text.", "3.1"],
    ["  3.1 Leading space text.", "3.1"],
    ["3.1", "3.1"],
  ])("reads the number of %j as %j", (text, number) => {
    expect(only(text).number).toBe(number);
  });

  it.each([
    "30 days after the Effective Date, the Supplier shall pay.",
    "2.5% of the fees are payable.",
    "3.Term of the Agreement.",
    "Sections 3.1 and 3.2 apply.",
    "12345. Too many digits.",
    "1 March 2026 is the Effective Date.",
    "(1234) Four digits in brackets.",
  ])("does not read a number from %j", (text) => {
    expect(only(text).number).toBeUndefined();
  });

  it("starts a new clause for each typed number, including deeper levels", () => {
    const clauses = segment(doc("3.1 Parent:", "3.1.1 Child.", "3.1.2 Child.", "3.2 Next."));
    expect(clauses.map((c) => c.number)).toEqual(["3.1", "3.1.1", "3.1.2", "3.2"]);
  });

  it("keeps the paragraph text untrimmed while reading the number", () => {
    const clause = only("  3.1 Padded.  ");
    expect(clause.number).toBe("3.1");
    expect(clause.paragraphs[0]?.text).toBe("  3.1 Padded.  ");
  });
});

describe("sub-items (rule 4)", () => {
  it.each([
    "(a) a limb;",
    "(ii) a limb;",
    "(1) a limb;",
    "(A) a limb;",
    "(IV) a limb;",
    "(aa) a limb;",
    "(xiv) a limb;",
    "[b] a limb;",
    "[2] a limb;",
    "a) a limb;",
    "i) a limb;",
    "C) a limb;",
    "(a)no space limb;",
    "  (a) leading space limb;",
  ])("merges %j into the previous clause", (item) => {
    const clauses = segment(doc("3.1 The Recipient shall:", item));
    expect(shape(clauses)).toEqual([{ number: "3.1", heading: undefined, ids: ["p:0", "p:1"] }]);
    expect(clauses[0]?.text).toBe(`3.1 The Recipient shall:\n${item}`);
  });

  it("collects a run of items into one clause", () => {
    const clauses = segment(
      doc(
        "3.1 The Recipient shall:",
        "(a) keep it secret;",
        "(b) use it only for the Purpose; and",
        "(c) return it on request.",
        "3.2 Next clause.",
      ),
    );
    expect(shape(clauses)).toEqual([
      { number: "3.1", heading: undefined, ids: ["p:0", "p:1", "p:2", "p:3"] },
      { number: "3.2", heading: undefined, ids: ["p:4"] },
    ]);
  });

  it("makes an item straight after a heading its own clause, and merges the next into it", () => {
    const clauses = segment(
      doc("1.1 Earlier clause.", "2. Remedies", "(a) First remedy;", "(b) Second remedy."),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: undefined, ids: ["p:0"] },
      { number: undefined, heading: "2. Remedies", ids: ["p:2", "p:3"] },
    ]);
  });

  it("never merges an item across a heading, whatever the heading style", () => {
    const clauses = segment(
      doc("1.1 Earlier clause.", styled("Remedies", "Heading1"), "(i) Item."),
    );
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: undefined, ids: ["p:0"] },
      { number: undefined, heading: "Remedies", ids: ["p:2"] },
    ]);
  });

  it("makes an item at the very start of the document its own clause", () => {
    const clauses = segment(doc("(a) orphan", "(b) sibling"));
    expect(shape(clauses)).toEqual([
      { number: undefined, heading: undefined, ids: ["p:0", "p:1"] },
    ]);
  });

  it("treats 4) as a clause number, not an item", () => {
    const clauses = segment(doc("3.1 Intro.", "4) Next clause."));
    expect(clauses.map((c) => c.number)).toEqual(["3.1", "4"]);
  });

  it.each([
    "(the Agreement) is governed by Delaware law.",
    "(Services) are provided as is.",
    "(see below) for the schedule.",
    "(a1) an odd label.",
    "(abcdefg) too long to be a label.",
    "(1234) four digits.",
    "a)b with no space.",
    "(a limb that never closes",
  ])("does not read %j as an item", (text) => {
    const clauses = segment(doc("3.1 Intro.", text));
    expect(clauses).toHaveLength(2);
    expect(clauses[1]?.number).toBeUndefined();
  });

  describe("auto-numbered paragraphs", () => {
    it("merges levels above 0 into the previous clause", () => {
      const clauses = segment(
        doc(
          auto("The Recipient shall:", 0),
          auto("keep it secret;", 1),
          auto("use it only for the Purpose.", 2),
        ),
      );
      expect(shape(clauses)).toEqual([
        { number: undefined, heading: undefined, ids: ["p:0", "p:1", "p:2"] },
      ]);
    });

    it("starts a clause with no number at level 0", () => {
      const clauses = segment(
        doc(auto("First obligation text.", 0), auto("Second obligation text.", 0)),
      );
      expect(shape(clauses)).toEqual([
        { number: undefined, heading: undefined, ids: ["p:0"] },
        { number: undefined, heading: undefined, ids: ["p:1"] },
      ]);
    });

    it("makes a nested paragraph with no parent in its section its own clause", () => {
      expect(shape(segment(doc(auto("Indented, no parent.", 1))))).toEqual([
        { number: undefined, heading: undefined, ids: ["p:0"] },
      ]);
      const clauses = segment(doc("1.1 Earlier.", "2. Remedies", auto("Indented text.", 1)));
      expect(shape(clauses)).toEqual([
        { number: "1.1", heading: undefined, ids: ["p:0"] },
        { number: undefined, heading: "2. Remedies", ids: ["p:2"] },
      ]);
    });

    it("lets a typed number open a clause even when the paragraph is nested", () => {
      const clauses = segment(doc("3.1 Parent.", auto("3.1.2 Typed child.", 2)));
      expect(clauses.map((c) => c.number)).toEqual(["3.1", "3.1.2"]);
    });

    it("merges a typed item into the previous clause whatever its own level", () => {
      const clauses = segment(doc(auto("Parent text.", 0), auto("(a) typed item.", 0)));
      expect(clauses).toHaveLength(1);
    });
  });
});

describe("unnumbered paragraphs (rule 5)", () => {
  it("makes each title, preamble and recital paragraph its own clause", () => {
    const clauses = segment(
      doc(
        "This Agreement is made on 1 March 2026 between A and B.",
        "WHEREAS the Supplier develops software;",
        "WHEREAS the Customer wishes to licence it.",
      ),
    );
    expect(shape(clauses)).toEqual([
      { number: undefined, heading: undefined, ids: ["p:0"] },
      { number: undefined, heading: undefined, ids: ["p:1"] },
      { number: undefined, heading: undefined, ids: ["p:2"] },
    ]);
  });

  it("starts a new clause for unnumbered text that follows a numbered clause", () => {
    const clauses = segment(doc("1.1 First.", "provided that the above does not apply to X."));
    expect(shape(clauses)).toEqual([
      { number: "1.1", heading: undefined, ids: ["p:0"] },
      { number: undefined, heading: undefined, ids: ["p:1"] },
    ]);
  });
});

describe("output shape (rule 6)", () => {
  it("numbers clauses c1, c2, ... over emitted clauses only", () => {
    const clauses = segment(
      doc("", "1.1 One.", "(a) item", "2. Heading", "", "2.1 Two.", cell("By: __"), "3.1 Three."),
    );
    expect(clauses.map((c) => [c.id, c.number])).toEqual([
      ["c1", "1.1"],
      ["c2", "2.1"],
      ["c3", "3.1"],
    ]);
  });

  it("keeps each paragraph's id and exact text, and joins texts with a newline", () => {
    const first = "  3.1 Padded text.  ";
    const second = "\t(a) tabbed limb\u00a0";
    const clauses = segment(doc(first, second));
    expect(clauses).toHaveLength(1);
    expect(clauses[0]?.paragraphs).toEqual([
      { id: "p:0", text: first },
      { id: "p:1", text: second },
    ]);
    expect(clauses[0]?.text).toBe(`${first}\n${second}`);
  });

  it("treats table paragraphs that are not skipped as ordinary clauses", () => {
    const clauses = segment(
      doc(cell("Acme Ltd."), cell("3.1 Cell clause."), cell("(a) cell item."), cell("By: ____")),
    );
    expect(shape(clauses)).toEqual([
      { number: undefined, heading: undefined, ids: ["p:0"] },
      { number: "3.1", heading: undefined, ids: ["p:1", "p:2"] },
    ]);
  });

  it("does not modify its input", () => {
    const input = doc("1. Term", "1.1 One.", "(a) item", "", cell("By: __"));
    for (const p of input) Object.freeze(p);
    Object.freeze(input);
    const first = segment(input);
    expect(segment(input)).toEqual(first);
    expect(input).toHaveLength(5);
  });
});

describe("robustness (rule 7)", () => {
  it("returns an empty list for an empty array", () => {
    expect(segment([])).toEqual([]);
  });

  it("returns an empty list when every paragraph is empty or noise", () => {
    expect(segment(doc("", " ", "\n\t", cell("Name:"), "_____"))).toEqual([]);
  });

  it("does not throw on unusual styles, levels or characters", () => {
    const odd = doc(
      styled("Styled with nothing useful", ""),
      auto("Absurd level", 9999),
      "\ud800 lone surrogate",
      "\u0000 control character",
      "(\u00e9) accented marker",
    );
    expect(() => segment(odd)).not.toThrow();
    expect(segment(odd).length).toBeGreaterThan(0);
  });

  it("handles a very large document", () => {
    const n = 100_000;
    const clauses = segment(
      docOf(Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `${i}.1 Clause.` : "(a) item"))),
    );
    expect(clauses).toHaveLength(Math.ceil(n / 3));
    expect(clauses.at(-1)?.id).toBe(`c${Math.ceil(n / 3)}`);
  });

  it("handles pathological single paragraphs without blowing up", () => {
    const inputs = [
      "1".repeat(1_000_000),
      "1.".repeat(200_000),
      `Section${" ".repeat(500_000)}x`,
      `${"a".repeat(1_000_000)})`,
      "(".repeat(500_000),
      "[".repeat(500_000),
      `${"A ".repeat(200_000)}A`,
    ];
    const clauses = segment(docOf(inputs));
    expect(clauses).toHaveLength(inputs.length);
    expect(clauses.every((c) => c.number === undefined)).toBe(true);
  });
});
