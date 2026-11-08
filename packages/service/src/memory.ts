import type {
  BlobStore,
  Delivery,
  JobQueue,
  ReviewJob,
  ReviewRecord,
  ReviewRecords,
  ReviewStatus,
} from "./types.js";

/**
 * In-memory stores and queue, for tests and for running the service on one machine. Nothing
 * survives a restart. The Azure adapters keep the same contracts.
 */
export function memoryBlobs(): BlobStore & { keys(): string[] } {
  const blobs = new Map<string, Uint8Array>();
  return {
    async put(key, data) {
      blobs.set(key, new Uint8Array(data));
    },
    async get(key) {
      const data = blobs.get(key);
      return data === undefined ? undefined : new Uint8Array(data);
    },
    keys: () => [...blobs.keys()],
  };
}

export function memoryRecords(): ReviewRecords {
  const records = new Map<string, ReviewRecord>();
  const copy = (record: ReviewRecord): ReviewRecord => structuredClone(record);
  return {
    async create(record) {
      if (records.has(record.id)) throw new Error("A review with this id already exists.");
      records.set(record.id, copy(record));
    },
    async get(id) {
      const record = records.get(id);
      return record === undefined ? undefined : copy(record);
    },
    async transition(id, from: readonly ReviewStatus[], patch) {
      const record = records.get(id);
      if (record === undefined || !from.includes(record.status)) return undefined;
      const updated = { ...record, ...patch };
      records.set(id, updated);
      return copy(updated);
    },
    async claim(id, now, staleBefore) {
      const record = records.get(id);
      if (record === undefined) return undefined;
      const stale = record.status === "running" && record.updatedAt < staleBefore;
      if (record.status !== "queued" && !stale) return undefined;
      const updated: ReviewRecord = { ...record, status: "running", updatedAt: now };
      records.set(id, updated);
      return copy(updated);
    },
  };
}

/** A queue that delivers each job once, and again after `release`, like a storage queue. */
export function memoryQueue(): JobQueue & { size(): number } {
  const waiting: ReviewJob[] = [];
  return {
    async send(job) {
      waiting.push({ ...job });
    },
    async receive(): Promise<Delivery | undefined> {
      const job = waiting.shift();
      if (job === undefined) return undefined;
      return {
        job,
        complete: async () => {},
        release: async () => {
          waiting.push(job);
        },
      };
    },
    size: () => waiting.length,
  };
}
