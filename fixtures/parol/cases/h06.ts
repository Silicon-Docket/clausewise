import {
  allowed,
  at,
  compliant,
  deviation,
  numbered,
  required,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H06: a defined term that leaves out advisers, and an exclusive Ontario forum
//
// A mutual agreement in ten sections whose last section, Interpretation, defines "Representatives"
// as directors, officers, employees and contractors of a Party and of its Affiliates
// and says in terms that it does not include any lawyer, accountant, auditor, financial adviser or
// other professional adviser. Section 4 lets the Receiving Party disclose only to its
// Representatives, so advisers are excluded, which the playbook calls unacceptable. The term is
// defined, in a section a reader may not look at first, so a reader that cannot find the
// definition may abstain with defined_term_unresolved and that is tolerated. Delaware law is on
// the approved list but the exclusive forum is the Ontario Superior Court of Justice sitting in
// Toronto, which is not, so the forum is a business decision for an attorney. Everything else
// meets the standard.
// ---------------------------------------------------------------------------------------------

export const H06: CaseDefinition = {
  case: "PAROL-H06",
  split: "heldout",
  phenomenon:
    'Defined term: "Representatives" is defined to exclude professional advisers; exclusive Ontario forum',
  intake: { clientLegalName: "Westerleigh Turbine Controls, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h06-nda.docx",
      kind: "nda",
      title: "Cross-border mutual NDA",
      statedDate: "2026-10-05",
      paragraphs: [
        title("CROSS-BORDER CONFIDENTIALITY AGREEMENT"),
        text(
          'This Cross-Border Confidentiality Agreement (the "Agreement") is made as of 5 October 2026 between Westerleigh Turbine Controls, Inc., a Michigan corporation ("Westerleigh"), and Greywater Foundry Corp., an Ontario corporation ("Greywater") (each a "Party" and together the "Parties").',
        ),
        text(
          'Greywater casts large steel housings, and Westerleigh designs the control units that are fitted inside turbine housings. The Parties are assessing whether Greywater should become Westerleigh\'s casting supplier for a new turbine range (the "Assessment"), and each expects to give the other drawings, test results and pricing for the Assessment.',
        ),
        ...numbered([
          [
            "The Information",
            [
              'A Party that gives information to the other under this Agreement is the "Furnishing Party" for that information, and the Party that receives it is the "Receiving Party".',
              '"Confidential Information" means non-public information, in any form, that the Furnishing Party gives the Receiving Party for the Assessment and that is marked as confidential, or stated to be confidential when it is given, or that a reasonable person in the Receiving Party\'s position would regard as confidential in view of its nature and the circumstances in which it is given.',
            ],
          ],
          [
            "Information Outside the Agreement",
            [
              "The Receiving Party has no obligation under this Agreement about information that it can demonstrate (a) is, or later becomes, public knowledge through no breach of this Agreement by the Receiving Party; (b) was already known to the Receiving Party, under no duty of confidence, when the Furnishing Party gave it; (c) the Receiving Party arrives at independently, without use of Confidential Information; or (d) reaches the Receiving Party from a third party that owes the Furnishing Party no duty of confidence.",
            ],
          ],
          [
            "Handling",
            [
              "The Receiving Party shall use Confidential Information solely for the Assessment.",
              "The Receiving Party shall store and handle Confidential Information using safeguards at least equal to those it uses for its own comparable information and in any case reasonable in the circumstances.",
              "The Receiving Party shall promptly inform the Furnishing Party if it learns of any use or disclosure of Confidential Information that this Agreement does not allow.",
            ],
          ],
          [
            "Disclosure to Others",
            [
              "The Receiving Party shall not disclose Confidential Information to anyone except its Representatives. It may disclose it to those of its Representatives who need to know it for the Assessment and who are bound by a duty of confidence no less protective than this Agreement.",
              "The Receiving Party is responsible to the Furnishing Party for any act or omission of its Representatives that would be a breach of this Agreement if the Receiving Party had done it.",
            ],
          ],
          [
            "Legal Compulsion",
            [
              "A Receiving Party that is compelled by statute, regulation, court order or the demand of a governmental authority to produce Confidential Information may produce what the compulsion requires and no more. To the extent the law permits and it is reasonably practicable, it shall first tell the Furnishing Party promptly and in writing, so that the Furnishing Party may apply for a protective order at its own expense.",
            ],
          ],
          [
            "Duration",
            [
              "The Receiving Party's obligations continue, for each item of Confidential Information, until twenty-four (24) months after the date on which that item is given.",
              "Either Party may end the Assessment by notice to the other, and doing so does not change the period in Section 6.1.",
            ],
          ],
          [
            "Return of Materials",
            [
              "Within sixty (60) days after a written request from the Furnishing Party, the Receiving Party shall return or destroy the Confidential Information in its possession or control. The Receiving Party may retain copies that the law requires it to keep and copies stored in routine backup systems, and all retained copies remain subject to this Agreement.",
            ],
          ],
          [
            "Governing Law and Courts",
            [
              "The laws of the State of Delaware govern this Agreement and every claim arising out of or relating to it.",
              "Each Party irrevocably submits to the exclusive jurisdiction of the Ontario Superior Court of Justice sitting in Toronto, and agrees that every proceeding arising out of or relating to this Agreement shall be brought only in that court.",
            ],
          ],
          [
            "General",
            [
              "This Agreement replaces every earlier understanding about information given for the Assessment, and an amendment has no effect unless both Parties have signed it.",
              "Nothing in this Agreement commits either Party to supply or buy anything, or to give the other any particular information.",
              "A signature delivered electronically binds the Party who gives it, and the counterparts together form a single instrument.",
            ],
          ],
          [
            "Interpretation",
            [
              '"Affiliate" of a Party means any entity that controls, is controlled by, or is under common control with that Party.',
              '"Representatives" of a Party means the directors, officers and employees of that Party and of its Affiliates, and the contractors engaged by any of them. It does not include any lawyer, accountant, auditor, financial adviser or other professional adviser, whether engaged by that Party or by an Affiliate.',
            ],
          ],
        ]),
        signature("Westerleigh Turbine Controls, Inc.", "Greywater Foundry Corp."),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at(
          "D1",
          null,
          'Westerleigh Turbine Controls, Inc., a Michigan corporation ("Westerleigh")',
        ),
      ],
      relevant: [
        at(
          "D1",
          "1.1",
          'A Party that gives information to the other under this Agreement is the "Furnishing Party"',
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party is the Furnishing Party of what it gives and the Receiving Party of what it obtains",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "marked as confidential, or stated to be confidential when it is given"),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
      note: "Clause 1.2 also covers non-public information that a reasonable person in the Receiving Party's position would regard as confidential in view of its nature and the circumstances.",
    }),
    "exc-1": compliant({
      governing: [
        at(
          "D1",
          "2.1",
          "The Receiving Party has no obligation under this Agreement about information that it can demonstrate",
        ),
      ],
      basis:
        "exc-1.standard: all four exclusions are present, as (a) to (d), and none needs written records",
      note: "Clause 2.1 lists information that is or becomes public without a breach by the Receiving Party (a), was known without a duty of confidence (b), is developed by the Receiving Party's own efforts without using Confidential Information (c) and is given by a third party that owes no duty of confidence (d).",
    }),
    "pds-1": deviation({
      governing: [
        at(
          "D1",
          "4.1",
          "shall not disclose Confidential Information to anyone except its Representatives",
        ),
        at(
          "D1",
          "10.2",
          "It does not include any lawyer, accountant, auditor, financial adviser or other professional adviser",
        ),
      ],
      escalation: allowed("defined_term_unresolved"),
      basis:
        "pds-1.unacceptable: the Receiving Party may disclose only to its Representatives, a defined term that leaves out professional advisers",
      note: "Clause 4.1 allows disclosure to no one but Representatives. Clause 10.2 defines Representatives as directors, officers, employees and contractors of the Party and its Affiliates and says that the term does not include any lawyer, accountant, auditor, financial adviser or other professional adviser, so advisers are excluded. The definition is in the last section, and a reader that cannot find it may abstain with defined_term_unresolved, which is tolerated.",
    }),
    "pds-2": compliant({
      governing: [at("D1", "5.1", "may produce what the compulsion requires and no more")],
      basis:
        "pds-2.standard: a dedicated clause lets the Receiving Party make a legally required disclosure, with prompt notice where the law permits and it is reasonably practicable",
    }),
    "dur-1": compliant({
      governing: [
        at("D1", "6.1", "until twenty-four (24) months after the date on which that item is given"),
      ],
      relevant: [at("D1", "6.2", "does not change the period in Section 6.1")],
      basis: "dur-1.standard: obligations end two years after each disclosure",
    }),
    "ret-1": compliant({
      governing: [
        at("D1", "7.1", "Within sixty (60) days after a written request from the Furnishing Party"),
      ],
      basis:
        "ret-1.standard: sixty days, longer than 30, with law and routine backup copies kept and still confidential",
      note: "Clause 7.1 lets the Receiving Party retain copies the law requires and copies stored in routine backup systems, and all retained copies remain subject to the agreement.",
    }),
    "gov-1": deviation({
      governing: [
        at(
          "D1",
          "8.2",
          "exclusive jurisdiction of the Ontario Superior Court of Justice sitting in Toronto",
        ),
      ],
      relevant: [at("D1", "8.1", "laws of the State of Delaware")],
      escalation: required("playbook_escalation"),
      basis:
        "gov-1.escalateWhen.forum-outside-list: the exclusive forum is a court in Ontario, Canada, which is not Delaware, New York or England and Wales",
      note: "Delaware law is on the approved list, but clause 8.2 gives the Ontario Superior Court of Justice sitting in Toronto exclusive jurisdiction and requires every proceeding to be brought there, and the forum is a business decision for the responsible attorney.",
    }),
  },
  warnings: [],
};
