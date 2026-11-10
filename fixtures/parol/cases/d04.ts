import { at, clause, compliant, heading, item, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D04: paraphrase, the false alarm test
//
// Every standard is met, in wording that does not echo the playbook: the exclusions open with
// "shall not extend to" and are lettered sub-paragraphs, and the term is "thirty-six months from
// the relevant disclosure". A reader that flags a rule because the usual words are absent is wrong
// on every slot.
// ---------------------------------------------------------------------------------------------

export const D04: CaseDefinition = {
  case: "PAROL-D04",
  split: "dev",
  phenomenon:
    'Paraphrase: exclusions as "shall not extend to", term as "thirty-six months from the relevant disclosure"',
  intake: { clientLegalName: "Fernwick Cartography Limited" },
  documents: [
    {
      label: "D1",
      file: "parol-d04-nda.docx",
      kind: "nda",
      title: "Reciprocal Confidentiality Agreement",
      statedDate: "2026-09-03",
      paragraphs: [
        title("RECIPROCAL CONFIDENTIALITY AGREEMENT"),
        text(
          'This Reciprocal Confidentiality Agreement (the "Agreement") is made on 3 September 2026 between Fernwick Cartography Limited, a private limited company incorporated in England and Wales ("Fernwick"), and Yarrowby Terrain Data LLC, a Colorado limited liability company ("Yarrowby") (each a "Party" and together the "Parties").',
        ),
        text(
          "The Parties wish to test whether Fernwick's aerial survey imagery can be combined with Yarrowby's terrain models (the \"Project\") and each expects to pass information to the other for the Project.",
        ),
        heading("1. Meaning of Terms"),
        clause(
          "1.1",
          '"Affiliate" means any entity that controls, is controlled by or is under common control with a Party, control meaning the power to direct the management and policies of an entity, whether through ownership of voting securities, by contract or otherwise.',
        ),
        clause(
          "1.2",
          '"Confidential Information" means non-public information, in any form, that one Party (the "Sharing Party") supplies to the other (the "Receiving Party") for the Project and that is identified as confidential when supplied, or that a reasonable person in the position of the Receiving Party would understand to be confidential having regard to its nature and the circumstances in which it was supplied.',
        ),
        heading("2. The Duty of Confidence"),
        clause(
          "2.1",
          "The Receiving Party shall use Confidential Information solely for the Project and shall keep it confidential.",
        ),
        clause(
          "2.2",
          "The Receiving Party shall guard Confidential Information with at least the care it gives to its own information of a similar kind, and in any case with reasonable care.",
        ),
        clause(
          "2.3",
          "The Receiving Party shall inform the Sharing Party without delay on becoming aware of any use or disclosure of Confidential Information that this Agreement does not permit.",
        ),
        heading("3. Information Outside the Duty"),
        clause("3.1", "The obligations in clause 2 shall not extend to any information which:"),
        item(
          "(a)",
          "is, or later becomes, part of the public domain otherwise than through a default of the Receiving Party;",
        ),
        item(
          "(b)",
          "was already known to the Receiving Party, and was not then subject to any duty of confidence, before the Sharing Party supplied it;",
        ),
        item(
          "(c)",
          "is developed by the Receiving Party independently, without drawing on or referring to the Sharing Party's Confidential Information; or",
        ),
        item(
          "(d)",
          "comes to the Receiving Party from a third party that is under no duty of confidence in respect of it.",
        ),
        heading("4. Passing Information On"),
        clause(
          "4.1",
          "The Receiving Party may pass Confidential Information to those of its own and its Affiliates' directors, officers, employees, contractors and professional advisers who need to know it for the Project, provided that each of them is bound by duties of confidentiality no less protective than those in this Agreement.",
        ),
        clause(
          "4.2",
          "The Receiving Party is answerable for any breach of this Agreement by a person to whom it passes Confidential Information under clause 4.1.",
        ),
        heading("5. Compelled Disclosure"),
        clause(
          "5.1",
          "If law, regulation or the order of a court or of a governmental or regulatory authority requires the Receiving Party to disclose Confidential Information, it may do so to the extent required, provided that, where it is legally permitted and reasonably practicable, it gives the Sharing Party prompt notice so that the Sharing Party may seek a protective order or other remedy at its own cost.",
        ),
        heading("6. Period of Protection"),
        clause(
          "6.1",
          "The Receiving Party's obligations in respect of an item of Confidential Information continue for thirty-six months from the relevant disclosure of that item, and then end.",
        ),
        clause(
          "6.2",
          "Either Party may end the discussions at any time by written notice. Ending the discussions neither shortens nor extends the period in clause 6.1 for information already supplied.",
        ),
        heading("7. Return of Materials"),
        clause(
          "7.1",
          "Within sixty (60) days after a written request from the Sharing Party, the Receiving Party shall return or destroy the Sharing Party's Confidential Information, save that it may keep copies that the law requires it to keep and copies held in its routine backup systems, and every copy kept in that way remains subject to this Agreement.",
        ),
        heading("8. Law and Courts"),
        clause(
          "8.1",
          "This Agreement, and any dispute or claim arising out of or in connection with it, is governed by the law of England and Wales.",
        ),
        clause(
          "8.2",
          "The courts of England and Wales have exclusive jurisdiction to settle any such dispute or claim.",
        ),
        heading("9. General"),
        clause(
          "9.1",
          "This Agreement is the entire agreement between the Parties about its subject matter and may be varied only in writing signed by both Parties.",
        ),
        clause(
          "9.2",
          "Neither Party is obliged to supply any particular information, and nothing in this Agreement gives either Party a licence or other right in the other's Confidential Information.",
        ),
        clause(
          "9.3",
          "The Parties may sign this Agreement in counterparts, which together form one agreement.",
        ),
        signature("Fernwick Cartography Limited", "Yarrowby Terrain Data LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at(
          "D1",
          null,
          "Fernwick Cartography Limited, a private limited company incorporated in England and Wales",
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and both disclose",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "1.2",
          "identified as confidential when supplied, or that a reasonable person in the position of the Receiving Party would understand to be confidential",
        ),
      ],
      basis: "def-1.standard: identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "3.1", "shall not extend to any information which"),
        at("D1", "3.1", "otherwise than through a default of the Receiving Party"),
        at("D1", "3.1", "was not then subject to any duty of confidence"),
        at("D1", "3.1", "without drawing on or referring to"),
        at("D1", "3.1", "under no duty of confidence in respect of it"),
      ],
      basis:
        "exc-1.standard: all four exclusions are present in other words, as items (a) to (d), and none needs written records",
      note: "Clause 3.1 says the obligations shall not extend to information that is public through no default of the recipient (a), already known without a duty of confidence (b), independently developed without drawing on the sharing party's information (c), or received from a third party under no duty of confidence (d).",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "4.1",
          "directors, officers, employees, contractors and professional advisers who need to know it for the Project",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "5.1",
          "requires the Receiving Party to disclose Confidential Information, it may do so to the extent required",
        ),
      ],
      basis: "pds-2.standard: a dedicated clause with notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [at("D1", "6.1", "thirty-six months from the relevant disclosure")],
      relevant: [at("D1", "6.2", "neither shortens nor extends the period in clause 6.1")],
      basis: "dur-1.standard: thirty-six months from each disclosure is three years",
      note: "The period runs from the disclosure of each item and clause 6.2 leaves it unchanged when the discussions end.",
    }),
    "ret-1": compliant({
      governing: [at("D1", "7.1", "Within sixty (60) days")],
      basis:
        "ret-1.standard: sixty days, a longer period than 30, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [at("D1", "8.2", "The courts of England and Wales have exclusive jurisdiction")],
      relevant: [at("D1", "8.1", "governed by the law of England and Wales")],
      basis: "gov-1.standard: the law and the exclusive forum of England and Wales are approved",
    }),
  },
  warnings: [],
};
