import {
  at,
  compliant,
  deviation,
  heading,
  numbered,
  required,
  signature,
  text,
  title,
  undetermined,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D14: an agreement that contradicts itself on the definition, and a forum outside the list
//
// Section 1.3 defines Confidential Information at the playbook's standard. Schedule A, which Section
// 1.1 and Section 8.1 make part of the agreement, defines the same term as all information of any
// kind, marked or not. Nothing says which prevails, so def-1 cannot be decided and must be
// escalated. Section 7 chooses New York law, which is approved, and an exclusive forum in Harris
// County, Texas, which is not.
// ---------------------------------------------------------------------------------------------

export const D14: CaseDefinition = {
  case: "PAROL-D14",
  split: "dev",
  phenomenon:
    "Internal conflict: two different definitions (Section 1 and Schedule A); New York law, exclusive forum in Harris County, Texas",
  intake: { clientLegalName: "Iolite Ledger Systems, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d14-nda.docx",
      kind: "nda",
      title: "Confidentiality Agreement",
      statedDate: "2026-07-14",
      paragraphs: [
        title("CONFIDENTIALITY AGREEMENT"),
        text(
          'This Confidentiality Agreement (the "Agreement") is made on 14 July 2026 between Iolite Ledger Systems, Inc., a New York corporation ("Iolite"), and Tallowmere Pipeline Services, Inc., a Texas corporation ("Tallowmere") (each a "Party" and together the "Parties").',
        ),
        text(
          "Iolite makes accounting software for energy companies. Tallowmere wishes to test that software against samples of its own pipeline billing records, and each Party expects to give the other confidential information for that evaluation.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              "Capitalized terms used in this Agreement have the meanings given in this Section 1 or in Schedule A.",
              '"Affiliate" means an entity that controls, is controlled by, or is under common control with a Party.',
              '"Confidential Information" means non-public information that one Party (the "Disclosing Party") discloses to the other Party (the "Receiving Party") for the Purpose and that is marked or identified as confidential when disclosed, or that a reasonable person would understand to be confidential from its nature or the circumstances of its disclosure.',
              "\"Purpose\" means the Parties' evaluation of Iolite's software against samples of Tallowmere's pipeline billing records.",
            ],
          ],
          [
            "Handling",
            [
              "The Receiving Party shall use Confidential Information only for the Purpose, and shall protect it with at least the care it uses for its own information of a similar nature, and no less than reasonable care.",
              "The Receiving Party shall tell the Disclosing Party within two (2) Business Days after it learns of any use or disclosure of Confidential Information that this Agreement does not allow.",
            ],
          ],
          [
            "Exclusions",
            [
              "Confidential Information does not include information that (a) is or becomes publicly available other than through a breach of this Agreement by the Receiving Party; (b) the Receiving Party already knew, without any duty of confidentiality, when the Disclosing Party disclosed it; (c) the Receiving Party develops independently without using Confidential Information of the Disclosing Party; or (d) the Receiving Party obtains from a third party that owes the Disclosing Party no duty of confidentiality.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to the employees, officers, contractors and professional advisers of itself and its Affiliates who need to know it for the Purpose and who are bound by confidentiality duties no less protective than those in this Agreement.",
              "The Receiving Party may disclose Confidential Information to the extent that law, regulation or the order of a court or governmental authority requires, and where it is legally permitted and reasonably practicable it shall first give the Disclosing Party prompt notice so that the Disclosing Party may seek a protective order at its own cost.",
            ],
          ],
          [
            "Duration",
            [
              "The Receiving Party's obligations under this Agreement end two (2) years after the date on which the Disclosing Party first disclosed the information concerned, except that its obligations for a trade secret continue for as long as the information remains a trade secret under applicable law.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within forty-five (45) days after the Disclosing Party's written request, the Receiving Party shall return or destroy the Disclosing Party's Confidential Information, except for copies that the law requires it to keep and copies held in routine backup systems, which remain subject to this Agreement.",
            ],
          ],
          [
            "Governing Law and Forum",
            [
              "This Agreement is governed by the laws of the State of New York, without regard to its conflict of laws rules.",
              "Each Party irrevocably submits to the exclusive jurisdiction of the state and federal courts located in Harris County, Texas, for any dispute arising out of or relating to this Agreement.",
            ],
          ],
          [
            "General",
            [
              "This Agreement, including Schedule A, is the entire agreement between the Parties about its subject matter.",
              "A change to this Agreement is effective only if it is in writing and signed by both Parties.",
              "Neither Party may assign this Agreement without the written agreement of the other Party.",
            ],
          ],
        ]),
        signature("Iolite Ledger Systems, Inc.", "Tallowmere Pipeline Services, Inc."),
        heading("Schedule A: Defined Terms"),
        text("This Schedule A forms part of the Agreement and lists defined terms used in it."),
        text(
          '"Business Day" means a day other than a Saturday, a Sunday or a public holiday in the State of New York.',
        ),
        text(
          '"Confidential Information" means all information of any kind, in any form, that a Party discloses to the other Party in connection with the Purpose, whether or not that information is marked or identified as confidential.',
        ),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Iolite Ledger Systems, Inc., a New York corporation")],
      basis:
        "pty-1.standard: the client is named exactly as given at intake, with its entity type, and both parties disclose and receive",
    }),
    "def-1": undetermined({
      relevant: [
        at("D1", "1.3", "marked or identified as confidential when disclosed"),
        at("D1", null, "all information of any kind, in any form"),
        at("D1", "1.1", "in this Section 1 or in Schedule A"),
      ],
      escalation: required("conflicting_sources"),
      basis:
        "def-1.standard: Section 1.3 states a scope the standard allows and Schedule A states one the unacceptable position describes, and the agreement does not say which controls",
      note: "Section 1.1 gives effect to the definitions in Section 1 and in Schedule A alike, Schedule A says that it forms part of the Agreement, Section 8.1 counts Schedule A in the entire agreement, and no clause ranks the body above the schedule or the schedule above the body. Section 1.3 would be compliant and Schedule A would be a deviation, so the status turns on a precedence the agreement does not state.",
    }),
    "exc-1": compliant({
      governing: [at("D1", "3.1", "Confidential Information does not include information that")],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers of itself and its Affiliates")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": compliant({
      governing: [at("D1", "4.2", "the order of a court or governmental authority requires")],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [at("D1", "5.1", "end two (2) years after the date on which")],
      basis:
        "dur-1.standard: obligations end two years after the first disclosure, with trade secrets protected for as long as they remain trade secrets",
    }),
    "ret-1": compliant({
      governing: [at("D1", "6.1", "Within forty-five (45) days")],
      basis:
        "ret-1.standard: forty-five days is longer than thirty, with law and routine backup copies kept confidential",
    }),
    "gov-1": deviation({
      governing: [
        at(
          "D1",
          "7.2",
          "exclusive jurisdiction of the state and federal courts located in Harris County, Texas",
        ),
      ],
      relevant: [at("D1", "7.1", "laws of the State of New York")],
      escalation: required("playbook_escalation"),
      basis:
        "gov-1.escalateWhen.forum-outside-list: the exclusive forum is in Texas, which is not Delaware, New York or England and Wales",
      note: "New York law is approved, but Section 7.2 gives the courts of Harris County, Texas exclusive jurisdiction, and the forum is a business decision for the responsible attorney.",
    }),
  },
  warnings: [],
};
