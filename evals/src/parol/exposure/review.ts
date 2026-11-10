/**
 * Takes a case through the application's services the way people do: a matter with an associate and
 * a reviewer (and a viewer), the documents uploaded, a review run, every finding decided and the
 * memo exported. It is `prepareMatter` of apps/parol/test/routes/support.ts without vitest, over
 * the dataset's cases instead of the tests' fixtures.
 *
 * The services are the real ones. The model is whatever generator the site was built with.
 */
import type { MatterRole } from "../../../../apps/parol/src/contracts.js";
import type { DecisionRequest, FindingView } from "../../../../apps/parol/src/services/views.js";
import type { AnswerKeyCase } from "../../../../fixtures/parol/types.js";
import { EvalError } from "../../errors.js";
import type { ExposureSite } from "./site.js";

export interface ReviewedMatter {
  matterId: string;
  /** In label order. */
  documentIds: string[];
  versionIds: string[];
  runId: string;
  findingIds: string[];
  /** The finding of `dur-1` when the case has one, else the first. */
  findingId: string;
  memoId: string;
}

export interface ReviewPeople {
  associate: string;
  reviewer: string;
  viewer: string | null;
}

/** What a reviewer does with a finding in this suite: accept what is verified, escalate the rest. */
export function decisionFor(view: FindingView): DecisionRequest {
  const ok = view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
  return {
    decision: ok ? "accept" : "escalate",
    findingContentSha256: view.contentSha256,
    edits: null,
    reason: ok ? null : "The workflow could not settle this rule.",
  };
}

/** The error for a step that cannot be taken. Names the case and the step, never a document. */
const fail = (key: AnswerKeyCase, what: string): EvalError =>
  new EvalError(`${key.case}: the exposure suite could not ${what}.`);

/**
 * Creates the matter and uploads the operative documents of the case in label order. Returns the
 * ids of what was stored. The title of the matter is given by the caller, because a test of
 * disclosure needs to know it.
 */
export async function createCaseMatter(args: {
  site: ExposureSite;
  key: AnswerKeyCase;
  files: (name: string) => Uint8Array;
  people: ReviewPeople;
  matterName: string;
}): Promise<Pick<ReviewedMatter, "matterId" | "documentIds" | "versionIds">> {
  const { site, key, people } = args;
  const summary = site.services.matters.create(site.principal(people.associate), {
    name: args.matterName,
    clientLegalName: key.intake.clientLegalName,
    playbookVersionId: site.playbookVersionId,
    reviewerUserId: people.reviewer,
  });
  if (people.viewer !== null)
    site.repo.addMember(summary.id, people.viewer, "viewer" satisfies MatterRole, {
      actorId: people.associate,
    });
  const am = site.authorize(people.associate, summary.id, "document.write");
  const documentIds: string[] = [];
  const versionIds: string[] = [];
  const documents = key.documents
    .filter((doc) => doc.operative !== false)
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const doc of documents) {
    const stored = await site.services.matters.addDocument(am, {
      title: doc.title,
      kind: doc.kind,
      fileName: doc.file,
      bytes: args.files(doc.file),
      statedDate: doc.statedDate,
    });
    documentIds.push(stored.documentId);
    versionIds.push(stored.versionId);
  }
  return { matterId: summary.id, documentIds, versionIds };
}

/** Starts the review, waits for it, has the reviewer decide every finding and exports the memo. */
export async function reviewAndExport(args: {
  site: ExposureSite;
  key: AnswerKeyCase;
  people: ReviewPeople;
  matterId: string;
}): Promise<Pick<ReviewedMatter, "runId" | "findingIds" | "findingId" | "memoId">> {
  const { site, key, people, matterId } = args;
  const am = site.authorize(people.associate, matterId, "run.start");
  const started = site.services.runs.start(am, { workflowLabel: site.workflowLabel });
  await site.services.runs.idle();
  const run = site.services.runs.get(am, started.id);
  if (run.status !== "succeeded") throw fail(key, `finish the review (it ended ${run.status})`);

  const issues = site.services.runs.issues(am, started.id);
  if (issues.length === 0) throw fail(key, "find the findings of the review");
  const reviewer = site.authorize(people.reviewer, matterId, "review.decide");
  for (const issue of issues) {
    const view = site.services.runs.finding(reviewer, issue.findingId);
    site.services.reviews.decide(reviewer, issue.findingId, decisionFor(view));
  }
  const exporter = site.authorize(people.reviewer, matterId, "memo.export");
  const memo = await site.services.reviews.exportMemo(exporter);
  const chosen = issues.find((issue) => issue.ruleKey === "dur-1") ?? issues[0]!;
  return {
    runId: started.id,
    findingIds: issues.map((issue) => issue.findingId),
    findingId: chosen.findingId,
    memoId: memo.memoId,
  };
}
