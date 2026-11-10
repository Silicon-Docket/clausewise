import { createScriptedGenerator } from "@clausewise/llm/testing";
import type { GenerateObjectRequest } from "@clausewise/llm";
import type { Hono } from "hono";
import { expect } from "vitest";
import type { MatterRole } from "../../src/contracts.js";
import { describeRoutes } from "../../src/server/matter-route.js";
import { createApp } from "../../src/server/app.js";
import type { AppConfig, AppDeps } from "../../src/server/deps.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";
import { formFields, urlEncoded, type SubmitOptions } from "../integration/layers-support.js";
import { WORDS, baselineAnswer } from "../integration/pipeline.js";
import { all, attr, first, parseHtml, type El } from "../pages/html.js";
import { checkInvariants } from "../pages/invariants.js";
import { Client, SECRET, addUser } from "../server/support-app.js";
import { multipart, type UploadFile } from "./probes.js";
import {
  baseWorld,
  cleanup,
  controlledModel,
  decideAll,
  gate,
  makeWorld,
  newMatter,
  revisedAnswer,
  uploadCase,
  type ModelOptions,
  type World,
} from "../services/support.js";

/**
 * A browser, a site and a matter for the route tests. The site is the real application: the real
 * shell (`createApp`), the real routes (`registerRoutes`), the real services over an in-memory
 * store and a temporary file store, and a scripted stand-in for the model that answers from the
 * answer key of the worked example (it is not a measurement of any model). Nothing here calls a
 * network. Every document, party and person is synthetic.
 */

export {
  baseWorld,
  cleanup,
  controlledModel,
  gate,
  makeWorld,
  newMatter,
  revisedAnswer,
  uploadCase,
};
export type { ModelOptions, World };

/** The model answers of docs/parol/04: every rule from the key, and the duration finding revised. */
export const WORKED_EXAMPLE: ModelOptions = { answers: { "dur-1": revisedAnswer(baseWorld) } };

/**
 * The same script, but the duration rule is answered from what the model was shown, as docs/parol/04
 * tells it. Shown only the NDA (the retrieval of workflow v1), it says "compliant" and cites
 * Section 6.1, a quote that is there and that the amendment has deleted. Shown the amendment too
 * (the retrieval of workflow v2), it says "deviation". Every other call is answered as in
 * `WORKED_EXAMPLE`. A script, not a measurement of any model.
 */
export function workedExampleModel(): ReturnType<typeof controlledModel> {
  const inner = controlledModel(WORKED_EXAMPLE);
  const generator = createScriptedGenerator(async (request: GenerateObjectRequest<unknown>) => {
    const duration =
      request.schemaName === "analyze_rule" && /^Rule ID: dur-1$/m.test(request.prompt);
    if (duration && !request.prompt.includes(WORDS.deletionQuote)) return baselineAnswer(baseWorld);
    return inner.generator.generate(request);
  });
  return { ...inner, generator };
}

export const VIEWER = "usr_test_viewer";
export const OUTSIDER = "usr_test_outsider";
export const OTHER_ASSOCIATE = "usr_test_associate_two";

export const IDS = DEMO_USER_IDS;

export interface Page {
  response: Response;
  html: string;
  root: El;
}

export interface Site {
  w: World;
  app: Hono;
  deps: AppDeps;
  config: AppConfig;
  /** Every access log line the server wrote, in order. */
  logs: string[];
  /** A browser with no session. */
  anonymous(): Browser;
  /** A browser that has signed in through the sign-in form. */
  as(userId: string): Promise<Browser>;
}

export interface SiteOptions {
  model?: ModelOptions;
  /** A model of the test's own, in place of `model`. */
  model2?: ReturnType<typeof controlledModel>;
  /** Single-person demonstration: the services and the shell both relax segregation. */
  relaxed?: boolean;
  maxUploadBytes?: number;
  /** Default true. With false nobody can be signed in. */
  demoIdentity?: boolean;
}

export function makeSite(options: SiteOptions = {}): Site {
  const w = makeWorld({
    model: options.model ?? WORKED_EXAMPLE,
    ...(options.model2 === undefined ? {} : { model2: options.model2 }),
    ...(options.relaxed === true ? { config: { relaxedSegregation: true } } : {}),
  });
  addUser(w.repo, VIEWER);
  addUser(w.repo, OUTSIDER);
  addUser(w.repo, OTHER_ASSOCIATE);
  const logs: string[] = [];
  const config: AppConfig = {
    demoIdentity: options.demoIdentity ?? true,
    cookieSecret: SECRET,
    secureCookies: false,
    maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024,
    ...(options.relaxed === true ? { relaxedSegregation: true } : {}),
  };
  const deps: AppDeps = { repo: w.repo, services: w.services, config, now: w.deps.now };
  const app = createApp(deps, { log: (line) => logs.push(line), renderError: renderErrorPage });
  registerRoutes(app, deps);
  return {
    w,
    app,
    deps,
    config,
    logs,
    anonymous: () => new Browser(app),
    async as(userId) {
      const browser = new Browser(app);
      await browser.signIn(userId);
      return browser;
    },
  };
}

/** The value of the hidden CSRF field of a page. */
export function csrfOf(page: Pick<Page, "root">): string {
  const input = first(
    page.root,
    (el) => el.name === "input" && attr(el, "name") === "_csrf",
    "a CSRF field",
  );
  return attr(input, "value") ?? "";
}

// The multipart builder is shared with the evaluation's exposure suite (see probes.ts).
export { multipart };
export type { UploadFile };

/**
 * A browser: it keeps cookies, reads pages as a person would, and submits the forms it finds in
 * them with the fields they hold (the token included). The JSON side takes its token from
 * `GET /api/session`, as a script would.
 */
export class Browser extends Client {
  constructor(app: Hono) {
    super(app);
  }

  async page(path: string, expected = 200): Promise<Page> {
    const response = await this.get(path);
    expect(response.status, path).toBe(expected);
    const html = await response.text();
    return { response, html, root: parseHtml(html) };
  }

  /** Signs in with the button of the sign-in form that names the user. */
  async signIn(userId: string): Promise<void> {
    const page = await this.page("/");
    const form = first(page.root, (el) => el.name === "form" && attr(el, "action") === "/session");
    const response = await this.send("POST", "/session", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded(
        formFields(form, { submitter: { name: "userId", value: userId } }, page.root),
      ),
    });
    expect(response.status, "sign-in").toBe(303);
  }

  /** The form of a page that posts to `action`. */
  formOf(page: Page, action: string): El {
    return first(
      page.root,
      (el) => el.name === "form" && attr(el, "action") === action,
      `the form that posts to ${action}`,
    );
  }

  hasForm(page: Page, action: string): boolean {
    return all(page.root, (el) => el.name === "form" && attr(el, "action") === action).length > 0;
  }

  /** Submits a form of a page the way a browser does: url-encoded, every field it holds. */
  submit(page: Page, action: string, options: SubmitOptions = {}): Promise<Response> {
    const form = this.formOf(page, action);
    return this.send("POST", action, {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: urlEncoded(formFields(form, options, page.root)),
    });
  }

  /** Submits an upload form of a page: its fields, plus the file, as multipart. */
  upload(
    page: Page,
    action: string,
    file: UploadFile | undefined,
    options: SubmitOptions = {},
  ): Promise<Response> {
    const form = this.formOf(page, action);
    return this.send("POST", action, {
      body: multipart(formFields(form, options, page.root), file),
    });
  }

  /** The token a script sends with a write. */
  async apiToken(): Promise<string> {
    const body = (await (await this.get("/api/session")).json()) as { csrfToken: string };
    return body.csrfToken;
  }

  /** A JSON request with its token in the header. `csrf` false sends none, a string sends that. */
  async api(
    method: string,
    path: string,
    body?: unknown,
    csrf: boolean | string = true,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") {
      const token = csrf === true ? await this.apiToken() : csrf === false ? null : csrf;
      if (token !== null) headers["x-csrf-token"] = token;
    }
    return this.send(method, path, {
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** A JSON-API upload: multipart with the header token. */
  async apiUpload(
    path: string,
    fields: Record<string, string>,
    file: UploadFile | undefined,
    method = "POST",
  ): Promise<Response> {
    return this.send(method, path, {
      headers: { "x-csrf-token": await this.apiToken() },
      body: multipart(Object.entries(fields), file),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Matters
// ---------------------------------------------------------------------------------------------

/** The matter's id from the redirect that created it. */
export function matterIdFrom(response: Response): string {
  const location = response.headers.get("location") ?? "";
  const found = /^\/matters\/(mat_[0-9a-f]+)/.exec(location);
  if (found?.[1] === undefined) throw new Error("the redirect does not name a matter");
  return found[1];
}

/** Adds a member through the services, for tests that are not about adding members. */
export function addMember(site: Site, matterId: string, userId: string, role: MatterRole): void {
  site.w.repo.addMember(matterId, userId, role, { actorId: IDS.associate });
}

// ---------------------------------------------------------------------------------------------
// Routes, as the application holds them
// ---------------------------------------------------------------------------------------------

/** A path template made into a pattern: `/matters/:matterId/runs` matches `/matters/mat_1/runs`. */
function patternOf(template: string): RegExp {
  const source = template
    .split("/")
    .map((part) => (part.startsWith(":") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

/** The registered route that would answer `METHOD path`, as `METHOD /template`, or undefined. */
export function routeFor(app: Hono, method: string, path: string): string | undefined {
  const pathname = path.split("?")[0] ?? path;
  const found = describeRoutes(app).find(
    (route) =>
      route.method === method.toUpperCase() &&
      route.kind !== "unmanaged" &&
      patternOf(route.path).test(pathname),
  );
  return found === undefined ? undefined : `${found.method} ${found.path}`;
}

/** The URLs the forms of a page post to. */
export function formActions(page: Page): string[] {
  return all(page.root, (el) => el.name === "form").map((form) => attr(form, "action") ?? "");
}

/**
 * The page-wide invariants of the page tests (one h1, a token on every form, no inline script, no
 * style, labelled controls), plus the one thing only the routes can say: every form on the page
 * posts to a route the application really has, as a POST.
 */
export function checkPage(site: Site, page: Page): El {
  const actions = new Set(formActions(page));
  for (const action of actions)
    expect(
      routeFor(site.app, "POST", action),
      `a route for the form that posts to ${action}`,
    ).toBeDefined();
  return checkInvariants(page.html, { actions, csrf: csrfOf(page) });
}

// ---------------------------------------------------------------------------------------------
// A matter that has been through the whole story, made through the services
// ---------------------------------------------------------------------------------------------

export interface Prepared {
  matterId: string;
  /** The NDA (D1), the document that is not the last one. */
  firstDocumentId: string;
  /** The amendment (D2), the last document. */
  lastDocumentId: string;
  /** The first version of the amendment. */
  versionId: string;
  runId: string;
  /** A finding with three passages of evidence (dur-1). */
  findingId: string;
  evidenceIds: string[];
  /** The memo, when the matter was exported. */
  memoId: string | null;
}

export interface PrepareOptions {
  name?: string;
  /** Decide every finding as the reviewer and export the memo. Default true. */
  exported?: boolean;
  /** Add the viewer as a member. Default true. */
  viewer?: boolean;
}

/**
 * A matter created by the associate with the reviewer (and by default the viewer) as members, the
 * two documents of PAROL-D05 uploaded, a v2 run finished, and, by default, every finding decided
 * and the memo exported. Built through the services, so tests of the routes do not repeat the
 * story that the end-to-end test tells.
 */
export async function prepareMatter(site: Site, options: PrepareOptions = {}): Promise<Prepared> {
  const { w } = site;
  const { matterId, am } = newMatter(w, options.name ?? "Lanternfish / Corvane NDA");
  if (options.viewer !== false) addMember(site, matterId, VIEWER, "viewer");
  const uploaded = await uploadCase(w, matterId);
  const started = w.services.runs.start(am, { workflowLabel: "v2" });
  await w.services.runs.idle();
  const reviewerAm = w.grant(w.reviewer, matterId);
  const issues = w.services.runs.issues(am, started.id);
  const dur = issues.find((issue) => issue.ruleKey === "dur-1")!;
  const view = w.services.runs.finding(am, dur.findingId);
  let memoId: string | null = null;
  if (options.exported !== false) {
    decideAll(w, reviewerAm, issues);
    memoId = (await w.services.reviews.exportMemo(reviewerAm)).memoId;
  }
  return {
    matterId,
    firstDocumentId: uploaded.documentIds[0]!,
    lastDocumentId: uploaded.documentIds[1]!,
    versionId: uploaded.versionIds[1]!,
    runId: started.id,
    findingId: dur.findingId,
    evidenceIds: view.evidence.map((e) => e.evidenceId),
    memoId,
  };
}

/**
 * A count of the rows that the routes can change, for the tests that say "nothing happened". A
 * request that was refused must leave every number as it was.
 */
export function fingerprint(site: Site, matterId?: string): Record<string, number> {
  const count = (sql: string, ...args: string[]): number =>
    (site.w.repo.db.prepare(sql).get(...args) as { n: number }).n;
  const scoped = matterId !== undefined;
  const where = scoped ? " WHERE matter_id = ?" : "";
  const args = scoped ? [matterId] : [];
  return {
    matters: count("SELECT COUNT(*) AS n FROM matters" + (scoped ? " WHERE id = ?" : ""), ...args),
    members: count("SELECT COUNT(*) AS n FROM matter_members" + where, ...args),
    documents: count("SELECT COUNT(*) AS n FROM documents" + where, ...args),
    versions: count("SELECT COUNT(*) AS n FROM document_versions" + where, ...args),
    runs: count("SELECT COUNT(*) AS n FROM runs" + where, ...args),
    findings: count("SELECT COUNT(*) AS n FROM findings" + where, ...args),
    reviews: count("SELECT COUNT(*) AS n FROM reviews" + where, ...args),
    memos: count("SELECT COUNT(*) AS n FROM memos" + where, ...args),
    audit: count("SELECT COUNT(*) AS n FROM audit_events" + where, ...args),
  };
}
