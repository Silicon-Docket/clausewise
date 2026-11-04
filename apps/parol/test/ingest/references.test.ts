import { describe, expect, it } from "vitest";
import { findCrossReferences, type CrossReference } from "../../src/ingest/references.js";
import { matchView } from "../../src/ingest/view.js";
import { AMENDMENT_NO_1, SHORT_NDA, annotationsOn, ingestTexts } from "./support.js";

const inAmendment = (text: string): CrossReference[] =>
  findCrossReferences(matchView(text), { amendment: true });
const inNda = (text: string): CrossReference[] =>
  findCrossReferences(matchView(text), { amendment: false });

const ref = (target: string, verb: CrossReference["verb"]): CrossReference => ({ target, verb });

describe("the verb an amendment applies to a clause", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "deleted in its entirety",
      "Section 6.1 of the Agreement is deleted in its entirety.",
      [ref("6.1", "deletes")],
    ],
    [
      "two sections amended by replacing words",
      'Sections 4 and 5 are hereby amended by replacing the words "two years" with "three years".',
      [ref("4", "amends"), ref("5", "amends")],
    ],
    [
      "amended by deleting a section and substituting text",
      "The Agreement is amended by deleting Section 7.2 and substituting the following:",
      [ref("7.2", "replaces")],
    ],
    [
      "the closing boilerplate names no clause",
      "Except as amended by this Amendment, the Agreement remains in full force and effect.",
      [],
    ],
    ["a schedule is not a clause", "See Schedule 2 for the list of Representatives.", []],
    [
      "the worked example's second clause",
      'Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".',
      [ref("7.2", "amends")],
    ],
    [
      "replaced in its entirety",
      "Clause 3 is replaced in its entirety with the following:",
      [ref("3", "replaces")],
    ],
    [
      "amended and restated is a replacement",
      "Section 4 is amended and restated in its entirety.",
      [ref("4", "replaces")],
    ],
    [
      "superseded, with a roman article",
      "Article II is superseded by the terms of this Amendment.",
      [ref("II", "replaces")],
    ],
    ["omitted", "Paragraph 2 is omitted.", [ref("2", "deletes")]],
    [
      "modified",
      'Section 9.3 is modified to add the word "Affiliates" after "Representatives".',
      [ref("9.3", "amends")],
    ],
    ["struck out", "Section 5.1 is struck out and left blank.", [ref("5.1", "deletes")]],
    [
      "a list with no operation word",
      "Sections 4, 5 and 8 survive any termination or expiration of the Agreement.",
      [ref("4", "refers"), ref("5", "refers"), ref("8", "refers")],
    ],
    [
      "two operations split by a semicolon",
      "Section 3 is deleted; Section 4 is replaced with the following.",
      [ref("3", "deletes"), ref("4", "replaces")],
    ],
    [
      "two operations in one sentence with no semicolon",
      "Section 3 is deleted and Section 4 is replaced by new wording.",
      [ref("3", "deletes"), ref("4", "replaces")],
    ],
    [
      "deleted and replaced in one go",
      "Section 6.1 is deleted and replaced with the following wording.",
      [ref("6.1", "replaces")],
    ],
    [
      "to delete",
      "The parties agree to delete Section 5.2 from the Agreement.",
      [ref("5.2", "deletes")],
    ],
    [
      "hereby replaces",
      "This Amendment hereby replaces Section 5 of the Agreement.",
      [ref("5", "replaces")],
    ],
    [
      "supplemented",
      "Section 8 is supplemented by the following new paragraph.",
      [ref("8", "amends")],
    ],
    ["revised", "Section 8 is revised as set out below.", [ref("8", "amends")]],
    ["a sub-item is dropped", "Section 6.1(a) is deleted.", [ref("6.1", "deletes")]],
    [
      "a trailing capital letter is part of the number",
      "Section 4A is deleted.",
      [ref("4A", "deletes")],
    ],
    [
      "every clause of a range",
      "Sections 4 through 6 are deleted.",
      [ref("4", "deletes"), ref("5", "deletes"), ref("6", "deletes")],
    ],
    ["the section sign", "\u00a7 7.2 is deleted.", [ref("7.2", "deletes")]],
    ["Sec.", "Sec. 3 is deleted.", [ref("3", "deletes")]],
    ["upper case", "SECTION 3 IS DELETED.", [ref("3", "deletes")]],
    ["the third person", "Amendment No. 1 deletes Section 3.", [ref("3", "deletes")]],
    [
      "e.g. and i.e. do not end the sentence",
      "Section 3, e.g. Section 4, is deleted.",
      [ref("3", "deletes"), ref("4", "deletes")],
    ],
    [
      "a full stop inside closing quotes still ends it",
      'Section 3 is amended by replacing "two years." Section 4 refers to this.',
      [ref("3", "amends"), ref("4", "refers")],
    ],
    [
      "the abbreviation No. does not end the sentence",
      "Section 3, introduced by Amendment No. 2, is deleted.",
      [ref("3", "deletes")],
    ],
    [
      "wording after a colon is new text, not an operation",
      "Section 6 is replaced as follows: Section 4 governs the term.",
      [ref("6", "replaces"), ref("4", "refers")],
    ],
    [
      "a reference inside quoted wording only refers",
      'Section 9 is amended by replacing "Section 4" with "Section 5".',
      [ref("9", "amends"), ref("4", "refers"), ref("5", "refers")],
    ],
    [
      "an operation word inside quotes is not an operation",
      'Section 9 requires notice. The heading "Deleted items" is kept.',
      [ref("9", "refers")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });

  it.each<[string, string, CrossReference[]]>([
    [
      "as amended describes a clause, it does not operate on it",
      "Section 4 as amended by Amendment No. 1 continues to apply.",
      [ref("4", "refers")],
    ],
    [
      "except as amended is a reservation",
      "Except as amended by this Amendment, Section 4 remains in full force.",
      [ref("4", "refers")],
    ],
    [
      "a prohibition is not an operation",
      "Section 4 shall not be amended or deleted without the consent of both parties.",
      [ref("4", "refers")],
    ],
    [
      "the bare verb is not an operation",
      "The Receiving Party shall delete all copies as required by Section 7.2.",
      [ref("7.2", "refers")],
    ],
    [
      "an operation in another sentence is not read",
      "Section 5 applies to every disclosure. Section 7 is deleted.",
      [ref("5", "refers"), ref("7", "deletes")],
    ],
  ])("is careful: %s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });

  it("reports one annotation per target, the strongest verb winning", () => {
    expect(
      inAmendment(
        "Section 5 shall continue to apply. Section 5 is deleted. Section 5 is mentioned again.",
      ),
    ).toEqual([ref("5", "deletes")]);
    expect(inAmendment("Section 5 is amended; Section 5 is replaced.")).toEqual([
      ref("5", "replaces"),
    ]);
  });

  it("gives the ends of a list but not a number that is a period of time", () => {
    expect(inAmendment("Section 4, 30 days after notice, is amended.")).toEqual([
      ref("4", "amends"),
    ]);
    expect(inAmendment("Section 4, 2026 will be amended.")).toEqual([ref("4", "amends")]);
    expect(inAmendment("Sections 4, 5, and 8 are deleted.")).toEqual([
      ref("4", "deletes"),
      ref("5", "deletes"),
      ref("8", "deletes"),
    ]);
    expect(inAmendment("Sections 4 or 5 and/or 6 are deleted.")).toEqual([
      ref("4", "deletes"),
      ref("5", "deletes"),
      ref("6", "deletes"),
    ]);
  });

  it("does not read a roman numeral in the middle of a list of numbers", () => {
    expect(inAmendment("Sections 3 and I agree on this.")).toEqual([ref("3", "refers")]);
    expect(inAmendment("Articles II and IV are deleted.")).toEqual([
      ref("II", "deletes"),
      ref("IV", "deletes"),
    ]);
  });

  it.each([
    ["no number after the label", "The Section headings are for convenience only."],
    ["a label inside a longer word", "A subsection heading and an intersection of interests."],
    ["Schedule, Exhibit and Annex", "See Schedule 2, Exhibit A and Annex 3."],
    ["a bare number", "The period in 6.1 is long."],
    ["a lower-case roman word", "Article i is not a number."],
    ["a lettered target", "Section A is deleted."],
  ])("finds nothing in %s", (_name, text) => {
    expect(inAmendment(text)).toEqual([]);
  });
});

describe("a clause the amendment leaves alone", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "nothing in this amendment deletes",
      "Nothing in this Amendment deletes Section 6.1.",
      [ref("6.1", "refers")],
    ],
    [
      "nothing deletes or replaces",
      "Nothing in this Amendment deletes or replaces Section 6.1.",
      [ref("6.1", "refers")],
    ],
    [
      "do not intend to delete",
      "The parties do not intend to delete Section 6.1.",
      [ref("6.1", "refers")],
    ],
    [
      "neither nor",
      "Neither Section 6.1 nor Section 6.2 is deleted.",
      [ref("6.1", "refers"), ref("6.2", "refers")],
    ],
    [
      "one clause is not deleted, the other is",
      "Section 6.1 is not deleted but Section 6.2 is deleted.",
      [ref("6.1", "refers"), ref("6.2", "deletes")],
    ],
    [
      "one clause is deleted, the other is not",
      "Section 6.1 is deleted but Section 6.2 is not.",
      [ref("6.1", "deletes"), ref("6.2", "refers")],
    ],
    ["a contraction", "This Amendment doesn't delete Section 6.1.", [ref("6.1", "refers")]],
    [
      "a negation far from the operation does not reach across a comma",
      "Section 6.1 of the Agreement, which shall not apply to Affiliates, is deleted.",
      [ref("6.1", "deletes")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("a conforming amendment edits a reference and not the clause it names", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "deleting the reference to a clause",
      "Section 9.3 is amended by deleting the reference to Section 6.1.",
      [ref("9.3", "amends"), ref("6.1", "refers")],
    ],
    [
      "replacing one reference with another",
      "Section 9.3 is amended by replacing the reference to Section 6.1 with a reference to Section 6.2.",
      [ref("9.3", "amends"), ref("6.1", "refers"), ref("6.2", "refers")],
    ],
    [
      "deleting one and inserting another",
      "Section 9.3 is amended by deleting the reference to Section 6.1 and inserting a reference to Section 6.2.",
      [ref("9.3", "amends"), ref("6.1", "refers"), ref("6.2", "refers")],
    ],
    [
      "references in the plural",
      "Section 9.3 is amended by deleting the references to Sections 6.1 and 6.2.",
      [ref("9.3", "amends"), ref("6.1", "refers"), ref("6.2", "refers")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("a sentence with two operations", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "shall be amended and shall be deleted",
      "Section 6.1 shall be amended and Section 7.2 shall be deleted.",
      [ref("6.1", "amends"), ref("7.2", "deletes")],
    ],
    [
      "deleted and a renumbered clause",
      "Section 6.1 is deleted and Section 6.2 is renumbered as 6.1.",
      [ref("6.1", "deletes"), ref("6.2", "refers")],
    ],
    [
      "deleted and a clause read as another",
      "Section 6.1 is deleted and Section 6.2 shall be read as Section 6.1.",
      [ref("6.1", "deletes"), ref("6.2", "refers")],
    ],
    [
      "the same sentence with is amended and is deleted",
      "Section 6.1 is amended and Section 7.2 is deleted.",
      [ref("6.1", "amends"), ref("7.2", "deletes")],
    ],
    [
      "two separate references share one passive verb",
      "Section 4 and Section 5 are deleted.",
      [ref("4", "deletes"), ref("5", "deletes")],
    ],
    [
      "three separate references share one passive verb",
      "Section 3, Section 4 and Section 5 are replaced.",
      [ref("3", "replaces"), ref("4", "replaces"), ref("5", "replaces")],
    ],
    [
      "two separate references share one active verb",
      "Delete Section 4 and Section 5.",
      [ref("4", "deletes"), ref("5", "deletes")],
    ],
    [
      "a clause that survives next to a deleted one",
      "Section 6.1 survives, and Section 6.2 is deleted.",
      [ref("6.1", "refers"), ref("6.2", "deletes")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("a full stop that does not end the sentence", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "Sept.",
      "Section 6.1 of the Agreement dated Sept. 1, 2025 is deleted.",
      [ref("6.1", "deletes")],
    ],
    [
      "Feb.",
      "Section 6.1 of the Agreement dated Feb. 2, 2026 is replaced as follows.",
      [ref("6.1", "replaces")],
    ],
    [
      "Pty.",
      "Section 6.1 of the Agreement between Acme Pty. Ltd. and Beta is deleted.",
      [ref("6.1", "deletes")],
    ],
    [
      "Dec. and Bhd.",
      "Section 6.1 of the Agreement made on Dec. 12, 2025 with Orion Sdn. Bhd. is deleted.",
      [ref("6.1", "deletes")],
    ],
    [
      "a sentence that really ends at a month name still ends",
      "Section 6.1 is deleted in December. Section 6.2 survives.",
      [ref("6.1", "deletes"), ref("6.2", "refers")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("other ways to delete, replace or amend a clause", () => {
  it.each<[string, string, CrossReference[]]>([
    ["imperative delete", "Delete Section 6.1 in its entirety.", [ref("6.1", "deletes")]],
    ["imperative delete after a list number", "2. Delete Section 6.1.", [ref("6.1", "deletes")]],
    [
      "imperative delete after a list marker",
      "(a) Delete Section 6.1 in its entirety.",
      [ref("6.1", "deletes")],
    ],
    ["imperative replace", "Replace Section 6.1 with the following:", [ref("6.1", "replaces")]],
    ["imperative amend", "Amend Section 6.1 to read as follows:", [ref("6.1", "amends")]],
    [
      "imperative delete, plural",
      "Delete Sections 4 and 5.",
      [ref("4", "deletes"), ref("5", "deletes")],
    ],
    ["revoked", "Section 6.1 is hereby revoked.", [ref("6.1", "deletes")]],
    ["repealed", "Section 6.1 is hereby repealed.", [ref("6.1", "deletes")]],
    ["rescinded", "Section 6.1 is rescinded.", [ref("6.1", "deletes")]],
    ["cancelled", "Section 6.1 is cancelled.", [ref("6.1", "deletes")]],
    ["canceled", "Section 6.1 is canceled.", [ref("6.1", "deletes")]],
    ["withdrawn", "Section 6.1 is withdrawn.", [ref("6.1", "deletes")]],
    [
      "of no further force or effect",
      "Section 6.1 is of no further force or effect.",
      [ref("6.1", "deletes")],
    ],
    ["null and void", "Section 6.1 is null and void.", [ref("6.1", "deletes")]],
    ["changed to", "Section 6.1 shall be changed to ten years.", [ref("6.1", "amends")]],
    [
      "extended to",
      "The term set forth in Section 6.1 is extended to ten (10) years.",
      [ref("6.1", "amends")],
    ],
    [
      "a third person verb with a comma before the clause",
      "This Amendment hereby deletes, in its entirety, Section 5.",
      [ref("5", "deletes")],
    ],
    [
      "a negated revocation",
      "Nothing in this Amendment revokes Section 6.1.",
      [ref("6.1", "refers")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("ranges and parentheticals", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "a dotted range",
      "Sections 6.1 through 6.3 are deleted.",
      [ref("6.1", "deletes"), ref("6.2", "deletes"), ref("6.3", "deletes")],
    ],
    [
      "a dotted range with to",
      "Sections 6.1 to 6.3 are deleted.",
      [ref("6.1", "deletes"), ref("6.2", "deletes"), ref("6.3", "deletes")],
    ],
    [
      "a range with a hyphen",
      "Sections 4-6 are deleted.",
      [ref("4", "deletes"), ref("5", "deletes"), ref("6", "deletes")],
    ],
    [
      "a range among a list",
      "Sections 2, 4 through 6 and 9 are deleted.",
      [
        ref("2", "deletes"),
        ref("4", "deletes"),
        ref("5", "deletes"),
        ref("6", "deletes"),
        ref("9", "deletes"),
      ],
    ],
    [
      "a range whose ends have different prefixes names only its ends",
      "Sections 6.1 through 7.3 are deleted.",
      [ref("6.1", "deletes"), ref("7.3", "deletes")],
    ],
    [
      "a backwards range names only its ends",
      "Sections 6 through 4 are deleted.",
      [ref("6", "deletes"), ref("4", "deletes")],
    ],
    [
      "a parenthetical exception does not cancel the operation",
      "Sections 6.1 and 6.2 (but not 6.3) are deleted.",
      [ref("6.1", "deletes"), ref("6.2", "deletes")],
    ],
    [
      "a parenthetical note with a negation",
      "Section 6.1 (which does not apply to Affiliates) is deleted.",
      [ref("6.1", "deletes")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });

  it("expands a range only up to a bound", () => {
    // 99 clauses lie between 1 and 101 and 100 between 1 and 102: both are expanded. 101 between
    // 1 and 103 is one too many, and a range of that size names its ends.
    expect(inAmendment("Sections 1 through 101 are deleted.")).toHaveLength(101);
    expect(inAmendment("Sections 1 through 102 are deleted.")).toHaveLength(102);
    const ends = inAmendment("Sections 1 through 103 are deleted.");
    expect(ends.map((r) => r.target)).toEqual(["1", "103"]);
    expect(inAmendment("Sections 1 through 999 are deleted.").map((r) => r.target)).toEqual([
      "1",
      "999",
    ]);
    expect(ends.every((r) => r.verb === "deletes")).toBe(true);
  });

  it("does not expand ranges of roman numerals, letters or numbers with a suffix", () => {
    expect(inAmendment("Articles II through V are deleted.").map((r) => r.target)).toEqual([
      "II",
      "V",
    ]);
    expect(inAmendment("Sections 4A through 4D are deleted.").map((r) => r.target)).toEqual([
      "4A",
      "4D",
    ]);
    expect(inAmendment("Sections 6.01 to 6.04 are deleted.").map((r) => r.target)).toEqual([
      "6.01",
      "6.04",
    ]);
  });
});

describe("a bare verb that is not an operation on a clause", () => {
  it.each<[string, string, CrossReference[]]>([
    [
      "agrees to remove copies",
      "The Receiving Party agrees to remove all copies of Confidential Information in accordance with Section 7.2.",
      [ref("7.2", "refers")],
    ],
    [
      "may require to delete information",
      "The Disclosing Party may require the Receiving Party to delete Confidential Information in accordance with Section 7.2.",
      [ref("7.2", "refers")],
    ],
    [
      "shall hereby supplement the schedule",
      "The Recipient shall hereby supplement the Schedule as required by Section 4.",
      [ref("4", "refers")],
    ],
    [
      "the words are deleted from the clause",
      'The parties agree to delete the words "ten days" from Section 4.',
      [ref("4", "refers")],
    ],
  ])("%s", (_name, text, expected) => {
    expect(inAmendment(text)).toEqual(expected);
  });
});

describe("a reference in the NDA itself", () => {
  it("only refers, whatever the words around it", () => {
    expect(inNda("Section 6.1 of the Agreement is deleted in its entirety.")).toEqual([
      ref("6.1", "refers"),
    ]);
    expect(inNda("Sections 4, 5 and 8 survive any termination.")).toEqual([
      ref("4", "refers"),
      ref("5", "refers"),
      ref("8", "refers"),
    ]);
    expect(inNda("Clause 3 is replaced and Section 2 is amended.")).toEqual([
      ref("3", "refers"),
      ref("2", "refers"),
    ]);
  });
});

describe("cross_reference annotations through buildIngest", () => {
  it("annotates the worked example: 6.1 deleted, 7.2 amended, nothing for the boilerplate", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1);
    expect(annotationsOn(out, "D2-p3", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d2:p3", target: "6.1", verb: "deletes" },
    ]);
    expect(annotationsOn(out, "D2-p4", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d2:p4", target: "7.2", verb: "amends" },
    ]);
    expect(annotationsOn(out, "D2-p5", "cross_reference")).toEqual([]);
    expect(annotationsOn(out, "D2-p2", "cross_reference")).toEqual([]);
  });

  it("gives the NDA's own references the verb refers", () => {
    const out = ingestTexts(SHORT_NDA, AMENDMENT_NO_1);
    expect(annotationsOn(out, "D1-p11", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d1:p11", target: "4", verb: "refers" },
      { kind: "cross_reference", spanId: "dv_d1:p11", target: "5", verb: "refers" },
      { kind: "cross_reference", spanId: "dv_d1:p11", target: "8", verb: "refers" },
    ]);
    expect(annotationsOn(out, "D1-p7", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d1:p7", target: "4", verb: "refers" },
    ]);
  });

  it("gives the same sentence the verb deletes in an amendment and refers in the NDA", () => {
    const sentence = "1. Section 6.1 of the Agreement is deleted in its entirety.";
    const out = ingestTexts(sentence, sentence, sentence);
    const verbOf = (label: string): string[] =>
      annotationsOn(out, label, "cross_reference").map((a) => (a as { verb: string }).verb);
    expect(verbOf("D1-p0")).toEqual(["refers"]);
    expect(verbOf("D2-p0")).toEqual(["deletes"]);
    expect(verbOf("D3-p0")).toEqual(["deletes"]);
  });

  it("reads the third document as an amendment too", () => {
    const out = ingestTexts(
      SHORT_NDA,
      AMENDMENT_NO_1,
      "1. Section 6.1 of the Agreement, as deleted by Amendment No. 1, is reinstated.\n\n2. Section 9.3 is amended.",
    );
    expect(annotationsOn(out, "D3-p1", "cross_reference")).toEqual([
      { kind: "cross_reference", spanId: "dv_d3:p1", target: "9.3", verb: "amends" },
    ]);
  });
});

describe("hostile text", () => {
  it("is not fooled by words that are keys of every JavaScript object", () => {
    const text =
      "constructor __proto__ toString hasOwnProperty valueOf Section 3 constructor toString is __proto__ deleted.";
    expect(inAmendment(text)).toEqual([ref("3", "deletes")]);
    expect(inAmendment("Section 3 __proto__ constructor toString valueOf hasOwnProperty.")).toEqual(
      [ref("3", "refers")],
    );
  });

  it("stays fast on a very long list of references", () => {
    const start = Date.now();
    inAmendment(
      `Sections ${Array.from({ length: 400_000 }, (_, i) => (i % 99) + 1).join(", ")} are deleted.`,
    );
    inAmendment("Section 1 deleted ".repeat(100_000));
    inAmendment("Section ".repeat(200_000));
    inAmendment("Sections 1, ".repeat(100_000));
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("bounds the number of annotations a single span can make", () => {
    const numbers = Array.from({ length: 5000 }, (_, i) => i + 1).join(", ");
    const found = inAmendment(`Sections ${numbers} are deleted.`);
    expect(found.length).toBeLessThanOrEqual(200);
    expect(found.length).toBeGreaterThan(0);
  });
});
