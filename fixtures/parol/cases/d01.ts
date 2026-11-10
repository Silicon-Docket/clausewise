import { at, compliant, numbered, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D01: clean control
// ---------------------------------------------------------------------------------------------

export const D01: CaseDefinition = {
  case: "PAROL-D01",
  split: "dev",
  phenomenon: "Clean control: every standard met",
  intake: { clientLegalName: "Quillfeather Robotics, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d01-nda.docx",
      kind: "nda",
      title: "Mutual Confidentiality Agreement",
      statedDate: "2026-03-10",
      paragraphs: [
        title("MUTUAL CONFIDENTIALITY AGREEMENT"),
        text(
          'This Mutual Confidentiality Agreement (the "Agreement") is made on 10 March 2026 between Quillfeather Robotics, Inc., a Delaware corporation ("Quillfeather"), and Tidewater Meridian LLC, a Washington limited liability company ("Tidewater") (each a "Party" and together the "Parties").',
        ),
        text(
          'The Parties are discussing a possible joint development project (the "Purpose") and each may disclose confidential information to the other for the Purpose.',
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means a company or other entity that directly or indirectly controls, is controlled by, or is under common control with a Party.',
              '"Confidential Information" means information, in any form, that one Party (the "Discloser") makes available to the other Party (the "Recipient") for the Purpose and that is identified as confidential when disclosed or that a reasonable person would regard as confidential because of its nature or the way it is disclosed.',
            ],
          ],
          [
            "Exclusions",
            [
              "The Recipient has no obligation under this Agreement for information that (a) is or becomes publicly available without any breach of this Agreement by the Recipient; (b) the Recipient already knew, free of any confidentiality duty, when the Discloser disclosed it; (c) the Recipient develops on its own, without using or referring to the Discloser's Confidential Information; or (d) the Recipient lawfully obtains from a third party that is not bound by a confidentiality duty to the Discloser.",
            ],
          ],
          [
            "Use and Protection",
            [
              "The Recipient shall use Confidential Information only for the Purpose and shall protect it with the same care it applies to its own confidential information, and in any event with reasonable care.",
              "The Recipient shall tell the Discloser promptly if it learns of any unauthorized use or disclosure of Confidential Information.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Recipient may share Confidential Information with the employees, officers, contractors and professional advisers of the Recipient and of its Affiliates who need it for the Purpose and who owe the Recipient duties of confidentiality at least as protective as those in this Agreement.",
              "The Recipient may disclose Confidential Information to the extent a law, a regulation or a court or government order requires it, if it gives the Discloser prompt notice where the law allows and it is practicable, so that the Discloser can ask a court for protection at the Discloser's expense.",
            ],
          ],
          [
            "Term",
            [
              "The Recipient's obligations under this Agreement with respect to an item of Confidential Information end three (3) years after the Discloser first disclosed that item.",
              "Either Party may end the discussions at any time by written notice to the other, and this Agreement continues to apply to Confidential Information already disclosed.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within thirty (30) days after the Discloser's written request, the Recipient shall return or destroy the Discloser's Confidential Information, except that it may keep copies that the law requires it to keep and copies held in routine backup systems, which stay subject to this Agreement.",
            ],
          ],
          [
            "Governing Law",
            [
              "This Agreement is governed by the laws of the State of New York, without regard to its conflict of laws rules, and each Party submits to the exclusive jurisdiction of the state and federal courts located in New York County, New York.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the entire agreement of the Parties on its subject and may be changed only by a written document signed by both Parties.",
              "The Parties may sign this Agreement in counterparts, which together form one agreement.",
            ],
          ],
        ]),
        signature("Quillfeather Robotics, Inc.", "Tidewater Meridian LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Quillfeather Robotics, Inc., a Delaware corporation")],
      basis: "pty-1.standard: both parties are named in full with their entity types",
    }),
    "def-1": compliant({
      governing: [at("D1", "1.2", "identified as confidential when disclosed")],
      basis:
        "def-1.standard: information identified as confidential or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at(
          "D1",
          "2.1",
          "The Recipient has no obligation under this Agreement for information that",
        ),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers of the Recipient")],
      basis:
        "pds-1.standard: advisers and affiliates' staff may receive it on a need to know basis",
    }),
    "pds-2": compliant({
      governing: [at("D1", "4.2", "a court or government order requires it")],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [at("D1", "5.1", "end three (3) years after")],
      relevant: [
        at("D1", "5.2", "continues to apply to Confidential Information already disclosed"),
      ],
      basis: "dur-1.standard: obligations end three years after each disclosure",
    }),
    "ret-1": compliant({
      governing: [at("D1", "6.1", "Within thirty (30) days")],
      basis: "ret-1.standard: thirty days, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [at("D1", "7.1", "laws of the State of New York")],
      basis: "gov-1.standard: New York law and a New York forum are on the approved list",
    }),
  },
  warnings: [],
};
