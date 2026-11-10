import {
  at,
  clause,
  compliant,
  numbered,
  required,
  signature,
  text,
  title,
  undetermined,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D06: contradictory amendments on governing law
// ---------------------------------------------------------------------------------------------

export const D06: CaseDefinition = {
  case: "PAROL-D06",
  split: "dev",
  phenomenon:
    "Contradictory amendment: one clause moves governing law to New York, another to California",
  intake: { clientLegalName: "Cobaltine Health Software, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d06-nda.docx",
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-05-05",
      paragraphs: [
        title("MUTUAL NONDISCLOSURE AGREEMENT"),
        text(
          'This Mutual Nondisclosure Agreement (the "Agreement") is made as of 5 May 2026 between Cobaltine Health Software, Inc., a Delaware corporation ("Cobaltine"), and Orrery Instruments LLC, a Massachusetts limited liability company ("Orrery") (each a "Party" and together the "Parties").',
        ),
        text(
          "The Parties wish to discuss integrating Orrery's device data with Cobaltine's software and will share confidential information for that purpose.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means any entity that controls, is controlled by, or is under common control with a Party.',
              '"Confidential Information" means information that one Party (the "Disclosing Party") discloses to the other Party (the "Receiving Party") in connection with the discussions and that is marked as confidential, identified as confidential when disclosed, or reasonably understood to be confidential from its nature or the way it is disclosed.',
            ],
          ],
          [
            "Exclusions",
            [
              "The Receiving Party has no duty under this Agreement for information that (a) is or becomes publicly known other than through the Receiving Party's breach; (b) the Receiving Party already knew without any duty of confidence; (c) the Receiving Party independently develops without using the Disclosing Party's Confidential Information; or (d) a third party gives the Receiving Party without any duty of confidence to the Disclosing Party.",
            ],
          ],
          [
            "Obligations",
            [
              "The Receiving Party shall use Confidential Information only for the discussions and shall guard it with at least the care it gives its own sensitive information, and no less than reasonable care.",
              "The Receiving Party shall not disclose Confidential Information except as this Agreement allows.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to the employees, officers, contractors and professional advisers of itself and its Affiliates who need to know it for the discussions and who are bound by confidentiality duties no less protective than this Agreement.",
              "The Receiving Party may disclose Confidential Information to the extent that law, regulation or an order of a court or governmental authority requires, and where it is legally permitted and reasonably practicable it shall first give the Disclosing Party prompt notice so that the Disclosing Party may seek a protective order at its own cost.",
            ],
          ],
          [
            "Term",
            [
              "The Receiving Party's obligations under this Agreement continue for three (3) years from the date of each disclosure of Confidential Information.",
              "Either Party may end the discussions by written notice to the other.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within thirty (30) days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies required by law or held in routine backup systems, which remain subject to this Agreement.",
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
        signature("Cobaltine Health Software, Inc.", "Orrery Instruments LLC"),
      ],
    },
    {
      label: "D2",
      file: "parol-d06-amendment-1.docx",
      kind: "amendment",
      title: "Amendment No. 1",
      statedDate: "2026-08-18",
      paragraphs: [
        title("AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT"),
        text(
          'This Amendment No. 1 (the "Amendment") is made as of 18 August 2026 between Cobaltine Health Software, Inc. and Orrery Instruments LLC, and amends the Mutual Nondisclosure Agreement between them dated 5 May 2026 (the "Agreement").',
        ),
        clause(
          "1",
          "Capitalized terms used but not defined in this Amendment have the meanings given in the Agreement.",
        ),
        clause(
          "2",
          "Section 7.1 of the Agreement is amended so that the Agreement is governed by the laws of the State of New York, and the Parties submit to the exclusive jurisdiction of the state and federal courts located in New York County, New York.",
        ),
        clause(
          "3",
          "Each Party shall give the other the name of a contact person for notices under the Agreement within ten (10) days after the date of this Amendment.",
        ),
        clause(
          "4",
          "Section 7.1 of the Agreement is amended so that the Agreement is governed by the laws of the State of California, and the Parties submit to the exclusive jurisdiction of the state and federal courts located in Santa Clara County, California.",
        ),
        clause(
          "5",
          "Except as amended by this Amendment, the Agreement remains in full force and effect.",
        ),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Cobaltine Health Software, Inc., a Delaware corporation")],
      basis: "pty-1.standard: the client is named exactly as given at intake, with its entity type",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "marked as confidential, identified as confidential when disclosed"),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at(
          "D1",
          "2.1",
          "The Receiving Party has no duty under this Agreement for information that",
        ),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers of itself and its Affiliates")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [at("D1", "4.2", "an order of a court or governmental authority requires")],
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
    "gov-1": undetermined({
      relevant: [
        at("D1", "7.1", "laws of the State of Delaware"),
        at("D2", "2", "laws of the State of New York"),
        at("D2", "4", "laws of the State of California"),
      ],
      escalation: required("conflicting_sources"),
      basis:
        "gov-1.standard: two clauses of the same amendment name different governing laws and neither controls",
      note: "Clauses 2 and 4 of Amendment No. 1 amend the same Section 7.1 in opposite ways on one date, and the documents do not say which prevails.",
    }),
  },
  warnings: [],
};
