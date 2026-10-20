import { mkdtemp, readFile, rm } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocumentSummary, Finding, ReviewDetail, ReviewSummary } from "@clausewise/api";
import {
  ModelRefusalError,
  type GenerateObjectRequest,
  type ObjectGenerator,
} from "@clausewise/llm";
import { createOracleGenerator } from "@clausewise/review/testing";
import { sql, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, afterEach, vi } from "vitest";
import { createApp } from "../src/app.js";
import { DEFAULTS, type ServerConfig } from "../src/config.js";
import { openDatabase, type Database, type DatabaseTarget } from "../src/db/client.js";
import { applyMigrations } from "../src/db/migrate.js";
import type { AppDeps, Clock, IdSource, ModelSetup } from "../src/deps.js";
import type { AppEnv } from "../src/env.js";
import { createJobRunner, type JobRunner } from "../src/jobs.js";
import { createLogger, type Logger } from "../src/log.js";
import { createPlaybookStore } from "../src/playbooks.js";
import { createFileStorage, type DocumentStorage } from "../src/storage.js";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";

// Starting a database takes about two seconds, and several times that when the machine is busy
// with other test runs, so the default of five seconds a test is too tight for these.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

export const root = join(import.meta.dirname, "..", "..", "..");
export const fixturePath = (name: string): string => join(root, "fixtures", name);
export const playbooksDir = join(root, "playbooks");

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ---------------------------------------------------------------------------------------------
// Files and fixtures
// ---------------------------------------------------------------------------------------------

const cleanups: (() => Promise<void>)[] = [];
const fileCleanups: (() => Promise<void>)[] = [];

/** Registers something to tear down after the current test, or after the file with `scope: "file"`. */
export function later(cleanup: () => Promise<void>, scope: "test" | "file" = "test"): void {
  (scope === "file" ? fileCleanups : cleanups).push(cleanup);
}

// Last in, first out: a database is closed before the folder it lives in is removed.
async function runAll(list: (() => Promise<void>)[]): Promise<void> {
  for (const cleanup of list.splice(0).reverse()) await cleanup();
}

afterEach(() => runAll(cleanups));
afterAll(() => runAll(fileCleanups));

export async function tempDir(
  prefix = "clausewise-server-",
  scope: "test" | "file" = "test",
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  later(() => rm(dir, { recursive: true, force: true }), scope);
  return dir;
}

export async function fixtureBytes(name: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(fixturePath(name)));
}

const fixtureCache = new Map<string, Promise<Fixture>>();

/** A fixture with its playbook and the statuses a correct review gives it. */
export function fixture(name: string): Promise<Fixture> {
  let loaded = fixtureCache.get(name);
  if (loaded === undefined) {
    loaded = loadFixtures(root, [name]).then((list) => {
      const [first] = list;
      if (first === undefined) throw new Error(`No fixture ${name}`);
      return first;
    });
    fixtureCache.set(name, loaded);
  }
  return loaded;
}

/** A model stand-in that reviews a fixture the way a perfect reviewer would. */
export async function oracleFor(name: string) {
  return createOracleGenerator(oracleScripts(await fixture(name)));
}

// ---------------------------------------------------------------------------------------------
// Controlled clock, ids and log
// ---------------------------------------------------------------------------------------------

export function fakeClock(
  start = "2026-03-01T09:00:00.000Z",
): Clock & { advance(ms: number): void } {
  let at = new Date(start).getTime();
  return {
    now: () => new Date(at),
    advance: (ms) => {
      at += ms;
    },
  };
}

const hex = (n: number, width: number): string => n.toString(16).padStart(width, "0");

/** Ids that count up, so that a test knows them and two runs produce the same ones. */
export function sequentialIds(): IdSource {
  let uuid = 0;
  let short = 0;
  let request = 0;
  return {
    uuid: () => `00000000-0000-4000-8000-${hex((uuid += 1), 12)}`,
    shortId: () => `pb${hex((short += 1), 4)}`,
    requestId: () => `req-${(request += 1)}`,
  };
}

export function captureLog(clock: Clock): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    log: createLogger(
      (line) => lines.push(line),
      () => clock.now(),
    ),
    lines,
  };
}

// ---------------------------------------------------------------------------------------------
// A whole server minus the network
// ---------------------------------------------------------------------------------------------

export function testConfig(dataDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    databaseUrl: undefined,
    dataDir,
    playbooksDir,
    webDir: join(dataDir, "no-web"),
    accessToken: undefined,
    allowedHosts: [],
    maxUploadBytes: 5 * 1024 * 1024,
    reviewConcurrency: DEFAULTS.reviewConcurrency,
    maxQueued: DEFAULTS.maxQueued,
    maxReviewsPerDocument: DEFAULTS.maxReviewsPerDocument,
    progressIntervalMs: 0,
    ...overrides,
  };
}

let sharedDatabase: Promise<Database> | undefined;

/**
 * An in-memory database with the migrations applied. Starting one takes about two seconds, so the
 * tests of one file share a single one and empty it for each test. A harness that lives for the
 * whole file, or one on a database of its own, does not use the shared one.
 */
async function acquireDatabase(
  target: DatabaseTarget | undefined,
  scope: "test" | "file",
): Promise<Database> {
  if (target !== undefined || scope === "file") {
    const own = await openDatabase(target ?? { kind: "memory" });
    later(() => own.close(), scope);
    await applyMigrations(own);
    return own;
  }
  sharedDatabase ??= (async () => {
    const opened = await openDatabase({ kind: "memory" });
    later(() => opened.close(), "file");
    await applyMigrations(opened);
    return opened;
  })();
  const shared = await sharedDatabase;
  await shared.db.execute(
    sql`truncate table findings, reviews, playbooks, documents restart identity cascade`,
  );
  return shared;
}

export interface Harness {
  app: Hono<AppEnv>;
  /** What the app was built from, so that a test can build another app with one part replaced. */
  deps: AppDeps;
  database: Database;
  storage: DocumentStorage;
  runner: JobRunner;
  clock: ReturnType<typeof fakeClock>;
  config: ServerConfig;
  dataDir: string;
  /** Every line the server logged. */
  lines: string[];
  /** A request through the app. The Host header is localhost unless the init says otherwise. */
  request(path: string, init?: RequestInit): Promise<Response>;
  json<T = unknown>(
    path: string,
    init?: RequestInit,
  ): Promise<{ status: number; body: T; headers: Headers }>;
  /** Sends a JSON body with the method. */
  send<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T; headers: Headers }>;
  upload(
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
    init?: { headers?: Record<string, string> },
  ): Promise<Response>;
  uploadFixture(name: string): Promise<DocumentSummary>;
  startReview(
    documentId: string,
    playbookId: string,
    client?: string,
  ): Promise<{ status: number; body: ReviewSummary }>;
  waitFor(reviewId: string, statuses?: string[]): Promise<ReviewDetail>;
  /** Uploads the fixture, reviews it with its playbook, and waits until the review is done. */
  reviewedFixture(
    name: string,
    client?: string,
  ): Promise<{ document: DocumentSummary; review: ReviewDetail }>;
  finding(review: ReviewDetail, ruleId: string): Finding;
  close(): Promise<void>;
}

export interface HarnessOptions {
  generator?: ObjectGenerator;
  model?: ModelSetup;
  config?: Partial<ServerConfig>;
  /** Leave the runner stopped, so queued reviews stay queued. */
  startRunner?: boolean;
  database?: DatabaseTarget;
  dataDir?: string;
  /** "file" keeps the server for every test of the file, which saves the start of the database. */
  scope?: "test" | "file";
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const scope = options.scope ?? "test";
  const dataDir = options.dataDir ?? (await tempDir("clausewise-server-", scope));
  const clock = fakeClock();
  const ids = sequentialIds();
  const { log, lines } = captureLog(clock);
  const config = testConfig(dataDir, options.config);

  const database = await acquireDatabase(options.database, scope);
  const storage = await createFileStorage(join(dataDir, "documents"));
  const model: ModelSetup =
    options.model ??
    (options.generator === undefined
      ? { problem: "No model is set up in this test." }
      : { generator: options.generator, limits: {} });

  const playbooks = createPlaybookStore({
    db: database.db,
    dir: config.playbooksDir,
    clock,
    ids,
    log,
  });
  const runner = createJobRunner({ db: database.db, storage, model, config, clock, log });
  const deps: AppDeps = {
    db: database.db,
    storage,
    model,
    config,
    clock,
    ids,
    log,
    playbooks,
    runner,
    version: "9.9.9-test",
  };
  const app = createApp(deps);
  if (options.startRunner !== false) await runner.start();
  later(() => runner.stop(), scope);

  const request: Harness["request"] = (path, init) => Promise.resolve(app.request(path, init));
  const send: Harness["send"] = async (method, path, body) => {
    const response = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text === "" ? undefined : JSON.parse(text)) as never,
      headers: response.headers,
    };
  };
  const json: Harness["json"] = async (path, init) => {
    const response = await app.request(path, init);
    const text = await response.text();
    return {
      status: response.status,
      body: (text === "" ? undefined : JSON.parse(text)) as never,
      headers: response.headers,
    };
  };

  const upload: Harness["upload"] = (name, bytes, init) => {
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: DOCX_TYPE }));
    return request("/api/documents", {
      method: "POST",
      body: form,
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
    });
  };

  const harness: Harness = {
    app,
    deps,
    database,
    storage,
    runner,
    clock,
    config,
    dataDir,
    lines,
    request,
    json,
    send,
    upload,
    async uploadFixture(name) {
      const response = await upload(name, await fixtureBytes(name));
      if (response.status !== 201) throw new Error(`Upload failed with ${response.status}`);
      return (await response.json()) as DocumentSummary;
    },
    async startReview(documentId, playbookId, client) {
      const result = await send<ReviewSummary>("POST", "/api/reviews", {
        documentId,
        playbookId,
        ...(client === undefined ? {} : { client }),
      });
      return { status: result.status, body: result.body };
    },
    async waitFor(reviewId, statuses = ["done", "failed", "cancelled"]) {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const { body } = await json<ReviewDetail>(`/api/reviews/${reviewId}`);
        if (statuses.includes(body.status)) return body;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Review ${reviewId} did not reach ${statuses.join(" or ")}.`);
    },
    async reviewedFixture(name, client) {
      const fix = await fixture(name);
      const document = await harness.uploadFixture(name);
      const playbook = fix.playbookPath.includes("saas")
        ? "builtin:saas-customer"
        : "builtin:nda-mutual";
      const started = await harness.startReview(document.id, playbook, client);
      if (started.status !== 202) throw new Error(`Review not accepted: ${started.status}`);
      return { document, review: await harness.waitFor(started.body.id) };
    },
    finding(review, ruleId) {
      const found = review.findings.find((item) => item.ruleId === ruleId);
      if (found === undefined) throw new Error(`No finding ${ruleId}`);
      return found;
    },
    async close() {
      await runner.stop();
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------

/** A zip with each entry stored uncompressed, which is enough to hold a file that is not a .docx. */
export function storedZip(entries: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, "utf8");
    const label = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(label.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(label.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(header, label, data);
    central.push(entry, label);
    offset += header.length + label.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

/**
 * A body that never ends, handed out in chunks as the reader asks for them. `pulled` says how many
 * bytes the reader took, which is how a test sees that reading stopped.
 */
export function endlessBody(chunkBytes = 64 * 1024): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let total = 0;
  let cancelled = false;
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      total += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, pulled: () => total, cancelled: () => cancelled };
}

/** The rows of a raw query, which the two drivers wrap in the same `rows` field. */
export async function queryRows<T extends Record<string, unknown>>(
  database: Pick<Database, "db">,
  query: SQL,
): Promise<T[]> {
  const result = (await database.db.execute(query)) as unknown as { rows: T[] };
  return result.rows;
}

export { sql };

// ---------------------------------------------------------------------------------------------
// Model stand-ins that misbehave
// ---------------------------------------------------------------------------------------------

const RULE_ID = /^Rule ID: (.+)$/m;

/** The id of the rule a prompt asks about, read from what follows the contract block. */
export function ruleOf(request: GenerateObjectRequest<unknown>): string | undefined {
  const close = request.prompt.lastIndexOf("</contract>");
  return RULE_ID.exec(request.prompt.slice(close))?.[1];
}

export interface Controlled {
  generator: ObjectGenerator;
  /** Lets the calls that wait through. */
  release(): void;
  /** Lets this many more calls through, and holds the rest. */
  allow(count: number): void;
  /** The signal of each call, in order. */
  signals: AbortSignal[];
  /** Prompts of every call. */
  prompts: string[];
  /** Resolves when at least this many calls have started. */
  calls(count: number): Promise<void>;
}

/**
 * Wraps a model so that its calls wait until the test lets them through, and give up when the
 * signal they were handed is aborted, as a real model call does.
 */
export function controllable(inner: ObjectGenerator, options: { open?: boolean } = {}): Controlled {
  let allowed = options.open === true ? Number.POSITIVE_INFINITY : 0;
  const waiting: (() => void)[] = [];
  const watchers: { count: number; resolve: () => void }[] = [];
  const signals: AbortSignal[] = [];
  const prompts: string[] = [];

  const let_ = (): void => {
    while (allowed > 0 && waiting.length > 0) {
      allowed -= 1;
      waiting.shift()?.();
    }
  };
  const generator: ObjectGenerator = {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    cachesSharedPrefix: false,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      if (request.signal !== undefined) signals.push(request.signal);
      prompts.push(request.prompt);
      for (const watcher of watchers.splice(0)) {
        if (signals.length >= watcher.count) watcher.resolve();
        else watchers.push(watcher);
      }
      await new Promise<void>((resolve, reject) => {
        if (allowed > 0) {
          allowed -= 1;
          resolve();
          return;
        }
        waiting.push(resolve);
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
          once: true,
        });
      });
      return inner.generate(request);
    },
  };
  return {
    generator,
    release() {
      allowed = Number.POSITIVE_INFINITY;
      let_();
    },
    allow(count) {
      allowed += count;
      let_();
    },
    signals,
    prompts,
    calls(count) {
      if (signals.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => watchers.push({ count, resolve }));
    },
  };
}

/** A model whose every call fails with the error `make` returns. */
export function failingModel(make: () => Error): ObjectGenerator {
  return {
    provider: "failing",
    model: "failing-model",
    disclosure: "a model that always fails (nothing is sent anywhere)",
    cachesSharedPrefix: false,
    async generate(): Promise<never> {
      throw make();
    },
  };
}

/** A model that answers like the oracle, except that it declines the rules named. */
export function decliningModel(
  inner: ObjectGenerator,
  declined: ReadonlySet<string>,
): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    cachesSharedPrefix: false,
    async generate<T>(request: GenerateObjectRequest<T>): Promise<T> {
      const rule = ruleOf(request);
      if (rule !== undefined && declined.has(rule)) {
        throw new ModelRefusalError("declined", "policy");
      }
      return inner.generate(request);
    },
  };
}

/** A Word file with next to no text, which a review refuses. */
export async function tinyDocx(text = "Hello."): Promise<Uint8Array<ArrayBuffer>> {
  const { Document, Packer, Paragraph } = await import("docx");
  const buffer = await Packer.toBuffer(
    new Document({ sections: [{ children: [new Paragraph(text)] }] }),
  );
  return new Uint8Array(buffer);
}

export async function builtinYaml(name = "nda-mutual"): Promise<string> {
  return readFile(join(playbooksDir, `${name}.yaml`), "utf8");
}
