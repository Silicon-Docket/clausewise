import {
  addDocument,
  addVersion,
  at,
  compliant,
  deviation,
  identicalFile,
  newDocument,
  newVersion,
  numbered,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition, SourceParagraph } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D09: duplicate versions
//
// The person adds version 1 (a three year term), then version 2, which makes the term perpetual,
// then uploads version 1 a second time. Version 2 is operative from the moment it is added, and
// the second upload of version 1 is an identical file: nothing is stored and version 2 still
// governs. Only the dated line, Section 5.1 and Section 5.2 differ between the two versions.
// ---------------------------------------------------------------------------------------------

const V1_FILE = "parol-d09-nda-v1.docx";
const V2_FILE = "parol-d09-nda-v2.docx";

const TERM_V1 = [
  "The Recipient's duties under this Agreement for an item of Confidential Information end three (3) years after the date on which the Provider gave that item to the Recipient, except that its duties for an item that is a trade secret continue for as long as the item remains a trade secret under applicable law.",
  "Either Party may stop giving information under this Agreement at any time on thirty (30) days' written notice to the other. Notice does not affect the duties of the Recipient for information already given.",
] as const;

const TERM_V2 = [
  "The Recipient's duties under this Agreement continue in perpetuity. They are not limited to any number of years, they cover all Confidential Information whether or not it is a trade secret, and the end of the Trial or of this Agreement does not bring them to an end.",
  "Either Party may stop giving information under this Agreement at any time on thirty (30) days' written notice to the other. Notice does not shorten the duties described in Section 5.1, which continue after it.",
] as const;

/** The agreement as it stood on `dated`, with the two clauses of Section 5 as that version words them. */
function agreement(dated: string, term: readonly [string, string]): SourceParagraph[] {
  return [
    title("MUTUAL NON-DISCLOSURE AGREEMENT"),
    text(
      `This Mutual Non-Disclosure Agreement (the "Agreement") is dated ${dated} and is made between Orrinsby Glassworks, Inc., a Delaware corporation ("Orrinsby"), and Vellamore Kiln Systems LLC, a Massachusetts limited liability company ("Vellamore") (each a "Party" and together the "Parties").`,
    ),
    text(
      'Vellamore has designed a heat-recovery unit for glass melting furnaces, and Orrinsby runs three furnaces on which a trial of the unit could be carried out (the "Trial"). To plan the Trial, each Party expects to give the other furnace readings, drawings and pricing, and each wishes to set the conditions on which it does so.',
    ),
    ...numbered([
      [
        "Meanings",
        [
          '"Affiliate" of a Party means a company or other entity that controls that Party, is controlled by it, or is under common control with it, and a Party controls another entity if it holds a majority of the votes in it or can otherwise direct its management.',
          '"Confidential Information" means information, in any form, that one Party (the "Provider") gives to the other Party (the "Recipient") for the Trial and that is marked or described as confidential when it is given, or that a reasonable person in the Recipient\'s position would understand to be confidential because of what it is or the circumstances in which it is given.',
        ],
      ],
      [
        "Information Outside This Agreement",
        [
          "Information falls outside the Provider's Confidential Information if it (a) is in the public domain, or enters it later, without any breach of this Agreement by the Recipient; (b) was already lawfully known to the Recipient, free of any duty of confidence, before the Provider gave it; (c) is developed by or for the Recipient independently of the Provider's Confidential Information and without using it; or (d) is lawfully received by the Recipient from a third party that owes the Provider no duty of confidence about it.",
        ],
      ],
      [
        "Duties of the Recipient",
        [
          "The Recipient shall use the Provider's Confidential Information only to plan and carry out the Trial.",
          "The Recipient shall keep the Provider's Confidential Information secure, applying at least the care it applies to its own confidential information of a similar kind and never less than reasonable care.",
          "If the Recipient learns that any of the Provider's Confidential Information has been used or disclosed in breach of this Agreement, it shall tell the Provider without delay and help to limit the harm.",
        ],
      ],
      [
        "Permitted Disclosures",
        [
          "The Recipient may pass the Provider's Confidential Information to the employees, officers, contractors and professional advisers of the Recipient and of its Affiliates, but only to those who need to know it for the Trial and who are bound by duties of confidentiality no less protective than those in this Agreement.",
          "The Recipient answers for any act or omission of a person to whom it passes Confidential Information under Section 4.1 that would breach this Agreement if the Recipient had done it.",
          "If a law, a regulation or an order of a court or public authority requires the Recipient to disclose any of the Provider's Confidential Information, the Recipient may do so to the extent required. Where the law allows and it is reasonably practicable, the Recipient shall first give the Provider prompt written notice, so that the Provider may seek a protective order at its own expense.",
        ],
      ],
      ["How Long the Duties Last", [term[0], term[1]]],
      [
        "Return of Information",
        [
          "Within thirty (30) days after the Provider's written request, the Recipient shall return or destroy the Provider's Confidential Information that it holds. The Recipient may keep copies that a law or regulation requires it to keep and copies held in its routine backup systems, and those copies stay subject to this Agreement.",
        ],
      ],
      [
        "Governing Law and Courts",
        [
          "This Agreement is governed by the laws of the State of Delaware. Each Party submits to the exclusive jurisdiction of the state courts of Delaware and the federal courts located in Delaware for any dispute arising out of this Agreement.",
        ],
      ],
      [
        "General",
        [
          "This Agreement is the whole agreement between the Parties about the Trial and replaces any earlier discussion or understanding about it.",
          "A change to this Agreement has effect only if it is in writing and signed by both Parties.",
          "The Parties may sign this Agreement in counterparts, including by electronic signature, which together form one agreement.",
        ],
      ],
    ]),
    signature("Orrinsby Glassworks, Inc.", "Vellamore Kiln Systems LLC"),
  ];
}

export const D09: CaseDefinition = {
  case: "PAROL-D09",
  split: "dev",
  phenomenon: "Duplicate versions: v2 makes the term perpetual; v1 is uploaded twice",
  intake: { clientLegalName: "Orrinsby Glassworks, Inc." },
  documents: [
    {
      label: "D1",
      file: V1_FILE,
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-03-03",
      versionNo: 1,
      operative: false,
      paragraphs: agreement("3 March 2026", TERM_V1),
    },
    {
      label: "D1",
      file: V2_FILE,
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-03-20",
      versionNo: 2,
      paragraphs: agreement("20 March 2026", TERM_V2),
    },
  ],
  uploads: {
    steps: [
      addDocument(
        V1_FILE,
        { label: "D1", title: "Mutual NDA", kind: "nda", statedDate: "2026-03-03" },
        newDocument("D1"),
      ),
      addVersion(V2_FILE, "D1", "2026-03-20", newVersion("D1", 2)),
      addVersion(V1_FILE, "D1", "2026-03-03", identicalFile("D1", 1, false)),
    ],
  },
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Orrinsby Glassworks, Inc., a Delaware corporation")],
      basis: "pty-1.standard: the client is named exactly as given at intake, with its entity type",
    }),
    "def-1": compliant({
      governing: [at("D1", "1.2", "marked or described as confidential when it is given")],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "2.1", "Information falls outside the Provider's Confidential Information if it"),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "employees, officers, contractors and professional advisers")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "4.3",
          "requires the Recipient to disclose any of the Provider's Confidential Information",
        ),
      ],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": deviation({
      governing: [at("D1", "5.1", "continue in perpetuity")],
      relevant: [
        at("D1", "5.2", "Notice does not shorten the duties described in Section 5.1"),
        at("D1", "6.1", "those copies stay subject to this Agreement"),
      ],
      basis:
        "dur-1.unacceptable: obligations that are perpetual, for information that is not a trade secret",
      note: "Version 2 governs from the moment it is added: it replaces a three year term (version 1, now stored and not operative) with duties that never end and cover all Confidential Information, not only trade secrets. The second upload of version 1 is an identical file, stores nothing and leaves version 2 in force.",
    }),
    "ret-1": compliant({
      governing: [at("D1", "6.1", "Within thirty (30) days")],
      basis: "ret-1.standard: thirty days, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [at("D1", "7.1", "laws of the State of Delaware")],
      basis: "gov-1.standard: Delaware law and a Delaware forum are on the approved list",
    }),
  },
  warnings: ["duplicate_document"],
};
