import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { ObjectGenerator } from "../../packages/llm/src/index.js";
import { createOracleGenerator } from "../../packages/review/src/testing.js";

/**
 * A long contract for the scenario that looks at a heavy screen: 20 sections of 9 clauses each,
 * and one clause that is a single paragraph of 3,000 words with the words an edit replaces in the
 * middle of it. The text is generated from a fixed seed, so every run reviews the same contract.
 */

export const LONG_CLAUSE_NUMBER = "7.3";
/** The words the scripted model quotes. They occur once in the whole contract. */
export const LONG_QUOTE = "are perpetual and shall continue indefinitely";
export const LONG_REPLACEMENT = "end three (3) years after the date of disclosure";
export const LONG_WORDS = 3000;
export const LONG_SECTIONS = 20;
export const CLAUSES_PER_SECTION = 9;

const VOCABULARY = [
  "the",
  "parties",
  "shall",
  "keep",
  "records",
  "of",
  "each",
  "disclosure",
  "made",
  "under",
  "this",
  "agreement",
  "and",
  "may",
  "inspect",
  "them",
  "during",
  "ordinary",
  "business",
  "hours",
  "on",
  "reasonable",
  "notice",
  "recipient",
  "will",
  "treat",
  "materials",
  "with",
  "care",
  "no",
  "less",
  "than",
  "it",
  "uses",
  "for",
  "its",
  "own",
  "material",
  "provided",
  "that",
  "nothing",
  "herein",
  "requires",
  "either",
  "party",
  "to",
  "disclose",
  "information",
  "which",
  "is",
  "subject",
  "a",
  "duty",
  "owed",
  "third",
  "any",
  "such",
  "shall,",
  "however,",
  "remain",
];

// A small generator with a fixed seed (mulberry32), so the same words come out every time.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function words(count: number, next: () => number): string[] {
  return Array.from(
    { length: count },
    () => VOCABULARY[Math.floor(next() * VOCABULARY.length)] ?? "the",
  );
}

/** Words that read as sentences: a capital after each full stop, and a full stop at the end. */
function sentences(list: string[]): string {
  const out: string[] = [];
  list.forEach((word, index) => {
    const bare = word.replace(/,$/, "");
    const first = index === 0 || (index % 18 === 0 && out.length > 0);
    out.push(first ? bare.charAt(0).toUpperCase() + bare.slice(1) : word);
    if (index % 18 === 17) out[out.length - 1] += ".";
  });
  const text = out.join(" ").replace(/[,.]+$/, "");
  return `${text}.`;
}

export interface LongContract {
  bytes: Uint8Array;
  paragraphs: number;
  /** The words in the long clause, counted by splitting on spaces. */
  longClauseWords: number;
  /** The text of the long clause, without its number, as it is in the file. */
  longClauseText: string;
}

function clause(number: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 160 },
    children: [new TextRun({ text: `${number} `, bold: true }), new TextRun(text)],
  });
}

export async function buildLongContract(): Promise<LongContract> {
  const next = random(20260101);
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: "LONG CONFIDENTIALITY AGREEMENT", bold: true })],
    }),
    new Paragraph({
      children: [
        new TextRun(
          'This Long Confidentiality Agreement (the "Agreement") is made between Northwind Holdings, Inc. ("Discloser") and Fabrikam Labs LLC ("Recipient") for the purpose of testing a screen with a great deal on it.',
        ),
      ],
    }),
  ];

  let longClauseText = "";
  for (let section = 1; section <= LONG_SECTIONS; section += 1) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: `${section}. Section number ${section}`, bold: true })],
      }),
    );
    for (let item = 1; item <= CLAUSES_PER_SECTION; item += 1) {
      const number = `${section}.${item}`;
      if (number === LONG_CLAUSE_NUMBER) {
        // About 3,000 words, with the quote in the middle of them.
        const bridge = `Recipient's obligations under this Agreement ${LONG_QUOTE}, whether or not the parties proceed.`;
        const filler = LONG_WORDS - bridge.split(" ").length;
        const head = sentences(words(Math.floor(filler / 2), next));
        const tail = sentences(words(filler - Math.floor(filler / 2), next));
        longClauseText = `${head} ${bridge} ${tail}`;
        children.push(clause(number, longClauseText));
      } else {
        children.push(clause(number, `${sentences(words(40, next))}`));
      }
    }
  }

  const document = new Document({
    creator: "Clausewise e2e",
    title: "Long contract",
    sections: [{ children }],
  });
  return {
    bytes: new Uint8Array(await Packer.toBuffer(document)),
    paragraphs: children.length,
    longClauseWords: longClauseText.split(/\s+/).length,
    longClauseText,
  };
}

/**
 * The model for the long contract and the built-in mutual NDA playbook: the term rule finds the
 * words in the long clause, one rule finds a clause missing, and the others are met.
 */
export function longContractModel(): ObjectGenerator {
  const met = { status: "compliant" as const };
  return createOracleGenerator({
    mutuality: met,
    definition: met,
    exclusions: met,
    term: {
      status: "deviation",
      clauseNumbers: [LONG_CLAUSE_NUMBER],
      explanation: "Oracle explanation for term.",
      comment: "Oracle comment for term.",
      edit: { clauseNumber: LONG_CLAUSE_NUMBER, quote: LONG_QUOTE, replacement: LONG_REPLACEMENT },
    },
    "permitted-use": met,
    "compelled-disclosure": {
      status: "missing",
      explanation: "Oracle explanation for compelled-disclosure.",
      comment: "Oracle comment for compelled-disclosure.",
      suggestedClause: "Oracle suggested clause for compelled-disclosure.",
    },
    "return-or-destroy": met,
    remedies: met,
    "restrictive-covenants": met,
    "governing-law": met,
  });
}

// ---------------------------------------------------------------------------------------------
// A contract whose text, and a model whose answers, are full of markup
// ---------------------------------------------------------------------------------------------

/** Text that would run, load or change the page if it were ever treated as markup. */
export const HOSTILE_SNIPPETS = {
  image: '<img src=x onerror="window.__pwned=1">',
  script: "<script>window.__pwned=1</script>",
  link: '<a href="javascript:window.__pwned=1">this link</a>',
  entity: "&amp; &lt;b&gt;bold&lt;/b&gt;",
  bold: "<b>three</b>",
} as const;

export const HOSTILE_QUOTE = "are perpetual and shall continue indefinitely";
export const HOSTILE_REPLACEMENT = `end in ${HOSTILE_SNIPPETS.bold} years ${HOSTILE_SNIPPETS.image}`;
export const HOSTILE_CLAUSE_TEXT = `Recipient's obligations ${HOSTILE_QUOTE}, as ${HOSTILE_SNIPPETS.link} says, and ${HOSTILE_SNIPPETS.entity} stay as they are.`;
export const HOSTILE_DEFINITION_TEXT = `"Confidential Information" means ${HOSTILE_SNIPPETS.script} everything, including ${HOSTILE_SNIPPETS.image}, whether or not marked.`;

export async function buildHostileContract(): Promise<Uint8Array> {
  const document = new Document({
    creator: "Clausewise e2e",
    title: "Hostile contract",
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: `AGREEMENT ${HOSTILE_SNIPPETS.image}`, bold: true })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [
              new TextRun({ text: `1. Definitions ${HOSTILE_SNIPPETS.script}`, bold: true }),
            ],
          }),
          clause("1.1", HOSTILE_DEFINITION_TEXT),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "2. Term", bold: true })],
          }),
          clause("2.1", HOSTILE_CLAUSE_TEXT),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

/** A model that answers with markup in every field it can. */
export function hostileModel(): ObjectGenerator {
  const met = { status: "compliant" as const };
  return createOracleGenerator({
    mutuality: met,
    definition: met,
    exclusions: met,
    term: {
      status: "deviation",
      clauseNumbers: ["2.1"],
      explanation: `Why: ${HOSTILE_SNIPPETS.script} ${HOSTILE_SNIPPETS.image} ${HOSTILE_SNIPPETS.entity}`,
      comment: `Comment: ${HOSTILE_SNIPPETS.script} ${HOSTILE_SNIPPETS.link}`,
      edit: { clauseNumber: "2.1", quote: HOSTILE_QUOTE, replacement: HOSTILE_REPLACEMENT },
    },
    "permitted-use": met,
    "compelled-disclosure": {
      status: "missing",
      explanation: `Missing: ${HOSTILE_SNIPPETS.image}`,
      comment: `Add it: ${HOSTILE_SNIPPETS.script}`,
      suggestedClause: `Suggested: ${HOSTILE_SNIPPETS.image} ${HOSTILE_SNIPPETS.link}`,
    },
    "return-or-destroy": met,
    remedies: met,
    "restrictive-covenants": met,
    "governing-law": met,
  });
}
