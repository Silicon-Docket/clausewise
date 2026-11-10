import {
  at,
  clause,
  compliant,
  deviation,
  heading,
  item,
  missing,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H12: a long agreement with three separate faults and the carve-outs that are present
//
// A mutual agreement for a feasibility study between a Delaware corporation (the client) and a
// Pennsylvania company, in ten parts and thirty-one clauses. Three things are wrong, and each is
// in a different place. Clause 1.3 defines Restricted Material as all information and material of
// whatever nature, whether or not it has anything to do with the study and whether or not anyone
// has marked it or regarded it as confidential, which is the playbook's unacceptable definition.
// Clause 4.1 lists three exclusions (public, already held, received from a third party) and has no
// exclusion for independent development, and nothing elsewhere restores it. The agreement has no
// clause that lets the Receiving Party make a legally required disclosure; the general duty of
// care in Part 3 is not one. What is right is as much a part of the test: a term of three years
// with a trade secret carve-out, a fifty day return period that keeps law and backup copies, which
// stay subject to the agreement, an officer's statement of compliance that is not a deviation on
// its own, New York law with the Manhattan courts, and the permitted recipients. A reader that
// flags those is wrong.
// ---------------------------------------------------------------------------------------------

export const H12: CaseDefinition = {
  case: "PAROL-H12",
  split: "heldout",
  phenomenon:
    "Long, multi-issue: overbroad definition, independent-development exclusion absent, no compelled-disclosure clause; trade secret carve-out and backup carve-out present",
  intake: { clientLegalName: "Halvergate Instruments, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h12-nda.docx",
      kind: "nda",
      title: "Feasibility study NDA",
      statedDate: "2026-09-21",
      paragraphs: [
        title("FEASIBILITY STUDY CONFIDENTIALITY AGREEMENT"),
        text(
          'This Feasibility Study Confidentiality Agreement (the "Agreement") is made on 21 September 2026 between Halvergate Instruments, Inc., a Delaware corporation ("Halvergate"), and Ironbark Reclamation LLC, a Pennsylvania limited liability company ("Ironbark"). Halvergate and Ironbark are each a "Party" and together the "Parties".',
        ),
        text(
          "Ironbark recovers metals and polymer feedstock from industrial waste. Halvergate makes inline spectrometers and is considering a sorting module for Ironbark's recovery plants.",
        ),
        text(
          'The Parties will carry out a feasibility study of that module (the "Study"). Each expects to hand the other plant data, process know-how, drawings, software and commercial terms during it, and they have agreed how all of that is to be handled.',
        ),
        heading("PART 1. THE MATERIAL AND THE PARTIES"),
        clause(
          "1.1",
          '"Affiliate" of a Party means any entity that is under common ownership with it, owns it, or is owned by it, and one entity owns another if it holds more than half of the voting rights in that other, directly or through other entities.',
        ),
        clause(
          "1.2",
          'A Party that hands Restricted Material to the other is the "Imparting Party" for that material, and the Party that obtains it is the "Receiving Party". A Party can be the Imparting Party for some material and the Receiving Party for other material, so every duty of a Receiving Party applies to both Parties alike.',
        ),
        clause(
          "1.3",
          '"Restricted Material" means all information and material of whatever nature and in whatever form that the Imparting Party or any of its Affiliates discloses, hands over, shows or otherwise makes accessible to the Receiving Party or any of its Affiliates, whenever and however it does so, whether or not it has anything to do with the Study and whether or not anyone has marked it, labelled it, described it or regarded it as confidential, together with every copy, extract and summary of it.',
        ),
        heading("PART 2. THE STUDY"),
        clause(
          "2.1",
          "The Parties shall cooperate in good faith on the Study, and each shall provide the information and the staff time that it judges reasonably necessary for it.",
        ),
        clause(
          "2.2",
          "Nothing in this Agreement requires either Party to disclose any particular information, to carry on with the Study, or to sign a later contract.",
        ),
        heading("PART 3. USE AND SAFEKEEPING"),
        clause("3.1", "The Receiving Party may use Restricted Material only for the Study."),
        clause(
          "3.2",
          "The Receiving Party shall store and handle Restricted Material to at least the standard of protection it gives its own most valuable information of comparable sensitivity, and never below a reasonable standard.",
        ),
        clause(
          "3.3",
          "The Receiving Party shall notify the Imparting Party in writing, without undue delay, on discovering that Restricted Material has fallen into unauthorized hands or is being put to a use that this Agreement does not permit, and shall take reasonable steps to stop the misuse and to prevent a repeat.",
        ),
        clause(
          "3.4",
          "The Receiving Party shall not disassemble, decompile or reverse engineer any sample, prototype, device or software that it obtains as Restricted Material, except as the Study requires.",
        ),
        heading("PART 4. MATERIAL OUTSIDE THIS AGREEMENT"),
        clause(
          "4.1",
          "The duties of the Receiving Party under this Agreement do not extend to Restricted Material that:",
        ),
        item(
          "(a)",
          "is in the public domain when the Imparting Party releases it, or enters the public domain later without any fault of the Receiving Party;",
        ),
        item(
          "(b)",
          "was already lawfully in the Receiving Party's possession, and not subject to a duty of confidence, before the Imparting Party released it; or",
        ),
        item(
          "(c)",
          "is passed to the Receiving Party by a third party who has the right to pass it on and is under no duty of confidence to the Imparting Party.",
        ),
        heading("PART 5. PASSING MATERIAL ON"),
        clause(
          "5.1",
          "The Receiving Party may show Restricted Material to the officers, employees, secondees, contractors and subcontractors of the Receiving Party and of its Affiliates, and to the lawyers, accountants and other professional advisers of any of them, but only to the extent that each of those people needs it for the Study and is bound, by contract or by a professional duty, to keep it confidential on terms no less strict than this Agreement.",
        ),
        clause(
          "5.2",
          "If a person who has been shown Restricted Material under clause 5.1 does anything that would breach this Agreement if the Receiving Party had done it, the Receiving Party is liable to the Imparting Party for it.",
        ),
        heading("PART 6. DURATION"),
        clause(
          "6.1",
          "The Receiving Party's duties for any item of Restricted Material last for three (3) years from the day the item is first disclosed, handed over, shown or otherwise made accessible as described in clause 1.3. For an item that qualifies as a trade secret under the law that governs it, the duties last for as long as that status continues, if that is longer.",
        ),
        clause(
          "6.2",
          "Either Party may end the Study on thirty (30) days' written notice, but doing so leaves the periods in clause 6.1 untouched.",
        ),
        heading("PART 7. RETURN AND DESTRUCTION"),
        clause(
          "7.1",
          "Within fifty (50) days after the Imparting Party asks in writing, the Receiving Party shall return or destroy the Restricted Material in its hands, except that it may retain:",
        ),
        item("(a)", "any copy that a rule of law obliges it to keep; and"),
        item("(b)", "copies stored on its regular backup systems."),
        clause(
          "7.2",
          "Any copy retained under clause 7.1 stays subject to the terms of this Agreement.",
        ),
        clause(
          "7.3",
          "If the Imparting Party asks, an officer of the Receiving Party shall sign a short statement confirming that clause 7.1 has been followed.",
        ),
        heading("PART 8. REMEDIES AND OWNERSHIP"),
        clause(
          "8.1",
          "Either Party may apply to a court that has jurisdiction under clause 9.2 for an order restraining an actual or threatened breach of this Agreement, in addition to any other remedy that is open to it.",
        ),
        clause(
          "8.2",
          "Restricted Material is supplied as it stands. The Imparting Party makes no promise that it is accurate or complete, and neither Party is liable to the other for using Restricted Material in the way this Agreement allows.",
        ),
        clause(
          "8.3",
          "Ownership of Restricted Material stays with the Imparting Party, and the Receiving Party obtains no licence to do anything with it beyond what clause 3.1 permits.",
        ),
        heading("PART 9. GOVERNING LAW AND DISPUTES"),
        clause(
          "9.1",
          "New York law governs this Agreement and every claim connected with it, whether in contract, tort or otherwise.",
        ),
        clause(
          "9.2",
          "Each Party irrevocably submits to the exclusive jurisdiction of the state and federal courts having their seat in the Borough of Manhattan, New York, for every such claim.",
        ),
        clause(
          "9.3",
          "Before bringing a claim, except to seek urgent relief, a Party shall give the other written notice of the dispute, and senior executives of both Parties shall meet within twenty (20) days to try to settle it.",
        ),
        heading("PART 10. GENERAL"),
        clause(
          "10.1",
          "This Agreement is the Parties' complete agreement on how information exchanged for the Study is to be protected, and it supersedes earlier discussions on that subject.",
        ),
        clause(
          "10.2",
          "A change takes effect only once both Parties have signed a document that records it.",
        ),
        clause(
          "10.3",
          "A Party may assign its rights or delegate its duties under this Agreement only with the prior written consent of the other.",
        ),
        clause(
          "10.4",
          "Notices under this Agreement are to be given in writing and in English, and sent by courier or by email to the address that the addressee last notified for the purpose.",
        ),
        clause(
          "10.5",
          "Neither Party waives a right under this Agreement by failing or delaying to exercise it, and if a court finds one term unenforceable the other terms stay in force.",
        ),
        clause("10.6", "Only the Parties may enforce this Agreement."),
        clause(
          "10.7",
          "Neither Party shall announce the Study, or use the other's name or marks in publicity, without the other's prior written consent.",
        ),
        clause(
          "10.8",
          "Each Party may sign a separate copy of this Agreement, including an electronic copy, and the copies together make up one agreement.",
        ),
        signature("Halvergate Instruments, Inc.", "Ironbark Reclamation LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at(
          "D1",
          null,
          'Halvergate Instruments, Inc., a Delaware corporation ("Halvergate"), and Ironbark Reclamation LLC, a Pennsylvania limited liability company',
        ),
      ],
      relevant: [
        at(
          "D1",
          "1.2",
          "A Party can be the Imparting Party for some material and the Receiving Party for other material",
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party can be the Imparting Party or the Receiving Party",
    }),
    "def-1": deviation({
      governing: [
        at(
          "D1",
          "1.3",
          "all information and material of whatever nature and in whatever form that the Imparting Party or any of its Affiliates discloses, hands over, shows or otherwise makes accessible to the Receiving Party or any of its Affiliates, whenever and however it does so, whether or not it has anything to do with the Study and whether or not anyone has marked it, labelled it, described it or regarded it as confidential",
        ),
      ],
      basis:
        "def-1.unacceptable: all information and material of whatever nature, in any form, whether or not marked or identified as confidential",
      note: "Clause 1.3 has no requirement that the material be non-public, marked, identified or understood to be confidential, and it does not even require that it relate to the Study. It is not the fallback, which is limited to non-public information disclosed for the purpose of the agreement.",
    }),
    "exc-1": deviation({
      governing: [
        at(
          "D1",
          "4.1",
          "The duties of the Receiving Party under this Agreement do not extend to Restricted Material that",
        ),
        at("D1", "4.1", "enters the public domain later without any fault of the Receiving Party"),
        at(
          "D1",
          "4.1",
          "not subject to a duty of confidence, before the Imparting Party released it",
        ),
        at("D1", "4.1", "is under no duty of confidence to the Imparting Party"),
      ],
      basis:
        "exc-1.unacceptable: the exclusion for information the recipient develops independently without using the discloser's information is missing",
      note: "Clause 4.1 lists three exclusions, for public material, material already held and material received from a third party. There is no exclusion for independent development, and no other clause restores it.",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "5.1",
          "The Receiving Party may show Restricted Material to the officers, employees, secondees, contractors and subcontractors of the Receiving Party and of its Affiliates, and to the lawyers, accountants and other professional advisers of any of them, but only to the extent that each of those people needs it for the Study and is bound, by contract or by a professional duty, to keep it confidential on terms no less strict than this Agreement",
        ),
      ],
      relevant: [at("D1", "5.2", "the Receiving Party is liable to the Imparting Party for it")],
      basis:
        "pds-1.standard: officers, employees, contractors and professional advisers of the recipient and its affiliates who need to know it and are bound by duties no less protective",
    }),
    "pds-2": missing({
      basis:
        "pds-2.standard: a dedicated clause is needed and the agreement has none; the general duty of care in Part 3 is not one",
      note: "No clause lets the Receiving Party disclose what law, regulation or a court order requires. Part 3 holds a general duty of care, which the rule's guidance says is not such a clause, and the only mention of the law in Part 7 concerns copies the Receiving Party must keep.",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "6.1",
          "last for three (3) years from the day the item is first disclosed, handed over, shown or otherwise made accessible as described in clause 1.3. For an item that qualifies as a trade secret under the law that governs it, the duties last for as long as that status continues",
        ),
      ],
      relevant: [
        at("D1", "6.2", "leaves the periods in clause 6.1 untouched"),
        at("D1", "7.2", "stays subject to the terms of this Agreement"),
      ],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, and only trade secrets are protected for as long as they remain trade secrets",
    }),
    "ret-1": compliant({
      governing: [
        at("D1", "7.1", "Within fifty (50) days after the Imparting Party asks in writing"),
        at("D1", "7.1", "any copy that a rule of law obliges it to keep"),
        at("D1", "7.1", "copies stored on its regular backup systems"),
      ],
      relevant: [
        at("D1", "7.2", "stays subject to the terms of this Agreement"),
        at("D1", "7.3", "an officer of the Receiving Party shall sign a short statement"),
      ],
      basis:
        "ret-1.standard: fifty days, longer than 30, with law and routine backup copies kept and still confidential",
      note: "Clause 7.3 asks for an officer's statement of compliance, which the rule's guidance says is not a deviation on its own.",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "9.1", "New York law governs this Agreement"),
        at(
          "D1",
          "9.2",
          "exclusive jurisdiction of the state and federal courts having their seat in the Borough of Manhattan",
        ),
      ],
      basis:
        "gov-1.standard: New York law and an exclusive forum in New York are on the approved list",
    }),
  },
  warnings: [],
};
