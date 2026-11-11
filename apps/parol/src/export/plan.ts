import type { Severity } from "@clausewise/playbook";
import {
  DETERMINED_STATUSES,
  EVIDENCE_ROLES,
  STATUSES,
  type CategoryId,
  type EvidenceRole,
  type FallbackBasis,
  type Status,
} from "../contracts.js";
import type { MemoFinding, MemoInput } from "../module-contracts.js";
import { verifyQuote } from "../quotes.js";
import { settlementReason } from "../settlement.js";
import { memoUsageText } from "../usage/summary.js";
import { formatUtcDate, parseUtcInstant } from "./dates.js";
import { MemoGateError } from "./errors.js";
import {
  CATEGORY_LABEL,
  ESCALATION_PLAIN,
  MAX_WARNING_LOCATIONS,
  ROLE_LABEL,
  ROLE_ORDER,
  SEVERITIES_IN_ORDER,
  SHORT_HASH_LENGTH,
  UNKNOWN_ESCALATION_PLAIN,
  UNREAD_PART_LABEL,
  UNRESOLVED_CHANGE_LABEL,
  type Decision,
} from "./labels.js";
import { containBidi, printableId, sanitizeXmlText, truncateQuote } from "./sanitize.js";

/**
 * Everything the memo says, decided and checked, before any Word file is touched. The export gates
 * live here so they hold for whatever renders the plan, and so a refusal never leaves a half
 * built document behind.
 */

const DECISIONS: readonly Decision[] = ["accept", "edit", "reject", "escalate"];
const SEVERITIES: readonly string[] = SEVERITIES_IN_ORDER;
const BASES: readonly string[] = ["approved_adapted", "approved_verbatim", "generated", "none"];

export type OpenReason =
  | "escalated_by_reviewer"
  | "accepted_with_system_flags"
  | "edited_with_system_flags"
  | "no_status_stated";

export interface EvidenceView {
  roleLabel: string;
  /** The label the workflow gave, set only when the reviewer changed the role. */
  roleWorkflowLabel: string | null;
  /** Verified against the stored span text, then cleaned for XML and shortened for display. */
  quote: string;
  location: string;
  /** More than one means the words occur again in the same paragraph. */
  occurrences: number;
}

export interface FlagView {
  plain: string;
  detail: string;
}

export interface FindingView {
  number: number;
  ruleKey: string;
  /** The rule key in capitals, as the worked example prints it. */
  ruleId: string;
  title: string;
  severity: Severity;
  decision: Decision;
  reviewerName: string;
  decidedOn: string;
  reason: string | null;
  /** What the reviewer's decision leaves as the status. Rejected findings state none. */
  status: Status;
  proposedStatus: Status;
  statusEdited: boolean;
  /** The status the workflow stated, when the playbook's flags settled it to another one. */
  modelStatus: Status | null;
  /** Why the rule settles it so (one of three fixed texts), or null when the input gave no flags. */
  settlementReason: string | null;
  discrepancy: string;
  discrepancyEdited: boolean;
  discrepancyOriginal: string;
  explanation: string;
  conflict: string | null;
  abstainReason: string | null;
  evidence: EvidenceView[];
  /** How many passages the reviewer relabelled. */
  rolesEdited: number;
  omittedQuotes: number;
  language: string | null;
  languageEdited: boolean;
  languageOriginal: string | null;
  basis: FallbackBasis;
  flags: FlagView[];
  systemEscalated: boolean;
  openReason: OpenReason | null;
}

export interface ProvenanceView {
  matterId: string;
  runId: string;
  workflowLabel: string;
  workflowShortHash: string;
  playbookName: string;
  playbookSlug: string;
  playbookVersion: string;
  playbookShortHash: string;
  modelProvider: string;
  modelRequested: string;
  modelReported: string | null;
  /** What the model calls used, with the number of calls it is out of; null when the memo says nothing of it. */
  usageText: string | null;
  manifestSha256: string;
  startedOn: string;
  documents: {
    label: string;
    title: string;
    versionNo: number;
    statedDate: string | null;
    fileSha256: string;
  }[];
  exportedBy: string;
  exportedOn: string;
  quotationsShown: number;
  quotationsOmitted: number;
  segregationRelaxed: boolean;
}

/** One sentence about what the upload said of a document, in the memo's own words. */
export interface DocumentWarningView {
  text: string;
}

export interface MemoPlan {
  matterName: string;
  clientLegalName: string;
  /** "Mutual NDA (v1) and Amendment No. 1 (v1)". */
  documentList: string;
  playbookName: string;
  playbookVersion: string;
  exportedOn: string;
  exportedAt: Date;
  /** Empty when the upload raised nothing the memo's reader needs to know. */
  documentWarnings: DocumentWarningView[];
  findings: FindingView[];
  open: FindingView[];
  rejected: FindingView[];
  counts: Record<"accepted" | "edited" | "rejected" | "escalated", number>;
  severityCounts: Record<Severity, number>;
  provenance: ProvenanceView;
}

const has = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

const clean = (value: unknown): string => containBidi(sanitizeXmlText(value));

/**
 * The first digits of a hash, cut before the formatting is closed and not after, so that a value
 * that opens an override cannot lose the closer that `containBidi` adds to the end of it. The cut
 * is by code point and never separates the halves of a surrogate pair.
 */
const shortHash = (value: unknown): string =>
  containBidi(Array.from(sanitizeXmlText(value).trim()).slice(0, SHORT_HASH_LENGTH).join(""));

const WARNING_CODES_IN_MEMO: readonly string[] = [
  "unreviewed_content",
  "instruction_like_text",
  "no_reviewable_text",
];

const countWord = (count: number, [one, many]: readonly [string, string]): string =>
  `${count} ${count === 1 ? one : many}`;

/** `a`, `a and b`, `a, b and c`. */
function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Reads `key=count` pairs out of a stored warning detail and keeps the keys the vocabulary names.
 * The detail is ids, counts and pattern names, but it is stored data, so nothing else is taken
 * from it, and a count that is not a whole number is ignored.
 */
function countsIn(
  detail: unknown,
  vocabulary: Record<string, readonly [string, string]>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (typeof detail !== "string") return out;
  for (const match of detail.matchAll(/(?:^|[\s:,;])([a-z_]+)=(\d{1,9})(?=$|[\s,;])/g)) {
    const key = match[1]!;
    if (!has(vocabulary, key)) continue;
    out.set(key, (out.get(key) ?? 0) + Number(match[2]));
  }
  return out;
}

function sentencesFor(
  documentName: string,
  warnings: readonly NonNullable<MemoInput["documentWarnings"]>[number][],
): string[] {
  const out: string[] = [];
  const unread = new Map<string, number>();
  const unresolved = new Map<string, number>();
  const flagged: string[] = [];
  let withoutText = false;
  let unreadUnnamed = false;
  for (const warning of warnings) {
    if (warning.code === "unreviewed_content") {
      const before = unread.size + unresolved.size;
      for (const [key, count] of countsIn(warning.detail, UNREAD_PART_LABEL)) {
        unread.set(key, (unread.get(key) ?? 0) + count);
      }
      for (const [key, count] of countsIn(warning.detail, UNRESOLVED_CHANGE_LABEL)) {
        unresolved.set(key, (unresolved.get(key) ?? 0) + count);
      }
      if (unread.size + unresolved.size === before) unreadUnnamed = true;
    } else if (warning.code === "instruction_like_text") {
      flagged.push(
        typeof warning.location === "string" && clean(warning.location).trim() !== ""
          ? clean(warning.location).replace(/\s+/g, " ").trim()
          : "a paragraph the memo cannot place",
      );
    } else if (warning.code === "no_reviewable_text") {
      withoutText = true;
    }
  }
  const unreadWords = Object.keys(UNREAD_PART_LABEL)
    .filter((key) => (unread.get(key) ?? 0) > 0)
    .map((key) => countWord(unread.get(key)!, UNREAD_PART_LABEL[key]!));
  if (unreadWords.length > 0) {
    out.push(
      `${documentName}: the review did not read ${joinWords(unreadWords)} in the Word file. Nothing in this memorandum accounts for them.`,
    );
  } else if (unreadUnnamed && unresolved.size === 0) {
    out.push(
      `${documentName}: the Word file holds content the review did not read. Nothing in this memorandum accounts for it.`,
    );
  }
  const unresolvedWords = Object.keys(UNRESOLVED_CHANGE_LABEL)
    .filter((key) => (unresolved.get(key) ?? 0) > 0)
    .map((key) => countWord(unresolved.get(key)!, UNRESOLVED_CHANGE_LABEL[key]!));
  if (unresolvedWords.length > 0) {
    out.push(
      `${documentName}: the Word file holds ${joinWords(unresolvedWords)} that were not resolved. The review read the text as if every change had been accepted.`,
    );
  }
  if (flagged.length > 0) {
    const one = flagged.length === 1;
    const shown = flagged.slice(0, MAX_WARNING_LOCATIONS);
    const rest = flagged.length - shown.length;
    const places = rest > 0 ? `${shown.join(", ")} and ${rest} more` : joinWords(shown);
    out.push(
      `${documentName}: ${flagged.length} ${one ? "paragraph reads" : "paragraphs read"} like an instruction to software: ${places}. The review gave ${one ? "it" : "them"} to the model as document text, and nothing here shows that the model ignored ${one ? "it" : "them"}. Read ${one ? "it" : "them"} in the file and check the findings against ${one ? "it" : "them"}.`,
    );
  }
  if (withoutText) {
    out.push(`${documentName}: the file has no paragraph with text the review could read.`);
  }
  return out;
}

/**
 * What the upload said about the documents of the run, as sentences. The warnings are grouped by
 * document, in the order of the document list, and only the ones that bear on how far the memo can
 * be relied on are kept (duplicates of other files in the matter are not).
 */
function planDocumentWarnings(
  input: MemoInput,
  documents: { label: string; title: string; versionNo: number }[],
): DocumentWarningView[] {
  const given: unknown = input.documentWarnings;
  if (!Array.isArray(given)) return [];
  const items = (given as unknown[]).filter(
    (item): item is NonNullable<MemoInput["documentWarnings"]>[number] =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { label?: unknown }).label === "string" &&
      WARNING_CODES_IN_MEMO.includes((item as { code?: unknown }).code as string),
  );
  const labels = [
    ...new Set([
      ...documents.map((doc) => doc.label),
      ...items.map((item) => clean(item.label).trim()),
    ]),
  ];
  const views: DocumentWarningView[] = [];
  for (const label of labels) {
    const own = items.filter((item) => clean(item.label).trim() === label);
    if (own.length === 0) continue;
    const doc = documents.find((candidate) => candidate.label === label);
    const name = doc === undefined ? label : `${label} (${doc.title}, v${doc.versionNo})`;
    for (const text of sentencesFor(name, own)) views.push({ text });
  }
  return views;
}

const EDIT_FIELDS = ["status", "discrepancy", "fallbackLanguage"] as const;

function invalid(message: string, ruleKeys: readonly string[] = []): never {
  throw new MemoGateError("invalid_input", message, ruleKeys);
}

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function listDocuments(titles: string[]): string {
  if (titles.length <= 1) return titles.join("");
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

function ruleTitle(input: MemoInput, ruleKey: string, category: CategoryId): string {
  const given =
    input.ruleTitles !== undefined && has(input.ruleTitles, ruleKey)
      ? clean(input.ruleTitles[ruleKey]).replace(/\s+/g, " ").trim()
      : "";
  if (given !== "") return given;
  return has(CATEGORY_LABEL, category) ? CATEGORY_LABEL[category] : clean(category);
}

function roleRank(role: unknown): number {
  const at = ROLE_ORDER.indexOf(role as EvidenceRole);
  return at === -1 ? ROLE_ORDER.length : at;
}

/**
 * Validates the input against every export gate and returns what the memo will say. Throws
 * `MemoGateError` (a `MemoError`) for the first gate that refuses, naming rule keys and span ids
 * and never quoting a document.
 */
export function planMemo(input: MemoInput): MemoPlan {
  const items: MemoFinding[] = Array.isArray(input.findings) ? input.findings : [];
  if (items.length === 0) {
    throw new MemoGateError("no_findings", "The memo has no findings to report.");
  }

  // Gate: one finding per rule. Two findings under one key would print one rule twice.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = item?.finding?.ruleKey;
    if (typeof key !== "string" || key.trim() === "") invalid("A finding has no rule key.");
    const folded = key.toLowerCase();
    if (seen.has(folded)) duplicates.add(key);
    seen.add(folded);
  }
  if (duplicates.size > 0) {
    const keys = [...duplicates];
    throw new MemoGateError(
      "duplicate_rule",
      `More than one finding for rule ${keys.map(printableId).join(", ")}.`,
      keys,
    );
  }

  // Gate: every rule has a finding. A memo that leaves a rule out looks complete and is not.
  const severities = input.ruleSeverities ?? {};
  const uncovered = Object.keys(severities).filter((key) => !seen.has(key.toLowerCase()));
  if (uncovered.length > 0) {
    throw new MemoGateError(
      "missing_finding",
      `No finding for rule ${uncovered.map(printableId).join(", ")}.`,
      uncovered,
    );
  }

  // Gate: every finding has a decision. All of them are named, so one refusal tells the whole story.
  const undecided = items
    .filter((item) => item.review === null || item.review === undefined)
    .map((item) => item.finding.ruleKey);
  if (undecided.length > 0) {
    throw new MemoGateError(
      "unreviewed",
      `${undecided.length} finding(s) have no review decision: ${undecided.map(printableId).join(", ")}.`,
      undecided,
    );
  }

  const exportedInstant = parseUtcInstant(input.exportedAt);
  const exportedOn = formatUtcDate(input.exportedAt);
  if (exportedInstant === null || exportedOn === null)
    invalid("exportedAt is not an ISO 8601 date.");

  if (clean(input.exportedBy).trim() === "") invalid("The memo does not say who exported it.");

  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    invalid("The memo names no documents.");
  }

  const spanTexts = input.spanTexts ?? {};
  const badQuotes: string[] = [];
  const badQuoteKeys = new Set<string>();
  let shown = 0;
  let omitted = 0;

  const findings: FindingView[] = items.map((item, index): FindingView => {
    const { finding } = item;
    const review = item.review!;
    const key = finding.ruleKey;
    const id = printableId(key);

    if (!DECISIONS.includes(review.decision)) invalid(`Rule ${id} has an unknown decision.`, [key]);
    if (!isStatus(finding.status)) invalid(`Rule ${id} has an unknown status.`, [key]);
    if (!SEVERITIES.includes(finding.severity))
      invalid(`Rule ${id} has an unknown severity.`, [key]);
    if (has(severities, key) && severities[key] !== finding.severity) {
      invalid(`Rule ${id} has two different severities.`, [key]);
    }
    if (!BASES.includes(finding.fallbackBasis))
      invalid(`Rule ${id} has an unknown language basis.`, [key]);
    if (clean(review.reviewerName).trim() === "") {
      invalid(`The decision on rule ${id} has no reviewer name.`, [key]);
    }
    const decidedOn = formatUtcDate(review.decidedAt);
    if (decidedOn === null) invalid(`The decision on rule ${id} has no valid date.`, [key]);

    // Edits belong to an edit decision and to nothing else, as docs/parol/03 says: "required for
    // edit, null otherwise". A field that is absent or null is not an edit. Only a field that holds
    // text is, and an empty string is the reviewer clearing the field.
    const rawEdits: unknown = review.edits ?? null;
    if (rawEdits !== null && (typeof rawEdits !== "object" || Array.isArray(rawEdits))) {
      invalid(`The edits on rule ${id} are not an object.`, [key]);
    }
    const edits = rawEdits as Record<string, unknown> | null;
    const editValue = (field: (typeof EDIT_FIELDS)[number]): unknown => {
      const value = edits !== null && has(edits, field) ? edits[field] : undefined;
      return value === null ? undefined : value;
    };
    if (review.decision !== "edit" && EDIT_FIELDS.some((field) => editValue(field) !== undefined)) {
      invalid(`The decision on rule ${id} is not an edit but carries edits.`, [key]);
    }

    // The reviewer may also have changed how cited passages are labelled. The store names the
    // passage by its evidence id, so the finding must carry the ids in the order of its evidence.
    const roleOverrides = new Map<number, EvidenceRole>();
    const rawRoles = edits !== null && has(edits, "evidenceRoles") ? edits["evidenceRoles"] : null;
    if (rawRoles !== null && rawRoles !== undefined) {
      if (!Array.isArray(rawRoles))
        invalid(`The edited roles on rule ${id} are not a list.`, [key]);
      if (rawRoles.length > 0 && review.decision !== "edit") {
        invalid(`The decision on rule ${id} is not an edit but carries edits.`, [key]);
      }
      const ids: unknown = item.evidenceIds;
      for (const change of rawRoles as unknown[]) {
        const entry = change as { evidenceId?: unknown; role?: unknown } | null;
        const roleName = entry !== null && typeof entry === "object" ? entry.role : undefined;
        if (
          typeof roleName !== "string" ||
          !(EVIDENCE_ROLES as readonly string[]).includes(roleName)
        ) {
          invalid(`An edited role on rule ${id} is not a role.`, [key]);
        }
        const at =
          Array.isArray(ids) && typeof entry?.evidenceId === "string"
            ? ids.indexOf(entry.evidenceId)
            : -1;
        if (at === -1)
          invalid(`An edited role on rule ${id} names a passage the finding lacks.`, [key]);
        roleOverrides.set(at, roleName as EvidenceRole);
      }
    }

    // The status the workflow stated, kept when the playbook's flags settled it to another one.
    // Anything but a determined status (or nothing) is a defect of the input, not a thing to print.
    const rawModelStatus: unknown = (finding as { modelStatus?: unknown }).modelStatus;
    if (
      rawModelStatus !== undefined &&
      rawModelStatus !== null &&
      !(DETERMINED_STATUSES as readonly unknown[]).includes(rawModelStatus)
    ) {
      invalid(`Rule ${id} has an unknown model status.`, [key]);
    }
    const modelStatus = (rawModelStatus ?? null) as Status | null;
    const flags =
      modelStatus !== null && input.ruleFlags !== undefined && has(input.ruleFlags, key)
        ? input.ruleFlags[key]
        : undefined;

    let status: Status = finding.status;
    const editedStatus = editValue("status");
    if (editedStatus !== undefined) {
      if (!isStatus(editedStatus))
        invalid(`The edited status on rule ${id} is not a status.`, [key]);
      status = editedStatus;
    }

    const editedDiscrepancyValue = editValue("discrepancy");
    if (editedDiscrepancyValue !== undefined && typeof editedDiscrepancyValue !== "string") {
      invalid(`The edited discrepancy on rule ${id} is not text.`, [key]);
    }
    const editedLanguageValue = editValue("fallbackLanguage");
    if (editedLanguageValue !== undefined && typeof editedLanguageValue !== "string") {
      invalid(`The edited proposed language on rule ${id} is not text.`, [key]);
    }

    const originalDiscrepancy = clean(finding.discrepancy);
    const discrepancy =
      editedDiscrepancyValue !== undefined ? clean(editedDiscrepancyValue) : originalDiscrepancy;
    const originalLanguage =
      clean(finding.fallbackLanguage).trim() === "" ? null : clean(finding.fallbackLanguage);
    const editedLanguage =
      editedLanguageValue !== undefined ? clean(editedLanguageValue) : undefined;
    const language =
      editedLanguage !== undefined
        ? editedLanguage.trim() === ""
          ? null
          : editedLanguage
        : originalLanguage;

    const rejected = review.decision === "reject";
    const evidence: EvidenceView[] = [];
    let omittedHere = 0;

    // Rejected findings state no conclusion, so none of their passages is shown or checked.
    if (!rejected) {
      const cited = Array.isArray(finding.evidence) ? finding.evidence : [];
      if (!Array.isArray(item.locations) || item.locations.length !== cited.length) {
        invalid(`Rule ${id} has locations that do not match its passages.`, [key]);
      }
      const staged: { rank: number; at: number; view: EvidenceView }[] = [];
      const idList: unknown = item.evidenceIds;
      if (roleOverrides.size > 0 && (!Array.isArray(idList) || idList.length !== cited.length)) {
        invalid(`Rule ${id} has passage ids that do not match its passages.`, [key]);
      }
      cited.forEach((passage, at) => {
        // The stored check already said this quotation is not in its paragraph. It is never shown.
        if (passage.quoteCheck === "not_found") {
          omittedHere += 1;
          return;
        }
        const spanId = printableId(passage.spanId);
        const spanText =
          typeof passage.spanId === "string" && has(spanTexts, passage.spanId)
            ? spanTexts[passage.spanId]
            : undefined;
        const location = item.locations[at];
        const check =
          typeof spanText === "string" && typeof passage.quote === "string"
            ? verifyQuote(spanText, passage.quote)
            : null;
        if (check === null || check.check === "not_found") {
          badQuotes.push(`rule ${id}, passage ${at + 1}, span ${spanId}`);
          badQuoteKeys.add(key);
          return;
        }
        if (typeof location !== "string" || clean(location).trim() === "") {
          badQuotes.push(`rule ${id}, passage ${at + 1}, no location`);
          badQuoteKeys.add(key);
          return;
        }
        const changedRole = roleOverrides.get(at);
        const role = changedRole ?? passage.role;
        const workflowLabel = has(ROLE_LABEL, passage.role) ? ROLE_LABEL[passage.role] : "Cited";
        staged.push({
          rank: roleRank(role),
          at,
          view: {
            roleLabel: has(ROLE_LABEL, role) ? ROLE_LABEL[role] : "Cited",
            roleWorkflowLabel:
              changedRole !== undefined && changedRole !== passage.role ? workflowLabel : null,
            quote: containBidi(truncateQuote(sanitizeXmlText(passage.quote).trim())),
            location: clean(location).replace(/\s+/g, " ").trim(),
            occurrences: check.occurrences,
          },
        });
      });
      staged.sort((a, b) => a.rank - b.rank || a.at - b.at);
      evidence.push(...staged.map((entry) => entry.view));
      shown += evidence.length;
      omitted += omittedHere;
    }

    const statusEdited = status !== finding.status;
    const discrepancyEdited = discrepancy.trim() !== originalDiscrepancy.trim();
    const systemEscalated = finding.verificationState === "escalated_by_system";
    let openReason: OpenReason | null = null;
    if (review.decision === "escalate") openReason = "escalated_by_reviewer";
    else if (review.decision === "accept" && systemEscalated)
      openReason = "accepted_with_system_flags";
    // An edit takes a flagged finding off the list only when it changes what was flagged: the
    // status or the discrepancy. An edit to the proposed language alone leaves the workflow's doubt
    // about the conclusion unanswered, so the finding stays where an attorney will see it.
    else if (review.decision === "edit" && systemEscalated && !statusEdited && !discrepancyEdited)
      openReason = "edited_with_system_flags";
    else if (!rejected && status === "undetermined") openReason = "no_status_stated";

    return {
      number: index + 1,
      ruleKey: key,
      ruleId: clean(key).toUpperCase(),
      title: ruleTitle(input, key, finding.category),
      severity: finding.severity,
      decision: review.decision,
      reviewerName: clean(review.reviewerName).replace(/\s+/g, " ").trim(),
      decidedOn,
      reason: clean(review.reason).trim() === "" ? null : clean(review.reason).trim(),
      status,
      proposedStatus: finding.status,
      statusEdited,
      modelStatus,
      settlementReason:
        flags === undefined
          ? null
          : settlementReason({
              kind: flags.kind === "absence" ? "absence" : "presence",
              required: flags.required === true,
            }),
      discrepancy,
      discrepancyEdited,
      discrepancyOriginal: originalDiscrepancy,
      explanation: clean(finding.explanation),
      conflict: clean(finding.conflict).trim() === "" ? null : clean(finding.conflict),
      abstainReason:
        clean(finding.abstainReason).trim() === "" ? null : clean(finding.abstainReason),
      evidence,
      rolesEdited: evidence.filter((passage) => passage.roleWorkflowLabel !== null).length,
      omittedQuotes: omittedHere,
      language,
      languageEdited: editedLanguage !== undefined && (language ?? "") !== (originalLanguage ?? ""),
      languageOriginal: originalLanguage,
      basis: finding.fallbackBasis,
      flags: (Array.isArray(finding.escalations) ? finding.escalations : []).map((escalation) => ({
        plain: has(ESCALATION_PLAIN, escalation.code)
          ? ESCALATION_PLAIN[escalation.code]
          : UNKNOWN_ESCALATION_PLAIN,
        detail: clean(escalation.detail).replace(/\s+/g, " ").trim(),
      })),
      systemEscalated,
      openReason,
    };
  });

  // Gate: a quotation that no longer matches its stored paragraph is never printed.
  if (badQuotes.length > 0) {
    throw new MemoGateError(
      "unverified_quote",
      `${badQuotes.length} quotation(s) do not verify against the stored text: ${badQuotes.join("; ")}.`,
      [...badQuoteKeys],
    );
  }

  const counts = { accepted: 0, edited: 0, rejected: 0, escalated: 0 };
  const severityCounts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const view of findings) {
    if (view.decision === "accept") counts.accepted += 1;
    else if (view.decision === "edit") counts.edited += 1;
    else if (view.decision === "reject") counts.rejected += 1;
    else counts.escalated += 1;
    severityCounts[view.severity] += 1;
  }

  const documents = input.documents.map((doc) => ({
    label: clean(doc.label).trim(),
    title: clean(doc.title).replace(/\s+/g, " ").trim(),
    versionNo: Number.isFinite(doc.versionNo) ? Math.trunc(doc.versionNo) : 0,
    statedDate:
      doc.statedDate === null || doc.statedDate === undefined
        ? null
        : (formatUtcDate(doc.statedDate) ?? clean(doc.statedDate).trim()),
    fileSha256: clean(doc.fileSha256).trim(),
  }));

  return {
    documentWarnings: planDocumentWarnings(input, documents),
    matterName: clean(input.matter.name).replace(/\s+/g, " ").trim(),
    clientLegalName: clean(input.matter.clientLegalName).replace(/\s+/g, " ").trim(),
    documentList: listDocuments(documents.map((doc) => `${doc.title} (v${doc.versionNo})`)),
    playbookName: clean(input.playbook.name).replace(/\s+/g, " ").trim(),
    playbookVersion: clean(input.playbook.version).trim(),
    exportedOn,
    exportedAt: exportedInstant,
    findings,
    open: findings.filter((view) => view.openReason !== null),
    rejected: findings.filter((view) => view.decision === "reject"),
    counts,
    severityCounts,
    provenance: {
      matterId: clean(input.matter.id).trim(),
      runId: clean(input.run.id).trim(),
      workflowLabel: clean(input.run.workflowLabel).trim(),
      workflowShortHash: shortHash(input.run.workflowSha256),
      playbookName: clean(input.playbook.name).replace(/\s+/g, " ").trim(),
      playbookSlug: clean(input.playbook.slug).trim(),
      playbookVersion: clean(input.playbook.version).trim(),
      playbookShortHash: shortHash(input.playbook.sha256),
      modelProvider: clean(input.run.modelProvider).trim(),
      modelRequested: clean(input.run.modelRequested).trim(),
      modelReported:
        input.run.modelReported === null || clean(input.run.modelReported).trim() === ""
          ? null
          : clean(input.run.modelReported).trim(),
      usageText:
        input.run.usage === undefined || input.run.usage === null
          ? null
          : memoUsageText(input.run.usage),
      manifestSha256: clean(input.run.manifestSha256).trim(),
      startedOn: formatUtcDate(input.run.startedAt) ?? "not recorded",
      documents,
      exportedBy: clean(input.exportedBy).replace(/\s+/g, " ").trim(),
      exportedOn,
      quotationsShown: shown,
      quotationsOmitted: omitted,
      segregationRelaxed: input.segregationRelaxed === true,
    },
  };
}
