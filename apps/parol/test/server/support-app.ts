import type { Hono } from "hono";
import { MATTER_ACTIONS, type MatterAction } from "../../src/auth/actions.js";
import { csrfToken } from "../../src/auth/csrf.js";
import { readPrincipal } from "../../src/auth/identity.js";
import type { MatterRole } from "../../src/contracts.js";
import { createApp, type AppOptions } from "../../src/server/app.js";
import type { AppConfig, AppDeps } from "../../src/server/deps.js";
import { defineMatterRoute, defineRoute } from "../../src/server/matter-route.js";
import type { Services } from "../../src/services/types.js";
import {
  DEMO_USER_IDS,
  createRepository,
  openDatabase,
  type Repository,
} from "../../src/store/index.js";

/**
 * A shell for the tests: the real application over an in-memory store with the demo users seeded,
 * a clock the test moves, a log it can read, and a client that keeps cookies the way a browser
 * does. The services are stand-ins that fail loudly when called, because the shell tests do not
 * exercise them; pass `services` to use the real ones.
 *
 * Route modules written later can use this too: build a shell, register their routes on
 * `shell.app`, and drive them with `shell.signIn(...)`.
 */

export const SECRET = "test-cookie-secret-0123456789-abcdefghij";
export const OTHER_SECRET = "another-cookie-secret-9876543210-zyxwvu";
export const START = new Date("2026-11-04T09:00:00.000Z");
export const HOUR_MS = 60 * 60 * 1000;

export const USERS = {
  associate: DEMO_USER_IDS.associate,
  reviewer: DEMO_USER_IDS.reviewer,
  engineer: DEMO_USER_IDS.legalEngineer,
  admin: DEMO_USER_IDS.admin,
} as const;

export class Clock {
  constructor(private current: Date = START) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Services that throw if a test reaches them by accident. */
export function stubServices(): Services {
  const refuse = (): never => {
    throw new Error("a stub service was called");
  };
  const group = <T>(): T => new Proxy({}, { get: () => refuse }) as T;
  return {
    matters: group<Services["matters"]>(),
    runs: group<Services["runs"]>(),
    reviews: group<Services["reviews"]>(),
    evaluations: group<Services["evaluations"]>(),
    audit: group<Services["audit"]>(),
    feedback: group<Services["feedback"]>(),
    pilot: group<Services["pilot"]>(),
  };
}

export interface ShellOptions {
  demoIdentity?: boolean;
  secureCookies?: boolean;
  maxUploadBytes?: number;
  relaxedSegregation?: boolean;
  cookieSecret?: string;
  services?: Services;
  app?: AppOptions;
  /** Register the two probe routes (`/__test/csrf`, `/__test/whoami`). Default true. */
  probes?: boolean;
}

export interface Shell {
  app: Hono;
  repo: Repository;
  deps: AppDeps;
  config: AppConfig;
  clock: Clock;
  /** Every access log line, in order. */
  logs: string[];
  anonymous(): Client;
  signIn(userId: string): Promise<Client>;
}

export function makeShell(options: ShellOptions = {}): Shell {
  const repo = createRepository(openDatabase(":memory:"));
  repo.seedDemoUsers();
  const clock = new Clock();
  const logs: string[] = [];
  const config: AppConfig = {
    demoIdentity: options.demoIdentity ?? true,
    cookieSecret: options.cookieSecret ?? SECRET,
    secureCookies: options.secureCookies ?? false,
    maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024,
    ...(options.relaxedSegregation === undefined
      ? {}
      : { relaxedSegregation: options.relaxedSegregation }),
  };
  const deps: AppDeps = {
    repo,
    services: options.services ?? stubServices(),
    config,
    now: clock.now,
  };
  const app = createApp(deps, { log: (line) => logs.push(line), ...options.app });
  if (options.probes !== false) mountProbes(app);
  const shell: Shell = {
    app,
    repo,
    deps,
    config,
    clock,
    logs,
    anonymous: () => new Client(app),
    async signIn(userId) {
      const client = new Client(app);
      const response = await client.post("/session", { intent: "sign-in", userId });
      if (response.status !== 303) throw new Error(`sign-in failed with ${response.status}`);
      return client;
    },
  };
  return shell;
}

/** Two public routes that expose what the page code can see: the token and the principal. */
export function mountProbes(app: Hono): void {
  defineRoute(app, {
    method: "GET",
    path: "/__test/csrf",
    access: "public",
    handler: (c) => c.json({ token: csrfToken(c) }),
  });
  defineRoute(app, {
    method: "GET",
    path: "/__test/whoami",
    access: "public",
    handler: (c) => {
      const principal = readPrincipal(c);
      return c.json({
        userId: principal?.userId ?? null,
        displayName: principal?.displayName ?? null,
        globalRole: principal?.globalRole ?? null,
      });
    },
  });
}

/** Parses the `Set-Cookie` headers of a response into name, value and attributes. */
export interface SetCookie {
  name: string;
  value: string;
  attributes: Map<string, string | true>;
  raw: string;
}

export function parseSetCookies(response: Response): SetCookie[] {
  return response.headers.getSetCookie().map((raw) => {
    const [pair = "", ...rest] = raw.split(";").map((part) => part.trim());
    const eq = pair.indexOf("=");
    const attributes = new Map<string, string | true>();
    for (const attribute of rest) {
      const at = attribute.indexOf("=");
      if (at === -1) attributes.set(attribute.toLowerCase(), true);
      else attributes.set(attribute.slice(0, at).toLowerCase(), attribute.slice(at + 1));
    }
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes, raw };
  });
}

export interface SendOptions {
  headers?: Record<string, string>;
  /** Raw body. */
  body?: BodyInit;
}

/** A browser stand-in: sends the cookies it holds and keeps the ones it is given. */
export interface Whoami {
  userId: string | null;
  displayName: string | null;
  globalRole: string | null;
}

export class Client {
  readonly jar = new Map<string, string>();
  constructor(private readonly app: Hono) {}

  cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async send(method: string, path: string, options: SendOptions = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    const cookie = this.cookieHeader();
    if (cookie !== "" && !headers.has("cookie")) headers.set("cookie", cookie);
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) init.body = options.body;
    const response = await this.app.request(path, init);
    for (const set of parseSetCookies(response)) {
      const gone = set.attributes.get("max-age") === "0" || set.value === "";
      if (gone) this.jar.delete(set.name);
      else this.jar.set(set.name, set.value);
    }
    return response;
  }

  get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.send("GET", path, { headers });
  }

  async whoami(): Promise<Whoami> {
    return (await (await this.get("/__test/whoami")).json()) as Whoami;
  }

  /** The token a page would put in a form, for whoever this client is now. */
  async token(): Promise<string> {
    const body = (await (await this.get("/__test/csrf")).json()) as { token: string };
    return body.token;
  }

  /**
   * A form post. `csrf` is `true` to fetch the right token first, a string to send that token
   * (right or wrong), or `false` to send none.
   */
  async post(
    path: string,
    fields: Record<string, string> = {},
    csrf: boolean | string = true,
    method = "POST",
  ): Promise<Response> {
    const form = new URLSearchParams(fields);
    const token = csrf === true ? await this.token() : csrf === false ? null : csrf;
    if (token !== null) form.set("_csrf", token);
    return this.send(method, path, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  }

  /** A JSON request that carries its token in the header. */
  async json(
    method: string,
    path: string,
    body: unknown = {},
    csrf: boolean | string = true,
  ): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = csrf === true ? await this.token() : csrf === false ? null : csrf;
    if (token !== null) headers["x-csrf-token"] = token;
    return this.send(method, path, { headers, body: JSON.stringify(body) });
  }
}

// ---------------------------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------------------------

export function addUser(
  repo: Repository,
  id: string,
  globalRole: "member" | "legal_engineer" | "admin" = "member",
): void {
  repo.db
    .prepare("INSERT INTO users (id, display_name, global_role, demo) VALUES (?, ?, ?, 1)")
    .run(id, `Synthetic ${id}`, globalRole);
}

/**
 * A matter created by `creator` (its associate) with the given other members. Returns the id.
 * Roles other than the creator's are added by the creator.
 */
export function makeMatter(
  repo: Repository,
  creator: string,
  members: Partial<Record<string, MatterRole>> = {},
): string {
  const matter = repo.createMatter({
    name: "Synthetic NDA",
    clientLegalName: "Lanternfish Software, Inc.",
    createdBy: creator,
  });
  for (const [userId, role] of Object.entries(members))
    if (role !== undefined) repo.addMember(matter.id, userId, role, { actorId: creator });
  return matter.id;
}

/** The actions a route can be declared with, for tests that go through all of them. */
export const ALL_ACTIONS = Object.keys(MATTER_ACTIONS) as MatterAction[];

/**
 * Who may do what, written out by hand from docs/parol/03 (the HTTP API table) and docs/parol/06,
 * and not computed from the table the code uses, so a wrong edit to either shows up in the tests
 * that use this.
 */
export const EXPECTED_ROLES: Record<MatterAction, readonly MatterRole[]> = {
  "matter.read": ["associate", "reviewer", "viewer"],
  "matter.update": ["associate"],
  "member.add": ["associate"],
  "document.write": ["associate"],
  "run.start": ["associate"],
  "run.resume": ["associate"],
  "run.read": ["associate", "reviewer", "viewer"],
  "finding.read": ["associate", "reviewer", "viewer"],
  "review.decide": ["reviewer"],
  "memo.export": ["reviewer"],
  "memo.read": ["associate", "reviewer", "viewer"],
  "feedback.add": ["associate", "reviewer", "viewer"],
  "time.record": ["associate", "reviewer"],
  "reference.write": ["reviewer"],
  "matter.delete": [],
};

/** With segregation relaxed, the associate may also decide and export, and nothing more. */
export const RELAXED_EXTRA: Partial<Record<MatterAction, readonly MatterRole[]>> = {
  "review.decide": ["associate"],
  "memo.export": ["associate"],
};

/** What the status code should be for a member in `role` doing `action`. */
export function expectedStatus(
  role: MatterRole,
  action: MatterAction,
  relaxed: boolean,
): 200 | 403 {
  return EXPECTED_ROLES[action].includes(role) || (relaxed && RELAXED_EXTRA[action]?.includes(role))
    ? 200
    : 403;
}

/** A response reduced to what must not differ between two answers that must look alike. */
export async function snapshot(response: Response): Promise<{
  status: number;
  headers: [string, string][];
  body: string;
}> {
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    if (name !== "x-request-id") headers.push([name, value]);
  });
  headers.sort(([a], [b]) => a.localeCompare(b));
  return { status: response.status, headers, body: await response.text() };
}

/**
 * One matter route per action, `POST /api/matters/:matterId/do/<action>`, each answering with
 * the role the guard resolved and counting how often the handler ran.
 */
export function mountActionRoutes(app: Hono): { calls: string[] } {
  const calls: string[] = [];
  for (const action of ALL_ACTIONS) {
    defineMatterRoute(app, {
      method: "POST",
      path: `/api/matters/:matterId/do/${action}`,
      action,
      handler: (c, am) => {
        calls.push(action);
        return c.json({ ok: true, role: am.role, matterId: am.matterId });
      },
    });
  }
  return { calls };
}
