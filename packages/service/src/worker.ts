import { DocxError } from "@clausewise/docx";
import type { ObjectGenerator } from "@clausewise/llm";
import {
  ReviewError,
  renderMarkdown,
  reviewContract,
  type ReviewOptions,
  type ReviewReport,
} from "@clausewise/review";
import { contractKey, resultKey } from "./keys.js";
import type { BlobStore, PlaybookSource, ReviewJob, ReviewRecords } from "./types.js";

export interface ReviewWorkerDeps {
  records: ReviewRecords;
  contracts: BlobStore;
  results: BlobStore;
  playbooks: PlaybookSource;
  generator: ObjectGenerator;
  limits?: Pick<ReviewOptions, "concurrency" | "maxContextTokens">;
  /**
   * How long a running review may go without its worker finishing it before another worker takes
   * it over. A review takes minutes, so the default is generous. Default 30 minutes.
   */
  leaseMs?: number;
  now?: () => Date;
  /** The time written on tracked changes. Default: now, as in the CLI. */
  changeDate?: () => Date;
  signal?: AbortSignal;
}

/**
 * "skipped": the review needs nothing more (it is finished, or gone). "busy": another worker is
 * running it, so the job must come back later in case that worker stops before it finishes.
 */
export type JobOutcome = "done" | "failed" | "skipped" | "busy";

const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();

/**
 * The same refusal as the CLI's: a review in which no rule ran says nothing about the contract,
 * so no results are kept. The reasons are grouped because a provider that is down gives the same
 * one for every rule.
 */
function nothingChecked(report: ReviewReport): string {
  const reasons = new Map<string, number>();
  for (const result of report.results) {
    const reason = result.error ?? "The rule was not checked.";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const listed = [...reasons]
    .slice(0, 5)
    .map(([reason, rules]) => `${rules} ${rules === 1 ? "rule" : "rules"}: ${reason}`);
  return `No rule could be checked, so nothing was reviewed. ${listed.join(" ")}`;
}

/**
 * Runs one review job. Safe to call twice for the same job: a review that another worker holds is
 * reported busy, and one that has already finished is skipped. The results are written exactly as
 * the CLI writes its three output files.
 *
 * Only a failure of the review itself, in words written to be shown, fails it here. Anything else,
 * such as storage that cannot be reached or a worker that is stopping, puts the review back as
 * queued and is thrown, so the job is delivered again and the loop can count the attempts. Those
 * errors are never shown to the user: they could carry a path, an address or a piece of the
 * contract.
 */
export async function processReviewJob(
  job: ReviewJob,
  deps: ReviewWorkerDeps,
): Promise<JobOutcome> {
  const now = deps.now ?? (() => new Date());
  const at = now();
  const staleBefore = new Date(at.getTime() - (deps.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
  const record = await deps.records.claim(job.reviewId, at.toISOString(), staleBefore);
  if (record === undefined) {
    const current = await deps.records.get(job.reviewId);
    return current?.status === "running" ? "busy" : "skipped";
  }

  const fail = async (message: string): Promise<JobOutcome> => {
    await deps.records.transition(record.id, ["running"], {
      status: "failed",
      error: message,
      updatedAt: now().toISOString(),
    });
    return "failed";
  };

  try {
    const [docx, playbook] = await Promise.all([
      deps.contracts.get(contractKey(record.id)),
      deps.playbooks.get(record.playbookId),
    ]);
    if (docx === undefined) return await fail("The contract of this review is missing.");
    if (playbook === undefined) return await fail("The playbook of this review no longer exists.");

    const { report, redlined } = await reviewContract(
      { docx, playbook, fileName: record.fileName },
      deps.generator,
      {
        ...deps.limits,
        author: record.author,
        ...(record.client === undefined ? {} : { client: record.client }),
        ...(deps.changeDate === undefined ? {} : { date: deps.changeDate() }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      },
    );

    const unchecked = report.results.filter((result) => result.status === "error").length;
    if (report.results.length > 0 && unchecked === report.results.length) {
      return await fail(nothingChecked(report));
    }

    await Promise.all([
      deps.results.put(resultKey(record.id, "redlined"), redlined),
      deps.results.put(
        resultKey(record.id, "report"),
        encoder.encode(`${JSON.stringify(report, null, 2)}\n`),
      ),
      deps.results.put(resultKey(record.id, "summary"), encoder.encode(renderMarkdown(report))),
    ]);
    await deps.records.transition(record.id, ["running"], {
      status: "done",
      open: report.open,
      unchecked,
      updatedAt: now().toISOString(),
    });
    return "done";
  } catch (error) {
    const stopping = deps.signal?.aborted === true;
    if (!stopping && (error instanceof ReviewError || error instanceof DocxError)) {
      return fail(error.message);
    }
    // Back to queued at once, so the next delivery need not wait for the lease to run out. If
    // even that fails, the lease still lets another worker take the review over later.
    await deps.records
      .transition(record.id, ["running"], { status: "queued", updatedAt: now().toISOString() })
      .catch(() => undefined);
    throw stopping ? deps.signal?.reason : error;
  }
}
