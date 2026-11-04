import type { DocumentKind } from "../contracts.js";
import { DEMO_USER_IDS } from "../store/index.js";

/**
 * The two matters the demonstration seed creates, as data. Every party, document and name here is
 * invented for this project.
 *
 * The first is the worked example of docs/parol/04: a Word NDA and a plain text amendment from the
 * committed evaluation dataset (case PAROL-D05), which the simulated reader knows how to read.
 * The second belongs to someone else and holds a different, shorter NDA, so that signing in as two
 * different people shows that neither sees the other's matter. The simulated reader does not know
 * it, and says so.
 */

export interface DemoDocument {
  title: string;
  kind: DocumentKind;
  /** The name the upload carries. Its extension decides how the file is read. */
  fileName: string;
  /** `YYYY-MM-DD`, as intake enters it. */
  statedDate: string;
  /** Where the bytes come from: a committed dataset file, or text written below. */
  source: { fixture: string } | { paragraphs: readonly string[] };
}

export interface DemoMatter {
  key: "lanternfish" | "heronbridge";
  name: string;
  clientLegalName: string;
  /** The demo user who creates it and so is its associate. */
  ownerUserId: string;
  /** The reviewing attorney added to it, or null for a matter that has none. */
  reviewerUserId: string | null;
  documents: readonly DemoDocument[];
}

/** The folder of the committed dataset files, under the repository root. */
export const FIXTURE_FILES = ["fixtures", "parol", "files"] as const;

/**
 * A short mutual NDA with other parties and other terms than the worked example: a five year
 * term, sixty days to return, two exclusions instead of four, and no clause on disclosure that law
 * requires. Written as numbered paragraphs, which is how a plain text file carries clause numbers.
 */
export const HERONBRIDGE_NDA: readonly string[] = [
  "MUTUAL CONFIDENTIALITY AGREEMENT",
  'This Mutual Confidentiality Agreement (the "Agreement") is made as of 14 April 2026 between Heronbridge Analytics, Inc., a Minnesota corporation ("Heronbridge"), and Tamarind Cloud Services LLC, an Oregon limited liability company ("Tamarind") (each a "Party" and together the "Parties").',
  '1. "Confidential Information" means all non-public information that one Party (the "Discloser") gives to the other Party (the "Recipient") in connection with the Parties\' talks about a possible reseller arrangement, in any form.',
  "2. The Recipient shall use Confidential Information only to evaluate the possible reseller arrangement and shall protect it with reasonable care.",
  "3. The Recipient may share Confidential Information with its employees and contractors who need to know it for that purpose.",
  "4. This Agreement does not apply to information that is public through no fault of the Recipient or that the Recipient already knew.",
  "5. The obligations of the Recipient under this Agreement continue for five (5) years from the date of this Agreement.",
  "6. On the Discloser's written request, the Recipient shall return or destroy the Discloser's Confidential Information within sixty (60) days.",
  "7. This Agreement is governed by the laws of the State of Oregon.",
];

export const DEMO_MATTERS: readonly DemoMatter[] = [
  {
    key: "lanternfish",
    name: "Lanternfish / Corvane NDA",
    clientLegalName: "Lanternfish Software, Inc.",
    ownerUserId: DEMO_USER_IDS.associate,
    reviewerUserId: DEMO_USER_IDS.reviewer,
    documents: [
      {
        title: "Mutual NDA",
        kind: "nda",
        fileName: "parol-d05-nda.docx",
        statedDate: "2026-02-02",
        source: { fixture: "parol-d05-nda.docx" },
      },
      {
        title: "Amendment No. 1",
        kind: "amendment",
        fileName: "parol-d05-amendment-1.txt",
        statedDate: "2026-09-15",
        source: { fixture: "parol-d05-amendment-1.txt" },
      },
    ],
  },
  {
    key: "heronbridge",
    name: "Heronbridge / Tamarind NDA",
    clientLegalName: "Heronbridge Analytics, Inc.",
    // There is one demo associate, and the matter has to belong to somebody else for the
    // isolation to be visible. The legal engineer is the demo user with no part in the first matter.
    ownerUserId: DEMO_USER_IDS.legalEngineer,
    reviewerUserId: null,
    documents: [
      {
        title: "Mutual Confidentiality Agreement",
        kind: "nda",
        fileName: "heronbridge-tamarind-nda.txt",
        statedDate: "2026-04-14",
        source: { paragraphs: HERONBRIDGE_NDA },
      },
    ],
  },
];

/** The bytes of a text file written as paragraphs: blank lines between them, one line feed at the end. */
export const textFileBytes = (paragraphs: readonly string[]): Uint8Array =>
  new TextEncoder().encode(`${paragraphs.join("\n\n")}\n`);
