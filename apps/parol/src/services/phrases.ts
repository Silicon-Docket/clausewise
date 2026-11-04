import type { WarningCode } from "../contracts.js";

/**
 * Every sentence a service hands to a page that is not data from the database. They are fixed
 * words: none of them is built from a document, a model, a name or a reason a person typed, so a
 * page can show them and a test can pin them.
 */

export const START_REASONS = {
  noPlaybook: "Choose a playbook",
  noNda: "Upload the NDA",
  noOperative: "Choose which version of each document is operative",
  noReviewableText: "A document has no reviewable text",
  runInFlight: "A review is already running",
} as const;

/** Why results are stale, by the code the store keeps as a finding's `stale_reason`. */
const STALE_PHRASES: Record<string, string> = {
  document_changed: "A document was replaced by a new version after this review.",
  document_added: "A document was added after this review.",
  document_removed: "A document was removed after this review.",
  operative_changed: "The operative version of a document changed after this review.",
  stated_date_changed: "The stated date of a document changed after this review.",
  client_name_changed: "The client's legal name changed after this review.",
  playbook_changed: "The playbook version changed after this review.",
  rerun_requested: "A new review was requested.",
};
export const STALE_FALLBACK = "The inputs changed after this review.";
export const staleReasonPhrase = (code: string | null): string =>
  (code !== null && Object.hasOwn(STALE_PHRASES, code) ? STALE_PHRASES[code] : undefined) ??
  STALE_FALLBACK;

export const CANNOT_DECIDE = {
  role: "Only the reviewing attorney can record a decision.",
  segregation: "A reviewer cannot decide findings of a review they started.",
  stale: "The documents or the playbook changed after this finding. Run the review again.",
  exported: "The memo is exported. Decisions can change only after a new review.",
  notOpen: "The matter is not open for review.",
  runNotCurrent: "This finding belongs to a review that is no longer current.",
} as const;

/**
 * What a person is told about an upload, naming the earlier version by its label and number. A
 * document's title is something a person typed, so it is not repeated here.
 */
export const nearDuplicateDetail = (label: string, versionNo: number): string =>
  `same text as ${label} v${versionNo}, saved as a different file`;
export const duplicateDetail = (label: string, versionNo: number): string =>
  `same file as ${label} v${versionNo}, not stored again`;

export const UNKNOWN_USER_NAME = "(unknown user)";

export const WARNING_ORDER: readonly WarningCode[] = [
  "instruction_like_text",
  "unreviewed_content",
  "no_reviewable_text",
  "near_duplicate_version",
  "duplicate_document",
];
