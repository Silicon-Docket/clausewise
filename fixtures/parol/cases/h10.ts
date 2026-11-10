import {
  at,
  clause,
  compliant,
  deviation,
  heading,
  item,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H10: a duty to resist a legally required disclosure at the recipient's cost, and a seven
// day return deadline
//
// A mutual agreement typed in plain text, in nine groups of dotted clauses under headings that
// carry no number. The parties are called by role, the Releasing Party and the Receiving Party,
// and by short name. Two rules deviate. Clause 5 is a dedicated clause on demands made by law,
// but it makes the Receiving Party contest every demand by every lawful means at its own cost
// before it may disclose anything, which the playbook calls unacceptable. Clause 7.1 gives seven
// days to return or destroy, while clause 7.2 keeps the copies the law requires and routine
// backups and keeps them subject to the agreement, so the deadline is the only fault in the
// clause. The definition, the four exclusions, the group disclosure, the three year duration and
// the New York law and courts all meet the playbook, so a reader that flags more than two slots
// is wrong.
// ---------------------------------------------------------------------------------------------

export const H10: CaseDefinition = {
  case: "PAROL-H10",
  split: "heldout",
  phenomenon:
    "Duty to resist legally required disclosure at the recipient's cost; 7-day return deadline",
  intake: { clientLegalName: "Fallowmere Hydrology, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h10-nda.txt",
      kind: "nda",
      title: "Sensor Trial Confidentiality Agreement",
      statedDate: "2026-09-02",
      paragraphs: [
        title("SENSOR TRIAL CONFIDENTIALITY AGREEMENT"),
        text(
          'This Sensor Trial Confidentiality Agreement (the "Agreement") is entered into on 2 September 2026 by Fallowmere Hydrology, Inc., a Colorado corporation ("Fallowmere"), and Tarnwick Fell Instruments LLC, a Wisconsin limited liability company ("Tarnwick"), who are each called a "Party".',
        ),
        text(
          'Fallowmere builds groundwater flow models for municipal water boards, and Tarnwick makes borehole sensors. The Parties have begun talks about a field trial in which Tarnwick sensors would supply readings to Fallowmere\'s models (the "Trial"). Each will need to hand the other some of its non-public data for that purpose, on the terms below.',
        ),
        heading("WHO IS WHO"),
        clause(
          "1.1",
          'For each item of information, the Party handing it over is the "Releasing Party" and the Party taking it is the "Receiving Party". A Party can be the Releasing Party for some items and the Receiving Party for others, and the duties of a Receiving Party bind each Party in the same way.',
        ),
        clause(
          "1.2",
          '"Confidential Information" is any non-public information that a Releasing Party makes available to a Receiving Party for the Trial, in whatever form, and that is marked as confidential, is announced as confidential when handed over, or would be recognized as confidential by a reasonable person in the Receiving Party\'s place, judging by its nature or the manner in which it was handed over.',
        ),
        clause(
          "1.3",
          'An "Affiliate" of a Party is any entity under the control of that Party, in control of that Party, or under the control of an entity that controls that Party. An entity has control of another when it can direct, or procure the direction of, the management of the other.',
        ),
        clause(
          "1.4",
          "This Agreement does not oblige either Party to hand over any information at all, to carry out the Trial, or to enter into any later contract.",
        ),
        heading("WHAT IS NOT COVERED"),
        clause(
          "2.1",
          "This Agreement imposes no duty on a Receiving Party concerning information that:",
        ),
        item(
          "(i)",
          "is generally known to the public when it is made available, or becomes so later, other than because the Receiving Party broke this Agreement;",
        ),
        item(
          "(ii)",
          "the Receiving Party already knew before it was made available, and was not then bound by any duty of confidence about it;",
        ),
        item(
          "(iii)",
          "the Receiving Party creates on its own account, independently, with no use of the Releasing Party's Confidential Information; or",
        ),
        item(
          "(iv)",
          "a third party passes to the Receiving Party, being free to do so and owing the Releasing Party no obligation of confidence in respect of it.",
        ),
        heading("HANDLING RULES"),
        clause(
          "3.1",
          "A Receiving Party may put Confidential Information to no use other than the Trial.",
        ),
        clause(
          "3.2",
          "A Receiving Party shall not pass Confidential Information on to anyone, except as clause 4.1 or clause 5.4 allows.",
        ),
        clause(
          "3.3",
          "A Receiving Party shall look after Confidential Information as carefully as it looks after comparable information of its own, and always with at least reasonable care.",
        ),
        clause(
          "3.4",
          "A Receiving Party shall make only the copies the Trial reasonably needs, and shall promptly inform the Releasing Party on learning that anyone has used or revealed Confidential Information without authority.",
        ),
        heading("WHO MAY SEE THE INFORMATION"),
        clause(
          "4.1",
          "Confidential Information may go from a Receiving Party to any of its or its Affiliates' employees, officers or contractors, and to any lawyer, accountant or other professional adviser engaged by it or by an Affiliate, provided that the person needs it for the Trial and is bound by a duty of confidence at least as strict as this Agreement.",
        ),
        clause(
          "4.2",
          "A Receiving Party is answerable to the Releasing Party for what any person it has let see Confidential Information under clause 4.1 does with it.",
        ),
        heading("WHEN THE LAW DEMANDS DISCLOSURE"),
        clause(
          "5.1",
          'This clause applies whenever a Receiving Party is served with a subpoena, court order, regulatory demand or other legal process that calls for Confidential Information (a "Demand").',
        ),
        clause(
          "5.2",
          "The Receiving Party shall resist the Demand. At its own cost, and by every lawful means available to it, it shall contest the Demand before the court or authority concerned, including by applying to have the Demand set aside, narrowed or suspended and by appealing any ruling against it.",
        ),
        clause(
          "5.3",
          "The Receiving Party shall bear all costs of resisting the Demand, including the reasonable legal fees of the Releasing Party if the Releasing Party chooses to take part, and shall not claim any of those costs back from the Releasing Party.",
        ),
        clause(
          "5.4",
          "Subject to any legal bar on notice and to what is practicable, the Receiving Party shall give the Releasing Party written notice of the Demand within two (2) business days. If the court or authority maintains the Demand after the Receiving Party has resisted it as this clause requires, the Receiving Party may disclose only the part of the Confidential Information that the Demand covers.",
        ),
        heading("HOW LONG THE DUTIES RUN"),
        clause(
          "6.1",
          "The duties of a Receiving Party under this Agreement concerning an item of Confidential Information run for three (3) years from the day on which the Releasing Party first made that item available, and then end. If the item is a trade secret, they run for as long as it stays a trade secret under applicable law.",
        ),
        clause(
          "6.2",
          "Either Party may end the talks about the Trial by written notice. Doing so does not shorten the period in clause 6.1.",
        ),
        heading("GIVING BACK THE INFORMATION"),
        clause(
          "7.1",
          "The Receiving Party must return or destroy the Releasing Party's Confidential Information, whichever it chooses, no later than seven (7) days after the Releasing Party asks for that in writing.",
        ),
        clause(
          "7.2",
          "The Receiving Party need not give up or destroy a copy it must keep by law or one that sits in its routine backup systems. Either kind of copy stays subject to this Agreement.",
        ),
        heading("GOVERNING LAW AND FORUM"),
        clause(
          "8.1",
          "New York law applies to this Agreement and to any claim connected with it, and no rule of any other jurisdiction on the choice of law is to be applied.",
        ),
        clause(
          "8.2",
          "Any proceedings about this Agreement must be brought in the state or federal courts sitting in New York County, New York, and each Party agrees that those courts alone may hear them.",
        ),
        heading("MISCELLANEOUS"),
        clause(
          "9.1",
          "Title to Confidential Information does not move to the Receiving Party, and nothing in this Agreement licenses the Receiving Party under any patent, copyright or other right of the Releasing Party.",
        ),
        clause(
          "9.2",
          "The Releasing Party makes no promise that Confidential Information is accurate, complete or fit for any use.",
        ),
        clause(
          "9.3",
          "Each Party recognizes that money damages may not be enough to put the other Party right if this Agreement is broken, and that the other Party may therefore ask the courts named in clause 8.2 for an injunction.",
        ),
        clause(
          "9.4",
          "No Party may hand over its place in this Agreement to a successor or any other person without the written approval of the other Party.",
        ),
        clause(
          "9.5",
          "This Agreement replaces every earlier understanding between Fallowmere and Tarnwick on what it covers, and it can be changed only by a document that both Parties sign.",
        ),
        clause(
          "9.6",
          "This Agreement may be signed on separate pages or in separate copies, and all the signed copies together make one document.",
        ),
        signature("Fallowmere Hydrology, Inc.", "Tarnwick Fell Instruments LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Fallowmere Hydrology, Inc., a Colorado corporation")],
      relevant: [
        at(
          "D1",
          "1.1",
          "A Party can be the Releasing Party for some items and the Receiving Party for others",
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client exactly as given at intake, and the agreement says that each may release and each may receive",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "1.2",
          "is announced as confidential when handed over, or would be recognized as confidential by a reasonable person in the Receiving Party's place",
        ),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "2.1", "imposes no duty on a Receiving Party concerning information that"),
        at("D1", "2.1", "is generally known to the public when it is made available"),
        at(
          "D1",
          "2.1",
          "already knew before it was made available, and was not then bound by any duty of confidence",
        ),
        at("D1", "2.1", "creates on its own account, independently"),
        at("D1", "2.1", "a third party passes to the Receiving Party, being free to do so"),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "4.1",
          "lawyer, accountant or other professional adviser engaged by it or by an Affiliate",
        ),
      ],
      relevant: [at("D1", "4.2", "is answerable to the Releasing Party")],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by equal duties, with no consent needed",
    }),
    "pds-2": deviation({
      governing: [
        at(
          "D1",
          "5.2",
          "At its own cost, and by every lawful means available to it, it shall contest the Demand",
        ),
        at("D1", "5.3", "shall bear all costs of resisting the Demand"),
      ],
      relevant: [
        at("D1", "5.1", "legal process that calls for Confidential Information"),
        at(
          "D1",
          "5.4",
          "may disclose only the part of the Confidential Information that the Demand covers",
        ),
      ],
      basis: "pds-2.unacceptable: a duty to resist disclosure at the recipient's own cost",
      note: "Clause 5 is a dedicated clause on demands made by law, so the rule is not missing, and it lets the Receiving Party disclose in the end. But clause 5.2 makes it contest every Demand by every lawful means, appeals included, and clause 5.3 puts all the cost of doing so on it, with no recovery from the Releasing Party. That is the duty to resist at the recipient's own cost.",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "6.1",
          "run for three (3) years from the day on which the Releasing Party first made that item available",
        ),
      ],
      relevant: [at("D1", "7.2", "stays subject to this Agreement")],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, with trade secrets protected for as long as they remain trade secrets",
    }),
    "ret-1": deviation({
      governing: [
        at(
          "D1",
          "7.1",
          "no later than seven (7) days after the Releasing Party asks for that in writing",
        ),
      ],
      relevant: [at("D1", "7.2", "one that sits in its routine backup systems")],
      basis: "ret-1.unacceptable: a deadline of seven days is shorter than 30 days",
      note: "Clause 7.2 keeps copies required by law and routine backup copies and leaves them subject to the Agreement, so the seven day deadline is the only fault in the clause.",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "8.1", "New York law applies to this Agreement"),
        at("D1", "8.2", "state or federal courts sitting in New York County, New York"),
      ],
      basis:
        "gov-1.standard: New York law and an exclusive forum in New York are on the approved list",
    }),
  },
  warnings: [],
};
