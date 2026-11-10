import { at, clause, compliant, deviation, item, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D11: a one-way NDA typed in plain text, where a legally required disclosure needs the
// discloser's prior written consent
//
// The file is TXT, so its numbers are typed: flat clause numbers ("7.") and lettered sub-items
// ("(a)"). Only pds-2 departs from the playbook: clause 7 exists, but it lets the recipient make a
// legally required disclosure only with the discloser's consent, which the discloser may refuse.
// ---------------------------------------------------------------------------------------------

export const D11: CaseDefinition = {
  case: "PAROL-D11",
  split: "dev",
  phenomenon:
    "Typed numbering in plain text; compelled disclosure needs the discloser's prior consent",
  intake: { clientLegalName: "Pellam Brook Analytics, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d11-nda.txt",
      kind: "nda",
      title: "One-way NDA",
      statedDate: "2026-04-21",
      paragraphs: [
        title("NON-DISCLOSURE AGREEMENT"),
        text(
          'This Non-Disclosure Agreement (the "Agreement") is made on 21 April 2026 between Ostrander Fennimore Ltd, a private limited company incorporated in England and Wales (the "Discloser"), and Pellam Brook Analytics, Inc., a Delaware corporation (the "Recipient").',
        ),
        text(
          "The Discloser operates a network of grain storage depots and is considering whether to engage the Recipient to build a demand forecasting model for those depots. So that the Recipient can assess and price that work, the Discloser is willing to share some of its operating information on the terms of this Agreement.",
        ),
        clause(
          "1",
          'Purpose. The Discloser will make information available to the Recipient only so that the Recipient can assess, scope and price a proposed forecasting engagement for the Discloser (the "Purpose"). Neither party is obliged to enter into that engagement.',
        ),
        clause(
          "2",
          'Confidential Information. "Confidential Information" means non-public information that the Discloser discloses to the Recipient for the Purpose, whether orally, in writing or by giving access to its systems, and that is marked or identified as confidential when it is disclosed or that a reasonable person in the Recipient\'s position would understand to be confidential from its nature or from the circumstances in which it is disclosed.',
        ),
        clause(
          "3",
          'Affiliates. In this Agreement, "Affiliate" means any entity that directly or indirectly controls, is controlled by, or is under common control with a party, and "control" means the power to direct the management of an entity, whether through voting securities, by contract or otherwise.',
        ),
        clause(
          "4",
          "Exclusions. Information is not Confidential Information, and the Recipient owes no duty under this Agreement in respect of it, if it:",
        ),
        item(
          "(a)",
          "is or becomes generally available to the public other than through a breach of this Agreement by the Recipient;",
        ),
        item(
          "(b)",
          "was already known to the Recipient before the Discloser disclosed it, and the Recipient owed no duty of confidence in respect of it;",
        ),
        item(
          "(c)",
          "is developed independently by the Recipient without use of the Discloser's Confidential Information; or",
        ),
        item(
          "(d)",
          "is received by the Recipient from a third party that owed the Discloser no duty of confidence in respect of it.",
        ),
        clause(
          "5",
          "Use and Care. The Recipient shall use Confidential Information only for the Purpose. It shall protect Confidential Information with at least the care it takes to protect its own information of a similar nature, and in any event with reasonable care.",
        ),
        clause(
          "6",
          "Representatives. The Recipient may share Confidential Information with the directors, officers, employees, contractors and professional advisers of the Recipient and of its Affiliates, if each of them needs the information for the Purpose and is bound by duties of confidentiality at least as protective as those in this Agreement. The Recipient is responsible for a breach of this Agreement by any person to whom it passes Confidential Information.",
        ),
        clause(
          "7",
          "Disclosure Required by Law. If a law, a regulation, a subpoena or an order of a court or government authority requires the Recipient to disclose Confidential Information, the Recipient may make that disclosure only if:",
        ),
        item(
          "(a)",
          "it has told the Discloser in writing what is required and who requires it; and",
        ),
        item(
          "(b)",
          "the Discloser has given its prior written consent to that disclosure, which the Discloser may give or withhold in its sole discretion.",
        ),
        clause(
          "8",
          "Unauthorized Use. The Recipient shall tell the Discloser promptly if it learns of any use or disclosure of Confidential Information that this Agreement does not allow.",
        ),
        clause(
          "9",
          "Duration. The Recipient's obligations under this Agreement in respect of an item of Confidential Information end three (3) years after the date on which the Discloser disclosed that item, except that its obligations in respect of an item that is a trade secret continue for as long as the item remains a trade secret under applicable law.",
        ),
        clause(
          "10",
          "Return or Destruction. Within thirty (30) days after receiving a written request from the Discloser, the Recipient shall return or destroy the Confidential Information it has received, except that it may keep copies that a law requires it to keep and copies held in its routine backup systems, and those copies remain subject to this Agreement.",
        ),
        clause(
          "11",
          "Ownership. Confidential Information remains the property of the Discloser. This Agreement gives the Recipient no license or other right in it, apart from the right to use it for the Purpose.",
        ),
        clause(
          "12",
          "No Warranty. The Discloser provides Confidential Information as it is and gives no warranty that it is accurate or complete.",
        ),
        clause(
          "13",
          "Remedies. The Recipient accepts that damages alone may not be an adequate remedy for a breach of this Agreement, and that the Discloser may ask a court for an injunction or other equitable relief.",
        ),
        clause(
          "14",
          "Ending the Discussions. Either party may end the discussions about the Purpose at any time by written notice to the other. Clause 9 and the other terms of this Agreement then continue to apply to Confidential Information that the Discloser has already disclosed.",
        ),
        clause(
          "15",
          "Governing Law and Courts. This Agreement is governed by the laws of England and Wales, and the courts of England and Wales have exclusive jurisdiction over any dispute arising out of or in connection with it.",
        ),
        clause(
          "16",
          "Assignment. A party may not transfer this Agreement to another person unless the other party agrees in writing.",
        ),
        clause(
          "17",
          "Entire Agreement. This Agreement is the whole agreement between the parties about its subject matter and may be changed only in writing signed by both parties.",
        ),
        clause(
          "18",
          "Counterparts. The parties may sign separate copies of this Agreement, and the signed copies together form one agreement.",
        ),
        signature("Ostrander Fennimore Ltd", "Pellam Brook Analytics, Inc."),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Pellam Brook Analytics, Inc., a Delaware corporation")],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client exactly as given at intake, and the roles of discloser and recipient are stated",
    }),
    "def-1": compliant({
      governing: [at("D1", "2", "marked or identified as confidential when it is disclosed")],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "4", "Information is not Confidential Information"),
        at("D1", "4", "is or becomes generally available to the public"),
        at("D1", "4", "was already known to the Recipient before the Discloser disclosed it"),
        at("D1", "4", "is developed independently by the Recipient"),
        at("D1", "4", "is received by the Recipient from a third party"),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [at("D1", "6", "professional advisers of the Recipient and of its Affiliates")],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by equal duties, with no consent needed",
    }),
    "pds-2": deviation({
      governing: [
        at("D1", "7", "the Recipient may make that disclosure only if"),
        at("D1", "7", "the Discloser has given its prior written consent to that disclosure"),
      ],
      relevant: [at("D1", "7", "it has told the Discloser in writing what is required")],
      basis:
        "pds-2.unacceptable: the recipient has no right to make a legally required disclosure unless the discloser consents beforehand, and the discloser may refuse",
      note: "Clause 7 is a dedicated clause on legally required disclosure, so the rule is not missing, and sub-item (a) alone would read as a notice duty. But sub-item (b) makes every such disclosure depend on the discloser's prior written consent, given or withheld in its sole discretion. The recipient therefore has no right of its own to make the disclosure the law requires, and the conditional permission the clause grants is the unacceptable case, not the standard.",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "9",
          "end three (3) years after the date on which the Discloser disclosed that item",
        ),
      ],
      relevant: [
        at(
          "D1",
          "14",
          "continue to apply to Confidential Information that the Discloser has already disclosed",
        ),
      ],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, with trade secrets protected for as long as they remain trade secrets",
    }),
    "ret-1": compliant({
      governing: [at("D1", "10", "Within thirty (30) days after receiving a written request")],
      basis: "ret-1.standard: thirty days, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [at("D1", "15", "governed by the laws of England and Wales")],
      basis:
        "gov-1.standard: the law of England and Wales and an exclusive forum there are on the approved list",
      note: "England and Wales is on the approved list, so no escalation is expected even though the client is a Delaware corporation and the counterparty is English.",
    }),
  },
  warnings: [],
};
