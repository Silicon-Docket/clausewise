import type { Decision, FindingStatus, ReviewStatus, RuleStatus, Severity } from "@clausewise/api";

/** Highest first, the order findings are read in. */
export const SEVERITIES: readonly Severity[] = ["high", "medium", "low"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const FINDING_STATUS_LABEL: Record<FindingStatus, string> = {
  deviation: "The contract departs from the playbook",
  missing: "The contract has no clause for this",
};

export const RULE_STATUS_LABEL: Record<RuleStatus, string> = {
  compliant: "Meets the playbook",
  deviation: "Departs from the playbook",
  missing: "Clause missing",
  not_applicable: "Does not apply to this contract",
  error: "Could not be checked",
};

export const DECISION_LABEL: Record<Decision, string> = {
  pending: "Not decided",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  queued: "Waiting to start",
  running: "In progress",
  done: "Finished",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The server sends where the text goes, such as "Anthropic API (api.anthropic.com)". A full
 * sentence is shown as it is, so that a server that sends one is not made to say it twice.
 */
export function disclosureSentence(disclosure: string): string {
  const text = disclosure.trim();
  if (/[.!]$/.test(text)) return text;
  return `Reviews are sent to ${text}.`;
}

/** The reminder next to the Start button, which says it again so that nobody starts without knowing. */
export function startDisclosure(disclosure: string): string {
  const text = disclosure.trim();
  if (/[.!]$/.test(text)) return text;
  return `Pressing Start sends the text of this contract to ${text}.`;
}

/** A name for a downloaded redline, used only when the server suggested none. */
export function redlineFileName(documentName: string): string {
  const stem = documentName.replace(/\.docx$/i, "").trim();
  return `${stem === "" ? "contract" : stem} (redline).docx`;
}
