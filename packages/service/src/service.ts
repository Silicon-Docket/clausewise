import { randomUUID } from "node:crypto";
import { DocxError, parseDocx } from "@clausewise/docx";
import { ServiceError } from "./errors.js";
import { contractKey, resultKey } from "./keys.js";
import type {
  BlobStore,
  JobQueue,
  PlaybookSource,
  PlaybookSummary,
  ResultKind,
  ReviewRecord,
  ReviewRecords,
  User,
} from "./types.js";

export interface ReviewServiceDeps {
  records: ReviewRecords;
  contracts: BlobStore;
  results: BlobStore;
  queue: JobQueue;
  playbooks: PlaybookSource;
  /** Largest contract accepted, in bytes. Default 50 MiB. */
  maxContractBytes?: number;
  newId?: () => string;
  now?: () => Date;
}

export interface NewReview {
  playbookId: string;
  fileName: string;
  client?: string | undefined;
  author?: string | undefined;
}

const DEFAULT_MAX_CONTRACT_BYTES = 50 * 1024 * 1024;
const DEFAULT_AUTHOR = "Clausewise";
const MAX_TEXT = 200;

// Names and texts end up in headers, file names and Word comments, so control characters and
// path separators are refused rather than cleaned up behind the user's back.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function invalid(message: string): never {
  throw new ServiceError("invalid", message);
}

function checkFileName(raw: string): string {
  const name = raw.trim();
  if (name === "" || name.length > MAX_TEXT || CONTROL.test(name) || /[/\\]/.test(name)) {
    invalid("The file name must be a plain name of at most 200 characters, such as nda.docx.");
  }
  if (!/\.docx$/i.test(name)) invalid("Only Word .docx contracts can be reviewed.");
  return name;
}

function checkText(raw: string | undefined, what: string): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  if (text === "" || text.length > MAX_TEXT || CONTROL.test(text)) {
    invalid(`The ${what} must be between 1 and 200 visible characters on one line.`);
  }
  return text;
}

export function createReviewService(deps: ReviewServiceDeps) {
  const maxBytes = deps.maxContractBytes ?? DEFAULT_MAX_CONTRACT_BYTES;
  const newId = deps.newId ?? randomUUID;
  const now = () => (deps.now ?? (() => new Date()))().toISOString();

  // Version 1 has no sharing, so anyone but the owner is told the review does not exist.
  async function own(user: User, id: string): Promise<ReviewRecord> {
    const record = await deps.records.get(id);
    if (record === undefined || record.owner !== user.id) {
      throw new ServiceError("not_found", "There is no such review.");
    }
    return record;
  }

  return {
    async listPlaybooks(): Promise<PlaybookSummary[]> {
      return deps.playbooks.list();
    },

    async createReview(user: User, request: NewReview): Promise<ReviewRecord> {
      const fileName = checkFileName(request.fileName);
      const client = checkText(request.client, "client");
      const author = checkText(request.author, "author name") ?? DEFAULT_AUTHOR;
      if ((await deps.playbooks.get(request.playbookId)) === undefined) {
        invalid("There is no playbook with that id.");
      }
      const at = now();
      const record: ReviewRecord = {
        id: newId(),
        owner: user.id,
        playbookId: request.playbookId,
        fileName,
        client,
        author,
        status: "awaiting_upload",
        createdAt: at,
        updatedAt: at,
      };
      await deps.records.create(record);
      return record;
    },

    /**
     * Stores the contract. In Azure the browser uploads straight to Blob Storage instead, with a
     * short-lived URL, and this path serves local runs and tests.
     */
    async uploadContract(user: User, id: string, bytes: Uint8Array): Promise<void> {
      const record = await own(user, id);
      if (record.status !== "awaiting_upload") {
        throw new ServiceError("conflict", "This review already has its contract.");
      }
      if (bytes.byteLength > maxBytes) {
        throw new ServiceError(
          "too_large",
          `The contract is larger than ${Math.floor(maxBytes / (1024 * 1024))} MiB.`,
        );
      }
      await deps.contracts.put(contractKey(id), bytes);
    },

    /**
     * Opens the contract before anything is queued, so a file that is not Word, an old .doc, a
     * password protected or damaged file is refused at once, in the words of the Word engine, as
     * the CLI refuses it before any model is called.
     */
    async startReview(user: User, id: string): Promise<ReviewRecord> {
      const record = await own(user, id);
      if (record.status !== "awaiting_upload") {
        throw new ServiceError("conflict", "This review has already been started.");
      }
      const bytes = await deps.contracts.get(contractKey(id));
      if (bytes === undefined) {
        throw new ServiceError("conflict", "Upload the contract before starting the review.");
      }
      try {
        await parseDocx(bytes);
      } catch (error) {
        if (!(error instanceof DocxError)) throw error;
        const reason = error.message.trim();
        invalid(`Cannot open ${record.fileName}: ${/[.!?]$/.test(reason) ? reason : `${reason}.`}`);
      }
      const queued = await deps.records.transition(id, ["awaiting_upload"], {
        status: "queued",
        updatedAt: now(),
      });
      if (queued === undefined) {
        throw new ServiceError("conflict", "This review has already been started.");
      }
      await deps.queue.send({ reviewId: id });
      return queued;
    },

    async getReview(user: User, id: string): Promise<ReviewRecord> {
      return own(user, id);
    },

    async getResult(user: User, id: string, kind: ResultKind): Promise<Uint8Array> {
      const record = await own(user, id);
      if (record.status !== "done") {
        throw new ServiceError("conflict", "The review has not finished.");
      }
      const data = await deps.results.get(resultKey(id, kind));
      if (data === undefined) throw new ServiceError("not_found", "That result is missing.");
      return data;
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;
