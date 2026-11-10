import { at, compliant, deviation, numbered, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D13: fallback positions
//
// The definition (Section 1.2) and the duration (Section 5.2) sit at the playbook's fallback and
// are compliant. Only the ten day return deadline (Section 6.1) is unacceptable. The duration is
// exactly five years after the agreement ends, so the over-five-years escalation does not arise.
// ---------------------------------------------------------------------------------------------

export const D13: CaseDefinition = {
  case: "PAROL-D13",
  split: "dev",
  phenomenon:
    "Fallback positions: definition at fallback, term five years after termination; 10-day return deadline",
  intake: { clientLegalName: "Thornquist Mapping, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d13-nda.docx",
      kind: "nda",
      title: "Reciprocal Confidentiality Agreement",
      statedDate: "2026-08-03",
      paragraphs: [
        title("RECIPROCAL CONFIDENTIALITY AGREEMENT"),
        text(
          'This Reciprocal Confidentiality Agreement (the "Agreement") takes effect on 3 August 2026 (the "Effective Date") and is made between Thornquist Mapping, Inc., a Colorado corporation ("Thornquist"), and Belmarrow Utilities LLC, an Ohio limited liability company ("Belmarrow") (each a "Party" and together the "Parties").',
        ),
        text(
          "Thornquist produces aerial survey and mapping data, and Belmarrow operates regional water and gas distribution networks. The Parties wish to test whether Thornquist's survey data can be combined with Belmarrow's network records to locate buried pipes and cables (the \"Project\"), and each expects to give the other non-public information for that work.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means an entity that controls, is controlled by, or is under common control with a Party, where control means the power to direct the management or policies of that entity, directly or indirectly.',
              '"Confidential Information" means non-public information that one Party (the "Disclosing Party") discloses to the other Party (the "Receiving Party") for the Project, whether or not that information is marked or identified as confidential.',
            ],
          ],
          [
            "Exclusions",
            [
              "Confidential Information does not include information that (a) is or becomes generally available to the public other than through a breach of this Agreement by the Receiving Party; (b) the Receiving Party knew, without a duty of confidentiality, before the Disclosing Party disclosed it; (c) the Receiving Party develops independently, without using the Disclosing Party's Confidential Information; or (d) the Receiving Party receives from a third party that owes the Disclosing Party no duty of confidentiality.",
            ],
          ],
          [
            "Handling of Confidential Information",
            [
              "The Receiving Party shall use the Disclosing Party's Confidential Information only for the Project.",
              "The Receiving Party shall protect the Disclosing Party's Confidential Information with at least the care it uses for its own information of a similar nature, and no less than reasonable care.",
              "The Receiving Party shall tell the Disclosing Party promptly after it learns of any use or disclosure of the Disclosing Party's Confidential Information that this Agreement does not allow.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to those of its and its Affiliates' directors, officers, employees, contractors and professional advisers who need to know it for the Project and who are bound by duties of confidentiality no less protective than those in this Agreement.",
              "The Receiving Party may disclose Confidential Information to the extent that a law, a regulation or an order of a court or governmental authority requires, provided that, where the law permits and it is reasonably practicable, it gives the Disclosing Party prompt written notice so that the Disclosing Party can seek a protective order at the Disclosing Party's own expense.",
              "The Receiving Party remains responsible for any breach of this Agreement by a person to whom it discloses Confidential Information under Section 4.1.",
            ],
          ],
          [
            "Term and Duration",
            [
              'This Agreement begins on the Effective Date and continues for twelve (12) months, unless either Party ends it earlier by giving the other thirty (30) days\' written notice. The date on which this Agreement expires or is ended is the "End Date".',
              "The obligations of each Receiving Party under this Agreement continue until five (5) years after the End Date, whenever the Confidential Information concerned was disclosed.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within ten (10) days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies that the law requires it to keep and copies held in routine backup systems, which remain subject to this Agreement.",
            ],
          ],
          [
            "Ownership and Remedies",
            [
              "Confidential Information remains the property of the Disclosing Party. This Agreement gives the Receiving Party no license or other right in it, apart from the right to use it for the Project.",
              "Each Party accepts that damages alone may not be an adequate remedy for a breach of this Agreement and that the other Party may ask a court for an injunction or other equitable relief.",
            ],
          ],
          [
            "Governing Law",
            [
              "The laws of the State of Delaware govern this Agreement, and the Parties agree that the state and federal courts located in New Castle County, Delaware are the exclusive forum for any dispute arising out of it.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the entire agreement between the Parties about its subject matter and replaces every earlier discussion or understanding about it.",
              "A change to this Agreement is effective only if it is in writing and signed by both Parties.",
              "The Parties may sign separate copies of this Agreement, which together make one agreement.",
            ],
          ],
        ]),
        signature("Thornquist Mapping, Inc.", "Belmarrow Utilities LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Thornquist Mapping, Inc., a Colorado corporation")],
      basis:
        "pty-1.standard: the client is named exactly as given at intake, with its entity type, and both parties disclose and receive",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "whether or not that information is marked or identified as confidential"),
      ],
      basis:
        "def-1.fallback: non-public information disclosed for the Project, whether or not it is marked or identified as confidential",
      note: "The definition is the playbook's fallback, not its standard: it covers non-public information disclosed for the Project whether or not it is marked. It stays limited to non-public information and to the Project, so it is not the unacceptable definition of all information of any kind.",
    }),
    "exc-1": compliant({
      governing: [at("D1", "2.1", "Confidential Information does not include information that")],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers who need to know it")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [at("D1", "4.2", "an order of a court or governmental authority requires")],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [at("D1", "5.2", "continue until five (5) years after the End Date")],
      relevant: [at("D1", "5.1", "The date on which this Agreement expires or is ended")],
      basis:
        "dur-1.fallback: obligations end five years after the agreement ends, which is no more than five years",
      note: "The period is the playbook's fallback, not its standard, and it is exactly five years, so it is not longer than five years and the over-five-years escalation does not apply. The End Date is fixed by Section 5.1. The playbook counts the period from whichever event the clause uses, and this clause uses the End Date, so information disclosed early in the twelve month term being protected for somewhat more than five years from its own disclosure does not change the status: the fallback expressly allows five years or less after the agreement ends.",
    }),
    "ret-1": deviation({
      governing: [
        at("D1", "6.1", "Within ten (10) days after the Disclosing Party's written request"),
      ],
      basis: "ret-1.unacceptable: the deadline of ten days is shorter than thirty days",
      note: "Section 6.1 keeps the carve-out for copies required by law and for routine backups, so the only departure from the standard is the ten day deadline.",
    }),
    "gov-1": compliant({
      governing: [at("D1", "8.1", "laws of the State of Delaware")],
      basis: "gov-1.standard: Delaware law and a Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
