import {
  at,
  clause,
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
// PAROL-H04: an amendment that replaces the term, and consent for advisers
//
// A mutual agreement in nine sections whose parties are the Originator and the Holder of each
// item of information. Everything in it meets the playbook except one clause: the Holder may give
// information to its own and its Affiliates' directors, officers, employees and contractors, but
// a lawyer, accountant or other professional adviser only after the Originator has approved that
// disclosure in writing, which the Originator may refuse for any reason. The agreement's own term
// is three years from the first giving of each item, and the agreement terminates on a fixed date
// at the latest. A text amendment dated after the agreement, with a signature block for each Party,
// deletes Section 6.1 and replaces it with a period that runs for ten years after the agreement
// terminates, which is finite (the termination date is fixed) but longer than the playbook's five
// years, so the answer is a deviation that an attorney must look at. The amendment governs; the
// three year clause is superseded and is the wrong place to look.
// ---------------------------------------------------------------------------------------------

export const H04: CaseDefinition = {
  case: "PAROL-H04",
  split: "heldout",
  phenomenon:
    'Amendment expressly replaces the term with "ten (10) years after termination"; consent needed for advisers',
  intake: { clientLegalName: "Brindlemoor Sensors, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h04-nda.docx",
      kind: "nda",
      title: "Information Exchange Agreement",
      statedDate: "2026-03-17",
      paragraphs: [
        title("INFORMATION EXCHANGE AGREEMENT"),
        text(
          'This Information Exchange Agreement (the "Agreement") is made on 17 March 2026 between Brindlemoor Sensors, Inc., a Washington corporation ("Brindlemoor"), and Quillon Strand Marine LLC, a Maine limited liability company ("Quillon") (each a "Party" and together the "Parties").',
        ),
        text(
          'Quillon runs passenger ferries along the Maine coast and Brindlemoor builds hull and engine monitoring sensors. The Parties are talking about a trial fitting of Brindlemoor sensors on two Quillon vessels (the "Trial"), and each of them expects to hand the other technical and operating information for it.',
        ),
        ...numbered([
          [
            "Meaning of Words",
            [
              '"Affiliate" of a Party means any entity that controls that Party, is controlled by it, or is controlled by the same entity as it is, and an entity controls another if it holds a majority of the votes in it or can otherwise direct how it is managed.',
              'A Party that gives information to the other under this Agreement is the "Originator" of that information, and the Party that obtains it is its "Holder".',
              '"Confidential Information" means non-public information, in any form, that the Originator gives to the Holder for the Trial and that the Originator marks or describes as confidential when it gives it, or that a reasonable person would treat as confidential because of what it is or how it was given.',
            ],
          ],
          [
            "Information the Agreement Leaves Alone",
            [
              "The Holder owes no duty under this Agreement in respect of information that (a) is public when the Originator gives it, or becomes public later without the Holder having broken this Agreement; (b) was already held by the Holder, with no duty of confidence, before the Originator gave it; (c) is developed by the Holder independently of, and without drawing on, Confidential Information; or (d) comes to the Holder from a third party that owes the Originator no duty of confidence.",
            ],
          ],
          [
            "Duties of the Holder",
            [
              "The Holder shall use Confidential Information only for the Trial.",
              "The Holder shall apply to Confidential Information the safeguards it applies to its own equally sensitive information and, if those safeguards would fall short of reasonable care, shall apply reasonable care instead.",
              "The Holder shall tell the Originator without delay on learning that Confidential Information has been lost, or has been used or disclosed in a way that this Agreement does not allow.",
            ],
          ],
          [
            "Who May Receive It",
            [
              "The Holder may give Confidential Information to the directors, officers, employees and contractors of the Holder and of its Affiliates who need it for the Trial and who are bound by a duty of confidence at least as protective as the duties in this Agreement.",
              "The Holder may give Confidential Information to a lawyer, accountant or other professional adviser of the Holder or of an Affiliate only after the Originator has approved that disclosure in writing. The Originator may refuse its approval, or attach conditions to it, for any reason or for none.",
              "The Holder answers to the Originator for anything done by a person who receives Confidential Information from the Holder that would have broken this Agreement if the Holder had done it.",
            ],
          ],
          [
            "Disclosure Required by Law",
            [
              "If a law, a regulation or an order of a court or public authority requires the Holder to disclose Confidential Information, the Holder may do so to the extent of the requirement. Where the law permits and it is reasonably practicable, the Holder shall first give the Originator prompt notice, so that the Originator can seek a protective order at the Originator's own expense.",
            ],
          ],
          [
            "Duration",
            [
              "The Holder's obligations under this Agreement in respect of an item of Confidential Information continue for three (3) years from the date on which the Originator first gives that item to the Holder.",
              "This Agreement terminates on 31 December 2027 unless it is ended sooner. Either Party may end the exchange of information earlier by giving the other fifteen (15) days' written notice, and this Agreement then terminates when that notice expires.",
              "A notice under Section 6.2 does not release the Holder from any obligation that continues under Section 6.1.",
            ],
          ],
          [
            "Return of Information",
            [
              "Not later than forty (40) days after a written request from the Originator, the Holder shall return or destroy the Confidential Information it holds. The Holder may keep a copy that the law requires it to keep and copies held in its routine backup systems, and a copy kept in either way stays subject to this Agreement.",
            ],
          ],
          [
            "Governing Law and Courts",
            [
              "This Agreement, and any claim arising out of it, is governed by the law of the State of Delaware.",
              "Each Party agrees that every action about this Agreement shall be brought only in the Superior Court of the State of Delaware or in the United States District Court for the District of Delaware, and submits to the exclusive jurisdiction of those courts.",
            ],
          ],
          [
            "General",
            [
              "Sections 1 to 5, Section 7 and Section 8 continue to apply after this Agreement terminates, for the period stated in Section 6.1.",
              "This Agreement is the whole agreement of the Parties about information given for the Trial, and a change to it takes effect only if both Parties sign it.",
              "Separate counterparts, whether on paper or electronic, may be signed, and the counterparts are read together as a single agreement.",
            ],
          ],
        ]),
        signature("Brindlemoor Sensors, Inc.", "Quillon Strand Marine LLC"),
      ],
    },
    {
      label: "D2",
      file: "parol-h04-amendment-1.txt",
      kind: "amendment",
      title: "First Amendment",
      statedDate: "2026-09-08",
      paragraphs: [
        title("FIRST AMENDMENT TO INFORMATION EXCHANGE AGREEMENT"),
        text(
          'This First Amendment (the "Amendment") is made on 8 September 2026 between Brindlemoor Sensors, Inc. and Quillon Strand Marine LLC. It amends the Information Exchange Agreement between them dated 17 March 2026 (the "Agreement").',
        ),
        clause(
          "1",
          "Words and expressions defined in the Agreement have the same meanings in this Amendment.",
        ),
        clause(
          "2",
          'Section 6.1 of the Agreement is deleted and replaced with the following: "The Holder\'s obligations under this Agreement in respect of Confidential Information continue until ten (10) years after the date on which this Agreement terminates."',
        ),
        clause(
          "3",
          'Section 6.2 of the Agreement is amended by replacing "fifteen (15) days" with "thirty (30) days".',
        ),
        clause("4", "Every other term of the Agreement is unchanged and continues to apply."),
        signature("Brindlemoor Sensors, Inc.", "Quillon Strand Marine LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at("D1", null, 'Brindlemoor Sensors, Inc., a Washington corporation ("Brindlemoor")'),
      ],
      relevant: [
        at(
          "D1",
          "1.2",
          'A Party that gives information to the other under this Agreement is the "Originator"',
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party is the Originator of what it gives and the Holder of what it obtains",
    }),
    "def-1": compliant({
      governing: [at("D1", "1.3", "marks or describes as confidential when it gives it")],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
      note: "Clause 1.3 also covers non-public information that a reasonable person would treat as confidential because of what it is or how it was given.",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "2.1", "The Holder owes no duty under this Agreement in respect of information"),
      ],
      basis:
        "exc-1.standard: all four exclusions are present, as (a) to (d), and none needs written records",
      note: "Clause 2.1 lists information that is or becomes public without a breach by the Holder (a), was already held without a duty of confidence (b), is developed independently without drawing on Confidential Information (c) and comes from a third party that owes no duty of confidence (d).",
    }),
    "pds-1": deviation({
      governing: [
        at("D1", "4.2", "only after the Originator has approved that disclosure in writing"),
      ],
      relevant: [
        at(
          "D1",
          "4.1",
          "the directors, officers, employees and contractors of the Holder and of its Affiliates",
        ),
      ],
      basis:
        "pds-1.unacceptable: each disclosure to a professional adviser needs the Originator's prior written approval, which it may refuse for any reason",
      note: "Clause 4.1 lets directors, officers, employees and contractors of the Holder and its Affiliates receive information without consent. Clause 4.2 makes every disclosure to a lawyer, accountant or other professional adviser wait for the Originator's prior written approval, which it may refuse or condition for any reason or for none, so advisers who need to know the information cannot rely on the permission the standard gives them.",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "5.1",
          "requires the Holder to disclose Confidential Information, the Holder may do so to the extent of the requirement",
        ),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the Holder make a legally required disclosure, with prompt notice where the law permits and it is reasonably practicable",
    }),
    "dur-1": deviation({
      governing: [
        at(
          "D2",
          "2",
          "continue until ten (10) years after the date on which this Agreement terminates",
        ),
      ],
      superseded: [
        at(
          "D1",
          "6.1",
          "for three (3) years from the date on which the Originator first gives that item",
        ),
      ],
      relevant: [
        at("D1", "6.2", "This Agreement terminates on 31 December 2027"),
        at("D1", "9.1", "continue to apply after this Agreement terminates"),
      ],
      escalation: required("playbook_escalation"),
      basis:
        "dur-1.escalateWhen.over-five-years: ten years after the agreement terminates is finite, because the agreement terminates by 31 December 2027 at the latest, and longer than the five year fallback, which makes it a business decision",
      note: "The First Amendment, dated after the agreement, deletes Section 6.1 and replaces it, so the three year period in the original clause is superseded. The replacement runs for ten years after termination. Section 6.2 fixes 31 December 2027 as the latest date on which the agreement terminates, so the period has a stated end and is not the perpetual case, but it exceeds both the standard and the fallback. The amendment carries a signature block for each Party, as Section 9.2 requires for a change.",
    }),
    "ret-1": compliant({
      governing: [
        at(
          "D1",
          "7.1",
          "Not later than forty (40) days after a written request from the Originator",
        ),
      ],
      basis:
        "ret-1.standard: forty days, longer than 30, with law and routine backup copies kept and still confidential",
      note: "Clause 7.1 lets the Holder keep a copy the law requires and copies in its routine backup systems, and a copy kept stays subject to the agreement.",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "8.1", "law of the State of Delaware"),
        at(
          "D1",
          "8.2",
          "only in the Superior Court of the State of Delaware or in the United States District Court for the District of Delaware",
        ),
      ],
      basis:
        "gov-1.standard: Delaware law and an exclusive Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
