import { at, clause, compliant, heading, item, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H01: clean control in a different structure
//
// A one-way agreement in nine articles, typed "ARTICLE n" with clauses numbered under them and
// lettered sub-clauses carrying the lists: the definition, the four exclusions, the persons who
// may receive information, the two duration periods, the return exceptions and the compelled
// disclosure conditions. The parties are called by their short names, not by role words. Every
// standard of the playbook is met, so a reader that flags a rule because the layout is unfamiliar
// is wrong on every slot.
// ---------------------------------------------------------------------------------------------

export const H01: CaseDefinition = {
  case: "PAROL-H01",
  split: "heldout",
  phenomenon: "Clean control in a different structure: articles and lettered sub-clauses",
  intake: { clientLegalName: "Aldermoor Fieldworks, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h01-nda.docx",
      kind: "nda",
      title: "One-Way Confidentiality Agreement",
      statedDate: "2026-07-16",
      paragraphs: [
        title("ONE-WAY CONFIDENTIALITY AGREEMENT"),
        text(
          'This One-Way Confidentiality Agreement (the "Agreement") is entered into on 16 July 2026 between Sablewood Textile Machinery LLC, a Georgia limited liability company ("Sablewood"), which will disclose information under it, and Aldermoor Fieldworks, Inc., a Minnesota corporation ("Aldermoor"), which will receive that information.',
        ),
        text(
          'Sablewood builds loom control modules. Aldermoor is considering whether to offer installation and repair services for those modules across the upper Midwest (the "Purpose"), and Sablewood is willing to give Aldermoor technical information for the Purpose on the terms set out below.',
        ),
        heading("ARTICLE 1. DEFINITIONS"),
        clause(
          "1.1",
          '"Affiliate" means, for a person, any other person that controls it, is controlled by it, or is controlled by the same person as it is, and one person controls another if it can determine how the other conducts its affairs, whether by holding a majority of the votes, by agreement or in some other way.',
        ),
        clause(
          "1.2",
          '"Confidential Information" means information, in any form or medium, that Sablewood makes available to Aldermoor for the Purpose, whether before or after the date of this Agreement, and that:',
        ),
        item(
          "(a)",
          "is labelled as confidential, or is described as confidential in speech or in writing, at or before the time it is disclosed; or",
        ),
        item(
          "(b)",
          "would strike a reasonable person in Aldermoor's position as confidential, judging by its content and the setting in which Sablewood discloses it.",
        ),
        clause(
          "1.3",
          '"Trade Secret" means any Confidential Information that is a trade secret under applicable law.',
        ),
        heading("ARTICLE 2. UNDERTAKINGS OF ALDERMOOR"),
        clause(
          "2.1",
          "Aldermoor may use Confidential Information for the Purpose and for no other purpose.",
        ),
        clause(
          "2.2",
          "Aldermoor shall safeguard Confidential Information with no less care than it gives to comparable material of its own, and never with less than a reasonable degree of care.",
        ),
        clause(
          "2.3",
          "If Aldermoor learns that Confidential Information has been used or disclosed contrary to this Agreement, it shall promptly inform Sablewood.",
        ),
        clause(
          "2.4",
          "Confidential Information remains the property of Sablewood, and this Agreement gives Aldermoor no licence or other right in it beyond the use permitted by clause 2.1.",
        ),
        heading("ARTICLE 3. INFORMATION OUTSIDE THIS AGREEMENT"),
        clause(
          "3.1",
          "Aldermoor owes nothing under this Agreement in relation to any information that:",
        ),
        item(
          "(a)",
          "is in the public domain when Sablewood makes it available, or enters the public domain afterwards otherwise than because Aldermoor has broken this Agreement;",
        ),
        item(
          "(b)",
          "Aldermoor already held, free of any obligation of confidence, before Sablewood made it available;",
        ),
        item(
          "(c)",
          "Aldermoor creates through its own work, independently and without use of Confidential Information; or",
        ),
        item(
          "(d)",
          "reaches Aldermoor from a third party who is free to pass it on and owes Sablewood no obligation of confidence in respect of it.",
        ),
        heading("ARTICLE 4. PERMITTED DISCLOSURES"),
        clause(
          "4.1",
          "Aldermoor may give Confidential Information to the persons listed below, if and to the extent that each of them has a genuine need for it in connection with the Purpose and is under a duty of confidentiality, arising by contract or from a professional obligation, that is no less protective than the duties in this Agreement:",
        ),
        item("(a)", "the directors, officers and employees of Aldermoor and of its Affiliates;"),
        item("(b)", "contractors and consultants engaged by Aldermoor or its Affiliates; and"),
        item(
          "(c)",
          "the lawyers, accountants and other professional advisers of Aldermoor and of its Affiliates.",
        ),
        clause(
          "4.2",
          "Aldermoor answers to Sablewood for any act or omission of a person to whom it has given Confidential Information under clause 4.1 that would have been a breach of this Agreement had Aldermoor itself committed it.",
        ),
        heading("ARTICLE 5. DISCLOSURE REQUIRED BY LAW"),
        clause(
          "5.1",
          "Aldermoor may disclose Confidential Information if a statute, a regulation, a court order or a binding direction of a government authority compels it to do so, provided that, to the extent the law permits and it is reasonably practicable to do so, Aldermoor:",
        ),
        item(
          "(a)",
          "promptly notifies Sablewood of the requirement, so that Sablewood may apply for a protective order or other relief at Sablewood's expense; and",
        ),
        item("(b)", "discloses no more than the requirement compels."),
        clause(
          "5.2",
          "Information disclosed under clause 5.1 remains Confidential Information for every other purpose.",
        ),
        heading("ARTICLE 6. DURATION"),
        clause("6.1", "How long Aldermoor's obligations last depends on the kind of information:"),
        item(
          "(a)",
          "for each item of information that is not a Trade Secret, they last for three (3) years after the date on which Sablewood first made that item available to Aldermoor; and",
        ),
        item(
          "(b)",
          "for a Trade Secret, they last until the information ceases to be a Trade Secret.",
        ),
        clause(
          "6.2",
          "Sablewood or Aldermoor may bring the exchange of information to a close by giving the other a written notice. Doing so leaves the periods in clause 6.1 unchanged.",
        ),
        heading("ARTICLE 7. RETURN OR DESTRUCTION"),
        clause(
          "7.1",
          "Aldermoor shall, within thirty (30) days after a written request from Sablewood, return or destroy the Confidential Information that it holds, except that it may keep:",
        ),
        item("(a)", "a copy that the law requires it to keep; and"),
        item("(b)", "copies held in its routine electronic backup systems."),
        clause("7.2", "A copy kept under clause 7.1 remains subject to this Agreement."),
        heading("ARTICLE 8. LAW AND COURTS"),
        clause(
          "8.1",
          "Delaware law governs this Agreement, and Delaware's rules on conflicts of laws do not apply to it.",
        ),
        clause(
          "8.2",
          "Any proceeding between Sablewood and Aldermoor arising from this Agreement shall be brought exclusively in the Delaware state courts or in a federal court located in Delaware, and each of them consents to the jurisdiction of those courts.",
        ),
        heading("ARTICLE 9. GENERAL"),
        clause(
          "9.1",
          "This Agreement contains everything that Sablewood and Aldermoor have agreed about the protection of information for the Purpose, and it can be amended only in a document signed by both of them.",
        ),
        clause(
          "9.2",
          "Neither Sablewood nor Aldermoor is obliged to enter into any further agreement as a result of their discussions about the Purpose.",
        ),
        clause(
          "9.3",
          "Sablewood and Aldermoor may sign on separate counterparts, including electronic ones, and the counterparts together make up one agreement.",
        ),
        signature("Sablewood Textile Machinery LLC", "Aldermoor Fieldworks, Inc."),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at(
          "D1",
          null,
          'Aldermoor Fieldworks, Inc., a Minnesota corporation ("Aldermoor"), which will receive that information',
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and the agreement says that Sablewood discloses and Aldermoor receives",
    }),
    "def-1": compliant({
      governing: [
        at(
          "D1",
          "1.2",
          "is labelled as confidential, or is described as confidential in speech or in writing",
        ),
        at("D1", "1.2", "would strike a reasonable person in Aldermoor's position as confidential"),
      ],
      basis:
        "def-1.standard: information marked or identified as confidential, or that a reasonable person would understand to be confidential",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "3.1", "owes nothing under this Agreement in relation to any information that"),
        at("D1", "3.1", "otherwise than because Aldermoor has broken this Agreement"),
        at("D1", "3.1", "free of any obligation of confidence, before Sablewood made it available"),
        at("D1", "3.1", "independently and without use of Confidential Information"),
        at("D1", "3.1", "owes Sablewood no obligation of confidence in respect of it"),
      ],
      basis:
        "exc-1.standard: all four exclusions are present, as items (a) to (d), and none needs written records",
      note: "Clause 3.1 lists information that is or becomes public through no breach by Aldermoor (a), already held without a duty of confidence (b), created independently without use of Confidential Information (c) and received from a third party under no obligation of confidence (d).",
    }),
    "pds-1": compliant({
      governing: [
        at("D1", "4.1", "has a genuine need for it in connection with the Purpose"),
        at("D1", "4.1", "the directors, officers and employees of Aldermoor and of its Affiliates"),
        at("D1", "4.1", "contractors and consultants engaged by Aldermoor or its Affiliates"),
        at(
          "D1",
          "4.1",
          "the lawyers, accountants and other professional advisers of Aldermoor and of its Affiliates",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and professional advisers of the recipient and its affiliates who need to know and are bound by duties no less protective",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "5.1",
          "a statute, a regulation, a court order or a binding direction of a government authority compels it to do so",
        ),
        at("D1", "5.1", "promptly notifies Sablewood of the requirement"),
      ],
      basis:
        "pds-2.standard: a dedicated article lets Aldermoor make a legally required disclosure, with prompt notice where permitted and practicable",
    }),
    "dur-1": compliant({
      governing: [
        at(
          "D1",
          "6.1",
          "they last for three (3) years after the date on which Sablewood first made that item available",
        ),
        at("D1", "6.1", "they last until the information ceases to be a Trade Secret"),
      ],
      relevant: [
        at("D1", "1.3", "is a trade secret under applicable law"),
        at("D1", "6.2", "leaves the periods in clause 6.1 unchanged"),
      ],
      basis:
        "dur-1.standard: obligations end three years after each disclosure, and only trade secrets are protected for as long as they remain trade secrets",
    }),
    "ret-1": compliant({
      governing: [
        at("D1", "7.1", "within thirty (30) days after a written request from Sablewood"),
        at("D1", "7.1", "a copy that the law requires it to keep"),
        at("D1", "7.1", "copies held in its routine electronic backup systems"),
      ],
      relevant: [at("D1", "7.2", "remains subject to this Agreement")],
      basis:
        "ret-1.standard: thirty days, with law and routine backup copies kept and still confidential",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "8.1", "Delaware law governs this Agreement"),
        at(
          "D1",
          "8.2",
          "brought exclusively in the Delaware state courts or in a federal court located in Delaware",
        ),
      ],
      basis:
        "gov-1.standard: Delaware law and an exclusive Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
