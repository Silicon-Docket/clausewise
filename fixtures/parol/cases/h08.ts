import {
  addDocument,
  addVersion,
  at,
  clause,
  compliant,
  deviation,
  identicalCopyOf,
  identicalFile,
  item,
  newDocument,
  resaveOf,
  sameText,
  signature,
  text,
  title,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H08: the same file under two names, a re-save with identical text, and a term that runs
// until the information becomes public
//
// A one-way undertaking in twenty flat clauses, each opened by a run-in caption, with no section
// headings: the client, a Minnesota maltster, receives, and an Idaho probe maker discloses. The
// person uploads the document, then the same bytes under another name (with the stated date of the
// first upload), then a re-saved copy of the same text (no date). The first copy changes nothing
// and the application names the stored version; the re-save is stored as version 2, does not
// govern, and carries the near-duplicate notice. Version 1 therefore still governs at the end, and
// it is the only document of the case.
//
// One rule deviates. Clause 11 ends the obligations only on the day an item becomes public and
// says in terms that no number of years applies, so the clause has an end only in the sense of an
// event that may never occur: the playbook's "no stated end" case, not a finite period over five
// years, so no escalation is expected. The other seven rules meet the playbook: the exclusions of
// clause 3 need no records, clause 9 is a dedicated compelled-disclosure clause, and clause 12
// gives thirty days with law and backup copies kept under the undertaking.
// ---------------------------------------------------------------------------------------------

export const H08: CaseDefinition = {
  case: "PAROL-H08",
  split: "heldout",
  phenomenon:
    'Same file under two names; a re-save with identical text; term runs "until the information becomes public"',
  intake: { clientLegalName: "Marrowdale Maltings Technology, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h08-nda.docx",
      kind: "nda",
      title: "Confidentiality Undertaking",
      statedDate: "2026-10-27",
      paragraphs: [
        title("CONFIDENTIALITY UNDERTAKING"),
        text(
          'This Confidentiality Undertaking (the "Undertaking") is given on 27 October 2026 by Marrowdale Maltings Technology, Inc., a Minnesota corporation ("Marrowdale"), to Kesterwood Probe Works LLC, an Idaho limited liability company ("Kesterwood"). Marrowdale and Kesterwood are each a "party" and together the "parties".',
        ),
        text(
          "Kesterwood makes moisture probes for grain stores and drying kilns. Marrowdale runs malting plants and is considering whether to fit Kesterwood probes to its kilning lines. Kesterwood is willing to show Marrowdale its design files, calibration data and field trial results for that purpose if Marrowdale gives the promises set out below.",
        ),
        clause(
          "1",
          'Who gives and who receives. This Undertaking is one-way: Kesterwood will give information to Marrowdale, and Marrowdale is not asked to give any to Kesterwood. Marrowdale may use that information only to decide whether to fit Kesterwood probes to its kilning lines and, if it decides to, to plan their installation (together, the "Evaluation").',
        ),
        clause(
          "2",
          'What the information is. "Kesterwood Information" means non-public information, in any form, that Kesterwood gives to Marrowdale for the Evaluation and that Kesterwood labels or describes as confidential at the time, or that a reasonable person would regard as confidential from the nature of the information and the way Kesterwood gives it. It includes the parts of Marrowdale\'s own notes that reproduce it.',
        ),
        clause(
          "3",
          "Information Marrowdale is free to use. Marrowdale owes no duty under this Undertaking about information that:",
        ),
        item(
          "(a)",
          "is, or later comes to be, in the public domain, unless that happened because Marrowdale broke this Undertaking;",
        ),
        item(
          "(b)",
          "Marrowdale already knew, without being under any duty of confidence about it, before Kesterwood handed it over;",
        ),
        item(
          "(c)",
          "Marrowdale's own personnel work out for themselves without using Kesterwood Information; or",
        ),
        item(
          "(d)",
          "Marrowdale is given by a third party that was under no obligation of confidence to Kesterwood about it.",
        ),
        clause(
          "4",
          "Care. Marrowdale shall guard Kesterwood Information with the diligence it gives its own sensitive business records, and with no less diligence than a reasonable company would show. It shall not copy Kesterwood Information except as the Evaluation needs.",
        ),
        clause(
          "5",
          "Probes and firmware. Marrowdale shall not dismantle any probe or sensor head that Kesterwood supplies for the Evaluation, or try to recover the source code of its firmware, unless Kesterwood agrees in writing.",
        ),
        clause(
          "6",
          "Reporting a problem. Marrowdale shall tell Kesterwood without delay if it learns that Kesterwood Information has been lost, stolen or used or shown to anyone in a way this Undertaking does not allow.",
        ),
        clause(
          "7",
          "People who may see it. Marrowdale may show or give Kesterwood Information to its own employees, officers, contractors and professional advisers, and those of its affiliates, but only a person who needs it for the Evaluation and is bound by obligations of secrecy that are no weaker than this Undertaking. For this purpose a company is an affiliate of Marrowdale if it controls Marrowdale, or is controlled by Marrowdale, or is controlled by the same owner as Marrowdale.",
        ),
        clause(
          "8",
          "Responsibility for others. Kesterwood's consent is not needed for a disclosure that clause 7 allows. If a person who has seen Kesterwood Information through Marrowdale mishandles it, Marrowdale is liable to Kesterwood as if it had mishandled the information itself.",
        ),
        clause(
          "9",
          "Disclosure demanded by law. If a statute, a regulation, a court order or a demand from a public authority obliges Marrowdale to disclose Kesterwood Information, Marrowdale may do so, but only as far as the obligation requires. Unless a law forbids it, and so far as it is reasonably practicable, Marrowdale shall give Kesterwood prompt notice of the demand before it complies, so that Kesterwood has the chance to apply, at Kesterwood's own cost, for an order protecting the information.",
        ),
        clause(
          "10",
          "Ownership. Kesterwood keeps all rights in Kesterwood Information. Nothing in this Undertaking gives Marrowdale a license or any other right in it, other than the right to use it for the Evaluation.",
        ),
        clause(
          "11",
          "How long Marrowdale's obligations last. Marrowdale's obligations under this Undertaking about an item of Kesterwood Information continue until that item becomes public otherwise than through Marrowdale's own breach of this Undertaking, and no earlier. Their duration is not counted in years: it does not run from the day of disclosure or from the end of the Evaluation, and neither the end of the Evaluation nor the return or destruction of the item shortens it.",
        ),
        clause(
          "12",
          "Giving the information back. If Kesterwood asks in writing, Marrowdale shall, within thirty (30) days of the request, return or destroy the Kesterwood Information it holds. Marrowdale need not remove a copy that it must keep to comply with the law, or a copy that sits in a routine back-up of its systems, but every copy of that kind stays subject to this Undertaking.",
        ),
        clause(
          "13",
          "If the Evaluation stops. Either party may end the Evaluation by written notice to the other. A notice of that kind does not release Marrowdale from its obligations about Kesterwood Information it has already received.",
        ),
        clause(
          "14",
          "Court orders. Marrowdale agrees that Kesterwood may seek an injunction to stop a breach or threatened breach of this Undertaking, as well as any damages that a court awards.",
        ),
        clause(
          "15",
          "No promises about the information. Kesterwood gives no warranty about the accuracy or completeness of Kesterwood Information, and neither party is obliged to enter into any further agreement because of the Evaluation.",
        ),
        clause(
          "16",
          "Governing law and courts. Delaware law applies to this Undertaking and to every claim arising from it. Each party agrees that the only courts with jurisdiction over such a claim are the Court of Chancery of the State of Delaware and, if that court lacks subject-matter jurisdiction, the Superior Court of the State of Delaware or the United States District Court for the District of Delaware.",
        ),
        clause(
          "17",
          "Notices. Any notice under this Undertaking is to be sent in writing to the postal or email address that the receiving party has most recently given for the purpose.",
        ),
        clause(
          "18",
          "Transfer. Marrowdale may not assign or transfer this Undertaking without Kesterwood's written consent.",
        ),
        clause(
          "19",
          "Complete terms. This Undertaking is the entire bargain of the parties on the Evaluation. Earlier statements, drafts and correspondence between them form no part of it, and it can be varied only by a written variation signed by both parties.",
        ),
        clause(
          "20",
          "Signature. Each party may sign its own copy of this Undertaking, by hand or electronically, and the signed copies are read together as one document.",
        ),
        signature("Marrowdale Maltings Technology, Inc.", "Kesterwood Probe Works LLC"),
      ],
    },
  ],
  uploads: {
    files: [
      identicalCopyOf("parol-h08-nda.docx", "parol-h08-nda-copy.docx"),
      resaveOf("parol-h08-nda.docx", "parol-h08-nda-resaved.docx"),
    ],
    steps: [
      addDocument(
        "parol-h08-nda.docx",
        {
          label: "D1",
          title: "Confidentiality Undertaking",
          kind: "nda",
          statedDate: "2026-10-27",
        },
        newDocument("D1"),
      ),
      addVersion("parol-h08-nda-copy.docx", "D1", "2026-10-27", identicalFile("D1", 1, true)),
      addVersion(
        "parol-h08-nda-resaved.docx",
        "D1",
        null,
        sameText("D1", 2, { label: "D1", versionNo: 1 }),
      ),
    ],
  },
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Marrowdale Maltings Technology, Inc., a Minnesota corporation")],
      relevant: [
        at(
          "D1",
          "1",
          "Kesterwood will give information to Marrowdale, and Marrowdale is not asked",
        ),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client exactly as given at intake, and the undertaking says that Kesterwood discloses and Marrowdale receives",
    }),
    "def-1": compliant({
      governing: [at("D1", "2", "labels or describes as confidential at the time")],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
    }),
    "exc-1": compliant({
      governing: [
        at("D1", "3", "Marrowdale owes no duty under this Undertaking about information that"),
        at("D1", "3", "later comes to be, in the public domain"),
        at("D1", "3", "already knew, without being under any duty of confidence"),
        at("D1", "3", "own personnel work out for themselves without using Kesterwood Information"),
        at("D1", "3", "was under no obligation of confidence to Kesterwood"),
      ],
      basis: "exc-1.standard: all four exclusions are present and none needs written records",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "7",
          "employees, officers, contractors and professional advisers, and those of its affiliates",
        ),
      ],
      relevant: [
        at("D1", "8", "Kesterwood's consent is not needed for a disclosure that clause 7 allows"),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by equal duties, with no consent needed",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "9",
          "obliges Marrowdale to disclose Kesterwood Information, Marrowdale may do so, but only as far as the obligation requires",
        ),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the recipient disclose what law requires, with prompt notice where the law allows and it is practicable",
    }),
    "dur-1": deviation({
      governing: [
        at(
          "D1",
          "11",
          "continue until that item becomes public otherwise than through Marrowdale's own breach of this Undertaking, and no earlier. Their duration is not counted in years",
        ),
      ],
      relevant: [
        at("D1", "3", "later comes to be, in the public domain"),
        at("D1", "12", "every copy of that kind stays subject to this Undertaking"),
        at("D1", "13", "does not release Marrowdale from its obligations"),
      ],
      basis:
        "dur-1.unacceptable: no stated end for non-trade-secret information; the only end is an event that may never occur",
      note: "Clause 11 gives no period at all, in years or from any date, and clauses 12 and 13 confirm that neither returning the information nor ending the Evaluation shortens it. The obligation lasts for as long as an item stays non-public, which is no stated end. No finite period is stated, so the over-five-years business decision does not arise.",
    }),
    "ret-1": compliant({
      governing: [at("D1", "12", "within thirty (30) days of the request")],
      basis: "ret-1.standard: thirty days, with law and routine backup copies kept confidential",
    }),
    "gov-1": compliant({
      governing: [
        at(
          "D1",
          "16",
          "Delaware law applies to this Undertaking and to every claim arising from it. Each party agrees that the only courts with jurisdiction over such a claim are the Court of Chancery of the State of Delaware",
        ),
      ],
      basis: "gov-1.standard: Delaware law and a Delaware forum are on the approved list",
    }),
  },
  warnings: ["duplicate_document", "near_duplicate_version"],
};
