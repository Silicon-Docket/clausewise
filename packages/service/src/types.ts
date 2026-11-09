import type { Playbook, Severity } from "@clausewise/playbook";

/**
 * Where a review is in its life. A review is created waiting for its contract, queued once the
 * contract is in and has been checked, run by a worker, and ends done or failed.
 */
export type ReviewStatus = "awaiting_upload" | "queued" | "running" | "done" | "failed";

/** The person asking, as the sign-in in front of the service identifies them. */
export interface User {
  /** A stable id, such as the Entra ID object id. Never shown. */
  id: string;
}

export interface ReviewRecord {
  id: string;
  /** The user who created the review. Only they can see it in version 1. */
  owner: string;
  playbookId: string;
  /** The contract's file name as uploaded, already checked to be a plain .docx name. */
  fileName: string;
  /** The party the lawyer acts for, as the CLI's --client. */
  client: string | undefined;
  /** The name on tracked changes and comments, as the CLI's --author. */
  author: string;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  /** Why a failed review failed, in words that are safe to show the user. */
  error?: string;
  /** Once done: open items by severity. */
  open?: Record<Severity, number>;
  /** Once done: how many rules could not be checked. */
  unchecked?: number;
}

/** The three results of a review, named as the CLI names its output files. */
export type ResultKind = "redlined" | "report" | "summary";

/** Bytes kept under a key: contracts, and the results of reviews. */
export interface BlobStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
}

export interface ReviewRecords {
  create(record: ReviewRecord): Promise<void>;
  get(id: string): Promise<ReviewRecord | undefined>;
  /**
   * Changes a record only if it is still in `from`, so two requests or two workers can never both
   * move it on. Returns the updated record, or undefined when it was not in `from`.
   */
  transition(
    id: string,
    from: readonly ReviewStatus[],
    patch: Partial<Omit<ReviewRecord, "id" | "owner" | "createdAt">> & { updatedAt: string },
  ): Promise<ReviewRecord | undefined>;
  /**
   * Hands a queued review to a worker, or one whose worker stopped updating it before
   * `staleBefore`, which is how a review survives a worker that crashed mid-run.
   */
  claim(id: string, now: string, staleBefore: string): Promise<ReviewRecord | undefined>;
}

export interface ReviewJob {
  reviewId: string;
}

/** One delivery of a job. Delivery is at least once, so a job can arrive twice. */
export interface Delivery {
  job: ReviewJob;
  /** How many times this job has been delivered, this time included. */
  attempt: number;
  /** The job is finished, successfully or not, and must not be delivered again. */
  complete(): Promise<void>;
  /** The worker could not handle the job now; it comes back after a delay. */
  release(): Promise<void>;
}

export interface JobQueue {
  send(job: ReviewJob): Promise<void>;
  /** The next job, or undefined when there is none right now. */
  receive(): Promise<Delivery | undefined>;
}

export interface PlaybookSummary {
  id: string;
  name: string;
  rules: number;
}

export interface PlaybookSource {
  list(): Promise<PlaybookSummary[]>;
  get(id: string): Promise<Playbook | undefined>;
}
