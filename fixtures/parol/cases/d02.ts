import { at, compliant, deviation, numbered, required, signature, text, title } from "../draft.js";
import type { CaseDefinition } from "../types.js";

// ---------------------------------------------------------------------------------------------
// PAROL-D02: aggressive one-way draft sent by the discloser
//
// Six rules deviate in one document: an overbroad definition, a single exclusion, consent for each
// disclosure, a perpetual term, a five day return deadline with a duty to erase backups, and an
// exclusive Singapore forum. The parties and the compelled-disclosure clause are sound, so a
// reviewer that flags everything in sight is wrong twice.
// ---------------------------------------------------------------------------------------------

export const D02: CaseDefinition = {
  case: "PAROL-D02",
  split: "dev",
  phenomenon:
    "Aggressive draft: overbroad definition, one exclusion, consent for each disclosure, perpetual term, 5-day purge of backups, exclusive Singapore forum",
  intake: { clientLegalName: "Windlass Ridge Analytics, Inc." },
  documents: [
    {
      label: "D1",
      file: "parol-d02-nda.docx",
      kind: "nda",
      title: "One-way NDA",
      statedDate: "2026-07-14",
      paragraphs: [
        title("CONFIDENTIALITY AND NON-USE AGREEMENT"),
        text(
          'This Confidentiality and Non-Use Agreement (the "Agreement") is made on 14 July 2026 between Ostrander Reach Technologies Pte. Ltd., a Singapore private company limited by shares (the "Discloser"), and Windlass Ridge Analytics, Inc., a Delaware corporation (the "Recipient").',
        ),
        text(
          'The Discloser has developed sensor calibration technology and will give the Recipient information about it so that the Recipient can decide whether to become a reseller of the Discloser\'s calibration systems (the "Purpose").',
        ),
        ...numbered([
          [
            "Definitions",
            [
              '"Affiliate" means any entity that directly or indirectly controls, is controlled by, or is under common control with a person.',
              '"Confidential Information" means all information of any kind and in any form, whether or not it is marked or identified as confidential, that the Discloser or any of its Affiliates discloses or makes available to the Recipient at any time and by any means, together with all notes, analyses and other material that the Recipient prepares from any of it.',
            ],
          ],
          [
            "Use and Ownership",
            [
              "The Recipient shall use Confidential Information only for the Purpose and for no other reason.",
              "All Confidential Information remains the property of the Discloser, and this Agreement gives the Recipient no license or other right in it.",
              "The Discloser gives no warranty about the accuracy or completeness of Confidential Information and is not liable for any use the Recipient makes of it.",
            ],
          ],
          [
            "Exclusion",
            [
              "The obligations of the Recipient under this Agreement do not apply to information that is or becomes generally available to the public, other than as a result of any act or omission of the Recipient or of anyone to whom the Recipient has disclosed it.",
              "Information is not generally available to the public merely because part of it is known or because individual features of it can be found in public sources.",
            ],
          ],
          [
            "Protection",
            [
              "The Recipient shall keep Confidential Information strictly confidential and shall protect it with at least the care it takes to protect its own most sensitive information, and in no case with less than reasonable care.",
              "The Recipient shall not copy or record Confidential Information except as the Purpose strictly requires, and shall not reverse engineer, disassemble or analyze any sample, prototype or software that the Discloser supplies.",
              "The Recipient shall notify the Discloser in writing within twenty-four (24) hours after it becomes aware of any actual or suspected unauthorized use or disclosure of Confidential Information.",
            ],
          ],
          [
            "Disclosure to Others",
            [
              "The Recipient shall not disclose Confidential Information to any person, including its own directors, officers, employees, contractors, professional advisers and Affiliates, unless the Discloser has first given its written consent to that particular disclosure.",
              "Consent to one disclosure is not consent to any other disclosure, and the Discloser may refuse, or attach conditions to, any consent in its sole discretion.",
            ],
          ],
          [
            "Legally Required Disclosure",
            [
              "Despite Section 5, the Recipient may disclose Confidential Information to the extent that a law, a regulation or an order of a court or governmental authority requires it to do so, provided that, where legally permitted and reasonably practicable, the Recipient gives the Discloser prompt written notice of the requirement so that the Discloser may seek a protective order at its own cost, and provided that the Recipient discloses no more than the requirement compels.",
            ],
          ],
          [
            "Duration",
            [
              "The obligations of the Recipient under this Agreement continue in perpetuity. They have no expiry date and survive the end of this Agreement and of any discussions between the Discloser and the Recipient.",
            ],
          ],
          [
            "Return and Destruction",
            [
              "Within five (5) days after the Discloser's written request, the Recipient shall return to the Discloser, or at the Discloser's election destroy, all Confidential Information in its possession or control, and shall permanently erase every copy held on any backup, archival or disaster recovery system.",
              "On the Discloser's request the Recipient shall give the Discloser a certificate, signed by one of its officers, confirming that it has complied with Section 8.1.",
            ],
          ],
          [
            "Governing Law and Forum",
            [
              "This Agreement is governed by the laws of the State of New York, without regard to its conflict of laws rules.",
              "The courts of Singapore have exclusive jurisdiction over every dispute arising out of or in connection with this Agreement, and the Recipient irrevocably submits to that jurisdiction and waives any objection that those courts are an inconvenient forum.",
            ],
          ],
          [
            "General",
            [
              "This Agreement is the entire agreement between the Discloser and the Recipient about its subject matter and may be changed only by a written document signed by both of them.",
              "The Recipient acknowledges that damages alone would not be an adequate remedy for a breach of this Agreement and that the Discloser may seek an injunction or specific performance without proving actual loss and without posting a bond.",
              "The Discloser and the Recipient may sign this Agreement in counterparts, including by electronic signature, which together form one agreement.",
            ],
          ],
        ]),
        signature("Ostrander Reach Technologies Pte. Ltd.", "Windlass Ridge Analytics, Inc."),
      ],
    },
  ],
  expect: {
    "pty-1": compliant({
      governing: [at("D1", null, "Windlass Ridge Analytics, Inc., a Delaware corporation")],
      basis:
        "pty-1.standard: both parties are named in full with their entity types, the client is named exactly as given at intake, and it is clear that the Discloser discloses and the Recipient receives",
    }),
    "def-1": deviation({
      governing: [
        at(
          "D1",
          "1.2",
          "all information of any kind and in any form, whether or not it is marked or identified as confidential",
        ),
      ],
      basis:
        "def-1.unacceptable: all information of any kind, in any form, whether or not marked or identified as confidential",
      note: "Section 1.2 has no requirement that the information be non-public, marked, identified or understood to be confidential, and it reaches notes the Recipient prepares itself.",
    }),
    "exc-1": deviation({
      governing: [
        at("D1", "3.1", "do not apply to information that is or becomes generally available"),
      ],
      relevant: [
        at(
          "D1",
          "3.2",
          "Information is not generally available to the public merely because part of it is known",
        ),
      ],
      basis:
        "exc-1.unacceptable: only the public information exclusion is present; prior knowledge, independent development and receipt from a third party are missing",
      note: "Section 3 holds one exclusion, and Section 3.2 narrows it. The rule treats any one of the four missing as unacceptable, and three are missing.",
    }),
    "pds-1": deviation({
      governing: [
        at(
          "D1",
          "5.1",
          "unless the Discloser has first given its written consent to that particular disclosure",
        ),
      ],
      relevant: [
        at("D1", "5.2", "Consent to one disclosure is not consent to any other disclosure"),
      ],
      basis:
        "pds-1.unacceptable: each disclosure needs the discloser's prior written consent, even a disclosure to the Recipient's own employees and advisers",
      note: "Section 5.1 names directors, officers, employees, contractors, professional advisers and Affiliates and allows none of them to receive Confidential Information without consent to that disclosure.",
    }),
    "pds-2": compliant({
      governing: [
        at(
          "D1",
          "6.1",
          "to the extent that a law, a regulation or an order of a court or governmental authority requires it to do so",
        ),
      ],
      basis:
        "pds-2.standard: a dedicated clause lets the Recipient disclose what law requires, with prompt notice where legally permitted and reasonably practicable",
      note: "Section 6.1 applies despite the consent rule of Section 5 and imposes no duty to resist the disclosure.",
    }),
    "dur-1": deviation({
      governing: [at("D1", "7.1", "continue in perpetuity")],
      basis:
        "dur-1.unacceptable: the obligations are perpetual and no carve-out limits them to trade secrets",
      note: "The period has no end, so it is the perpetual case and not the finite period longer than five years that the over-five-years escalation covers.",
    }),
    "ret-1": deviation({
      governing: [
        at(
          "D1",
          "8.1",
          "Within five (5) days after the Discloser's written request, the Recipient shall return to the Discloser, or at the Discloser's election destroy, all Confidential Information in its possession or control, and shall permanently erase every copy held on any backup, archival or disaster recovery system",
        ),
      ],
      relevant: [at("D1", "8.2", "a certificate, signed by one of its officers")],
      basis:
        "ret-1.unacceptable: a five day deadline is shorter than 30 days and the clause requires routine backups to be erased",
      note: "The officer's certificate in Section 8.2 is not a deviation on its own; the deadline and the backup purge are.",
    }),
    "gov-1": deviation({
      governing: [at("D1", "9.2", "The courts of Singapore have exclusive jurisdiction")],
      relevant: [at("D1", "9.1", "laws of the State of New York")],
      escalation: required("playbook_escalation"),
      basis:
        "gov-1.escalateWhen.forum-outside-list: an exclusive Singapore forum is outside the approved list, which is a business decision for the responsible attorney",
      note: "New York law is on the approved list; the exclusive forum in Singapore is not.",
    }),
  },
  warnings: [],
};
