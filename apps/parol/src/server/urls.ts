/**
 * Every URL the pages link to or post to, in one place, so pages and routes cannot disagree. All
 * ids are escaped; none of these functions ever receives document text.
 */
const e = encodeURIComponent;

export const urls = {
  home: () => "/",
  session: () => "/session",
  matters: () => "/matters",
  matter: (matterId: string) => `/matters/${e(matterId)}`,
  matterSettings: (matterId: string) => `/matters/${e(matterId)}/settings`,
  matterDelete: (matterId: string) => `/matters/${e(matterId)}/delete`,
  matterRetention: (matterId: string) => `/matters/${e(matterId)}/retention`,
  members: (matterId: string) => `/matters/${e(matterId)}/members`,
  documents: (matterId: string) => `/matters/${e(matterId)}/documents`,
  versions: (matterId: string, documentId: string) =>
    `/matters/${e(matterId)}/documents/${e(documentId)}/versions`,
  operative: (matterId: string, documentId: string) =>
    `/matters/${e(matterId)}/documents/${e(documentId)}/operative`,
  statedDate: (matterId: string, versionId: string) =>
    `/matters/${e(matterId)}/versions/${e(versionId)}/stated-date`,
  documentRemove: (matterId: string, documentId: string) =>
    `/matters/${e(matterId)}/documents/${e(documentId)}/remove`,
  runs: (matterId: string) => `/matters/${e(matterId)}/runs`,
  run: (matterId: string, runId: string, findingId?: string) =>
    `/matters/${e(matterId)}/runs/${e(runId)}${findingId === undefined ? "" : `?finding=${e(findingId)}`}`,
  /** What the progress script polls (pages/matter.tsx puts it in `data-status-url`). Answers JSON. */
  runStatus: (matterId: string, runId: string) => `/matters/${e(matterId)}/runs/${e(runId)}/status`,
  runResume: (matterId: string, runId: string) => `/matters/${e(matterId)}/runs/${e(runId)}/resume`,
  runCancel: (matterId: string, runId: string) => `/matters/${e(matterId)}/runs/${e(runId)}/cancel`,
  finding: (matterId: string, findingId: string) =>
    `/matters/${e(matterId)}/findings/${e(findingId)}`,
  review: (matterId: string, findingId: string) =>
    `/matters/${e(matterId)}/findings/${e(findingId)}/reviews`,
  memos: (matterId: string) => `/matters/${e(matterId)}/memos`,
  memoFile: (matterId: string, memoId: string) => `/matters/${e(matterId)}/memos/${e(memoId)}/file`,
  /**
   * The evaluation comparison page (package W2.5). With no query it is the list; with `comparison`
   * it is one comparison, and `split`, or `caseKey` and `ruleKey` together, select a part of it. A
   * chosen slot adds `#trail`, the place where its evidence trail starts. Values are escaped here.
   */
  evaluations: (q?: {
    comparison?: string;
    split?: string;
    caseKey?: string;
    ruleKey?: string;
  }) => {
    const parts: string[] = [];
    if (q?.comparison !== undefined) parts.push(`comparison=${e(q.comparison)}`);
    if (q?.split !== undefined) parts.push(`split=${e(q.split)}`);
    if (q?.caseKey !== undefined) parts.push(`case=${e(q.caseKey)}`);
    if (q?.ruleKey !== undefined) parts.push(`rule=${e(q.ruleKey)}`);
    const chosen = q?.caseKey !== undefined && q.ruleKey !== undefined;
    return `/evaluations${parts.length === 0 ? "" : `?${parts.join("&")}`}${chosen ? "#trail" : ""}`;
  },
  /** The audit log check (package W2.7). */
  audit: () => "/audit",
  asset: (name: string) => `/assets/${e(name)}`,
} as const;
