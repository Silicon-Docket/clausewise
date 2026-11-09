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

/**
 * A queue that delivers each job once, and again some time after `release`, like a storage queue.
 * The delay matters even at 0: a released job comes back on a later turn of the event loop, so a
 * worker that keeps releasing it cannot starve everything else.
 */
export function memoryQueue(
  options: { releaseDelayMs?: number } = {},
): JobQueue & { size(): number } {
  const releaseDelayMs = options.releaseDelayMs ?? 1000;
  const waiting: { job: ReviewJob; attempts: number }[] = [];
  let away = 0;
  return {
    async send(job) {
      waiting.push({ job: { ...job }, attempts: 0 });
    },
    async receive(): Promise<Delivery | undefined> {
      const entry = waiting.shift();
      if (entry === undefined) return undefined;
      entry.attempts += 1;
      return {
        job: entry.job,
        attempt: entry.attempts,
        complete: async () => {},
        release: async () => {
          away += 1;
          const timer = setTimeout(() => {
            away -= 1;
            waiting.push(entry);
          }, releaseDelayMs);
          // A released job alone does not keep a process alive.
          timer.unref();
        },
      };
    },
    /** Jobs waiting or released and due back. */
    size: () => waiting.length + away,
  };
}
