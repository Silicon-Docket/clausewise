import { at, compliant, deviation, missing, numbered, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H03: omission of the exclusions, and a duty to purge routine backups
//
// A mutual agreement between a Pennsylvania corporation and an English company that has no
// exclusions of any kind: nothing about information that is public, already known, independently
// developed or received from a third party, and no sentence that works like one. Its definition
// does not say "non-public" for the same reason. The return section gives a thirty day deadline,
// a copy kept because the law requires it, and an officer's certificate (none of which is a
// deviation), and then requires the routine backup systems to be cleared by the same date, which
// is the one thing the playbook calls unacceptable there.
// ---------------------------------------------------------------------------------------------

export const H03: CaseDefinition = {
  case: "PAROL-H03",
  split: "heldout",
  phenomenon: "Omission: no exclusions at all; duty to purge backups",
  intake: { clientLegalName: "Hexham Vale Coldchain, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h03-nda.docx",
      kind: "nda",
      title: "Information Protection Agreement",
      statedDate: "2026-11-04",
      paragraphs: [
        title("INFORMATION PROTECTION AGREEMENT"),
        text(
          'This Information Protection Agreement (the "Agreement") is dated 4 November 2026 and is made between Hexham Vale Coldchain, Inc., a Pennsylvania corporation ("Hexham"), and Mossbank Packaging Limited, a private limited company incorporated in England and Wales ("Mossbank"). Hexham and Mossbank are each a "Party".',
        ),
        text(
          'Hexham operates refrigerated distribution centres and Mossbank makes insulated shipping containers. The Parties wish to discuss a supply arrangement for temperature-controlled parcels (the "Discussions") and each expects to give the other commercial and technical information for the Discussions.',
        ),
        ...numbered([
          [
            "What This Agreement Protects",
            [
              'A Party that makes information available under this Agreement is the "Provider" of that information, and the Party that obtains it is the "Recipient" of that information.',
              '"Confidential Information" means information, in any form, that the Provider makes available to the Recipient for the Discussions and that either the Provider identifies as confidential when it does so, or a reasonable person in the Recipient\'s position would regard as confidential in view of its nature or the manner of its disclosure.',
              '"Affiliates" means, for a Party, the entities that hold more than half of its voting rights, the entities in which it holds more than half of the voting rights, and the entities in which a holder of more than half of its voting rights also holds more than half of the voting rights.',
            ],
          ],
          [
            "The Recipient's Duties",
            [
              "The Recipient may use Confidential Information for the Discussions and for no other purpose, and shall hold it in confidence.",
              "The Recipient shall treat Confidential Information with no less care than it gives to comparable information of its own, and never with less than reasonable care.",
              "The Recipient shall not make copies of Confidential Information beyond what the Discussions reasonably require.",
              "If the Recipient learns that Confidential Information has been used or disclosed contrary to this Agreement, it shall promptly tell the Provider.",
            ],
          ],
          [
            "Legal Compulsion",
            [
              "If the Recipient is compelled by statute, by regulation or by a court or other public body to disclose any Confidential Information, it may comply, but only to the extent of the compulsion. Where the law permits and it is reasonably practicable, the Recipient shall give the Provider prompt notice of the compulsion so that the Provider may apply for a protective order at the Provider's own expense.",
            ],
          ],
          [
            "Sharing Within the Recipient's Group",
            [
              "Employees, officers and contractors of the Recipient or of any of its Affiliates, and the professional advisers who act for any of them, may be given Confidential Information to the extent that they need it for the Discussions, on condition that each of them is first placed under a duty of confidence no weaker than the duties in this Agreement.",
              "Where a person receives Confidential Information from the Recipient under clause 4.1, the Recipient answers to the Provider for anything that person does which would have breached this Agreement had the Recipient done it.",
            ],
          ],
          [
            "Return and Destruction of Information",
            [
              "Within thirty (30) days after the Provider's written request, the Recipient shall give back or destroy all Confidential Information held by it or by any of its Affiliates, other than any copy that the law requires the Recipient to keep.",
              "The duty in clause 5.1 extends to backup media. By the same date the Recipient shall clear every copy of Confidential Information from the routine backup systems operated by it or its Affiliates, and may not wait for those systems to rotate or overwrite the copies in their ordinary cycle.",
              "On the Provider's request the Recipient shall confirm, in a document certified by an officer of the Recipient, that it has complied with clauses 5.1 and 5.2.",
            ],
          ],
          [
            "How Long the Obligations Last",
            [
              "Each obligation of the Recipient under this Agreement expires, as regards a given item of Confidential Information, once three (3) years have passed since the Provider disclosed that item. The exception is a trade secret, as to which the obligations continue for so long as it keeps its status as a trade secret in law.",
              "A Party that no longer wishes to continue the Discussions may say so in a written notice to the other Party. The notice does not change the period in clause 6.1.",
            ],
          ],
          [
            "Governing Law and Courts",
            [
              "The laws of England and Wales apply to this Agreement and to every claim, whether in contract or otherwise, that relates to it.",
              "Any proceedings relating to this Agreement must be started in the High Court of Justice of England and Wales, to whose exclusive jurisdiction each Party submits.",
            ],
          ],
          [
            "General",
            [
              "This document records everything the Parties have agreed about the protection of information for the Discussions. It can be varied only by a later document that both Parties have signed.",
              "Neither Party is obliged to proceed with a supply arrangement as a result of the Discussions.",
              "The Parties may execute this Agreement in any number of copies, which together make one agreement.",
            ],
          ],
        ]),
        signature("Hexham Vale Coldchain, Inc.", "Mossbank Packaging Limited"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at("D1", null, 'Hexham Vale Coldchain, Inc., a Pennsylvania corporation ("Hexham")'),
      ],
      relevant: [
        at(
          "D1",
          "1.1",
          'A Party that makes information available under this Agreement is the "Provider"',
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party can be the Provider or the Recipient",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "1.2",
          "either the Provider identifies as confidential when it does so, or a reasonable person in the Recipient's position would regard as confidential",
        ),
      ],
      basis:
        "def-1.standard: information identified as confidential, or that a reasonable person would regard as confidential",
    }),
    "exc-1": missing({
      basis:
        "exc-1.standard: the agreement states none of the four exclusions and has no clause that works like one",
      note: "The definition in clause 1.2 is not an exclusion, and no other clause carves out information that is public, already known, independently developed or received from a third party.",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "4.1",
          "Employees, officers and contractors of the Recipient or of any of its Affiliates, and the professional advisers who act for any of them",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by duties no weaker than the Agreement",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "3.1",
          "to disclose any Confidential Information, it may comply, but only to the extent of the compulsion",
        ),
      ],
      basis:
        "pds-2.standard: a dedicated section lets the recipient make a legally required disclosure, with prompt notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [
        at("D1", "6.1", "once three (3) years have passed since the Provider disclosed that item"),
      ],
      relevant: [at("D1", "6.2", "does not change the period in clause 6.1")],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, and a trade secret is protected for as long as it remains one",
    }),
    "ret-1": deviation({
      governing: [
        at(
          "D1",
          "5.2",
          "clear every copy of Confidential Information from the routine backup systems operated by it or its Affiliates",
        ),
      ],
      relevant: [at("D1", "5.1", "Within thirty (30) days after the Provider's written request")],
      basis: "ret-1.unacceptable: the Recipient must purge routine backups",
      note: "The thirty day deadline in clause 5.1, the copy kept because the law requires it and the officer's certificate in clause 5.3 are not deviations (the certificate is not one on its own, per the rule's guidance). Clause 5.2 requires the routine backup systems to be cleared by the same date and forbids waiting for their ordinary cycle, which is the duty to purge routine backups.",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "7.1", "The laws of England and Wales apply to this Agreement"),
        at(
          "D1",
          "7.2",
          "High Court of Justice of England and Wales, to whose exclusive jurisdiction each Party submits",
        ),
      ],
      basis:
        "gov-1.standard: the law and the exclusive forum of England and Wales are on the approved list",
    }),
  },
  warnings: [],
};
