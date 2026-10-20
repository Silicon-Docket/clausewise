import type {
  Decision,
  Finding,
  PatchFindingRequest,
  ReviewNotShown,
  Severity,
} from "@clausewise/api";
import { SEVERITIES, plural } from "./format.js";

/** The wording that goes into the file for a finding with an applied edit: the lawyer's, else the model's. */
export function effectiveReplacement(finding: Finding): string | null {
  if (finding.edit.kind !== "applied") return null;
  return finding.editedReplacement ?? finding.edit.replacement;
}

/**
 * The request for saving a new wording. The server accepts `editedReplacement` only for an applied
 * edit, and null means "use the model's", so a wording equal to the model's is sent as null rather
 * than stored as a copy that would stay behind if the model's changed. Returns null when there is
 * nothing to send.
 */
export function editRequestFor(
  finding: Finding,
  draft: string,
  accept: boolean,
): PatchFindingRequest | null {
  if (finding.edit.kind !== "applied") return null;
  const wanted = draft === finding.edit.replacement ? null : draft;
  const request: PatchFindingRequest = {};
  if (wanted !== finding.editedReplacement) request.editedReplacement = wanted;
  if (accept && finding.decision !== "accepted") request.decision = "accepted";
  return Object.keys(request).length === 0 ? null : request;
}

/** The request for putting a finding back as the review left it. */
export function resetRequestFor(finding: Finding): PatchFindingRequest {
  return finding.edit.kind === "applied"
    ? { decision: "pending", editedReplacement: null }
    : { decision: "pending" };
}

export function groupBySeverity(findings: readonly Finding[]): Array<{
  severity: Severity;
  findings: Finding[];
}> {
  return SEVERITIES.map((severity) => ({
    severity,
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

export function countDecisions(findings: readonly Finding[]): Record<Decision, number> {
  const counts: Record<Decision, number> = { pending: 0, accepted: 0, rejected: 0 };
  for (const finding of findings) counts[finding.decision] += 1;
  return counts;
}

export function countBySeverity(findings: readonly Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** What a bulk change does to the screen at once, before the server has answered. */
export function applyBulk(
  findings: readonly Finding[],
  decision: Decision,
  severities: readonly Severity[] | undefined,
): Finding[] {
  return findings.map((finding) =>
    severities === undefined || severities.includes(finding.severity)
      ? { ...finding, decision }
      : finding,
  );
}

/** The parts of the document the model did not see, in words, or an empty list. */
export function describeNotShown(notShown: ReviewNotShown | null): string[] {
  if (notShown === null) return [];
  const items: Array<[number, string, string]> = [
    [notShown.trackedInsertions, "tracked insertion", "tracked insertions"],
    [notShown.trackedDeletions, "tracked deletion", "tracked deletions"],
    [notShown.comments, "comment", "comments"],
    [notShown.footnotes, "footnote", "footnotes"],
    [notShown.endnotes, "endnote", "endnotes"],
    [notShown.headerFooterParts, "header or footer", "headers or footers"],
    [notShown.hiddenRuns, "piece of hidden text", "pieces of hidden text"],
    [notShown.images, "image", "images"],
  ];
  return items.filter(([count]) => count > 0).map(([count, one, many]) => plural(count, one, many));
}
