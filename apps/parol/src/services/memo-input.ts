import { formatLocation } from "../location.js";
import type { MemoFinding, MemoInput } from "../module-contracts.js";
import { loadPlaybook } from "../playbooks/load.js";
import type { FindingRecord, Repository, RunRow, StoredSpan } from "../store/index.js";

/**
 * Everything the memo says, read from the store for one run: its findings with their current
 * decisions, the text of every span they cite, the documents as the run pinned them, the playbook
 * and the run's provenance. Nothing comes from a request.
 *
 * `segregationRelaxed` is a statement about what happened, so it is read from the recorded
 * decisions alone: it is true when the associate who started the run is the reviewer of at least
 * one current decision. It does not follow the relaxed-mode setting of the process (which may have
 * changed since the decisions were made) or who exports the memo (exporting is not deciding).
 */
export function buildMemoInput(args: {
  repo: Repository;
  matterId: string;
  run: RunRow;
  exporterId: string;
  exportedAt: string;
  /** Not used: the memo's statement comes from the decisions, not from the setting. Kept so callers need not change. */
  relaxedSegregation?: boolean;
}): { input: MemoInput; findings: FindingRecord[] } {
  const { repo, matterId, run } = args;
  const matter = repo.getMatter(matterId);
  const playbook = repo.getPlaybookVersion(run.playbookVersionId);
  if (matter === undefined || playbook === undefined) throw new Error("the memo's inputs are gone");

  const rules = repo.listRules(run.playbookVersionId);
  const findings = repo.listFindings(matterId, run.id);
  const spans = repo.listSpans(
    matterId,
    run.manifest.documents.map((d) => d.documentVersionId),
  );
  const spanById = new Map<string, StoredSpan>(spans.map((s) => [s.id, s]));
  const spanOf = (spanId: string): StoredSpan => {
    const known = spanById.get(spanId) ?? repo.getSpan(matterId, spanId);
    if (known === undefined) throw new Error("a cited span is gone");
    spanById.set(spanId, known);
    return known;
  };

  const memoFindings: MemoFinding[] = findings.map((record) => {
    const review = record.currentReview;
    return {
      finding: record,
      locations: record.evidence.map((e) => formatLocation(spanOf(e.spanId))),
      evidenceIds: record.evidence.map((e) => e.id),
      review:
        review === null
          ? null
          : {
              decision: review.decision,
              reviewerName: review.reviewerName,
              decidedAt: review.createdAt,
              reason: review.reason,
              edits: review.edits,
            },
    };
  });

  const sameAsAssociate = findings.some((f) => f.currentReview?.reviewerId === run.startedBy);

  let playbookName = playbook.slug;
  try {
    playbookName = loadPlaybook({ yaml: playbook.yaml, slug: playbook.slug }).name;
  } catch {
    // The memo names the playbook by its slug if the stored text no longer loads.
  }

  const input: MemoInput = {
    matter: { id: matter.id, name: matter.name, clientLegalName: matter.clientLegalName },
    playbook: {
      name: playbookName,
      slug: playbook.slug,
      version: playbook.version,
      sha256: playbook.sha256,
    },
    run: {
      id: run.id,
      workflowLabel: run.manifest.workflow.label,
      workflowSha256: run.manifest.workflow.sha256,
      modelProvider: run.modelProvider,
      modelRequested: run.modelRequested,
      modelReported: run.modelReported,
      manifestSha256: run.inputManifestSha256,
      startedAt: run.startedAt,
    },
    documents: run.manifest.documents.map((d) => ({
      label: d.label,
      title: d.title,
      versionNo: d.versionNo,
      statedDate: d.statedDate,
      fileSha256: repo.getVersion(matterId, d.documentVersionId)?.fileSha256 ?? "",
    })),
    spanTexts: Object.fromEntries(
      [
        ...new Set([
          ...spans.map((s) => s.id),
          ...findings.flatMap((f) => f.evidence.map((e) => e.spanId)),
        ]),
      ].map((id) => [id, spanOf(id).text]),
    ),
    findings: memoFindings,
    ruleSeverities: Object.fromEntries(rules.map((r) => [r.key, r.severity])),
    ruleTitles: Object.fromEntries(rules.map((r) => [r.key, r.title])),
    exportedBy: repo.getUser(args.exporterId)?.displayName ?? "(unknown user)",
    exportedAt: args.exportedAt,
    segregationRelaxed: sameAsAssociate,
  };
  return { input, findings };
}
