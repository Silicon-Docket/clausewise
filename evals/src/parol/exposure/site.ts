/**
 * The Parol application, built in process for the exposure suite: the real shell (`createApp`),
 * the real routes (`registerRoutes`), the real services over an in-memory store and a temporary
 * file store, with demo users, sessions and CSRF tokens. It is the site of apps/parol/test/routes
 * (support.ts) without vitest, so that the evaluation can use it.
 *
 * Nothing here opens a socket, and the model is whatever generator the caller passes, which in the
 * exposure suite is a scripted oracle. Every user, matter and document is synthetic.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectGenerator } from "@clausewise/llm";
import type { MatterAction } from "../../../../apps/parol/src/auth/actions.js";
import { authorizeMatter } from "../../../../apps/parol/src/auth/authorize.js";
import type { AuthorizedMatter, Principal } from "../../../../apps/parol/src/auth/types.js";
import { PROMPT_IDS, WORKFLOW_LABELS } from "../../../../apps/parol/src/boot/register.js";
import { buildMemo } from "../../../../apps/parol/src/export/memo.js";
import type { BuildMemo, LoadedPlaybook } from "../../../../apps/parol/src/module-contracts.js";
import { promptRecord } from "../../../../apps/parol/src/prompts/registry.js";
import { workflowFor } from "../../../../apps/parol/src/prompts/workflows.js";
import { createApp } from "../../../../apps/parol/src/server/app.js";
import type { AppConfig, AppDeps } from "../../../../apps/parol/src/server/deps.js";
import { renderErrorPage } from "../../../../apps/parol/src/server/pages/index.js";
import { registerRoutes } from "../../../../apps/parol/src/server/routes/index.js";
import type { ServiceConfig, ServiceDeps } from "../../../../apps/parol/src/services/deps.js";
import { createServices } from "../../../../apps/parol/src/services/index.js";
import type { Services } from "../../../../apps/parol/src/services/types.js";
import {
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  openDatabase,
  type Repository,
} from "../../../../apps/parol/src/store/index.js";
import { EvalError } from "../../errors.js";

export type App = ReturnType<typeof createApp>;

/** A fixed secret for a server that exists for one run and is never reachable. Synthetic. */
const COOKIE_SECRET = "exposure-suite-cookie-secret-0123456789abcdef";
const UPLOAD_LIMIT_BYTES = 1024 * 1024;

/** What a test may do to the application to show that the suite can fail. The suite never does. */
export interface SiteHooks {
  /**
   * Runs after the shell is made and before the real routes are registered, so a route added here
   * is matched first. This is where a test plants an authorization hole or a revealing refusal.
   */
  beforeRoutes?: (app: App, deps: AppDeps) => void;
  /**
   * Runs after the real routes are registered, so a route added here is matched last and answers
   * only what no real route did. This is where a test plants a catch-all that the real routes do
   * not shadow.
   */
  afterRoutes?: (app: App, deps: AppDeps) => void;
  /** Wraps the memo builder the services use. */
  wrapMemoBuilder?: (real: BuildMemo) => BuildMemo;
}

/**
 * The workflow version the exposure suite reviews under when the run does not name one: the newest
 * the application ships.
 */
export const DEFAULT_EXPOSURE_WORKFLOW: string = WORKFLOW_LABELS[WORKFLOW_LABELS.length - 1]!;

export interface SiteOptions {
  playbook: LoadedPlaybook;
  /**
   * The workflow version the reviews of the suite run under. It is registered in the site's store
   * beside the versions the application ships, so an evaluation candidate that the application does
   * not ship (v3) can be exercised; the application itself registers only the shipped ones.
   * Default: DEFAULT_EXPOSURE_WORKFLOW.
   */
  workflow?: string;
  /** The model the services call. The caller decides what it is. */
  generator: ObjectGenerator;
  /** Single-person demonstration: the services and the shell both relax segregation. */
  relaxed?: boolean;
  hooks?: SiteHooks;
}

export interface ExposureSite {
  /** The workflow version the suite's reviews run under. */
  workflowLabel: string;
  repo: Repository;
  services: Services;
  app: App;
  deps: AppDeps;
  relaxed: boolean;
  /** Every access log line, in order. */
  accessLog: string[];
  /** Every line the services logged. */
  serviceLog: string[];
  playbookVersionId: string;
  principal(userId: string): Principal;
  /** Proof of membership, made the way the application makes it: by the authorization layer, from the database. */
  authorize(userId: string, matterId: string, action: MatterAction): AuthorizedMatter;
  addUser(id: string, displayName: string): void;
  anonymous(): SiteClient;
  signIn(userId: string): Promise<SiteClient>;
  /**
   * Checks that the application's pages render in this process. They are Hono JSX, and a process
   * that was not started with the JSX settings of apps/parol answers every page with a 500, which
   * would make a probe matrix look like a different failure. Throws with the remedy.
   */
  preflight(): Promise<void>;
  /** Removes the temporary folder. Safe to call twice. */
  close(): void;
}

/** A browser stand-in: sends the cookies it holds and keeps the ones it is given. */
export class SiteClient {
  private readonly jar = new Map<string, string>();
  constructor(private readonly app: App) {}

  async send(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookie = [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie !== "" && !headers.has("cookie")) headers.set("cookie", cookie);
    const request: RequestInit = { method, headers };
    if (init.body !== undefined) request.body = init.body;
    const response = await this.app.request(path, request);
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ""] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const gone = value === "" || /;\s*max-age=0\b/i.test(raw);
      if (gone) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return response;
  }

  get(path: string): Promise<Response> {
    return this.send("GET", path);
  }

  /** The token a script sends with a write, for whoever this client is now. */
  async apiToken(): Promise<string> {
    const response = await this.get("/api/session");
    const body = (await response.json()) as { csrfToken?: unknown };
    if (typeof body.csrfToken !== "string")
      throw new EvalError("The application did not give a CSRF token at /api/session.");
    return body.csrfToken;
  }
}

/**
 * The prompts, the workflow versions and the playbook the run depends on, put into the store as
 * the application does at start-up (`registerAll`), but with the playbook the evaluation loaded
 * and not the one on disk.
 */
function register(repo: Repository, playbook: LoadedPlaybook, workflowLabel: string): string {
  repo.seedDemoUsers();
  for (const id of PROMPT_IDS) repo.upsertPromptVersion(promptRecord(id), { actorId: null });
  // The shipped versions, and the one under test when the evaluation asks for another.
  const labels = new Set<string>([...WORKFLOW_LABELS, workflowLabel]);
  for (const label of labels) repo.upsertWorkflowVersion(workflowFor(label), { actorId: null });
  let version = repo.findPlaybookVersion(playbook.slug, playbook.version);
  if (version === undefined || version.sha256 !== playbook.sha256)
    version = repo.importPlaybookDraft(
      {
        slug: playbook.slug,
        version: playbook.version,
        yaml: playbook.yaml,
        sha256: playbook.sha256,
        rules: playbook.rules,
      },
      { actorId: DEMO_USER_IDS.legalEngineer },
    );
  if (version.status === "draft")
    version = repo.approvePlaybookVersion(version.id, { actorId: DEMO_USER_IDS.admin });
  return version.id;
}

export function createExposureSite(options: SiteOptions): ExposureSite {
  const relaxed = options.relaxed === true;
  const root = mkdtempSync(join(tmpdir(), "parol-exposure-"));
  let closed = false;
  try {
    // A clock that ticks once a second, so rows made in turn sort in the order they were made.
    let tick = Date.parse("2026-11-03T09:00:00.000Z");
    const repo = createRepository(openDatabase(":memory:"), {
      now: () => new Date((tick += 1000)),
    });
    const workflowLabel = options.workflow ?? DEFAULT_EXPOSURE_WORKFLOW;
    const playbookVersionId = register(repo, options.playbook, workflowLabel);
    const files = new FileStore(join(root, "files"));
    const now = (): Date => new Date("2026-11-04T09:00:00.000Z");

    const serviceLog: string[] = [];
    const serviceConfig: ServiceConfig = { relaxedSegregation: relaxed, maxConcurrentRuns: 2 };
    const serviceDeps: ServiceDeps = {
      repo,
      files,
      generator: options.generator,
      config: serviceConfig,
      now,
      log: (line) => serviceLog.push(line),
      ...(options.hooks?.wrapMemoBuilder === undefined
        ? {}
        : { buildMemo: options.hooks.wrapMemoBuilder(buildMemo) }),
    };
    const services = createServices(serviceDeps);

    const config: AppConfig = {
      demoIdentity: true,
      cookieSecret: COOKIE_SECRET,
      secureCookies: false,
      maxUploadBytes: UPLOAD_LIMIT_BYTES,
      ...(relaxed ? { relaxedSegregation: true } : {}),
    };
    const deps: AppDeps = { repo, services, config, now };
    const accessLog: string[] = [];
    const app = createApp(deps, {
      log: (line) => accessLog.push(line),
      renderError: renderErrorPage,
    });
    options.hooks?.beforeRoutes?.(app, deps);
    registerRoutes(app, deps);
    options.hooks?.afterRoutes?.(app, deps);

    const principal = (userId: string): Principal => {
      const user = repo.getUser(userId);
      if (user === undefined) throw new EvalError("The exposure site has no such user.");
      return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
    };

    const site: ExposureSite = {
      workflowLabel,
      repo,
      services,
      app,
      deps,
      relaxed,
      accessLog,
      serviceLog,
      playbookVersionId,
      principal,
      authorize: (userId, matterId, action) =>
        authorizeMatter(repo, principal(userId), matterId, action, {
          relaxedSegregation: relaxed,
        }),
      addUser(id, displayName) {
        repo.db
          .prepare("INSERT INTO users (id, display_name, global_role, demo) VALUES (?, ?, ?, 1)")
          .run(id, displayName, "member");
      },
      anonymous: () => new SiteClient(app),
      async signIn(userId) {
        const client = new SiteClient(app);
        // A script signs in as a form does, but with JSON and the token in the header.
        const token = await client.apiToken();
        const response = await client.send("POST", "/session", {
          headers: { "content-type": "application/json", "x-csrf-token": token },
          body: JSON.stringify({ intent: "sign-in", userId }),
        });
        if (response.status !== 200)
          throw new EvalError(`Signing in to the exposure site was refused (${response.status}).`);
        return client;
      },
      async preflight() {
        const client = await site.signIn(DEMO_USER_IDS.associate);
        const response = await client.get("/matters");
        if (response.status !== 200)
          throw new EvalError(
            `The application's pages did not render in this process (the matters page answered ${response.status}). ` +
              "When the evaluation runs under tsx, start it with --tsconfig apps/parol/tsconfig.json " +
              "so that the JSX of the pages is compiled for Hono.",
          );
      },
      close() {
        if (closed) return;
        closed = true;
        rmSync(root, { recursive: true, force: true });
      },
    };
    return site;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
