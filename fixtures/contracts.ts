/**
 * Synthetic contracts for tests and evals. Every party, term and sentence here was written for
 * this project. Do not paste text from real agreements or from other products' templates.
 */

export type Expected = "compliant" | "deviation" | "missing" | "n/a";

export interface Section {
  heading: string;
  clauses: string[];
}

export interface Contract {
  file: string;
  title: string;
  intro: string[];
  sections: Section[];
  /** Playbook this contract is meant to be reviewed against, relative to the repo root. */
  playbook: string;
  /** What a correct review should conclude for each rule in that playbook. */
  expected: Record<string, Expected>;
  parties: [string, string];
}

export const contracts: Contract[] = [
  {
    file: "nda-aggressive.docx",
    title: "CONFIDENTIALITY AGREEMENT",
    parties: ["Northwind Holdings, Inc.", "Fabrikam Labs LLC"],
    playbook: "playbooks/nda-mutual.yaml",
    intro: [
      'This Confidentiality Agreement (the "Agreement") is made on 1 March 2026 between Northwind Holdings, Inc., a Delaware corporation ("Discloser"), and Fabrikam Labs LLC, a California limited liability company ("Recipient").',
      'The parties wish to explore a possible commercial relationship (the "Purpose").',
    ],
    sections: [
      {
        heading: "1. Confidential Information",
        clauses: [
          '1.1 "Confidential Information" means all information of any kind disclosed by or on behalf of Discloser to Recipient, in any form and whether or not marked or identified as confidential, together with the existence and content of the parties\' discussions.',
          "1.2 Information is not Confidential Information only if it has entered the public domain other than through any act or omission of Recipient.",
        ],
      },
      {
        heading: "2. Obligations of Recipient",
        clauses: [
          "2.1 Recipient shall hold all Confidential Information in strict confidence, shall use it solely for the Purpose, and shall not disclose it to any person.",
          "2.2 Recipient shall not disclose Confidential Information to any employee, adviser, contractor or affiliate without the prior written consent of Discloser in each case.",
        ],
      },
      {
        heading: "3. Term",
        clauses: [
          "3.1 Recipient's obligations under this Agreement are perpetual and shall continue indefinitely, whether or not the parties proceed with any transaction.",
        ],
      },
      {
        heading: "4. Return of Information",
        clauses: [
          "4.1 Within five (5) days of any request, Recipient shall return or permanently destroy all Confidential Information in every form, including all copies held in automatic backup systems, and shall deliver a certificate to that effect signed by an officer of Recipient.",
        ],
      },
      {
        heading: "5. Remedies",
        clauses: [
          "5.1 Recipient acknowledges that any breach would cause Discloser irreparable harm for which damages are an inadequate remedy.",
          "5.2 Recipient shall pay Discloser liquidated damages of fifty thousand dollars (US$50,000) for each breach, which the parties agree is a reasonable estimate of loss and not a penalty.",
          "5.3 Discloser may obtain injunctive relief without posting a bond. Recipient shall pay all legal costs of Discloser in enforcing this Agreement, whatever the outcome.",
        ],
      },
      {
        heading: "6. Restrictive Covenants",
        clauses: [
          "6.1 For twenty-four (24) months after the date of this Agreement, Recipient shall not, directly or indirectly, engage in any business that competes with Discloser, or solicit any customer or employee of Discloser.",
        ],
      },
      {
        heading: "7. General",
        clauses: [
          "7.1 This Agreement is governed by the laws of Singapore, and the parties submit to the exclusive jurisdiction of the courts of Singapore.",
          "7.2 This Agreement is the entire agreement between the parties on its subject matter and may be changed only in writing signed by both parties.",
        ],
      },
    ],
    expected: {
      mutuality: "deviation",
      definition: "deviation",
      exclusions: "deviation",
      term: "deviation",
      "permitted-use": "deviation",
      "compelled-disclosure": "missing",
      "return-or-destroy": "deviation",
      remedies: "deviation",
      "restrictive-covenants": "deviation",
      "governing-law": "deviation",
    },
  },
  {
    file: "nda-balanced.docx",
    title: "MUTUAL NON-DISCLOSURE AGREEMENT",
    parties: ["Contoso Software, Inc.", "Tailspin Analytics Ltd."],
    playbook: "playbooks/nda-mutual.yaml",
    intro: [
      'This Mutual Non-Disclosure Agreement (the "Agreement") is made on 1 March 2026 (the "Effective Date") between Contoso Software, Inc., a Delaware corporation, and Tailspin Analytics Ltd., a company registered in England and Wales.',
      'The parties wish to evaluate a possible partnership (the "Purpose") and each may disclose confidential information to the other for that Purpose.',
    ],
    sections: [
      {
        heading: "1. Definitions",
        clauses: [
          '1.1 A party that discloses Confidential Information is the "Disclosing Party" and a party that receives it is the "Receiving Party". Each party may be either, and every obligation in this Agreement applies equally to each party as Receiving Party.',
          '1.2 "Confidential Information" means non-public information disclosed by the Disclosing Party to the Receiving Party that is marked as confidential or that a reasonable person would understand to be confidential from its nature or the circumstances of its disclosure.',
        ],
      },
      {
        heading: "2. Exclusions",
        clauses: [
          "2.1 Confidential Information does not include information that (a) is or becomes publicly available through no fault of the Receiving Party; (b) was known to the Receiving Party before disclosure, without a duty of confidentiality; (c) is independently developed by the Receiving Party without use of the Disclosing Party's Confidential Information; or (d) is received from a third party without breach of any duty of confidence.",
        ],
      },
      {
        heading: "3. Obligations",
        clauses: [
          "3.1 The Receiving Party shall use Confidential Information only for the Purpose and shall protect it with at least the care it uses for its own confidential information, and no less than reasonable care.",
          "3.2 The Receiving Party may share Confidential Information with its employees, contractors, affiliates and professional advisers who need to know it for the Purpose and who are bound by duties of confidentiality no less protective than those in this Agreement.",
        ],
      },
      {
        heading: "4. Compelled Disclosure",
        clauses: [
          "4.1 The Receiving Party may disclose Confidential Information to the extent required by law, court order or a regulator, provided that, where legally permitted and reasonably practicable, it gives the Disclosing Party prompt notice so that the Disclosing Party may seek a protective order.",
        ],
      },
      {
        heading: "5. Term",
        clauses: [
          "5.1 This Agreement applies to Confidential Information disclosed during the two (2) years after the Effective Date. The Receiving Party's obligations for each item of Confidential Information continue for three (3) years after its disclosure, except that trade secrets remain protected for as long as they qualify as trade secrets under applicable law.",
        ],
      },
      {
        heading: "6. Remedies",
        clauses: [
          "6.1 Either party may seek injunctive or other equitable relief for an actual or threatened breach of this Agreement, in addition to any other remedy available at law.",
          "6.2 Each party bears its own legal costs, unless a court awards costs to the prevailing party.",
        ],
      },
      {
        heading: "7. General",
        clauses: [
          "7.1 Neither party is obliged to disclose any information or to enter into any further agreement, and no licence to any intellectual property is granted by this Agreement.",
          "7.2 This Agreement is governed by the laws of the State of Delaware, and the parties submit to the non-exclusive jurisdiction of the state and federal courts located in Delaware.",
          "7.3 This Agreement is the entire agreement between the parties on its subject matter and may be changed only in writing signed by both parties.",
        ],
      },
    ],
    expected: {
      mutuality: "compliant",
      definition: "compliant",
      exclusions: "compliant",
      term: "compliant",
      "permitted-use": "compliant",
      "compelled-disclosure": "compliant",
      "return-or-destroy": "n/a",
      remedies: "compliant",
      "restrictive-covenants": "compliant",
      "governing-law": "compliant",
    },
  },
  {
    file: "saas-vendor-friendly.docx",
    title: "SUBSCRIPTION SERVICES AGREEMENT",
    parties: ["Cloudhaven Systems Ltd.", "Harborview Logistics, Inc."],
    playbook: "playbooks/saas-customer.yaml",
    intro: [
      'This Subscription Services Agreement (the "Agreement") is made on 1 March 2026 between Cloudhaven Systems Ltd., a company incorporated in Ireland ("Vendor"), and Harborview Logistics, Inc., an Oregon corporation ("Customer").',
    ],
    sections: [
      {
        heading: "1. Services",
        clauses: [
          '1.1 Vendor shall make its hosted route-planning software (the "Services") available to Customer during the Subscription Term in accordance with the order form signed by the parties (the "Order Form").',
        ],
      },
      {
        heading: "2. Fees and Term",
        clauses: [
          "2.1 Customer shall pay the fees in the Order Form annually in advance. All fees are non-refundable.",
          '2.2 The initial subscription term is twelve (12) months (the "Subscription Term"). It renews automatically for successive terms of twelve (12) months unless Customer gives written notice of non-renewal at least one hundred twenty (120) days before the end of the then-current term.',
          "2.3 Vendor may increase the fees on any renewal by any amount, by notice given at any time before the renewal date.",
        ],
      },
      {
        heading: "3. Customer Data",
        clauses: [
          "3.1 As between the parties, Customer owns all data that Customer submits to the Services (\"Customer Data\"). Customer grants Vendor a perpetual, worldwide licence to use, copy and analyse Customer Data to develop, train and improve Vendor's products and machine-learning models, and to share Customer Data with Vendor's business partners.",
        ],
      },
      {
        heading: "4. Security",
        clauses: [
          "4.1 Vendor shall use commercially reasonable efforts to protect Customer Data. Vendor may, at its discretion, notify Customer of any unauthorised access to Customer Data.",
        ],
      },
      {
        heading: "5. Availability",
        clauses: [
          "5.1 Vendor shall make the Services available at least 99.9 percent of the time in each calendar month, excluding scheduled maintenance announced at least five days in advance.",
          "5.2 If availability in a month is below 99.9 percent, Vendor shall credit Customer with the service credits set out in Schedule A.",
          "5.3 If availability is below 99 percent in any two months of a rolling six-month period, Customer may terminate this Agreement by written notice and receive a refund of prepaid fees for the remainder of the Subscription Term.",
        ],
      },
      {
        heading: "6. Suspension",
        clauses: [
          "6.1 Vendor may suspend the Services only (a) where reasonably necessary to prevent a security threat to the Services, or (b) for non-payment of undisputed fees more than thirty (30) days overdue after written notice. Vendor shall restore the Services promptly once the cause has been remedied.",
        ],
      },
      {
        heading: "7. Termination",
        clauses: [
          "7.1 Either party may terminate this Agreement for a material breach by the other that is not cured within thirty (30) days after written notice.",
          "7.2 Vendor may also terminate this Agreement for convenience on thirty (30) days' written notice.",
          "7.3 Fees are not refundable on any termination.",
        ],
      },
      {
        heading: "8. Intellectual Property Indemnity",
        clauses: [
          "8.1 Vendor shall defend Customer against a third-party claim that the Services infringe a United States patent, and shall pay damages finally awarded, up to the fees paid by Customer in the month before the claim arose.",
        ],
      },
      {
        heading: "9. Limitation of Liability",
        clauses: [
          "9.1 Vendor's total liability arising out of this Agreement is limited to the fees paid by Customer in the month before the claim arose.",
          "9.2 Customer's liability under this Agreement is not limited.",
          "9.3 Vendor is not liable for any indirect, incidental or consequential loss.",
        ],
      },
      {
        heading: "10. General",
        clauses: [
          "10.1 This Agreement is governed by the laws of Ireland, and the parties submit to the exclusive jurisdiction of the courts of Dublin, Ireland.",
          "10.2 This Agreement is the entire agreement between the parties on its subject matter and may be changed only in writing signed by both parties.",
        ],
      },
    ],
    expected: {
      "liability-cap": "deviation",
      "ip-indemnity": "deviation",
      "data-ownership": "deviation",
      "security-and-breach": "deviation",
      availability: "compliant",
      "term-renewal": "deviation",
      "termination-refund": "deviation",
      suspension: "compliant",
      "data-return": "missing",
      "governing-law": "deviation",
    },
  },
];
