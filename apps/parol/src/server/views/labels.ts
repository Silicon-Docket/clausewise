import type { Severity } from "@clausewise/playbook";
import type {
  CategoryId,
  DocumentKind,
  EscalationCode,
  EvidenceRole,
  FallbackBasis,
  GlobalRole,
  MatterRole,
  MatterStatus,
  QuoteCheck,
  ReviewDecision,
  RunStatus,
  Status,
  SupportCheck,
  WarningCode,
} from "../../contracts.js";

/**
 * The words pages use for every code in the data. A code never reaches a reader as it is stored:
 * each one has short plain words, and the ones that need it have a sentence. Each table is typed
 * as a complete record of its vocabulary, so a new member does not compile until it has a label,
 * and a test walks the vocabularies in contracts.ts as well.
 *
 * Values that arrive from the database at run time are looked up with `Object.hasOwn`, so a code
 * that is not in a table (a newer workflow, or hostile data) gets a fixed phrase and the lookup
 * never reaches a prototype property. No fallback echoes the unknown code.
 */

function lookup(table: Readonly<Record<string, string>>, key: unknown, fallback: string): string {
  return typeof key === "string" && Object.hasOwn(table, key) ? (table[key] as string) : fallback;
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

export const STATUS_LABEL: Record<Status, string> = {
  compliant: "Compliant",
  deviation: "Deviation",
  missing: "Missing",
  not_applicable: "Not applicable",
  undetermined: "Undetermined",
};

export const STATUS_MEANING: Record<Status, string> = {
  compliant: "The documents meet the playbook standard.",
  deviation: "The documents fall short of the playbook standard.",
  missing: "The playbook requires this and no clause covers it.",
  not_applicable: "The playbook does not require this and no clause covers it.",
  undetermined: "The workflow would not state a status. A person has to decide.",
};

/**
 * Rows that need action come first. A definite problem (deviation, missing) comes before a
 * question (undetermined), and the findings that need nothing come last.
 */
export const STATUS_ORDER: readonly Status[] = [
  "deviation",
  "missing",
  "undetermined",
  "compliant",
  "not_applicable",
];

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const SEVERITY_ORDER: readonly Severity[] = ["high", "medium", "low"];

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  parties: "Parties",
  "ci-definition": "Definition of Confidential Information",
  exclusions: "Exclusions",
  "permitted-disclosures": "Permitted disclosures",
  duration: "Duration",
  "return-destruction": "Return or destruction",
  "governing-law": "Governing law",
};

export const ROLE_LABEL: Record<EvidenceRole, string> = {
  governing: "Governing",
  supporting: "Supporting",
  superseded: "Superseded",
  conflicting: "Conflicting",
  definition: "Definition",
};

export const ROLE_MEANING: Record<EvidenceRole, string> = {
  governing: "This passage decides the status.",
  supporting: "This passage backs up the governing passage.",
  superseded: "A later passage replaces this one. It is shown for context and no longer applies.",
  conflicting: "This passage disagrees with another one.",
  definition: "This passage defines a term the other passages use.",
};

/** The order passages are shown in. Governing comes first because it decides the status. */
export const ROLE_ORDER: readonly EvidenceRole[] = [
  "governing",
  "supporting",
  "definition",
  "superseded",
  "conflicting",
];

/** Short enough for a chip in a table cell, and still a plain statement of the problem. */
export const ESCALATION_LABEL: Record<EscalationCode, string> = {
  quote_not_verified: "Quote not found",
  support_not_confirmed: "Support not confirmed",
  superseded_evidence: "Replaced clause relied on",
  conflicting_sources: "Sources conflict",
  missing_not_confirmed: "May not be missing",
  defined_term_unresolved: "Defined term unclear",
  parties_mismatch: "Client name differs",
  playbook_escalation: "Playbook says escalate",
  model_abstained: "No status given",
  output_invalid: "No valid answer",
  context_over_budget: "Too long to analyze",
};

export const ESCALATION_MEANING: Record<EscalationCode, string> = {
  quote_not_verified:
    "A cited passage could not be found in the document. It is struck through and is never exported.",
  support_not_confirmed:
    "The cited passages do not clearly establish the conclusion, or a number in the finding is not in them.",
  superseded_evidence:
    "The finding relies on a clause that an amendment replaces, without citing the amendment.",
  conflicting_sources: "Two passages disagree and the documents do not settle which one governs.",
  missing_not_confirmed:
    "The finding says the topic is missing, but the documents hold passages that may cover it.",
  defined_term_unresolved:
    "A defined term the finding relies on is undefined, or is defined in two ways.",
  parties_mismatch: "The client's legal name from intake does not appear in the parties passage.",
  playbook_escalation: "The playbook says this situation goes to an attorney.",
  model_abstained: "The workflow declined to state a status and said why.",
  output_invalid: "The workflow produced no valid answer for this rule.",
  context_over_budget:
    "The text for this rule was too long to analyze, so the rule was not analyzed.",
};

export const QUOTE_CHECK_LABEL: Record<QuoteCheck, string> = {
  verified: "Quote found",
  not_found: "Quote not found",
  ambiguous: "Quote found more than once",
};

export const QUOTE_CHECK_MEANING: Record<QuoteCheck, string> = {
  verified: "The quote appears word for word in this paragraph, once.",
  not_found: "The quote does not appear in this paragraph.",
  ambiguous:
    "The quote appears more than once in this paragraph, so it does not point to one place.",
};

export const SUPPORT_CHECK_LABEL: Record<SupportCheck, string> = {
  supported: "Supported",
  not_supported: "Not supported",
  insufficient: "Not enough to support",
  not_run: "Support not checked",
};

export const SUPPORT_CHECK_MEANING: Record<SupportCheck, string> = {
  supported:
    "A second check, shown only the cited passages, agrees that they support the conclusion.",
  not_supported:
    "A second check, shown only the cited passages, says they do not support the conclusion.",
  insufficient: "A second check says the cited passages are not enough to decide.",
  not_run: "No second check was run on this passage.",
};

export const FALLBACK_BASIS_LABEL: Record<FallbackBasis, string> = {
  approved_verbatim: "Approved playbook text, unchanged",
  approved_adapted: "Approved playbook text, adapted to these documents",
  generated: "Wording written by the workflow, not approved playbook text",
  none: "No suggested wording",
};

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/**
 * The checks verify can record, from the order in src/stages/verify.ts. The list is not in
 * contracts.ts, so a test reads that source and fails if verify gains a check this table lacks.
 */
export const CHECK_LABEL = {
  quote_exists: "Quotes appear word for word in the cited paragraphs",
  span_in_bundle: "Cited paragraphs were among the text the workflow was given",
  evidence_set: "The list of cited passages is complete and has no repeats",
  citation_shape: "The status is cited the way it requires",
  numeric_consistency: "Numbers in the finding appear in the cited text",
  precedence_labels: "Passage labels follow the rules for which document governs",
  superseded_evidence: "The finding does not rely on a clause an amendment replaces",
  parties: "The client's legal name appears in the parties passage",
  missing_confirmation: "A finding of missing is not contradicted by candidate passages",
  playbook_escalation: "Playbook conditions for escalation",
  defined_term: "Defined terms are defined once",
  instruction_like_text: "Cited paragraphs do not read like an instruction to software",
  support: "A second check agrees the cited passages support the conclusion",
  model_abstained: "The workflow stated a status",
  status_forced: "The status was kept as the workflow stated it",
  fallback_basis: "Where the suggested wording comes from",
} as const satisfies Record<string, string>;

export type CheckId = keyof typeof CHECK_LABEL;
export const CHECK_IDS = Object.keys(CHECK_LABEL) as CheckId[];

export const CHECK_OUTCOME_LABEL: Record<"pass" | "fail" | "not_applicable", string> = {
  pass: "Passed",
  fail: "Failed",
  not_applicable: "Not applicable",
};

export const CHECK_KIND_LABEL: Record<"deterministic" | "model", string> = {
  deterministic: "Automatic check",
  model: "Model check",
};

// ---------------------------------------------------------------------------------------------
// Matters, runs, documents
// ---------------------------------------------------------------------------------------------

export const WARNING_LABEL: Record<WarningCode, string> = {
  instruction_like_text: "Reads like an instruction to software",
  duplicate_document: "Duplicate document",
  near_duplicate_version: "Nearly the same as the previous version",
  unreviewed_content: "Content that is not reviewed",
  no_reviewable_text: "No text to review",
};

export const WARNING_MEANING: Record<WarningCode, string> = {
  instruction_like_text:
    "This paragraph reads like an instruction to software. The review gives it to the model as document text, and Parol cannot show that a model ignored it. Read the paragraph yourself and check any finding that cites it. In the label, the number after p counts the paragraphs of the file from zero, tables included.",
  duplicate_document:
    "This document has the same text as another document in the matter. Keep only the one you need.",
  near_duplicate_version:
    "This version is almost the same as the version before it. Check that you uploaded the right file.",
  unreviewed_content:
    "This Word file holds footnotes, headers, hidden text or comments that the review does not read, or tracked changes that are not resolved, which the review reads as if every change had been accepted. Read the file yourself.",
  no_reviewable_text: "This file has no text that can be reviewed.",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  ingesting: "Reading documents",
  extracting: "Locating passages",
  retrieving: "Gathering context",
  analyzing: "Analyzing rules",
  verifying: "Checking findings",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
  superseded: "Superseded",
};

export const RUN_STATUS_MEANING: Record<RunStatus, string> = {
  queued: "The review is waiting to start.",
  ingesting: "The documents are being read and split into paragraphs.",
  extracting: "The passages that matter for each topic are being located.",
  retrieving: "The text each rule needs is being gathered.",
  analyzing: "Each playbook rule is being applied to its text.",
  verifying: "Each finding is being checked against the documents.",
  succeeded: "The review finished and the findings are ready.",
  failed: "The review stopped before it finished.",
  cancelled: "The review was cancelled.",
  superseded:
    "The documents or playbook changed after this review, so its findings are out of date.",
};

const ACTIVE_RUN: ReadonlySet<string> = new Set<RunStatus>([
  "queued",
  "ingesting",
  "extracting",
  "retrieving",
  "analyzing",
  "verifying",
]);

/** Whether a run is still working, so a page shows progress and the script polls. */
export const isActiveRun = (status: unknown): boolean =>
  typeof status === "string" && ACTIVE_RUN.has(status);

export const PROGRESS_STAGE_LABEL: Record<
  "ingest" | "extract" | "retrieve" | "analyze" | "verify",
  string
> = {
  ingest: "Reading documents",
  extract: "Locating passages",
  retrieve: "Gathering context",
  analyze: "Analyzing rules",
  verify: "Checking findings",
};

export const MATTER_STATUS_LABEL: Record<MatterStatus, string> = {
  draft: "Draft",
  ready: "Ready to review",
  running: "Review running",
  in_review: "In review",
  review_complete: "Review complete",
  exported: "Memo exported",
  stale: "Out of date",
  deleted: "Deleted",
};

export const MATTER_STATUS_MEANING: Record<MatterStatus, string> = {
  draft: "Documents or settings are still missing.",
  ready: "Everything needed for a review is in place.",
  running: "A review is running.",
  in_review: "The findings are waiting for a reviewing attorney's decisions.",
  review_complete: "Every finding has a decision. The memo can be exported.",
  exported: "A memo has been exported.",
  stale: "A document or the playbook changed after the last review.",
  deleted: "This matter has been deleted.",
};

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  nda: "NDA",
  amendment: "Amendment",
};

export const MATTER_ROLE_LABEL: Record<MatterRole, string> = {
  associate: "Associate",
  reviewer: "Reviewing attorney",
  viewer: "Viewer",
};

export const GLOBAL_ROLE_LABEL: Record<GlobalRole, string> = {
  member: "Member",
  legal_engineer: "Legal engineer",
  admin: "Administrator",
};

export const DECISION_LABEL: Record<ReviewDecision, string> = {
  accept: "Accepted",
  edit: "Edited",
  reject: "Rejected",
  escalate: "Escalated",
};

export const DECISION_VERB: Record<ReviewDecision, string> = {
  accept: "Accept",
  edit: "Edit",
  reject: "Reject",
  escalate: "Escalate",
};

export const DECISION_HINT: Record<ReviewDecision, string> = {
  accept: "The finding is right as shown.",
  edit: "The finding needs changes. Use the fields below. A reason is required.",
  reject: "The finding is wrong. A reason is required.",
  escalate: "Send it to a partner, or leave it open in the memo. A reason is required.",
};

/** Decisions that must come with a reason. */
export const DECISIONS_NEEDING_REASON: readonly ReviewDecision[] = ["edit", "reject", "escalate"];

/**
 * What a run's `errorKind` means to a person, with what to do about it. The kinds a run can end
 * with are the closed set RUN_ERROR_KINDS in services/run-support.ts, and a test in
 * test/integration/layers.test.ts fails when this table and that set differ: a kind without
 * wording, or wording for a kind nothing sets. A cancelled or superseded run has a status of its
 * own and no error kind. A resume is refused
 * when the provider or model of the process differs from the run's, so a kind that is fixed by
 * changing the model says to start a new review.
 */
export const RUN_ERROR_MEANING: Record<string, string> = {
  interrupted: "The server stopped while the review was running. Resume it to carry on.",
  provider_auth:
    "The model provider did not accept the credentials. Fix the configuration, then resume.",
  provider_permission:
    "The model provider refused this account or key. Check what it is allowed to use, then resume.",
  provider_model:
    "The model provider does not know the configured model. Fix the model name and start a new review.",
  provider_billing:
    "The model provider reports a billing or quota problem on the account. Fix it, then resume.",
  provider_redirect:
    "The model provider's address redirected the request, which Parol does not follow. Check the configured address, then resume.",
  internal:
    "The review stopped because of a fault in Parol. Resume it, and report it if it stops again.",
};

// ---------------------------------------------------------------------------------------------
// Lookups for values that come from the database
// ---------------------------------------------------------------------------------------------

export const statusLabel = (v: unknown): string => lookup(STATUS_LABEL, v, "Unknown status");
export const statusMeaning = (v: unknown): string =>
  lookup(STATUS_MEANING, v, "This status has no description.");
export const severityLabel = (v: unknown): string => lookup(SEVERITY_LABEL, v, "Unknown severity");
export const categoryLabel = (v: unknown): string => lookup(CATEGORY_LABEL, v, "Other topic");
export const roleLabel = (v: unknown): string => lookup(ROLE_LABEL, v, "Unlabelled");
export const roleMeaning = (v: unknown): string =>
  lookup(ROLE_MEANING, v, "This passage has no role this page can describe.");
export const escalationLabel = (v: unknown): string =>
  lookup(ESCALATION_LABEL, v, "Flag with no wording");
export const escalationMeaning = (v: unknown): string =>
  lookup(ESCALATION_MEANING, v, "The workflow raised a flag that this page has no wording for.");
export const quoteCheckLabel = (v: unknown): string =>
  lookup(QUOTE_CHECK_LABEL, v, "Quote check unknown");
export const quoteCheckMeaning = (v: unknown): string =>
  lookup(QUOTE_CHECK_MEANING, v, "The result of this check is not known to the page.");
export const supportCheckLabel = (v: unknown): string =>
  lookup(SUPPORT_CHECK_LABEL, v, "Support check unknown");
export const supportCheckMeaning = (v: unknown): string =>
  lookup(SUPPORT_CHECK_MEANING, v, "The result of this check is not known to the page.");
export const fallbackBasisLabel = (v: unknown): string =>
  lookup(FALLBACK_BASIS_LABEL, v, "No recorded basis");
export const checkLabel = (v: unknown): string => lookup(CHECK_LABEL, v, "Another check");
export const checkOutcomeLabel = (v: unknown): string =>
  lookup(CHECK_OUTCOME_LABEL, v, "Result unknown");
export const checkKindLabel = (v: unknown): string => lookup(CHECK_KIND_LABEL, v, "Check");
export const warningLabel = (v: unknown): string => lookup(WARNING_LABEL, v, "Warning");
export const warningMeaning = (v: unknown): string =>
  lookup(
    WARNING_MEANING,
    v,
    "The upload check raised a warning that this page has no wording for.",
  );
export const runStatusLabel = (v: unknown): string => lookup(RUN_STATUS_LABEL, v, "Unknown");
export const runStatusMeaning = (v: unknown): string =>
  lookup(RUN_STATUS_MEANING, v, "The state of this review is not known to the page.");
export const progressStageLabel = (v: unknown): string =>
  lookup(PROGRESS_STAGE_LABEL, v, "Working");
export const matterStatusLabel = (v: unknown): string => lookup(MATTER_STATUS_LABEL, v, "Unknown");
export const matterStatusMeaning = (v: unknown): string =>
  lookup(MATTER_STATUS_MEANING, v, "The state of this matter is not known to the page.");
export const documentKindLabel = (v: unknown): string => lookup(DOCUMENT_KIND_LABEL, v, "Document");
export const matterRoleLabel = (v: unknown): string => lookup(MATTER_ROLE_LABEL, v, "Member");
export const globalRoleLabel = (v: unknown): string => lookup(GLOBAL_ROLE_LABEL, v, "Member");
export const decisionLabel = (v: unknown): string => lookup(DECISION_LABEL, v, "Decided");
export const runErrorMeaning = (v: unknown): string =>
  lookup(RUN_ERROR_MEANING, v, "The review stopped for a reason this page has no wording for.");
