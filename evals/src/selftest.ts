import type { OracleRule } from "@clausewise/review/testing";
import type { Fixture } from "./fixtures.js";

interface ScriptedEdit {
  clauseNumber: string;
  quote: string;
  replacement: string;
}

/**
 * The edits a perfect reviewer would propose for the shipped fixtures, so that a selftest has
 * tracked changes to write and then check. Each quote occurs once, as whole words, in its clause.
 * A fixture or a rule with no entry here simply gets no edit, so adding a fixture needs nothing.
 */
const EDITS: Record<string, Record<string, ScriptedEdit>> = {
  "nda-aggressive.docx": {
    mutuality: {
      clauseNumber: "1.1",
      quote: "disclosed by or on behalf of Discloser to Recipient",
      replacement: "disclosed by or on behalf of either party to the other",
    },
    definition: {
      clauseNumber: "1.1",
      quote: "whether or not marked or identified as confidential",
      replacement: "that is marked as confidential or that a reasonable person would so understand",
    },
    exclusions: {
      clauseNumber: "1.2",
      quote:
        "only if it has entered the public domain other than through any act or omission of Recipient",
      replacement:
        "if it is or becomes public through no fault of Recipient, was already known to Recipient, was independently developed by Recipient, or was received from a third party without a duty of confidence",
    },
    term: {
      clauseNumber: "3.1",
      quote: "are perpetual and shall continue indefinitely",
      replacement: "end three (3) years after the date of disclosure",
    },
    "permitted-use": {
      clauseNumber: "2.2",
      quote:
        "shall not disclose Confidential Information to any employee, adviser, contractor or affiliate without the prior written consent of Discloser in each case",
      replacement:
        "may disclose Confidential Information to those of its employees, advisers, contractors and affiliates who need to know it for the Purpose and are bound by duties of confidentiality no less protective than those in this Agreement",
    },
    "return-or-destroy": {
      clauseNumber: "4.1",
      quote: "Within five (5) days of any request",
      replacement: "Within thirty (30) days of any request",
    },
    remedies: {
      clauseNumber: "5.2",
      quote:
        "liquidated damages of fifty thousand dollars (US$50,000) for each breach, which the parties agree is a reasonable estimate of loss and not a penalty",
      replacement: "damages as provided by law",
    },
    "restrictive-covenants": {
      clauseNumber: "6.1",
      quote:
        "engage in any business that competes with Discloser, or solicit any customer or employee of Discloser",
      replacement: "solicit any employee of Discloser, other than through general advertising",
    },
    "governing-law": {
      clauseNumber: "7.1",
      quote: "the laws of Singapore",
      replacement: "the laws of the State of Delaware",
    },
  },
  "saas-vendor-friendly.docx": {
    "liability-cap": {
      clauseNumber: "9.1",
      quote: "the fees paid by Customer in the month before the claim arose",
      replacement:
        "the greater of the fees paid by Customer in the twelve (12) months before the claim arose and US$1,000,000",
    },
    "ip-indemnity": {
      clauseNumber: "8.1",
      quote: "a United States patent",
      replacement: "any patent, copyright, trade secret or trademark",
    },
    "data-ownership": {
      clauseNumber: "3.1",
      quote:
        "a perpetual, worldwide licence to use, copy and analyse Customer Data to develop, train and improve Vendor's products and machine-learning models, and to share Customer Data with Vendor's business partners",
      replacement:
        "a limited licence to use Customer Data solely to provide the Services to Customer",
    },
    "security-controls": {
      clauseNumber: "4.1",
      quote: "Vendor shall use commercially reasonable efforts to protect Customer Data",
      replacement:
        "Vendor shall maintain industry-standard security controls and an independent SOC 2 Type II audit report, and shall protect Customer Data accordingly",
    },
    "breach-notice": {
      clauseNumber: "4.1",
      quote:
        "Vendor may, at its discretion, notify Customer of any unauthorised access to Customer Data",
      replacement:
        "Vendor shall notify Customer within seventy-two (72) hours after becoming aware of any unauthorised access to Customer Data",
    },
    "term-renewal": {
      clauseNumber: "2.2",
      quote: "one hundred twenty (120) days",
      replacement: "thirty (30) days",
    },
    "price-increase": {
      clauseNumber: "2.3",
      quote: "by any amount",
      replacement:
        "by no more than the lesser of five percent (5%) and the annual change in a named consumer price index",
    },
    "termination-refund": {
      clauseNumber: "7.3",
      quote: "Fees are not refundable on any termination",
      replacement:
        "On termination by Customer for Vendor's breach, Vendor shall refund prepaid fees for the remainder of the Subscription Term",
    },
    "governing-law": {
      clauseNumber: "10.1",
      quote: "the laws of Ireland",
      replacement: "the laws of the State of Oregon",
    },
  },
};

/**
 * What a perfect reviewer says about each rule of a fixture: the status expected.json lists, with
 * the scripted edit for a deviation. It names the edit's clause so that, in a review split into
 * windows, the answer comes from the window that holds it.
 */
export function oracleScripts(fixture: Fixture): Record<string, OracleRule> {
  const scripts: Record<string, OracleRule> = {};
  for (const [ruleId, status] of Object.entries(fixture.expected)) {
    const edit = status === "deviation" ? EDITS[fixture.name]?.[ruleId] : undefined;
    scripts[ruleId] =
      edit === undefined ? { status } : { status, clauseNumbers: [edit.clauseNumber], edit };
  }
  return scripts;
}
