import { at, clause, compliant, deviation, numbered, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D05: the worked example (docs/parol/04-worked-example.md)
//
// Amendment No. 1 deletes the only time limit in the NDA, and a correct, verifiable quote from
// the deleted Section 6.1 supports the wrong conclusion. A second clause of the amendment cures
// the return deadline. The passages quoted in document 4 are reproduced as written.
// ---------------------------------------------------------------------------------------------

export const D05: CaseDefinition = {
  case: "PAROL-D05",
  split: "dev",
  phenomenon:
    "Amendment deletes the only time limit; a second amendment clause cures the return deadline (worked example)",
  intake: { clientLegalName: "Lanternfish Software, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d05-nda.docx",
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-02-02",
      paragraphs: [
        title("MUTUAL NONDISCLOSURE AGREEMENT"),
        text(
          'This Mutual Nondisclosure Agreement (the "Agreement") is made as of 2 February 2026 between Lanternfish Software, Inc., a Delaware corporation ("Lanternfish"), and Corvane Data Systems LLC, a Texas limited liability company ("Corvane") (each a "Party" and together the "Parties").',
        ),
        text(
          "The Parties wish to evaluate a possible commercial relationship and expect to share confidential information with each other for that purpose.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means an entity that controls, is controlled by, or is under common control with a Party, where control means holding more than fifty percent of the voting interests of that entity.',
              '"Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") that is marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential given its nature and the circumstances of disclosure.',
            ],
          ],
          [
            "Exclusions",
            [
              "Confidential Information does not include information that the Receiving Party can show (a) is or becomes generally available to the public other than through a breach of this Agreement by the Receiving Party; (b) was known to the Receiving Party, free of any duty of confidentiality, before the Disclosing Party disclosed it; (c) the Receiving Party develops independently without using the Disclosing Party's Confidential Information; or (d) the Receiving Party receives from a third party that owes the Disclosing Party no duty of confidentiality.",
            ],
          ],
          [
            "Ownership",
            [
              "Confidential Information remains the property of the Disclosing Party. This Agreement grants the Receiving Party no license or other right in it, other than the limited right of use stated in this Agreement.",
            ],
          ],
          [
            "Obligations of the Receiving Party",
            [
              "The Receiving Party shall use Confidential Information only to evaluate a possible commercial relationship between the Parties and shall protect it with at least the degree of care it uses for its own information of a similar nature, and no less than reasonable care.",
              "The Receiving Party shall not disclose Confidential Information to any person except as Section 5 permits.",
              "The Receiving Party shall tell the Disclosing Party promptly after it becomes aware of any unauthorized use or disclosure of the Disclosing Party's Confidential Information.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to its and its Affiliates' employees, officers, contractors and professional advisers who need to know it to evaluate the possible commercial relationship and who are bound by obligations of confidentiality no less protective than those in this Agreement.",
              "If law, regulation or the order of a court or governmental authority requires the Receiving Party to disclose Confidential Information, it may do so to the extent required, provided that, where legally permitted and reasonably practicable, it gives the Disclosing Party prompt written notice so that the Disclosing Party may seek a protective order at its own cost.",
              "A disclosure that Section 5 permits does not release the Receiving Party, or the person who receives the information, from the other obligations in this Agreement.",
            ],
          ],
          [
            "Term and Termination",
            [
              "The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information.",
              "Either Party may terminate this Agreement on thirty (30) days' written notice.",
            ],
          ],
          [
            "Return of Information",
            [
              "The Receiving Party acquires no right to keep Confidential Information once the Disclosing Party has asked for it back.",
              "Within ten (10) business days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.",
            ],
          ],
          [
            "Governing Law",
            [
              "This Agreement is governed by the laws of the State of Delaware, and the Parties submit to the exclusive jurisdiction of the state and federal courts located in Delaware.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the entire agreement between the Parties about its subject matter and replaces every earlier discussion or understanding about it.",
              "A change to this Agreement is effective only if it is in writing and signed by both Parties.",
              "Sections 4, 5 and 8 survive any termination or expiration of this Agreement.",
            ],
          ],
        ]),
        signature("Lanternfish Software, Inc.", "Corvane Data Systems LLC"),
      ],
    },
    {
      label: "D2",
      file: "parol-d05-amendment-1.txt",
      kind: "amendment",
      title: "Amendment No. 1",
      statedDate: "2026-09-15",
      paragraphs: [
        title("AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT"),
        text(
          'This Amendment No. 1 (the "Amendment") is made as of 15 September 2026 between Lanternfish Software, Inc. and Corvane Data Systems LLC, and amends the Mutual Nondisclosure Agreement between them dated 2 February 2026 (the "Agreement").',
        ),
        clause(
          "1",
          "Capitalized terms used but not defined in this Amendment have the meanings given in the Agreement.",
        ),
        clause("2", "Section 6.1 of the Agreement is deleted in its entirety."),
        clause(
          "3",
          'Section 7.2 of the Agreement is amended by replacing "ten (10) business days" with "thirty (30) days".',
        ),
        clause(
          "4",
          "Except as amended by this Amendment, the Agreement remains in full force and effect.",
        ),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Lanternfish Software, Inc., a Delaware corporation")],
      basis: "pty-1.standard: the client is named exactly as given at intake, with its entity type",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "marked or identified as confidential at the time of disclosure"),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at(
          "D1",
          "2.1",
          "Confidential Information does not include information that the Receiving Party can show",
        ),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "5.1", "professional advisers who need to know it")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [
        at("D1", "5.2", "requires the Receiving Party to disclose Confidential Information"),
      ],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": deviation({
      governing: [at("D2", "2", "Section 6.1 of the Agreement is deleted")],
      superseded: [at("D1", "6.1", "two (2) years from the date of each disclosure")],
      relevant: [at("D1", "9.3", "survive any termination")],
      basis: "dur-1.unacceptable: no stated end for non-trade-secret information",
      note: "Amendment No. 1 deletes Section 6.1; Section 9.3 keeps Section 4 in force after termination.",
    }),
    "ret-1": compliant({
      governing: [at("D2", "3", 'replacing "ten (10) business days" with "thirty (30) days"')],
      relevant: [
        at("D1", "7.2", "except for copies required by law or held in routine backup systems"),
      ],
      basis: "ret-1.standard: thirty days after the amendment, with law and backup copies kept",
      note: "Without the amendment the ten business day deadline would be a deviation; Amendment No. 1 clause 3 cures it. The amendment replaces only the number of days, so the rest of Section 7.2 (return or destroy, copies required by law, routine backups) is still operative and is not superseded.",
    }),
    "gov-1": compliant({
      governing: [at("D1", "8.1", "laws of the State of Delaware")],
      basis: "gov-1.standard: Delaware law and a Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
