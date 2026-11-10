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
  undetermined,
} from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-H05: two amendments that set different return deadlines, the second undated, and an
// exclusion that needs written records
//
// A mutual agreement in eight sections. Section 2.2 lets the Receiving Party prove exclusions (b)
// and (c) only by written records made at the time, which is the one thing the playbook calls
// unacceptable in the exclusions. Section 6.1 gives thirty days to return or destroy. Two text
// amendments each delete Section 6.1 and replace it in full: the first, dated 15 June 2026, with
// forty-five days, the second, which carries no date in its text and was entered with none, with
// ten days. Each ends in a signature block for both Parties, as Section 8.1 requires for a change,
// so whether either was signed is not in doubt. Neither refers to the other or says which
// prevails, and neither is numbered, so nothing but the stated dates could order them. The return
// deadline is therefore undetermined, with conflicting_sources: forty-five days would meet the
// playbook and ten days would not.
// ---------------------------------------------------------------------------------------------

export const H05: CaseDefinition = {
  case: "PAROL-H05",
  split: "heldout",
  phenomenon:
    "Two amendments set different return deadlines (45 days and 10 days); the second is undated; exclusion needs written records",
  intake: { clientLegalName: "Tolliver Marsh Biofuels, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-h05-nda.docx",
      kind: "nda",
      title: "Mutual NDA",
      statedDate: "2026-02-24",
      paragraphs: [
        title("CONFIDENTIALITY AND INFORMATION SHARING AGREEMENT"),
        text(
          'This Confidentiality and Information Sharing Agreement (the "Agreement") is dated 24 February 2026 and is made between Tolliver Marsh Biofuels, Inc., an Iowa corporation ("Tolliver Marsh"), and Hartsgrove Kiln Works LLC, a Tennessee limited liability company ("Hartsgrove") (each a "Party" and together the "Parties").',
        ),
        text(
          "Tolliver Marsh produces wood pellets and Hartsgrove designs industrial kilns. The Parties are assessing whether Hartsgrove's heat recovery design could be fitted to the pellet dryers at Tolliver Marsh's plants (the \"Project\"), and each may need to disclose plant data and design information to the other for the Project.",
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means an entity that, directly or indirectly, owns or controls a Party, is owned or controlled by a Party, or is under common ownership or control with a Party.',
              '"Confidential Information" means non-public information, in any form, that one Party (the "Disclosing Party") discloses to the other Party (the "Receiving Party") for the Project and that is either designated confidential by the Disclosing Party when it is disclosed or of a kind that a person of ordinary business sense would recognise as confidential given what it is and how it came to be disclosed.',
            ],
          ],
          [
            "Exclusions",
            [
              "The Receiving Party has no duty in respect of an item of information if it shows that the item (a) is or becomes part of the public domain other than through a breach of this Agreement by the Receiving Party; (b) was already in the Receiving Party's possession, free of any duty of confidence, before it was disclosed; (c) was developed by or for the Receiving Party independently, without use of the Disclosing Party's Confidential Information; or (d) was obtained by the Receiving Party from a third party that was under no duty of confidence to the Disclosing Party.",
              "The Receiving Party may establish the facts in paragraph (b) or paragraph (c) of Section 2.1 only by written records that it made at the time those facts occurred and that it produces to the Disclosing Party on request. Oral evidence, recollection and records made afterwards are not accepted as proof.",
            ],
          ],
          [
            "Duties of the Receiving Party",
            [
              "The Receiving Party shall use Confidential Information only for the Project.",
              "The Receiving Party shall give Confidential Information at least the protection it gives its own comparable information and, in every case, a reasonable standard of care.",
              "The Receiving Party shall notify the Disclosing Party promptly if it becomes aware of any use or disclosure of Confidential Information that this Agreement does not permit.",
            ],
          ],
          [
            "Sharing and Legal Process",
            [
              "The Receiving Party may share Confidential Information with the employees, officers, contractors, lawyers, accountants and other professional advisers of itself and of its Affiliates, if each of them needs to know it for the Project and is bound by confidentiality duties at least as protective as those in this Agreement.",
              "A disclosure that a law, a regulation, a court order or a demand from a government body makes compulsory is allowed, but only to the extent of the compulsion. Unless the law forbids notice or notice is not reasonably practicable, the Receiving Party shall notify the Disclosing Party promptly beforehand, so that the Disclosing Party can seek a protective order at its own cost.",
            ],
          ],
          [
            "Term",
            [
              "The Receiving Party's obligations in respect of each item of Confidential Information end three (3) years after the day on which that item is disclosed.",
              "A Party may withdraw from the Project by written notice to the other, and withdrawal does not change the period in Section 5.1.",
            ],
          ],
          [
            "Return of Information",
            [
              "Within thirty (30) days after the Disclosing Party asks in writing, the Receiving Party shall return or destroy the Confidential Information it holds. It may keep copies that the law obliges it to keep and copies held in routine backup systems, and every copy so kept remains subject to this Agreement.",
            ],
          ],
          [
            "Governing Law",
            [
              "This Agreement, and every dispute arising from it, is governed by the laws of the State of Delaware.",
              "The Parties submit to the exclusive jurisdiction of the state and federal courts sitting in Wilmington, Delaware, and neither of them will start proceedings about this Agreement anywhere else.",
            ],
          ],
          [
            "General",
            [
              "This document is the whole of what the Parties have agreed about information exchanged for the Project, and no change to it counts unless it is in writing and signed for each Party.",
              "Each Party remains free to decline to share any item of information, and neither is committed to the Project by signing.",
              "The Agreement takes effect when each Party has signed a copy, and the signed copies together are one instrument.",
            ],
          ],
        ]),
        signature("Tolliver Marsh Biofuels, Inc.", "Hartsgrove Kiln Works LLC"),
      ],
    },
    {
      label: "D2",
      file: "parol-h05-amendment-1.txt",
      kind: "amendment",
      title: "Amendment",
      statedDate: "2026-06-15",
      paragraphs: [
        title("AMENDMENT TO CONFIDENTIALITY AND INFORMATION SHARING AGREEMENT"),
        text(
          'This Amendment (the "Amendment") is made on 15 June 2026 between Tolliver Marsh Biofuels, Inc. and Hartsgrove Kiln Works LLC. It amends the Confidentiality and Information Sharing Agreement between them dated 24 February 2026 (the "Agreement").',
        ),
        clause("1", "Words defined in the Agreement have the same meanings in this Amendment."),
        clause(
          "2",
          'Section 6.1 of the Agreement is deleted and replaced with the following: "Within forty-five (45) days after the Disclosing Party asks in writing, the Receiving Party shall return or destroy the Confidential Information it holds. It may keep copies that the law obliges it to keep and copies held in routine backup systems, and every copy so kept remains subject to this Agreement."',
        ),
        clause("3", "All other provisions of the Agreement stay as they were."),
        signature("Tolliver Marsh Biofuels, Inc.", "Hartsgrove Kiln Works LLC"),
      ],
    },
    {
      label: "D3",
      file: "parol-h05-amendment-2.txt",
      kind: "amendment",
      title: "Variation",
      statedDate: null,
      paragraphs: [
        title("VARIATION OF CONFIDENTIALITY AND INFORMATION SHARING AGREEMENT"),
        text(
          'Tolliver Marsh Biofuels, Inc. and Hartsgrove Kiln Works LLC vary the Confidentiality and Information Sharing Agreement between them dated 24 February 2026 (the "Agreement") as follows.',
        ),
        clause(
          "1",
          'Section 6.1 of the Agreement is replaced in full by the following: "Within ten (10) days after the Disclosing Party asks in writing, the Receiving Party shall return or destroy the Confidential Information it holds. It may keep copies that the law obliges it to keep and copies held in routine backup systems, and every copy so kept remains subject to this Agreement."',
        ),
        clause("2", "The remainder of the Agreement is unchanged."),
        signature("Tolliver Marsh Biofuels, Inc.", "Hartsgrove Kiln Works LLC"),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [
        at("D1", null, 'Tolliver Marsh Biofuels, Inc., an Iowa corporation ("Tolliver Marsh")'),
      ],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and each Party can be the Disclosing Party or the Receiving Party",
    }),
    "def-1": compliant({
      governing: [
        at("D1", "1.2", "designated confidential by the Disclosing Party when it is disclosed"),
      ],
      basis: "def-1.standard: marked or identified as confidential, or reasonably understood to be",
      note: "Clause 1.2 also covers non-public information that a person of ordinary business sense would recognise as confidential given what it is and how it came to be disclosed.",
    }),
    "exc-1": deviation({
      governing: [
        at("D1", "2.2", "only by written records that it made at the time those facts occurred"),
      ],
      relevant: [
        at(
          "D1",
          "2.1",
          "has no duty in respect of an item of information if it shows that the item",
        ),
      ],
      basis:
        "exc-1.unacceptable: exclusions (b) and (c) can be proved only by written records made at the time",
      note: "Clause 2.1 states all four exclusions, but clause 2.2 then allows the Receiving Party to establish prior knowledge (b) and independent development (c) only by contemporaneous written records and refuses oral evidence and later records, which is the proof requirement the playbook treats as unacceptable.",
    }),
    "pds-1": compliant({
      governing: [
        at(
          "D1",
          "4.1",
          "employees, officers, contractors, lawyers, accountants and other professional advisers of itself and of its Affiliates",
        ),
      ],
      basis:
        "pds-1.standard: employees, officers, contractors and advisers of the recipient and its affiliates who need to know and are bound by duties no less protective",
    }),
    "pds-2": compliant({
      governing: [
        at("D1", "4.2", "makes compulsory is allowed, but only to the extent of the compulsion"),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the Receiving Party make a legally required disclosure, with prompt notice where the law allows and it is reasonably practicable",
    }),
    "dur-1": compliant({
      governing: [
        at("D1", "5.1", "end three (3) years after the day on which that item is disclosed"),
      ],
      relevant: [at("D1", "5.2", "withdrawal does not change the period in Section 5.1")],
      basis: "dur-1.standard: obligations end three years after each disclosure",
    }),
    "ret-1": undetermined({
      superseded: [
        at("D1", "6.1", "Within thirty (30) days after the Disclosing Party asks in writing"),
      ],
      relevant: [
        at("D2", "2", "Within forty-five (45) days after the Disclosing Party asks in writing"),
        at("D3", "1", "Within ten (10) days after the Disclosing Party asks in writing"),
      ],
      escalation: required("conflicting_sources"),
      basis:
        "ret-1.standard: two amendments replace Section 6.1 with deadlines of forty-five days and ten days, and the documents do not say which governs",
      note: "Amendment (dated 15 June 2026) gives forty-five days, which meets the standard, and the Variation (no date in its text and none entered) gives ten days, which is shorter than 30 days. Both delete and replace the same clause in full, neither refers to the other, and the missing date means the stated dates cannot order them, so the passages conflict. Each ends in a signature block for both Parties, so the missing date, not a missing signature, is what leaves the order open. The thirty day deadline of Section 6.1 does not govern on either reading.",
    }),
    "gov-1": compliant({
      governing: [
        at("D1", "7.1", "laws of the State of Delaware"),
        at(
          "D1",
          "7.2",
          "exclusive jurisdiction of the state and federal courts sitting in Wilmington, Delaware",
        ),
      ],
      basis:
        "gov-1.standard: Delaware law and an exclusive Delaware forum are on the approved list",
    }),
  },
  warnings: [],
};
