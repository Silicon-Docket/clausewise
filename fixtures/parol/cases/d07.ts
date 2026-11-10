import { allowed, at, compliant, deviation, numbered, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D07: a defined-term problem
//
// Every obligation protects "Confidential Information", which Section 1 defines. The four
// exclusions are written for "Proprietary Information", a term that appears nowhere else and is
// defined nowhere. Everything else in the agreement is sound and every other capitalised term is
// defined, so the only open term is the one the exclusions depend on.
// ---------------------------------------------------------------------------------------------

export const D07: CaseDefinition = {
  case: "PAROL-D07",
  split: "dev",
  phenomenon:
    'Defined-term problem: exclusions apply to "Proprietary Information", which is never defined',
  intake: { clientLegalName: "Gannet Hollow Biosystems, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d07-nda.docx",
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-01-21",
      paragraphs: [
        title("CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT"),
        text(
          'This Confidentiality and Non-Disclosure Agreement (the "Agreement") is made on 21 January 2026 between Gannet Hollow Biosystems, Inc., a Massachusetts corporation ("Gannet Hollow"), and Tarnside Microfluidics LLC, a California limited liability company ("Tarnside") (each a "Party" and together the "Parties").',
        ),
        text(
          'The Parties are evaluating whether to co-develop a benchtop sample preparation instrument (the "Evaluation") and each may make information available to the other in the course of the Evaluation.',
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means an entity that directly or indirectly controls, is controlled by, or is under common control with a Party.',
              '"Confidential Information" means non-public information, in any form, that a Party (the "Discloser") makes available to the other Party (the "Recipient") in the course of the Evaluation and that is marked or identified as confidential when it is made available, or that a reasonable person would understand to be confidential because of its nature or the circumstances in which it is made available.',
              '"Personnel" means the employees, officers, contractors and professional advisers of a Party and of its Affiliates.',
            ],
          ],
          [
            "Obligations of the Recipient",
            [
              "The Recipient shall use Confidential Information only for the Evaluation and shall not disclose it except as this Agreement permits.",
              "The Recipient shall protect Confidential Information with at least the care it gives to its own information of a similar kind, and with no less than reasonable care.",
              "The Recipient shall notify the Discloser promptly after it becomes aware of any unauthorized use or disclosure of Confidential Information.",
            ],
          ],
          [
            "Exclusions",
            [
              "This Agreement imposes no obligation on the Recipient in respect of Proprietary Information that the Recipient can show (a) is or becomes generally available to the public other than through a breach of this Agreement by the Recipient; (b) was known to the Recipient, free of any duty of confidence, before the Discloser made it available; (c) the Recipient develops independently, without using the Discloser's Proprietary Information; or (d) the Recipient receives from a third party that owes the Discloser no duty of confidence.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Recipient may disclose Confidential Information to its Personnel who need to know it for the Evaluation and who are bound by duties of confidentiality no less protective than those in this Agreement.",
              "The Recipient may disclose Confidential Information to the extent that a law, a regulation or an order of a court or governmental authority requires, if it gives the Discloser prompt notice where the law allows and it is reasonably practicable, so that the Discloser may seek a protective order at its own cost.",
            ],
          ],
          [
            "Term",
            [
              "The obligations of the Recipient under this Agreement continue, for each item of Confidential Information, for two (2) years from the date on which that item is first made available.",
              "Either Party may end the Evaluation at any time by written notice to the other. This Agreement continues to apply, for the period stated in Section 5.1, to Confidential Information made available before the notice.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within forty-five (45) days after the Discloser's written request, the Recipient shall return or destroy the Discloser's Confidential Information, except that it may keep copies that the law requires it to keep and copies held in routine backup systems, which remain subject to this Agreement.",
            ],
          ],
          [
            "Governing Law and Forum",
            [
              "This Agreement is governed by the laws of the State of Delaware, without regard to its conflict of laws rules.",
              "Each Party submits to the exclusive jurisdiction of the Court of Chancery of the State of Delaware or, if that court lacks subject matter jurisdiction, the United States District Court for the District of Delaware.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the entire agreement between the Parties about its subject matter and may be changed only by a written document signed by both Parties.",
              "Neither Party is obliged to make any information available, and this Agreement grants no license or other right in Confidential Information.",
              "The Parties may sign this Agreement in counterparts, which together form one agreement.",
            ],
          ],
        ]),
        signature("Gannet Hollow Biosystems, Inc.", "Tarnside Microfluidics LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Gannet Hollow Biosystems, Inc., a Massachusetts corporation")],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and both disclose",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "1.2",
          "marked or identified as confidential when it is made available, or that a reasonable person would understand to be confidential",
        ),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": deviation({
      acceptable: ["undetermined"],
      governing: [
        at(
          "D1",
          "3.1",
          "imposes no obligation on the Recipient in respect of Proprietary Information",
        ),
      ],
      relevant: [
        at("D1", "1.2", '"Confidential Information" means non-public information'),
        at("D1", "2.1", "The Recipient shall use Confidential Information only for the Evaluation"),
      ],
      escalation: allowed("defined_term_unresolved"),
      basis:
        "exc-1.unacceptable: the four exclusions are written for Proprietary Information, which is not the defined Confidential Information, so for Confidential Information none of them operates",
      note: "Section 3.1 states all four exclusions for Proprietary Information. The term appears only there and is defined nowhere, while every obligation protects Confidential Information, so the exclusions do not clearly reach the information the obligations protect. Undetermined with defined_term_unresolved is also accepted: the term cannot be resolved from the document. Compliant would read an undefined term as the defined one.",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "4.1",
          "to its Personnel who need to know it for the Evaluation and who are bound by duties of confidentiality",
        ),
      ],
      relevant: [
        at(
          "D1",
          "1.3",
          "employees, officers, contractors and professional advisers of a Party and of its Affiliates",
        ),
      ],
      basis:
        "pds-1.standard: Personnel is defined as employees, officers, contractors and advisers of the Party and its Affiliates, who need to know and are bound",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "4.2",
          "to the extent that a law, a regulation or an order of a court or governmental authority requires",
        ),
      ],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "5.1",
          "for two (2) years from the date on which that item is first made available",
        ),
      ],
      relevant: [at("D1", "5.2", "for the period stated in Section 5.1")],
      basis: "dur-1.standard: obligations end two years after each disclosure",
    }),
    "ret-1": compliant({
      governing: [at("D1", "6.1", "Within forty-five (45) days")],
      basis:
        "ret-1.standard: forty-five days, longer than 30, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [at("D1", "7.1", "laws of the State of Delaware")],
      relevant: [
        at("D1", "7.2", "exclusive jurisdiction of the Court of Chancery of the State of Delaware"),
      ],
      basis: "gov-1.standard: Delaware law and a Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
