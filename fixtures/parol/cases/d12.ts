import { at, compliant, deviation, numbered, required, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D12: parties mismatch
// ---------------------------------------------------------------------------------------------

export const D12: CaseDefinition = {
  case: "PAROL-D12",
  split: "dev",
  phenomenon:
    'Parties mismatch: the NDA names "Lanternfish Software Holdings, Inc."; intake says "Lanternfish Software, Inc."',
  intake: { clientLegalName: "Lanternfish Software, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d12-nda.docx",
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-03-09",
      paragraphs: [
        title("MUTUAL NONDISCLOSURE AGREEMENT"),
        text(
          'This Mutual Nondisclosure Agreement (the "Agreement") is made as of 9 March 2026 between Lanternfish Software Holdings, Inc., a Delaware corporation ("Lanternfish"), and Corvane Data Systems LLC, a Texas limited liability company ("Corvane") (each a "Party" and together the "Parties").',
        ),
        text(
          "The Parties wish to explore a data-sharing partnership and expect to give each other confidential information for that purpose.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means any entity that controls, is controlled by, or is under common control with a Party.',
              '"Confidential Information" means non-public information disclosed by a Party (the "Disclosing Party") to the other Party (the "Receiving Party") for the partnership discussions that is marked or identified as confidential at the time of disclosure, or that a reasonable person would understand to be confidential from its nature and the circumstances of disclosure.',
            ],
          ],
          [
            "Exclusions",
            [
              "Confidential Information does not include information that (a) is or becomes publicly available other than through a breach of this Agreement by the Receiving Party; (b) the Receiving Party knew before disclosure without any duty of confidentiality; (c) the Receiving Party independently develops without using the Disclosing Party's Confidential Information; or (d) the Receiving Party receives from a third party without any duty of confidentiality.",
            ],
          ],
          [
            "Obligations",
            [
              "The Receiving Party shall use Confidential Information only for the partnership discussions and shall protect it with at least the degree of care it uses for its own information of a similar nature, and no less than reasonable care.",
              "The Receiving Party shall not disclose Confidential Information except as this Agreement allows.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to its and its Affiliates' employees, officers, contractors and professional advisers who need to know it for the partnership discussions and who are bound by obligations of confidentiality no less protective than those in this Agreement.",
              "The Receiving Party may disclose Confidential Information to the extent required by law, regulation or order of a court or governmental authority, provided that, where legally permitted and reasonably practicable, it gives the Disclosing Party prompt notice so that the Disclosing Party may seek a protective order at its own cost.",
            ],
          ],
          [
            "Term",
            [
              "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information.",
              "Either Party may terminate this Agreement on thirty (30) days' written notice.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within thirty (30) days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except that it may retain copies required by law or held in routine backup systems, which remain subject to this Agreement.",
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
              "This Agreement is the entire agreement between the Parties about its subject matter.",
              "A change to this Agreement is effective only if it is in writing and signed by both Parties.",
            ],
          ],
        ]),
        signature("Lanternfish Software Holdings, Inc.", "Corvane Data Systems LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": deviation({
      governing: [at("D1", null, "Lanternfish Software Holdings, Inc., a Delaware corporation")],
      escalation: required("parties_mismatch"),
      basis: "pty-1.unacceptable: the client is named as a different entity, a holding company",
      note: "The intake gives Lanternfish Software, Inc.; the agreement names Lanternfish Software Holdings, Inc. in the preamble and in the signature block.",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "marked or identified as confidential at the time of disclosure"),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [at("D1", "2.1", "Confidential Information does not include information that")],
      basis: "exc-1.standard: all four exclusions are present",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers who need to know it")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [at("D1", "4.2", "to the extent required by law, regulation or order of a court")],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [at("D1", "5.1", "continue for three (3) years from the date of each disclosure")],
      basis: "dur-1.standard: obligations end three years after each disclosure",
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
  warnings: [],
};

/**
 * The cases written so far: the six development cases of week one. The other eight development
 * cases and the twelve held-out cases are added later in this format.
 */
