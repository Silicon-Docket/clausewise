/**
 * The 40 pairs of the support calibration set (docs/parol/05-evaluation.md, "Support calibration
 * set"). Read fixtures/parol/calibration.ts for the checks they must pass and
 * fixtures/parol/README.md for how to use them.
 *
 * A pair is a finding as a model would write it (the status, the discrepancy and the explanation),
 * the one passage it cites (a document label, a clause number and a quote that occurs exactly once
 * in that clause of the operative document), the rule it answers and the author's label. Twenty
 * are supported: the claim follows from the cited paragraph, read as it stands, in the right frame
 * and with nothing overlooked. Twenty are unsupported although the quote is valid, in five kinds of
 * four: a superseded passage, an exception overlooked, the other party's obligation, a definition
 * read as if it imposed a duty, and a number in the wrong frame.
 *
 * The ids carry no information. The order was drawn once with a fixed seed so that the labels, the
 * kinds, the cases and the rules are mixed through the file: no more than three pairs in a row have
 * one label, and no two neighbours share a case. Do not sort the file. Several supported and
 * unsupported pairs cite the same paragraph on purpose, so that the paragraph cannot tell the label
 * either; the `note` of a pair says which.
 *
 * The `note` is the author's reason for the label, written for the qualified review that checks the
 * labels. A blind reader does not see it (`pnpm fixtures:parol:case --calibration --blind`).
 *
 * What the checker is shown is the rule, the status and the discrepancy, and the paragraph that
 * holds the quote (apps/parol/src/services/support-checker.ts), not the explanation and not any other
 * document. So an unsupported pair is one whose claim does not follow from that paragraph, or
 * follows only if a document the finding did not cite is ignored. One pair (the deleted term of
 * PAROL-D05) is of the second sort: nothing in its paragraph can show that the term was deleted.
 * It is here because the labels are about the documents, not about what the checker can see.
 *
 * Every party and passage is synthetic. No text is copied from a real agreement.
 */
import type { CalibrationPairSpec } from "../types.js";

export const CALIBRATION_PAIRS: readonly CalibrationPairSpec[] = [
  {
    id: "CAL-01",
    case: "PAROL-D13",
    rule: "def-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "The definition covers non-public information disclosed for the Project, whether or not it is marked or identified as confidential. That is the playbook's fallback and not the unacceptable definition of all information of any kind.",
    },
    evidence: {
      doc: "D1",
      clause: "1.2",
      quote:
        'non-public information that one Party (the "Disclosing Party") discloses to the other Party',
    },
    note: "The claim reads the definition with its limits, non-public information disclosed for the Project, which makes it the fallback. D13 key def-1 is compliant at the fallback.",
  },
  {
    id: "CAL-02",
    case: "PAROL-D05",
    rule: "dur-1",
    label: "unsupported",
    kind: "superseded",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 6.1 limits the obligations of each Receiving Party to two years from the date of each disclosure of Confidential Information. That is within the three year standard and counted from each disclosure, which meets the rule.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote: "two (2) years from the date of each disclosure",
    },
    note: "Clause 2 of Amendment No. 1 deletes Section 6.1 in its entirety, so the quoted term no longer exists and dur-1 is a deviation (the D05 key lists this paragraph as superseded). The finding cites the original clause alone and the paragraph does not show the deletion, which the checker is not shown either. This is the one pair that no reading of the cited paragraph can catch. It is in the set on purpose: docs/parol/05 names it as the limit of the isolation. The deleted term is also cited through the clause that deletes it, in the other superseded pair of D05 on dur-1, where the paragraph does show it.",
  },
  {
    id: "CAL-03",
    case: "PAROL-D02",
    rule: "ret-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The Recipient must return or destroy all Confidential Information within five days of the request and must permanently erase every copy held on any backup, archival or disaster recovery system. The standard allows at least 30 days and lets the recipient keep routine backups.",
      explanation:
        "Both the five day deadline and the duty to purge routine backups are listed as unacceptable. The officer's certificate in Section 8.2 is not a deviation on its own.",
    },
    evidence: {
      doc: "D1",
      clause: "8.1",
      quote:
        "and shall permanently erase every copy held on any backup, archival or disaster recovery system",
    },
    note: "Section 8.1 sets a five day deadline and requires erasure of every backup copy, and the claim says both. It does not say who chooses between return and destruction. D02 key ret-1 is a deviation.",
  },
  {
    id: "CAL-04",
    case: "PAROL-D14",
    rule: "pds-2",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 4.2 allows disclosure to the extent that law or an order requires, with prompt notice where permitted and practicable. The Disclosing Party seeks any protective order at its own cost, so the Receiving Party has no duty to resist or pay.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote: "so that the Disclosing Party may seek a protective order at its own cost",
    },
    note: "The cost of a protective order is the Disclosing Party's, and the Receiving Party's only condition is notice where it is permitted and practicable. The claim puts the cost where the paragraph puts it. D14 key pds-2 is compliant.",
  },
  {
    id: "CAL-05",
    case: "PAROL-D06",
    rule: "gov-1",
    label: "unsupported",
    kind: "superseded",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 7.1 chooses the laws of the State of Delaware and gives the state and federal courts located in Delaware exclusive jurisdiction. Amendment No. 1 refers to Section 7.1 but leaves that choice as it was, so both the law and the forum stay on the approved list.",
    },
    evidence: {
      doc: "D2",
      clause: "4",
      quote: "4. Section 7.1 of the Agreement is amended so that",
    },
    note: "Clause 4 amends Section 7.1 so that the governing law is that of California and the exclusive forum is Santa Clara County, and clause 2 amends the same section to New York, so the Delaware clause the finding relies on no longer stands and gov-1 is undetermined (D06 key). The cited paragraph says that Section 7.1 is amended and names a law and a forum that are not Delaware and not on the approved list, so the claim can be tested against what it says. The quote starts at the clause number because the same words open clause 2 and the quote must occur once in the document. The paragraph has no exception wording, so the pair cannot be read as an overlooked exception.",
  },
  {
    id: "CAL-06",
    case: "PAROL-D02",
    rule: "dur-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The Recipient's obligations continue in perpetuity, have no expiry date and survive the end of the Agreement and of any discussions between the parties.",
      explanation:
        "There is no stated end and no limit to trade secrets, so this is the perpetual case that the playbook lists as unacceptable and not a finite period longer than five years.",
    },
    evidence: {
      doc: "D1",
      clause: "7.1",
      quote: "continue in perpetuity",
    },
    note: "Section 7.1 says the obligations continue in perpetuity with no expiry date, and the claim says the same. D02 key dur-1 is a deviation.",
  },
  {
    id: "CAL-07",
    case: "PAROL-D09",
    rule: "dur-1",
    label: "unsupported",
    kind: "definition_as_duty",
    claim: {
      status: "deviation",
      discrepancy:
        "Confidential Information is defined as information in any form given for the Trial, with no limit on how long it stays protected, so the Recipient's duties never end.",
      explanation:
        "The definition has no time limit and applies to information whatever its form, so the duty to keep it confidential has no stated end. That is the perpetual case that the playbook lists as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "1.2",
      quote:
        'means information, in any form, that one Party (the "Provider") gives to the other Party',
    },
    note: "Section 1.2 defines the term and says nothing about duration. A definition without a time limit is not a statement that the duty is unlimited; the perpetual duty is in Section 5.1 (D09 key dur-1). The status is right, but the cited definition does not support the discrepancy.",
  },
  {
    id: "CAL-08",
    case: "PAROL-D14",
    rule: "gov-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The exclusive forum is the state and federal courts located in Harris County, Texas, which is not in Delaware, New York or England and Wales.",
      explanation:
        "New York law in Section 7.1 is on the approved list, but the exclusive forum is outside it. The playbook treats a forum outside the list as a business decision for the responsible attorney.",
    },
    evidence: {
      doc: "D1",
      clause: "7.2",
      quote:
        "exclusive jurisdiction of the state and federal courts located in Harris County, Texas",
    },
    note: "Section 7.2 gives the courts of Harris County, Texas exclusive jurisdiction, and Texas is not Delaware, New York or England and Wales. The claim is about the forum only and follows from the paragraph. D14 key gov-1 is a deviation.",
  },
  {
    id: "CAL-09",
    case: "PAROL-D11",
    rule: "pds-2",
    label: "unsupported",
    kind: "overlooked_exception",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 7 is a dedicated clause on disclosure required by law. If a law, regulation, subpoena or order requires it, the Recipient may make the disclosure, so the standard is met.",
    },
    evidence: {
      doc: "D1",
      clause: "7",
      quote:
        "the Recipient to disclose Confidential Information, the Recipient may make that disclosure only if",
    },
    note: "The sentence ends 'only if:' and the conditions are in items (a) and (b). Item (b) makes the disclosure depend on the Discloser's prior written consent, which it may withhold in its sole discretion. The finding reads the right without its condition. D11 key pds-2 is a deviation.",
  },
  {
    id: "CAL-10",
    case: "PAROL-D01",
    rule: "gov-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 7.1 chooses the laws of the State of New York and gives the state and federal courts in New York County, New York exclusive jurisdiction. Both are on the approved list.",
    },
    evidence: {
      doc: "D1",
      clause: "7.1",
      quote: "This Agreement is governed by the laws of the State of New York",
    },
    note: "One paragraph states both the governing law and the exclusive forum, and both are approved. D01 key gov-1 is compliant.",
  },
  {
    id: "CAL-11",
    case: "PAROL-D06",
    rule: "ret-1",
    label: "unsupported",
    kind: "wrong_frame",
    claim: {
      status: "deviation",
      discrepancy:
        "The period for return or destruction is ten days, which is shorter than the 30 days the standard requires.",
      explanation:
        "Clause 3 of Amendment No. 1 sets a period of ten days. The standard requires at least 30 days for return or destruction, so the amended deadline is too short.",
    },
    evidence: {
      doc: "D2",
      clause: "3",
      quote: "within ten (10) days after the date of this Amendment",
    },
    note: "The ten days are the time within which each Party gives the other a contact person for notices, counted from the date of the Amendment. They are not a return or destruction deadline. The return deadline is thirty days in Section 6.1 and ret-1 is compliant (D06 key). The finding takes a number from one frame as a number in another.",
  },
  {
    id: "CAL-12",
    case: "PAROL-D10",
    rule: "dur-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Corrimar's duties for each item end three years after Pindlebury first gave it that item, which meets the standard. Duties for a trade secret continue for as long as it remains a trade secret, which the standard accepts.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote:
        "for an item of Confidential Information end three (3) years after Pindlebury first gave Corrimar that item",
    },
    note: "Three years counted from the first giving of each item, with the trade secret exception that the standard accepts. D10 key dur-1 is compliant.",
  },
  {
    id: "CAL-13",
    case: "PAROL-D12",
    rule: "pds-2",
    label: "unsupported",
    kind: "other_party_obligation",
    claim: {
      status: "deviation",
      discrepancy:
        "The Receiving Party must give the Disclosing Party prompt notice of a legally required disclosure and must bear the cost of the protective order that is sought, so it carries the cost of resisting the disclosure.",
      explanation:
        "Section 4.2 lets the Receiving Party disclose only if it gives notice so that a protective order can be sought, and it leaves the cost of that order with the Receiving Party. The playbook lists a duty to resist a legally required disclosure at the recipient's own cost as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote:
        "where legally permitted and reasonably practicable, it gives the Disclosing Party prompt notice",
    },
    note: "The same sentence goes on 'so that the Disclosing Party may seek a protective order at its own cost': the other party seeks the order and bears its own cost, and the Receiving Party may disclose to the extent required once it has given notice where permitted and practicable. The finding gives the Disclosing Party's cost to the client. D12 key pds-2 is compliant. Same paragraph as the supported pds-2 pair of D12.",
  },
  {
    id: "CAL-14",
    case: "PAROL-D01",
    rule: "pds-2",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 4.2 allows the Recipient to disclose what a law, regulation or court or government order requires, with prompt notice where the law allows and it is practicable. That is the standard.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote: "if it gives the Discloser prompt notice where the law allows and it is practicable",
    },
    note: "The notice duty is qualified in the paragraph itself, where the law allows and it is practicable, and the claim keeps the qualifier. D01 key pds-2 is compliant. Same paragraph as the unsupported pair that turns the Discloser's step into the Recipient's duty.",
  },
  {
    id: "CAL-15",
    case: "PAROL-D08",
    rule: "dur-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The obligations continue until seven years after the date on which the Agreement terminates or expires, which is longer than the five years after the end of the agreement that the fallback allows.",
      explanation:
        "The period is finite, so it is not the perpetual case, but it counts from the end of the Agreement and exceeds both the standard and the fallback. That makes it a business decision for an attorney.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote: "until seven (7) years after the date on which this Agreement terminates or expires",
    },
    note: "The paragraph counts seven years from termination or expiry of the Agreement, and the claim says exactly that. Seven years after the agreement ends is longer than the five year fallback. D08 key dur-1 is a deviation. Same paragraph as the unsupported pair that reads the seven years from each disclosure.",
  },
  {
    id: "CAL-16",
    case: "PAROL-D14",
    rule: "pds-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 4.1 permits disclosure to the employees, officers, contractors and professional advisers of the Receiving Party and its Affiliates who need to know it for the Purpose and are bound by equally protective duties. That is the standard.",
    },
    evidence: {
      doc: "D1",
      clause: "4.1",
      quote:
        "employees, officers, contractors and professional advisers of itself and its Affiliates",
    },
    note: "The clause itself grants the permission, with the need to know and the equal confidentiality condition. D14 key pds-1 is compliant. Compare the unsupported pds-1 pairs, which read a definition as the clause that grants or imposes it.",
  },
  {
    id: "CAL-17",
    case: "PAROL-D04",
    rule: "pds-2",
    label: "unsupported",
    kind: "other_party_obligation",
    claim: {
      status: "deviation",
      discrepancy:
        "The Receiving Party must obtain a protective order or other remedy at its own cost before it can make a legally required disclosure, which is a duty to resist disclosure at the recipient's own cost.",
      explanation:
        "Clause 5.1 ties a legally required disclosure to prompt notice so that a protective order can be sought, and the Receiving Party carries the cost and the effort of seeking it.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote:
        "so that the Sharing Party may seek a protective order or other remedy at its own cost",
    },
    note: "The Sharing Party, the other party, may seek the order and bears its own cost. The Receiving Party may disclose to the extent required once it has given notice where permitted and practicable. The finding turns the Sharing Party's option into the Receiving Party's duty. D04 key pds-2 is compliant.",
  },
  {
    id: "CAL-18",
    case: "PAROL-D08",
    rule: "dur-1",
    label: "unsupported",
    kind: "wrong_frame",
    claim: {
      status: "deviation",
      discrepancy:
        "The obligations continue until seven years after the date of each disclosure of Confidential Information, which is longer than the five years from disclosure that the fallback allows.",
      explanation:
        "Section 5.1 runs the obligations for seven years from each disclosure. That is finite, so it is not the perpetual case, but it exceeds both the standard and the fallback and is a business decision for an attorney.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote:
        "of each Receiving Party under this Agreement shall continue until seven (7) years after",
    },
    note: "The seven years run from the date on which the Agreement terminates or expires, not from each disclosure. The status is right (D08 key dur-1), but the discrepancy states the number in the wrong frame. Same paragraph as the supported dur-1 pair of D08.",
  },
  {
    id: "CAL-19",
    case: "PAROL-D03",
    rule: "exc-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 2.1 lists all four exclusions: information that is public through no fault of the Receiving Party, already known without a duty of confidence, independently developed, and received from a third party with no duty of confidence. None needs written records.",
    },
    evidence: {
      doc: "D1",
      clause: "2.1",
      quote:
        "the Receiving Party develops independently without using the Disclosing Party's information",
    },
    note: "All four exclusions are in the one paragraph and none requires proof by records. D03 key exc-1 is compliant.",
  },
  {
    id: "CAL-20",
    case: "PAROL-D10",
    rule: "pds-2",
    label: "unsupported",
    kind: "other_party_obligation",
    claim: {
      status: "deviation",
      discrepancy:
        "Corrimar must give Pindlebury prompt written notice and bear the cost of any protective order sought in response to a legally required disclosure, which puts the cost of resisting disclosure on the recipient.",
      explanation:
        "The playbook lists a duty to resist a legally required disclosure at the recipient's own cost as unacceptable, and Section 5.1 makes Corrimar responsible for that cost, which makes it a deviation.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote: "so that Pindlebury may seek a protective order at its own cost",
    },
    note: "In the sentence it is Pindlebury, the other party, that may seek a protective order and that bears its own cost. Corrimar's only duty is notice where the law allows and it is practicable, and it may disclose to the extent required. The finding gives Pindlebury's cost to the client. D10 key pds-2 is compliant.",
  },
  {
    id: "CAL-21",
    case: "PAROL-D02",
    rule: "def-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "Section 1.2 defines Confidential Information as all information of any kind and in any form, whether or not it is marked or identified as confidential, and extends it to notes and analyses that the Recipient prepares itself.",
      explanation:
        "The definition has no requirement that the information be marked, identified or reasonably understood to be confidential, which is the all-information definition that the playbook lists as unacceptable. It also sweeps in the Recipient's own work product.",
    },
    evidence: {
      doc: "D1",
      clause: "1.2",
      quote: "whether or not it is marked or identified as confidential",
    },
    note: "The paragraph defines the term as all information of any kind and in any form, marked or not, and adds the Recipient's own notes and analyses. Nothing in it narrows the scope, so the claim follows from the paragraph alone. D02 key def-1 is a deviation.",
  },
  {
    id: "CAL-22",
    case: "PAROL-D05",
    rule: "ret-1",
    label: "unsupported",
    kind: "superseded",
    claim: {
      status: "deviation",
      discrepancy:
        "The deadline for return or destruction is ten business days after the Disclosing Party's written request, which is shorter than the 30 days the standard requires.",
      explanation:
        "Amendment No. 1 refers to a period of ten business days in Section 7.2. Ten business days is fewer than thirty days, and the carve-out for copies required by law and routine backups does not cure the deadline.",
    },
    evidence: {
      doc: "D2",
      clause: "3",
      quote: 'Section 7.2 of the Agreement is amended by replacing "ten (10) business days"',
    },
    note: "Clause 3 amends Section 7.2 by replacing ten (10) business days with thirty (30) days, so the quoted words are the ones the amendment removes and the deadline is thirty days. D05 key ret-1 is compliant through this clause. The paragraph shows the replacement, so the claim can be tested against what it says.",
  },
  {
    id: "CAL-23",
    case: "PAROL-D01",
    rule: "pds-2",
    label: "unsupported",
    kind: "other_party_obligation",
    claim: {
      status: "deviation",
      discrepancy:
        "The Recipient must ask a court for protection before it may make a legally required disclosure, which is a duty to resist disclosure.",
      explanation:
        "Section 4.2 conditions disclosure on notice so that protection can be sought from a court, and it is the Recipient that has to go to court. The playbook lists a duty to resist a legally required disclosure as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote: "so that the Discloser can ask a court for protection at the Discloser's expense",
    },
    note: "The Discloser, the other party, may ask a court for protection at its own expense. The Recipient's duty is notice where the law allows and it is practicable. The finding gives the Discloser's step to the Recipient. D01 key pds-2 is compliant.",
  },
  {
    id: "CAL-24",
    case: "PAROL-D12",
    rule: "pds-2",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 4.2 allows disclosure to the extent that law, regulation or an order requires, on prompt notice where legally permitted and reasonably practicable. That is the standard for a dedicated clause on legally required disclosure.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote:
        "to the extent required by law, regulation or order of a court or governmental authority",
    },
    note: "A dedicated clause with notice where permitted and practicable. D12 key pds-2 is compliant. Same paragraph as the unsupported pair that gives the Disclosing Party's cost of a protective order to the Receiving Party.",
  },
  {
    id: "CAL-25",
    case: "PAROL-D02",
    rule: "pds-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The Recipient may not disclose Confidential Information to any person, including its own directors, officers, employees, contractors, professional advisers and Affiliates, unless the Discloser has first given written consent to that particular disclosure.",
      explanation:
        "Every onward disclosure needs the Discloser's prior written consent, even a disclosure to the Recipient's own staff and advisers. The playbook lists a requirement of prior written consent for each disclosure as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote:
        "unless the Discloser has first given its written consent to that particular disclosure",
    },
    note: "Section 5.1 names directors, officers, employees, contractors, professional advisers and Affiliates and lets none of them receive Confidential Information without consent to that disclosure. The claim restates it. D02 key pds-1 is a deviation.",
  },
  {
    id: "CAL-26",
    case: "PAROL-D04",
    rule: "ret-1",
    label: "unsupported",
    kind: "overlooked_exception",
    claim: {
      status: "deviation",
      discrepancy:
        "The Receiving Party must return or destroy all of the Sharing Party's Confidential Information within sixty days of the request, with no right to keep copies that the law requires or copies held in routine backups.",
      explanation:
        "Clause 7.1 contains no carve-out for routine backup copies, so it requires them to be purged within the sixty days. The playbook lists a duty to purge routine backups as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "7.1",
      quote:
        "the Receiving Party shall return or destroy the Sharing Party's Confidential Information",
    },
    note: "The same sentence continues 'save that it may keep copies that the law requires it to keep and copies held in its routine backup systems', and the copies kept in that way remain subject to the Agreement. The finding overlooks the exception. D04 key ret-1 is compliant at sixty days.",
  },
  {
    id: "CAL-27",
    case: "PAROL-D13",
    rule: "ret-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The deadline for return or destruction is ten days after the Disclosing Party's written request, which is shorter than the 30 days the standard requires.",
      explanation:
        "The carve-out for copies required by law and for routine backups is present and those copies remain subject to the Agreement, so the ten day deadline is the only departure from the standard.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote: "Within ten (10) days after the Disclosing Party's written request",
    },
    note: "Section 6.1 gives ten days from the written request, and the claim states the period in that frame. The carve-out for law and routine backups is in the same paragraph and the claim does not contradict it. D13 key ret-1 is a deviation.",
  },
  {
    id: "CAL-28",
    case: "PAROL-D09",
    rule: "dur-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "The Recipient's duties continue in perpetuity, are not limited to any number of years, and cover all Confidential Information whether or not it is a trade secret.",
      explanation:
        "Version 2 makes the duties permanent and removes the trade secret limit that the standard accepts, so they have no stated end for information that is not a trade secret.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote: "they cover all Confidential Information whether or not it is a trade secret",
    },
    note: "Section 5.1 of the operative version says the duties continue in perpetuity, are not limited to any number of years and cover trade secrets or not. D09 key dur-1 is a deviation.",
  },
  {
    id: "CAL-29",
    case: "PAROL-D10",
    rule: "pds-1",
    label: "supported",
    claim: {
      status: "deviation",
      discrepancy:
        "Corrimar may not give Confidential Information to any lawyer, accountant, auditor or other professional adviser, whether the adviser is engaged by Corrimar or by one of its Affiliates and whether or not the adviser owes a duty of confidence.",
      explanation:
        "Clause 4.1 lets Corrimar share with the employees, officers and contractors of itself and its Affiliates, but Clause 4.2 bars every professional adviser outright. The playbook lists the exclusion of advisers as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote:
        "Corrimar shall not give Confidential Information to any lawyer, accountant, auditor or other professional adviser",
    },
    note: "Section 4.2 is an outright bar on professional advisers, with no condition. The claim follows from the paragraph alone. D10 key pds-1 is a deviation.",
  },
  {
    id: "CAL-30",
    case: "PAROL-D11",
    rule: "pds-1",
    label: "unsupported",
    kind: "definition_as_duty",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 3 requires the Recipient to ensure that every Affiliate it shares Confidential Information with is bound by the Agreement, which meets the standard's condition that representatives be bound by equal duties.",
    },
    evidence: {
      doc: "D1",
      clause: "3",
      quote:
        "means any entity that directly or indirectly controls, is controlled by, or is under common control with a party",
    },
    note: "Clause 3 defines Affiliate and controls nothing: it requires nothing of the Recipient. The permission to share with representatives, and the condition that they be bound, are in clause 6 (D11 key pds-1). The finding reads a definition as the clause that imposes the duty.",
  },
  {
    id: "CAL-31",
    case: "PAROL-D13",
    rule: "ret-1",
    label: "unsupported",
    kind: "wrong_frame",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "The Agreement gives thirty days' written notice, which meets the 30 day minimum for return or destruction under the standard. The deadline is not shorter than thirty days, so ret-1 is compliant.",
    },
    evidence: {
      doc: "D1",
      clause: "5.1",
      quote: "the other thirty (30) days' written notice",
    },
    note: "The thirty days are the notice that either Party gives to end the Agreement early. The return deadline is in Section 6.1 and is ten days, so ret-1 is a deviation (D13 key). The finding reads thirty days in the wrong frame and so misses the real deadline.",
  },
  {
    id: "CAL-32",
    case: "PAROL-D05",
    rule: "pds-1",
    label: "unsupported",
    kind: "overlooked_exception",
    claim: {
      status: "deviation",
      discrepancy:
        "The Receiving Party may not disclose Confidential Information to any person, so it cannot share it with its employees, officers, contractors or professional advisers.",
      explanation:
        "Section 4.2 is a flat prohibition on disclosure to any person, with no right to share with representatives such as employees, officers, contractors or advisers, which the playbook treats as unacceptable.",
    },
    evidence: {
      doc: "D1",
      clause: "4.2",
      quote:
        "The Receiving Party shall not disclose Confidential Information to any person except as Section 5 permits",
    },
    note: "The sentence ends 'except as Section 5 permits', and Section 5.1 permits disclosure to employees, officers, contractors and professional advisers who need to know it. The finding reads the prohibition without its exception, although the quote includes it. D05 key pds-1 is compliant.",
  },
  {
    id: "CAL-33",
    case: "PAROL-D04",
    rule: "dur-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 6.1 continues the obligations for each item for thirty-six months from the relevant disclosure of that item and then ends them. Thirty-six months counted from each disclosure is three years, which is the standard.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote:
        "continue for thirty-six months from the relevant disclosure of that item, and then end",
    },
    note: "Thirty-six months from the disclosure of each item is three years in the standard's own frame, and the paragraph says so itself. D04 key dur-1 is compliant. Same paragraph as the unsupported pair that counts the months from the end of the discussions.",
  },
  {
    id: "CAL-34",
    case: "PAROL-D13",
    rule: "exc-1",
    label: "unsupported",
    kind: "overlooked_exception",
    claim: {
      status: "deviation",
      discrepancy:
        "Exclusion (a) takes out of protection all information that is or becomes generally available to the public, with no exception for information that became public through the Receiving Party's own breach, so it is wider than the standard.",
      explanation:
        "The standard allows the public information exclusion only where the information is or becomes public through no fault of the recipient. Section 2.1(a) states no such limit, so the exclusion is wider than the playbook allows.",
    },
    evidence: {
      doc: "D1",
      clause: "2.1",
      quote: "is or becomes generally available to the public",
    },
    note: "The same sentence continues 'other than through a breach of this Agreement by the Receiving Party', which is the limit the standard asks for, and the claim says that limit is missing. The finding reads the exclusion without its exception. D13 key exc-1 is compliant: all four exclusions are present and none needs written records.",
  },
  {
    id: "CAL-35",
    case: "PAROL-D07",
    rule: "ret-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Clause 6.1 gives forty-five days after the written request, which is longer than the 30 day minimum, and allows the Recipient to keep copies required by law and copies held in routine backup systems, which remain subject to the Agreement.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote:
        "Within forty-five (45) days after the Discloser's written request, the Recipient shall return or destroy the Discloser's Confidential Information",
    },
    note: "Forty-five days is longer than thirty, with the same carve-outs. D07 key ret-1 is compliant.",
  },
  {
    id: "CAL-36",
    case: "PAROL-D02",
    rule: "dur-1",
    label: "unsupported",
    kind: "definition_as_duty",
    claim: {
      status: "deviation",
      discrepancy:
        "Confidential Information is defined to include everything that the Discloser or its Affiliates disclose at any time and by any means, so the Recipient's duties attach to it with no end date.",
      explanation:
        "The definition reaches information disclosed at any time and takes in the Recipient's own notes and analyses, so the duty to protect it has no stated end for information that is not a trade secret.",
    },
    evidence: {
      doc: "D1",
      clause: "1.2",
      quote: "makes available to the Recipient at any time and by any means",
    },
    note: "Section 1.2 is a definition. 'At any time and by any means' says when and how the disclosure may be made, not how long the Recipient's duties last; the period is in Section 7.1 (perpetuity). The status is right, but the finding reads the definition as a duty with a duration. Same paragraph as the supported def-1 pair of D02.",
  },
  {
    id: "CAL-37",
    case: "PAROL-D01",
    rule: "ret-1",
    label: "supported",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 6.1 requires return or destruction within thirty days of the written request and allows the Recipient to keep copies that the law requires and copies held in routine backup systems, which stay subject to the Agreement. That meets the standard.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote: "except that it may keep copies that the law requires it to keep",
    },
    note: "The paragraph has thirty days, the written request and the carve-outs for law and routine backups with continued protection, and the claim reads the exception as the paragraph states it. Compare the unsupported ret-1 pair that reads such an exception as absent. D01 key ret-1 is compliant.",
  },
  {
    id: "CAL-38",
    case: "PAROL-D07",
    rule: "pds-1",
    label: "unsupported",
    kind: "definition_as_duty",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Section 1.3 requires the Recipient to confine disclosure to its Personnel, meaning the employees, officers, contractors and professional advisers of a Party and of its Affiliates, which is the representative regime the standard describes.",
    },
    evidence: {
      doc: "D1",
      clause: "1.3",
      quote:
        "means the employees, officers, contractors and professional advisers of a Party and of its Affiliates",
    },
    note: "Section 1.3 defines Personnel and nothing more. It imposes no duty to confine disclosure and says nothing about need to know or equal confidentiality duties; the duty and its conditions are in Section 4.1 (D07 key pds-1). The status is right, but the finding reads a definition as the clause that imposes the duty, so the cited paragraph does not support it.",
  },
  {
    id: "CAL-39",
    case: "PAROL-D04",
    rule: "dur-1",
    label: "unsupported",
    kind: "wrong_frame",
    claim: {
      status: "deviation",
      discrepancy:
        "The obligations continue for thirty-six months after the discussions end, so information disclosed early is protected for longer than the three years from disclosure that the standard allows.",
      explanation:
        "Clause 6.1 runs the thirty-six months from the end of the discussions and not from each disclosure, so the obligations can outlast three years from the date an item was disclosed.",
    },
    evidence: {
      doc: "D1",
      clause: "6.1",
      quote:
        "obligations in respect of an item of Confidential Information continue for thirty-six months",
    },
    note: "Clause 6.1 counts the thirty-six months from the relevant disclosure of each item, which is three years from each disclosure, the standard (D04 key dur-1 is compliant, and clause 6.2 leaves the period unchanged when the discussions end). The finding counts from the end of the discussions, the wrong frame, and flags a deviation that is not there.",
  },
  {
    id: "CAL-40",
    case: "PAROL-D05",
    rule: "dur-1",
    label: "unsupported",
    kind: "superseded",
    claim: {
      status: "compliant",
      discrepancy: "",
      explanation:
        "Amendment No. 1 deals with Section 6.1 but keeps the limit it sets, so the obligations of each Receiving Party still end two years after each disclosure. Two years counted from each disclosure is inside the three year standard.",
    },
    evidence: {
      doc: "D2",
      clause: "2",
      quote: "Section 6.1 of the Agreement is deleted in its entirety",
    },
    note: "The cited paragraph deletes Section 6.1, so the two year limit the finding relies on no longer exists and dur-1 is a deviation (D05 key). The finding reads a deletion as if it kept the term. Unlike the pair that cites the original Section 6.1, this paragraph shows the deletion, so the claim can be tested against what it says.",
  },
];
