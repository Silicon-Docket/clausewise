import { randomBytes, randomUUID } from "node:crypto";
import type { ObjectGenerator } from "@clausewise/llm";
import type { ReviewOptions } from "@clausewise/review";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db/client.js";
import type { JobRunner } from "./jobs.js";
import type { Logger } from "./log.js";
import type { PlaybookStore } from "./playbooks.js";
import type { DocumentStorage } from "./storage.js";

export interface Clock {
  now(): Date;
}

export interface IdSource {
  /** A new document, review or storage id. */
  uuid(): string;
  /** A short id for a custom playbook. */
  shortId(): string;
  /** An id for one request, which the log and the error reply share. */
  requestId(): string;
}

export const systemClock: Clock = { now: () => new Date() };

export const randomIds: IdSource = {
  uuid: () => randomUUID(),
  shortId: () => randomBytes(5).toString("hex"),
  requestId: () => randomBytes(8).toString("hex"),
};

/** What `reviewContract` is told besides the document, taken from the model settings. */
export type ReviewLimits = Pick<ReviewOptions, "concurrency" | "maxContextTokens">;

/**
 * The model, or why there is none. A missing or wrong key never stops the server: the web app
 * shows the problem and the review routes answer 503 with it.
 */
export type ModelSetup = { generator: ObjectGenerator; limits: ReviewLimits } | { problem: string };

export interface AppDeps {
  db: Db;
  storage: DocumentStorage;
  model: ModelSetup;
  config: ServerConfig;
  clock: Clock;
  ids: IdSource;
  log: Logger;
  playbooks: PlaybookStore;
  runner: JobRunner;
  /** Shown by GET /api/config. */
  version: string;
}
