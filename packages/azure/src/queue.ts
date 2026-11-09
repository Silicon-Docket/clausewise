import type { Delivery, JobQueue, ReviewJob } from "@clausewise/service";
import { DOMParser } from "@xmldom/xmldom";
import {
  StorageError,
  normalizeEndpoint,
  storageRequest,
  unexpected,
  type StorageClientOptions,
} from "./rest.js";

// Azure's own rule for queue names.
const QUEUE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REVIEW_ID = /^[A-Za-z0-9-]{1,64}$/;

export interface QueueOptions extends StorageClientOptions {
  queue: string;
  /**
   * How long a received job stays hidden from other workers. A review that runs longer is seen
   * as busy by the next worker and released again, so this only needs to cover most reviews.
   * Default 10 minutes.
   */
  visibilitySeconds?: number;
  /** How long a released job stays hidden before it is delivered again. Default 1 minute. */
  retryDelaySeconds?: number;
  /** Told when a message that is not a review job was found and removed. */
  onInvalid?: () => void;
}

interface Message {
  id: string;
  popReceipt: string;
  dequeueCount: number;
  text: string;
}

function text(parent: Element, name: string): string | undefined {
  return parent.getElementsByTagName(name)[0]?.textContent ?? undefined;
}

// The answer comes from Azure Storage, but it is parsed strictly all the same, and a parser message
// is never passed on.
function parseMessages(xml: string): Message[] {
  const invalid = () =>
    new StorageError("Azure Storage answered with invalid XML.", 200, undefined);
  const parser = new DOMParser({
    onError(level) {
      if (level !== "warning") throw invalid();
    },
  });
  let doc: Document;
  try {
    doc = parser.parseFromString(xml, "text/xml") as unknown as Document;
  } catch {
    // The parser's own error can quote what it was given, so it is replaced, not passed on.
    throw invalid();
  }
  const messages: Message[] = [];
  for (const node of Array.from(doc.getElementsByTagName("QueueMessage"))) {
    const id = text(node, "MessageId");
    const popReceipt = text(node, "PopReceipt");
    const dequeueCount = Number(text(node, "DequeueCount"));
    const body = text(node, "MessageText");
    if (id === undefined || popReceipt === undefined || body === undefined) continue;
    messages.push({
      id,
      popReceipt,
      dequeueCount: Number.isInteger(dequeueCount) ? dequeueCount : 1,
      text: body,
    });
  }
  return messages;
}

/** A job is base64-encoded JSON, as queue triggers and the Azure SDKs expect. */
function encodeJob(job: ReviewJob): string {
  return Buffer.from(JSON.stringify({ reviewId: job.reviewId }), "utf8").toString("base64");
}

function decodeJob(body: string): ReviewJob | undefined {
  try {
    const value = JSON.parse(Buffer.from(body, "base64").toString("utf8")) as unknown;
    const reviewId = (value as { reviewId?: unknown }).reviewId;
    return typeof reviewId === "string" && REVIEW_ID.test(reviewId) ? { reviewId } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An Azure Storage queue as a JobQueue, signed in with the app's managed identity. Delivery is at
 * least once: a job that is neither completed nor released before its visibility runs out is
 * delivered again, which is what the worker's leases and attempt counting are built for.
 */
export function azureStorageQueue(options: QueueOptions): JobQueue {
  const endpoint = normalizeEndpoint(options.endpoint, "The queue endpoint");
  if (!QUEUE.test(options.queue)) {
    throw new Error("The queue name is not a valid Azure Storage queue name.");
  }
  const client = { ...options, endpoint };
  const visibility = options.visibilitySeconds ?? 600;
  const retryDelay = options.retryDelaySeconds ?? 60;
  const messagesUrl = (query: Record<string, string>) => {
    const url = new URL(`${endpoint}${options.queue}/messages`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  };
  const messageUrl = (message: Message, query: Record<string, string>) => {
    const url = new URL(`${endpoint}${options.queue}/messages/${encodeURIComponent(message.id)}`);
    url.searchParams.set("popreceipt", message.popReceipt);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url;
  };

  async function remove(message: Message): Promise<void> {
    const operation = "Removing a review job";
    const response = await storageRequest(client, operation, messageUrl(message, {}), {
      method: "DELETE",
    });
    // Already gone, or taken over by another delivery: either way it is not this worker's to keep.
    if (response.status === 204 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    throw await unexpected(operation, response);
  }

  async function release(message: Message): Promise<void> {
    const operation = "Releasing a review job";
    const response = await storageRequest(
      client,
      operation,
      messageUrl(message, { visibilitytimeout: String(retryDelay) }),
      { method: "PUT" },
    );
    if (response.status === 204 || response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    throw await unexpected(operation, response);
  }

  return {
    async send(job) {
      const operation = "Queueing a review";
      // messagettl -1: a queued review must not expire unseen and leave its record queued forever.
      const response = await storageRequest(client, operation, messagesUrl({ messagettl: "-1" }), {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: `<?xml version="1.0" encoding="utf-8"?><QueueMessage><MessageText>${encodeJob(job)}</MessageText></QueueMessage>`,
      });
      if (response.status !== 201) throw await unexpected(operation, response);
      await response.body?.cancel().catch(() => undefined);
    },

    async receive(): Promise<Delivery | undefined> {
      const operation = "Taking a review job";
      const response = await storageRequest(
        client,
        operation,
        messagesUrl({ numofmessages: "1", visibilitytimeout: String(visibility) }),
        { method: "GET" },
      );
      if (response.status !== 200) throw await unexpected(operation, response);
      const [message] = parseMessages(await response.text());
      if (message === undefined) return undefined;
      const job = decodeJob(message.text);
      if (job === undefined) {
        // Nothing can ever handle it, so keeping it would only make every worker read it again.
        await remove(message);
        options.onInvalid?.();
        return undefined;
      }
      return {
        job,
        attempt: Math.max(1, message.dequeueCount),
        complete: () => remove(message),
        release: () => release(message),
      };
    },
  };
}
