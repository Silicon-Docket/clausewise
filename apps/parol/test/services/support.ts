import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import type { AuthorizedMatter, Principal } from "../../src/auth/types.js";
import { registerAll } from "../../src/boot/register.js";
import type { AnalysisAnswer } from "../../src/contracts.js";
import { createServices } from "../../src/services/index.js";
import type { ServiceConfig, ServiceDeps } from "../../src/services/deps.js";
import type { Services } from "../../src/services/types.js";
import type { DecisionRequest, FindingView, IssueRow } from "../../src/services/views.js";
import {
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  openDatabase,
  type Repository,
} from "../../src/store/index.js";
import {
  buildCaseWorld,
  extractAnswer,
  keyAnswer,
  revisedAnswer,
  type CaseWorld,
} from "../integration/pipeline.js";
import { CATEGORY_IDS } from "../../src/contracts.js";

/**
 * A world for the service tests: the real store (in memory), a file store in a temporary folder,
 * the real stages, and a scripted model standing in for the provider. Nothing here calls a network.
 * Every document, party and name is synthetic.
 */

export const BASE_CASE = "PAROL-D05";
export const baseWorld: CaseWorld = await buildCaseWorld(BASE_CASE);
export const twinOf = async (caseKey: string): Promise<CaseWorld> =>
  buildCaseWorld(caseKey, { twin: true });

// ---------------------------------------------------------------------------------------------
// The scripted model
// ---------------------------------------------------------------------------------------------

export interface ModelCall {
  kind: "extract" | "analyze" | "support" | "other";
  ruleKey: string | undefined;
  prompt: string;
}

export interface ModelOptions {
  /** The case whose key the model answers from. Default: the base case. */
  world?: CaseWorld;
  /** Answers by rule key, replacing the key's own. */
  answers?: Record<string, AnalysisAnswer>;
  /**
   * Runs before each call is answered. A promise holds the call; a throw fails it (a provider
   * error). This is how a test pauses a run, cancels it, or breaks one rule.
   */
  before?: (call: ModelCall, request: GenerateObjectRequest<unknown>) => void | Promise<void>;
  /** The verdict of a support check. Default: supported. */
  supportVerdict?: "supported" | "not_supported" | "insufficient";
  /** What the generator says about itself, such as that it caches a shared prefix. */
  info?: {
    provider?: string;
    model?: string;
    disclosure?: string;
    cachesSharedPrefix?: boolean;
    minCacheableChars?: number;
  };
}

export function controlledModel(options: ModelOptions = {}): {
  generator: ObjectGenerator & { readonly calls: GenerateObjectRequest<unknown>[] };
  calls: ModelCall[];
  callsFor(ruleKey: string): ModelCall[];
  count(kind: ModelCall["kind"]): number;
} {
  const world = options.world ?? baseWorld;
  const calls: ModelCall[] = [];
  const generator = createScriptedGenerator(async (request) => {
    const kind =
      request.schemaName === "locate_passages"
        ? "extract"
        : request.schemaName === "analyze_rule"
          ? "analyze"
          : request.schemaName === "check_support"
            ? "support"
            : "other";
    const ruleKey = /^Rule ID: (\S+)$/m.exec(request.prompt)?.[1];
    const call: ModelCall = { kind, ruleKey, prompt: request.prompt };
    calls.push(call);
    await options.before?.(call, request);
    if (kind === "extract") return extractAnswer(world);
    if (kind === "analyze") {
      if (ruleKey === undefined) throw new Error("the analyze prompt names no rule");
      return options.answers?.[ruleKey] ?? keyAnswer(world, ruleKey);
    }
    if (kind === "support")
      return {
        verdict: options.supportVerdict ?? "supported",
        missingPremise: options.supportVerdict === undefined ? null : "x",
      };
    throw new Error("unexpected schema");
  }, options.info);
  return {
    generator,
    calls,
    callsFor: (ruleKey) => calls.filter((c) => c.ruleKey === ruleKey && c.kind === "analyze"),
    count: (kind) => calls.filter((c) => c.kind === kind).length,
  };
}

/** A gate: calls that reach it wait until `open()`. `reached` resolves when the n-th call arrives. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const waiters: { count: number; resolve: () => void }[] = [];
  let arrived = 0;
  return {
    open,
    /** Held until opened. */
    pass: async (): Promise<void> => {
      arrived += 1;
      for (const w of [...waiters]) if (arrived >= w.count) w.resolve();
      await opened;
    },
    reached: (count = 1): Promise<void> =>
      arrived >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve })),
    get arrived() {
      return arrived;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------------------------

export interface World {
  repo: Repository;
  files: FileStore;
  services: Services;
  model: ReturnType<typeof controlledModel>;
  logs: string[];
  root: string;
  playbookVersionId: string;
  deps: ServiceDeps;
  /** A principal for a seeded user, read from the database. */
  principal(userId: string): Principal;
  associate: Principal;
  reviewer: Principal;
  engineer: Principal;
  admin: Principal;
  /** Proof of membership, made the way the authorization layer makes it: from the database. */
  grant(principal: Principal, matterId: string): AuthorizedMatter;
  close(): void;
}

const roots: string[] = [];

/** Test-only construction of a branded value: the brand has no runtime form. */
const brand = <T>(value: unknown): T => value as T;

export function makeWorld(
  options: {
    config?: Partial<ServiceConfig>;
    model?: ModelOptions;
    model2?: ReturnType<typeof controlledModel>;
    now?: () => Date;
    supportChecker?: ServiceDeps["supportChecker"];
    buildMemo?: ServiceDeps["buildMemo"];
    /**
     * Lay the world out as a data folder: the database is `<root>/parol.sqlite` and the file store
     * is `<root>/matters`, as the server and the commands have them, so that one folder can be
     * walked for what a deletion left behind. Without it the database is in memory and the file
     * store is `<root>/files`.
     */
    onDisk?: boolean;
    /** How long the database waits for a lock; short, so that a test of a busy log need not wait. */
    busyTimeoutMs?: number;
  } = {},
): World {
  let tick = Date.parse("2026-11-03T09:00:00.000Z");
  const root = mkdtempSync(join(tmpdir(), "parol-services-"));
  roots.push(root);
  const repo = createRepository(
    openDatabase(
      options.onDisk === true ? join(root, "parol.sqlite") : ":memory:",
      options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs },
    ),
    { now: () => new Date((tick += 1000)) },
  );
  const registered = registerAll(repo, { seedDemoUsers: true });
  const files = new FileStore(join(root, options.onDisk === true ? "matters" : "files"));
  const model = options.model2 ?? controlledModel(options.model);
  const logs: string[] = [];
  const config: ServiceConfig = {
    relaxedSegregation: false,
    maxConcurrentRuns: 2,
    ...options.config,
  };
  const deps: ServiceDeps = {
    repo,
    files,
    generator: model.generator,
    config,
    now: options.now ?? (() => new Date("2026-11-04T09:00:00.000Z")),
    log: (line) => logs.push(line),
    ...(options.supportChecker === undefined ? {} : { supportChecker: options.supportChecker }),
    ...(options.buildMemo === undefined ? {} : { buildMemo: options.buildMemo }),
  };
  const services = createServices(deps);
  const principal = (userId: string): Principal => {
    const user = repo.getUser(userId);
    if (user === undefined) throw new Error("no such demo user");
    return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
  };
  return {
    repo,
    files,
    services,
    model,
    logs,
    root,
    playbookVersionId: registered.playbook.id,
    deps,
    principal,
    associate: principal(DEMO_USER_IDS.associate),
    reviewer: principal(DEMO_USER_IDS.reviewer),
    engineer: principal(DEMO_USER_IDS.legalEngineer),
    admin: principal(DEMO_USER_IDS.admin),
    grant(p, matterId) {
      const member = repo.getMember(matterId, p.userId);
      if (member === undefined) throw new Error("not a member of the matter");
      return brand<AuthorizedMatter>({ matterId, principal: p, role: member.role });
    },
    close() {
      if (options.onDisk === true) {
        try {
          repo.db.close();
        } catch {
          // Already closed by the test, which does so when it opens the file itself.
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function cleanup(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export interface Uploaded {
  matterId: string;
  documentIds: string[];
  versionIds: string[];
}

/** A matter with the associate as creator and the reviewer added, the playbook chosen, nothing uploaded. */
export function newMatter(w: World, name = "Lanternfish / Corvane NDA") {
  const summary = w.services.matters.create(w.associate, {
    name,
    clientLegalName: baseWorld.manifest.clientLegalName,
    playbookVersionId: w.playbookVersionId,
    reviewerUserId: w.reviewer.userId,
  });
  return { summary, matterId: summary.id, am: w.grant(w.associate, summary.id) };
}

/** Uploads the documents of a case in label order. */
export async function uploadCase(
  w: World,
  matterId: string,
  world: CaseWorld = baseWorld,
): Promise<Uploaded> {
  const am = w.grant(w.associate, matterId);
  const out: Uploaded = { matterId, documentIds: [], versionIds: [] };
  for (const file of world.files) {
    const document = world.documents.find((d) => d.label === file.label)!;
    const result = await w.services.matters.addDocument(am, {
      title: document.title,
      kind: document.kind,
      fileName: file.file,
      bytes: file.bytes,
      statedDate: document.statedDate,
    });
    out.documentIds.push(result.documentId);
    out.versionIds.push(result.versionId);
  }
  return out;
}

/** The whole way to a finished review: a matter, its documents, a run, and the wait for it. */
export async function reviewed(w: World, options: { workflowLabel?: string } = {}) {
  const { matterId, am } = newMatter(w);
  const uploaded = await uploadCase(w, matterId);
  const run = w.services.runs.start(am, { workflowLabel: options.workflowLabel ?? "v2" });
  await w.services.runs.idle();
  return { matterId, am, uploaded, runId: run.id, reviewerAm: w.grant(w.reviewer, matterId) };
}

/** What a reviewer's decision on a finding looks like in this world: accept what is verified, escalate the rest. */
export function decisionFor(view: FindingView): DecisionRequest {
  const ok = view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
  return {
    decision: ok ? "accept" : "escalate",
    findingContentSha256: view.contentSha256,
    edits: null,
    reason: ok ? null : "The workflow could not settle this rule.",
  };
}

/** The reviewer decides every finding of the run. */
export function decideAll(
  w: World,
  reviewerAm: AuthorizedMatter,
  issues: IssueRow[],
): FindingView[] {
  return issues.map((issue) => {
    const view = w.services.runs.finding(reviewerAm, issue.findingId);
    return w.services.reviews.decide(reviewerAm, issue.findingId, decisionFor(view));
  });
}

export { revisedAnswer, CATEGORY_IDS };
