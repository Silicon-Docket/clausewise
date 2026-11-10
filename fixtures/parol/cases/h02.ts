import { at, clause, compliant, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H02: paraphrase, the false alarm test
//
// A mutual agreement in plain prose, numbered 1 to 22 with no section headings. The four
// exclusions are not a list: they are four consecutive clauses of prose, the last three opening
// "The Receiver likewise has no duty", "Nor does the Receiver have any duty" and "Equally, the
// Receiver has no duty", each saying in full what it covers. The duration ends "on the third
// anniversary of the relevant disclosure", the return period is forty-five days, and the roles
// are called the Sender and the Receiver. Every standard is met, so a reader that flags a rule
// because the usual words are absent is wrong.
// ---------------------------------------------------------------------------------------------

export const H02: CaseDefinition = {
  case: "PAROL-H02",
  split: "heldout",
  phenomenon:
    'Paraphrase: narrative exclusions; term "ending on the third anniversary of the relevant disclosure"',
  intake: { clientLegalName: "Ravenhill Seed Genetics, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h02-nda.docx",
      kind: "nda",
      title: "Agreement to Keep Shared Information Confidential",
      statedDate: "2026-09-28",
      paragraphs: [
        title("AGREEMENT TO KEEP SHARED INFORMATION CONFIDENTIAL"),
        text(
          'This agreement (the "Agreement") is made on 28 September 2026 between Ravenhill Seed Genetics, Inc., an Iowa corporation ("Ravenhill"), and Foxglove Fen Greenhouses LLC, a Michigan limited liability company ("Foxglove"), which are each referred to as a "Party" and together as the "Parties".',
        ),
        text(
          'Ravenhill breeds tomato varieties for protected cultivation and Foxglove grows tomatoes under glass. The Parties intend to run a joint growing trial (the "Trial") and expect to tell each other things about their varieties, growing methods and results that neither of them wishes to see made public.',
        ),
        clause(
          "1",
          '"Affiliate" of a Party means any company or other body that controls that Party, is controlled by it, or is controlled by the same person that controls it, and for this purpose control means the power to direct how the body is run, whether through shares, voting rights, a contract or in any other way.',
        ),
        clause(
          "2",
          'Information is "Confidential Information" if one Party (the "Sender") gives it to the other Party (the "Receiver") in connection with the Trial, in any form, and either the Sender says that it is confidential, in writing or aloud, at the time it gives it, or a sensible person in the Receiver\'s position would recognise it as confidential from what it is and the way it was given.',
        ),
        clause(
          "3",
          "The Receiver must use Confidential Information only for the Trial and must keep it secret. It must look after Confidential Information at least as carefully as it looks after comparable information of its own and, whatever its own habits may be, with reasonable care.",
        ),
        clause(
          "4",
          "If the Receiver finds out that anyone has obtained, used or disclosed Confidential Information contrary to this Agreement, it must tell the Sender straight away.",
        ),
        clause(
          "5",
          "Giving information to the other Party does not transfer ownership of it, and neither Party acquires a licence or any other right in the other Party's Confidential Information other than a right to use it for the purposes of the Trial.",
        ),
        clause(
          "6",
          "Under this Agreement the Receiver has no duty concerning information that is, or later becomes, generally known to the public, unless this happens because the Receiver has broken this Agreement.",
        ),
        clause(
          "7",
          "The Receiver likewise has no duty concerning information that it already had, free of any duty of confidence, before the Sender gave it.",
        ),
        clause(
          "8",
          "Nor does the Receiver have any duty concerning information that it has developed independently, through its own people and without relying on anything the Sender gave it.",
        ),
        clause(
          "9",
          "Equally, the Receiver has no duty concerning information that reaches it from a third party who was free to pass it on and owed the Sender no duty of confidence.",
        ),
        clause(
          "10",
          "The Receiver may pass Confidential Information to the employees, officers, directors, contractors, lawyers, accountants and other professional advisers of itself and of its Affiliates, but only to those who have a genuine need to know it for the Trial and who are themselves bound by duties of confidence at least as strict as the duties in this Agreement.",
        ),
        clause(
          "11",
          "The Receiver must make sure that each of those people honours those duties, and it answers to the Sender if one of them does not.",
        ),
        clause(
          "12",
          "If the Receiver is compelled by law, by regulation, by a court or by a public authority to disclose Confidential Information, it may do so, but only to the extent of the compulsion.",
        ),
        clause(
          "13",
          "Where the law allows it and it is reasonably practicable, the Receiver must give the Sender prompt notice of the compulsion, so that the Sender can try, at its own expense, to obtain a protective order or other relief.",
        ),
        clause(
          "14",
          "For any given item of Confidential Information, every duty of the Receiver under this Agreement comes to an end on the third anniversary of the relevant disclosure, meaning the occasion on which the Sender first gave that item to the Receiver.",
        ),
        clause(
          "15",
          "Either Party may bring the Trial to an end by written notice to the other. The notice does not alter the time at which the duties in respect of any item given earlier come to an end.",
        ),
        clause(
          "16",
          "If the Sender asks in writing, the Receiver must within forty-five (45) days after the request either return the Confidential Information it holds or destroy it, as the Receiver chooses.",
        ),
        clause(
          "17",
          "The Receiver need not give up or destroy a copy that the law obliges it to keep, or a copy held in one of its routine backup systems, and each copy kept in either way stays subject to this Agreement.",
        ),
        clause(
          "18",
          "The law of the State of New York governs this Agreement and every dispute or claim that arises out of it or in connection with it.",
        ),
        clause(
          "19",
          "Each Party agrees that any lawsuit about this Agreement may be brought only in the state or federal courts sitting in New York County, New York, and submits to the exclusive jurisdiction of those courts.",
        ),
        clause(
          "20",
          "The Parties have set out here everything they have agreed about the protection of information exchanged for the Trial, and a change is effective only if both of them sign it.",
        ),
        clause(
          "21",
          "Neither Party may announce the Trial, or the existence of this Agreement, without the written consent of the other.",
        ),
        clause(
          "22",
          "This Agreement may be signed in two or more copies, and the signed copies together are one agreement.",
        ),
        signature("Ravenhill Seed Genetics, Inc.", "Foxglove Fen Greenhouses LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at("D1", null, 'Ravenhill Seed Genetics, Inc., an Iowa corporation ("Ravenhill")'),
      ],
      relevant: [
        at("D1", "2", 'one Party (the "Sender") gives it to the other Party (the "Receiver")'),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party can be the Sender or the Receiver",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "2",
          "either the Sender says that it is confidential, in writing or aloud, at the time it gives it, or a sensible person in the Receiver's position would recognise it as confidential",
        ),
      ],
      basis:
        "def-1.standard: information identified as confidential when given, or that a reasonable (sensible) person would recognise as confidential",
    }),
    "exc-1": compliant({
      governing: [
        at(
          "D1",
          "6",
          "is, or later becomes, generally known to the public, unless this happens because the Receiver has broken this Agreement",
        ),
        at("D1", "7", "already had, free of any duty of confidence, before the Sender gave it"),
        at(
          "D1",
          "8",
          "developed independently, through its own people and without relying on anything the Sender gave it",
        ),
        at(
          "D1",
          "9",
          "from a third party who was free to pass it on and owed the Sender no duty of confidence",
        ),
      ],
      basis:
        "exc-1.standard: all four exclusions are present, in four consecutive clauses of prose, and none needs written records",
      note: "Clause 6 states that the Receiver has no duty for information that is or becomes public through no breach by it; clauses 7, 8 and 9 each state that the Receiver has no duty for information it already had, developed independently and received from a third party under no duty of confidence.",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "10",
          "lawyers, accountants and other professional advisers of itself and of its Affiliates, but only to those who have a genuine need to know it for the Trial",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by duties no less strict",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "12",
          "to disclose Confidential Information, it may do so, but only to the extent of the compulsion",
        ),
        at("D1", "13", "must give the Sender prompt notice of the compulsion"),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the recipient make a legally required disclosure, with prompt notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [
        at("D1", "14", "comes to an end on the third anniversary of the relevant disclosure"),
      ],
      relevant: [
        at(
          "D1",
          "15",
          "does not alter the time at which the duties in respect of any item given earlier come to an end",
        ),
      ],
      basis:
        "dur-1.standard: duties end on the third anniversary of each disclosure, which is three years",
      note: "The third anniversary is counted from the first giving of each item, and ending the Trial early leaves that date unchanged.",
    }),
    "ret-1": compliant({
      governing: [
        at("D1", "16", "within forty-five (45) days after the request"),
        at("D1", "17", "a copy held in one of its routine backup systems"),
      ],
      basis:
        "ret-1.standard: forty-five days, a longer period than 30, with law and routine backup copies kept and still subject to the Agreement",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "18", "The law of the State of New York governs this Agreement"),
        at("D1", "19", "state or federal courts sitting in New York County, New York"),
      ],
      basis:
        "gov-1.standard: New York law and an exclusive New York forum are on the approved list",
    }),
  },
  warnings: [],
};
