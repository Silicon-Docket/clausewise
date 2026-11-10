import { at, clause, compliant, deviation, item, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H11: the other side's affiliates are made parties without being named
//
// A mutual agreement for a data pilot, written as twenty-one flat clauses with a run-in title at
// the start of each and no section headings. Whinbury Orchard Controls, Inc., the client, is named
// in full and exactly as at intake. The other side is "Corvane Data Systems LLC, together with each
// of its Affiliates": the preamble makes every Affiliate a party, clause 1 says each is a Party
// whether or not it is named or signs, the notice and amendment clauses treat the group as one,
// and the signature block is signed for the Affiliates too. None is listed by name, which the
// playbook calls unacceptable. The client is not confused with anyone else in its group, so the
// entity-differs escalation does not arise. Every other rule meets the standard, in wording that
// does not follow the playbook's own, so a reader that flags more than the parties is wrong.
// ---------------------------------------------------------------------------------------------

export const H11: CaseDefinition = {
  case: "PAROL-H11",
  split: "heldout",
  phenomenon:
    'Parties: "Corvane Data Systems LLC and each of its Affiliates" made parties without naming them',
  intake: { clientLegalName: "Whinbury Orchard Controls, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h11-nda.docx",
      kind: "nda",
      title: "Pilot programme confidentiality agreement",
      statedDate: "2026-08-24",
      paragraphs: [
        title("PILOT PROGRAMME CONFIDENTIALITY AGREEMENT"),
        text(
          'This Pilot Programme Confidentiality Agreement (the "Agreement") is made on 24 August 2026 between Whinbury Orchard Controls, Inc., an Oregon corporation ("Whinbury"), and Corvane Data Systems LLC, a Virginia limited liability company, together with each of its Affiliates (each of them a "Corvane Entity" and all of them together "Corvane"). Whinbury and each Corvane Entity are the parties to this Agreement, and each is a "Party".',
        ),
        text(
          "Whinbury designs irrigation controllers for orchards and vineyards. Corvane builds yield-forecasting models from field data and wants to test them against the usage logs that Whinbury's controllers record.",
        ),
        text(
          'For a pilot of up to five months (the "Pilot"), Whinbury and Corvane expect to pass each other sample logs, model parameters and interface notes, and they have agreed how that material is to be treated.',
        ),
        clause(
          "1",
          "Parties bound. Corvane Data Systems LLC signs this Agreement for itself and for each of its Affiliates. Every Affiliate of Corvane Data Systems LLC is a Party from the date of this Agreement, whether or not it is named in this Agreement and whether or not it signs, and it has the rights and bears the obligations of a Party. Corvane Data Systems LLC warrants that it has authority to bind each of its Affiliates in this way.",
        ),
        clause(
          "2",
          "Affiliates. \"Affiliate\" means, for an entity, any other entity that can direct that entity's affairs, any entity whose affairs that entity can direct, and any entity whose affairs are directed by a person who also directs that entity's affairs, in each case whether at the date of this Agreement or at any later time while this Agreement is in force.",
        ),
        clause(
          "3",
          'Roles. A Party that makes information available under this Agreement is the "Contributor" of that information, and a Party that receives it is the "Recipient" of that information. Whinbury and every Corvane Entity can each be a Contributor and a Recipient, so what this Agreement requires of a Recipient applies equally to every Party.',
        ),
        clause(
          "4",
          'What is protected. "Confidential Information" means non-public information in any form that a Contributor makes available to a Recipient for the Pilot and that either bears a confidentiality marking or is described as confidential when it is made available, or that a reasonable observer, looking at what it is and how it came to be shared, would take to be confidential.',
        ),
        clause(
          "5",
          "What is not protected. Nothing is Confidential Information if, or to the extent that, it:",
        ),
        item(
          "(a)",
          "is already in the public domain when it is made available, or enters the public domain later without fault on the part of the Recipient;",
        ),
        item(
          "(b)",
          "was in the Recipient's possession before it was made available, and was not then subject to any duty of confidence;",
        ),
        item(
          "(c)",
          "is the product of the Recipient's own independent development, made without drawing on anything that the Contributor has made available; or",
        ),
        item(
          "(d)",
          "reaches the Recipient from a third party that was under no duty of confidence to the Contributor.",
        ),
        clause(
          "6",
          "Use and care. A Recipient may use Confidential Information solely for the Pilot, and shall guard it at least as carefully as it guards its own information of the same sensitivity, and always to a reasonable standard.",
        ),
        clause(
          "7",
          "Incidents. A Recipient that finds Confidential Information in the wrong hands, or being used for another purpose, shall notify the Contributor at once and cooperate in containing the damage.",
        ),
        clause(
          "8",
          "Who may see it. A Recipient may let its own directors, officers, employees and contractors, those of its Affiliates, and outside professional advisers of any of them, including lawyers and accountants, see Confidential Information, provided that each of them needs it for the Pilot and is bound by duties of confidence at least as strict as those in this Agreement. A Recipient remains responsible to the Contributor for what any such person does with Confidential Information.",
        ),
        clause(
          "9",
          "Disclosure demanded by law. A Recipient that is compelled by a legal requirement, such as a statute, a regulation, or an order of a court or public authority, to disclose Confidential Information may disclose the part that the requirement reaches and nothing more, provided that, where the law permits and it is reasonably practicable, it first gives the Contributor prompt notice, so that the Contributor can ask the court or authority to protect the information at the Contributor's own expense.",
        ),
        clause(
          "10",
          "Duration. A Recipient's duties for an item of Confidential Information run for three (3) years from the day that item was made available to it. If the item is a trade secret, the duties run for as long as it stays a trade secret under the law that applies to it.",
        ),
        clause(
          "11",
          "Ending the Pilot. Whinbury or Corvane Data Systems LLC may end the Pilot by giving the other fourteen (14) days' written notice. Ending the Pilot does not bring forward the end of any duty under clause 10.",
        ),
        clause(
          "12",
          "Return of material. Within thirty-five (35) days after the Contributor asks in writing, the Recipient shall return or destroy the Confidential Information it holds. It may keep a copy that it is legally required to keep, and copies that sit in its ordinary system backups, and any copy so kept stays under this Agreement.",
        ),
        clause(
          "13",
          "Ownership. Confidential Information stays the property of the Contributor. Receiving it confers no licence or other right in it.",
        ),
        clause(
          "14",
          "No promises about accuracy. Confidential Information is shared without any promise about its accuracy, its completeness or its freedom from the rights of third parties.",
        ),
        clause(
          "15",
          "Law and courts. The law of Delaware applies to this Agreement. Any suit about it shall be filed exclusively in the state courts of Delaware or the federal courts sitting in Delaware, and every Party submits to those courts and gives up any objection to them as a forum.",
        ),
        clause(
          "16",
          "Notices. A notice under this Agreement must be in writing. A notice to Corvane Data Systems LLC is a notice to every Corvane Entity, and a notice from Corvane Data Systems LLC is a notice from every Corvane Entity.",
        ),
        clause(
          "17",
          "Changes. Whinbury and Corvane Data Systems LLC may change this Agreement by a document that both of them sign, and a change so signed binds every Corvane Entity.",
        ),
        clause(
          "18",
          "Assignment. Neither Whinbury nor Corvane may transfer this Agreement, or any right under it, without the written consent of the other, which for Corvane is given by Corvane Data Systems LLC.",
        ),
        clause(
          "19",
          "Whole agreement. This Agreement contains everything that Whinbury and Corvane have agreed about protecting information exchanged for the Pilot.",
        ),
        clause(
          "20",
          "No commitment. Nothing in this Agreement requires Whinbury or Corvane to start or continue the Pilot, to buy or sell anything, or to hand over any information.",
        ),
        clause(
          "21",
          "Counterparts. This Agreement may be signed in counterparts, including by electronic signature, and the counterparts together form one agreement.",
        ),
        signature(
          "Whinbury Orchard Controls, Inc.",
          "Corvane Data Systems LLC, for itself and for each of its Affiliates",
        ),
      ],
    },
  ],
  expect: {
    "pty-1": deviation({
      governing: [
        at("D1", null, "together with each of its Affiliates"),
        at("D1", "1", "whether or not it is named in this Agreement"),
      ],
      relevant: [
        at("D1", "2", "at any later time while this Agreement is in force"),
        at("D1", "16", "is a notice to every Corvane Entity"),
        at("D1", "17", "binds every Corvane Entity"),
      ],
      basis:
        "pty-1.unacceptable: the Affiliates of Corvane Data Systems LLC are made parties without being listed by name",
      note: "Whinbury Orchard Controls, Inc. is named in full and exactly as at intake, and both sides can disclose and receive. The preamble makes Corvane Data Systems LLC and each of its Affiliates the other side, and clause 1 makes every Affiliate a Party whether or not it is named or signs, with the Affiliates defined by ability to direct affairs at any time while the Agreement is in force. No Affiliate is named, so the set of parties is not fixed by the document.",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "4",
          "bears a confidentiality marking or is described as confidential when it is made available, or that a reasonable observer, looking at what it is and how it came to be shared, would take to be confidential",
        ),
      ],
      basis:
        "def-1.standard: non-public information marked or identified as confidential, or that a reasonable person would understand to be confidential",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "5", "Nothing is Confidential Information if, or to the extent that, it"),
        at("D1", "5", "enters the public domain later without fault on the part of the Recipient"),
        at("D1", "5", "was not then subject to any duty of confidence"),
        at("D1", "5", "is the product of the Recipient's own independent development"),
        at("D1", "5", "was under no duty of confidence to the Contributor"),
      ],
      basis:
        "exc-1.standard: all four exclusions are present, as items (a) to (d), and none needs written records",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "8",
          "its own directors, officers, employees and contractors, those of its Affiliates, and outside professional advisers of any of them, including lawyers and accountants, see Confidential Information, provided that each of them needs it for the Pilot",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and professional advisers of the recipient and its affiliates who need to know it and are bound by duties no less protective",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "9",
          "may disclose the part that the requirement reaches and nothing more, provided that, where the law permits and it is reasonably practicable, it first gives the Contributor prompt notice",
        ),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the Recipient make a legally required disclosure, with prompt notice where the law permits and it is reasonably practicable",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "10",
          "run for three (3) years from the day that item was made available to it. If the item is a trade secret, the duties run for as long as it stays a trade secret",
        ),
      ],
      relevant: [at("D1", "11", "does not bring forward the end of any duty under clause 10")],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, and only trade secrets are protected for as long as they remain trade secrets",
    }),
    "ret-1": compliant({
      governing: [
        at(
          "D1",
          "12",
          "Within thirty-five (35) days after the Contributor asks in writing, the Recipient shall return or destroy the Confidential Information it holds. It may keep a copy that it is legally required to keep, and copies that sit in its ordinary system backups, and any copy so kept stays under this Agreement",
        ),
      ],
      basis:
        "ret-1.standard: thirty-five days, longer than 30, with law and routine backup copies kept and still confidential",
    }),
    "gov-1": compliant({
      governing: [
        at(
          "D1",
          "15",
          "The law of Delaware applies to this Agreement. Any suit about it shall be filed exclusively in the state courts of Delaware or the federal courts sitting in Delaware",
        ),
      ],
      basis:
        "gov-1.standard: Delaware law and an exclusive Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
