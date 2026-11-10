import {
  at,
  compliant,
  missing,
  notApplicable,
  numbered,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D03: omissions (no governing law, no compelled-disclosure clause, no return clause)
// ---------------------------------------------------------------------------------------------

export const D03: CaseDefinition = {
  case: "PAROL-D03",
  split: "dev",
  phenomenon: "Omissions: no governing law, no compelled-disclosure clause, no return clause",
  intake: { clientLegalName: "Tessellate Logistics, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d03-nda.docx",
      kind: "nda",
      title: "Nondisclosure Agreement",
      statedDate: "2026-04-22",
      paragraphs: [
        title("NONDISCLOSURE AGREEMENT"),
        text(
          'This Nondisclosure Agreement (the "Agreement") is made as of 22 April 2026 between Tessellate Logistics, Inc., an Ohio corporation ("Tessellate"), and Brindle Marsh Freight LLC, an Illinois limited liability company ("Brindle") (each a "Party" and together the "Parties").',
        ),
        text(
          'The Parties intend to explore whether Brindle should carry Tessellate\'s regional freight and will exchange non-public business information for that purpose (the "Purpose").',
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Confidential Information" means non-public information that a Party (the "Disclosing Party") gives to the other Party (the "Receiving Party") for the Purpose and that is identified as confidential when given, or that a reasonable person would see to be confidential from its nature or the way it is given.',
              '"Affiliate" means any entity that is under common ownership or control with a Party.',
            ],
          ],
          [
            "Exclusions",
            [
              "Confidential Information does not include information that (a) is or becomes part of the public domain through no fault of the Receiving Party; (b) the Receiving Party knew before the Disclosing Party gave it and was under no duty of confidence about it; (c) the Receiving Party develops independently without using the Disclosing Party's information; or (d) the Receiving Party receives from a third party that owes no duty of confidence to the Disclosing Party.",
            ],
          ],
          [
            "Obligations",
            [
              "The Receiving Party shall hold Confidential Information in confidence and use it only for the Purpose.",
              "The Receiving Party shall protect Confidential Information with at least the care it takes with its own confidential records, and no less than reasonable care.",
              "The Receiving Party shall not copy Confidential Information except as the Purpose needs.",
            ],
          ],
          [
            "Permitted Disclosures",
            [
              "The Receiving Party may disclose Confidential Information to its and its Affiliates' employees, officers, contractors and professional advisers who need to know it for the Purpose and who are bound to keep it confidential on terms at least as protective as this Agreement.",
            ],
          ],
          [
            "Term",
            [
              "The Receiving Party's obligations under this Agreement end two (2) years after the date on which the Disclosing Party discloses the information concerned.",
              "Either Party may stop the discussions by giving the other thirty (30) days' written notice.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the whole agreement of the Parties about its subject matter.",
              "Any change to this Agreement must be in writing and signed by both Parties.",
              "The Parties may sign separate copies, which together make one agreement.",
            ],
          ],
        ]),
        signature("Tessellate Logistics, Inc.", "Brindle Marsh Freight LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Tessellate Logistics, Inc., an Ohio corporation")],
      basis: "pty-1.standard: both parties are named in full with their entity types",
    }),
    "def-1": compliant({
      governing: [at("D1", "1.1", "identified as confidential when given")],
      basis: "def-1.standard: identified as confidential or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [at("D1", "2.1", "Confidential Information does not include information that")],
      basis: "exc-1.standard: all four exclusions are present",
    }),
    "pds-1": compliant({
      governing: [at("D1", "4.1", "professional advisers who need to know it")],
      basis: "pds-1.standard: employees, officers, contractors and advisers who need to know",
    }),
    "pds-2": missing({
      basis:
        "pds-2.standard: a dedicated clause is needed and the agreement has none; the general duty of confidence is not one",
      note: "Section 3 holds a general duty of confidence, which the rule's guidance says is not a legally required disclosure clause.",
    }),
    "dur-1": compliant({
      governing: [at("D1", "5.1", "end two (2) years after the date")],
      basis: "dur-1.standard: obligations end two years after each disclosure",
    }),
    "ret-1": notApplicable({
      basis: "ret-1.required: the rule is not required and the agreement has no return clause",
    }),
    "gov-1": missing({
      basis: "gov-1.standard: the agreement states no governing law and no forum",
    }),
  },
  warnings: [],
};
