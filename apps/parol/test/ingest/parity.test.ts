import { segment, type Clause } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/ingest/parse.js";
import { startsWithClauseNumber } from "../../src/ingest/txt.js";
import { docxBytes, encode } from "./support.js";

/**
 * The same contract text as a plain text file and as a Word file must be cut into the same
 * clauses. The Word rendering types its numbers into the text, as a plain text file must, so
 * segment() sees the same words in both and only the paragraph rule of the TXT reader differs.
 */

interface Summary {
  number: string | undefined;
  heading: string | undefined;
  paragraphs: number;
  text: string;
}

const summarise = (clauses: Clause[]): Summary[] =>
  clauses.map((c) => ({
    number: c.number,
    heading: c.heading,
    paragraphs: c.paragraphs.length,
    text: c.text,
  }));

/** Breaks a paragraph into lines of at most `width` characters at spaces, as an editor would. */
function wrap(paragraph: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of paragraph.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

const CONTRACTS: Record<string, string[]> = {
  "a numbered NDA with headed sections": [
    "MUTUAL NONDISCLOSURE AGREEMENT",
    'This Mutual Nondisclosure Agreement (the "Agreement") is made between Lanternfish Software, Inc. and Corvane Data Systems LLC.',
    "1. DEFINITIONS",
    '1.1 "Confidential Information" means non-public information disclosed by one party to the other that is marked as confidential or that a reasonable person would understand to be confidential.',
    "1.2 The Receiving Party is the party that receives Confidential Information from the Disclosing Party.",
    "2. OBLIGATIONS",
    "2.1 The Receiving Party shall use Confidential Information only to evaluate a possible commercial relationship and shall protect it with reasonable care.",
    "2.2 The Receiving Party may disclose Confidential Information to its advisers who need to know it.",
    "3. TERM",
    "3.1 The obligations in Section 2 continue for two (2) years from the date of each disclosure.",
  ],
  "lettered sub-items under a lead-in": [
    "AMENDMENT NO. 1",
    "1. The Receiving Party shall, in relation to Confidential Information:",
    "(a) keep it secret and protect it with reasonable care;",
    "(b) use it only for the Purpose; and",
    "(c) return or destroy it on written request.",
    "2. Section 6.1 of the Agreement is deleted in its entirety.",
  ],
  "labelled sections and a signature block": [
    "SERVICES SCHEDULE",
    "Section 1. The Supplier shall deliver the Services described in this Schedule on time.",
    "Section 2. The Customer shall pay the Fees within thirty days of each invoice.",
    "Section 3. Either party may end this Schedule on written notice to the other.",
  ],
  "a preamble and unnumbered paragraphs": [
    "This letter agreement records the terms on which Northwind Holdings will share its pricing model with Fabrikam Labs for the sole purpose of evaluating a partnership.",
    "Each party will keep the other's information confidential and will not copy it except as the evaluation requires.",
    "1. The information stays confidential for three years.",
    "2. Either party may ask for its information to be returned at any time.",
  ],
};

async function bothWays(paragraphs: string[]): Promise<{
  docx: Summary[];
  blank: Summary[];
  wrapped: Summary[];
  counts: number[];
}> {
  const word = await parseDocument({ bytes: await docxBytes(paragraphs), mediaType: "docx" });
  const blankSeparated = await parseDocument({
    bytes: encode(paragraphs.join("\n\n")),
    mediaType: "txt",
  });
  // A hard-wrapped file separates unnumbered paragraphs with a blank line, because nothing else
  // could tell them from a wrapped line. Numbered clauses run on without one, which is how
  // typed contracts are usually laid out and what the rule must cope with.
  const hardWrapped = await parseDocument({
    bytes: encode(
      paragraphs
        .map((p, i) => {
          const gap = i === 0 ? "" : startsWithClauseNumber(p) ? "\n" : "\n\n";
          return gap + wrap(p, 48).join("\n");
        })
        .join(""),
    ),
    mediaType: "txt",
  });
  return {
    docx: summarise(segment(word.paragraphs)),
    blank: summarise(segment(blankSeparated.paragraphs)),
    wrapped: summarise(segment(hardWrapped.paragraphs)),
    counts: [
      word.paragraphs.length,
      blankSeparated.paragraphs.length,
      hardWrapped.paragraphs.length,
    ],
  };
}

describe("the same contract as TXT and as DOCX", () => {
  it.each(Object.entries(CONTRACTS))(
    "is cut into the same clauses: %s",
    async (_name, paragraphs) => {
      const { docx, blank, wrapped, counts } = await bothWays(paragraphs);
      expect(counts).toEqual([paragraphs.length, paragraphs.length, paragraphs.length]);
      expect(blank).toEqual(docx);
      expect(wrapped).toEqual(docx);
      // The comparison would be empty praise if segment found nothing to cut.
      expect(docx.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("gives the same clause numbers", async () => {
    const { docx, blank, wrapped } = await bothWays(
      CONTRACTS["a numbered NDA with headed sections"]!,
    );
    const numbers = docx.map((c) => c.number);
    expect(numbers).toEqual([undefined, "1.1", "1.2", "2.1", "2.2", "3.1"]);
    expect(blank.map((c) => c.number)).toEqual(numbers);
    expect(wrapped.map((c) => c.number)).toEqual(numbers);
    expect(docx.map((c) => c.heading)).toContain("2. OBLIGATIONS");
  });

  it("keeps the sub-items of a lead-in inside its clause in both", async () => {
    const { docx, wrapped } = await bothWays(CONTRACTS["lettered sub-items under a lead-in"]!);
    const lead = docx.find((c) => c.number === "1");
    expect(lead?.paragraphs).toBe(4);
    expect(wrapped.find((c) => c.number === "1")?.paragraphs).toBe(4);
  });

  it("does not let a wrapped line be mistaken for a clause start in these fixtures", () => {
    // The wrap width splits every paragraph above; none of the continuation lines may start like
    // a number, or the hard-wrapped rendering above would not be testing the rule it claims to.
    for (const paragraphs of Object.values(CONTRACTS)) {
      for (const paragraph of paragraphs) {
        const [, ...rest] = wrap(paragraph, 48);
        for (const line of rest) expect(startsWithClauseNumber(line)).toBe(false);
      }
    }
  });
});
