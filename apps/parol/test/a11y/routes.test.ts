import { ModelRequestError } from "@clausewise/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { globalRoleAllows, roleAllows } from "../../src/auth/actions.js";
import type { GlobalRole, MatterRole } from "../../src/contracts.js";
import { describeRoutes, type RouteReport } from "../../src/server/matter-route.js";
import { MATTER_PROBES, OTHER_PROBES, type Probe } from "../routes/probes.js";
import { comparisonPage, heldoutBody, liveBody } from "../evaluations/fixtures.js";
import { memorySource } from "../evaluations/render.js";
import { all, attr, parseHtml, type El } from "../pages/html.js";
import { checkInvariants } from "../pages/invariants.js";
import { variants } from "../pages/variants.js";
import {
  IDS,
  OUTSIDER,
  VIEWER,
  addMember,
  cleanup,
  gate,
  makeSite,
  newMatter,
  prepareMatter,
  routeFor,
  uploadCase,
  WORKED_EXAMPLE,
  type Browser,
  type Site,
} from "../routes/support.js";
import {
  NON_PAGE_GET,
  PAGE_GETS,
  isApiPath,
  staleClassifications,
  submitProblem,
  unclassifiedGetRoutes,
  unnamedFields,
} from "./inventory.js";
import { auditPage, formatViolations } from "./rules.js";

/**
 * The route table, walked. The application says which routes it serves (`describeRoutes`) and the
 * probe tables say which of them the authorization tests send requests to; this file makes the
 * accessibility rules follow the same table, so that a page nobody wrote a fixture for is held to
 * them all the same.
 *
 * - Every GET route is either a page of `PAGE_GETS` or listed in `NON_PAGE_GET` with the reason, or
 *   is under `/api/`. A route in none of them fails the first test, with what to do.
 * - Every page route has a probe, and is requested as every kind of person (a visitor, the three
 *   roles on a matter, a person with no part in it, the legal engineer, the administrator), on
 *   matters in the states the routes can produce: reviewed, reviewed and exported, with nothing in
 *   it, with a review under way, and with a review that failed. The answer is the one the role
 *   tables give; an answer that is a page, a refusal page included, passes every rule.
 * - Every internal link of those pages goes to a route the application has. Every form posts to a
 *   route, names its fields and has a submit that the keyboard reaches.
 * - Every POST route that is not the JSON API is the action of a form on some page, a live one or
 *   a fixture, so no action exists that a person using the keyboard cannot reach.
 *
 * What it can show: the HTML the application sends. What it cannot show: a browser, a colour, a
 * screen reader. The data is synthetic and the model is a script.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/**
 * The POST routes that no form sends to, each with the form that does the same. The JSON side of
 * the shell has its own address to end a session, which a script uses; a person signs out with the
 * button of every page, which posts to the sign-in address with the intent to sign out.
 */
const POST_WITHOUT_FORM: Readonly<Record<string, string>> = {
  "/session/end":
    "ends a session for a script that sends JSON; the Sign out button posts to /session",
};

// ---------------------------------------------------------------------------------------------
// People and matters
// ---------------------------------------------------------------------------------------------

interface Person {
  name: string;
  /** Null for a visitor. */
  userId: string | null;
  globalRole: GlobalRole | null;
  /** The role on the matters of this file; null for a person with no part in them. */
  matterRole: MatterRole | null;
}

const PEOPLE: readonly Person[] = [
  { name: "a visitor", userId: null, globalRole: null, matterRole: null },
  { name: "the associate", userId: IDS.associate, globalRole: "member", matterRole: "associate" },
  { name: "the reviewer", userId: IDS.reviewer, globalRole: "member", matterRole: "reviewer" },
  { name: "the viewer", userId: VIEWER, globalRole: "member", matterRole: "viewer" },
  { name: "a person with no part", userId: OUTSIDER, globalRole: "member", matterRole: null },
  {
    name: "the legal engineer",
    userId: IDS.legalEngineer,
    globalRole: "legal_engineer",
    matterRole: null,
  },
  { name: "the administrator", userId: IDS.admin, globalRole: "admin", matterRole: null },
];

/** What a request for a route should be answered with, from the role tables the application reads. */
function expectedStatus(route: RouteReport, person: Person): number {
  if (route.kind === "public") return 200;
  if (person.userId === null || person.globalRole === null) return 303;
  if (route.kind === "principal") {
    return route.globalAction === null || globalRoleAllows(person.globalRole, route.globalAction)
      ? 200
      : 403;
  }
  if (route.action === null) throw new Error(`${route.path} is a matter route with no action`);
  return person.matterRole !== null && roleAllows(person.matterRole, route.action) ? 200 : 404;
}

interface WorldIds {
  matterId: string;
  runId: string | null;
  findingId: string | null;
  memoId: string | null;
}

interface World {
  label: string;
  ids: WorldIds;
}

/** The URL of a route for a matter, or null when the matter lacks an id the route needs. */
function fill(template: string, ids: WorldIds): string | null {
  const parts: Record<string, string | null> = {
    ":matterId": ids.matterId,
    ":runId": ids.runId,
    ":findingId": ids.findingId,
    ":memoId": ids.memoId,
  };
  let path = template;
  for (const [name, value] of Object.entries(parts)) {
    if (!path.includes(name)) continue;
    if (value === null) return null;
    path = path.replace(name, value);
  }
  return path.includes(":") ? null : path;
}

// ---------------------------------------------------------------------------------------------
// The site, and the answers it gives
// ---------------------------------------------------------------------------------------------

const simulated = comparisonPage();
const withHeldout = comparisonPage(heldoutBody(), "heldout");
const withLive = comparisonPage(liveBody(), "live");
const SLOT = "&case=PAROL-D05&rule=dur-1";

/**
 * A query string that changes what a page shows, and the status that differs from the role tables'
 * when the page is asked for with it (an id that names nothing is a 404 page, not an empty one).
 */
interface Query {
  query: string;
  status?: number;
}

/** The query strings, besides none, that change what a page shows, with the matter it is asked of. */
const QUERIES: Readonly<Record<string, (ids: WorldIds) => Query[]>> = {
  "/matters/:matterId/runs/:runId": (ids) => [
    { query: "?filter=open" },
    { query: "?filter=escalated" },
    { query: "?filter=stale" },
    ...(ids.findingId === null ? [] : [{ query: `?finding=${ids.findingId}` }]),
    // An id that is shaped like a finding and names none: the review, with a sentence saying so.
    { query: "?finding=fnd_0000000000000000" },
  ],
  "/pilot": () => [{ query: "?scope=synthetic" }],
  "/evaluations": () => [
    { query: `?comparison=${simulated.id}` },
    { query: `?comparison=${simulated.id}${SLOT}` },
    { query: `?comparison=${withHeldout.id}` },
    { query: `?comparison=${withLive.id}${SLOT}` },
    // An id that is shaped like a comparison and names none is a page that is not found.
    { query: "?comparison=cmp_ffffffffffffffff", status: 404 },
  ],
};

interface Answer {
  route: RouteReport;
  /** The status that differs from the role tables for this very request, if any. */
  override: number | undefined;
  person: Person;
  world: string;
  path: string;
  status: number;
  location: string | null;
  contentType: string;
  html: string | null;
}

let site: Site;
const worlds: World[] = [];
const answers: Answer[] = [];
const rows = (): RouteReport[] => describeRoutes(site.app);
const pageRoutes = (): RouteReport[] =>
  rows().filter((route) => route.method === "GET" && PAGE_GETS.includes(route.path as never));

const hold = gate();
let mode: "ready" | "fail" | "hold" = "ready";

async function worldOf(label: string, start: (matterId: string) => Promise<void>): Promise<World> {
  const { matterId } = newMatter(site.w, `Synthetic matter, ${label}`);
  addMember(site, matterId, VIEWER, "viewer");
  await uploadCase(site.w, matterId);
  await start(matterId);
  const am = site.w.grant(site.w.associate, matterId);
  // The one review the matter has, whatever became of it.
  const run = site.w.services.matters.view(am).runs[0];
  if (run === undefined) throw new Error(`the matter "${label}" has no review`);
  const issues = site.w.services.runs.issues(am, run.id);
  return {
    label,
    ids: { matterId, runId: run.id, findingId: issues[0]?.findingId ?? null, memoId: null },
  };
}

/** The forms found on every audited page, by the route their action matched, for the coverage test. */
const liveFormActions = new Set<string>();
const problems = {
  status: [] as string[],
  rules: [] as string[],
  invariants: [] as string[],
  forms: [] as string[],
  links: [] as string[],
};

const tokenOf = (root: El): string | undefined =>
  all(root, (el) => el.name === "input" && attr(el, "name") === "_csrf").map((el) =>
    attr(el, "value"),
  )[0] ?? undefined;

/** The path of an internal link or form action, without its query and fragment. */
const pathOnly = (href: string): string => href.split(/[?#]/)[0] ?? href;

function examine(answer: Answer): void {
  const { route, person, path } = answer;
  const label = `${person.name} asks for ${path}`;
  const given = expectedStatus(route, person);
  // The exception applies to a person who is let in; everyone else is refused as ever.
  const expected = given === 200 ? (answer.override ?? given) : given;
  if (answer.status !== expected) {
    problems.status.push(`${label}: ${answer.status}, the role tables say ${expected}`);
    return;
  }
  if (answer.html === null) return;
  const root = parseHtml(answer.html);
  const violations = auditPage(root);
  if (violations.length > 0) problems.rules.push(`${label}:\n${formatViolations(violations)}`);
  const token = tokenOf(root);
  if (violations.length === 0) {
    try {
      const actions = new Set(
        all(root, (el) => el.name === "form").map((form) => attr(form, "action") ?? ""),
      );
      checkInvariants(answer.html, { actions, ...(token === undefined ? {} : { csrf: token }) });
    } catch (error) {
      problems.invariants.push(`${label}: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  for (const form of all(root, (el) => el.name === "form")) {
    const action = attr(form, "action") ?? "";
    const posts = routeFor(site.app, "POST", pathOnly(action));
    if (posts === undefined) problems.forms.push(`${label}: the form to ${action} has no route`);
    else liveFormActions.add(posts);
    if (attr(form, "method")?.toLowerCase() !== "post")
      problems.forms.push(`${label}: the form to ${action} does not post`);
    for (const field of unnamedFields(root, form))
      problems.forms.push(`${label}: the form to ${action} has a field with no name: ${field}`);
    const why = submitProblem(root, form);
    if (why !== null) problems.forms.push(`${label}: the form to ${action}: ${why}`);
  }
  for (const link of all(root, (el) => el.name === "a")) {
    const href = attr(link, "href") ?? "";
    if (!href.startsWith("/") || href.startsWith("//")) continue;
    const target = pathOnly(href);
    if (target.startsWith("/assets/")) continue;
    if (routeFor(site.app, "GET", target) === undefined)
      problems.links.push(`${label}: a link to ${href} that no route answers`);
  }
}

async function ask(
  browser: Browser,
  route: RouteReport,
  person: Person,
  world: string,
  path: string,
  override?: number,
): Promise<void> {
  const response = await browser.get(path);
  const contentType = response.headers.get("content-type") ?? "";
  const html = contentType.includes("text/html") ? await response.text() : null;
  if (html === null) await response.arrayBuffer();
  const answer: Answer = {
    route,
    override,
    person,
    world,
    path,
    status: response.status,
    location: response.headers.get("location"),
    contentType,
    html,
  };
  answers.push(answer);
  examine(answer);
}

beforeAll(async () => {
  site = makeSite({
    model: {
      ...WORKED_EXAMPLE,
      before: (call) => {
        if (call.kind !== "extract") return undefined;
        if (mode === "fail") throw new ModelRequestError("no key", 401);
        if (mode === "hold") return hold.pass();
        return undefined;
      },
    },
    evaluations: memorySource([simulated, withHeldout, withLive]),
  });

  // Two matters made the way the route tests make them: reviewed, and reviewed then exported.
  const ready = await prepareMatter(site, { exported: false });
  worlds.push({
    label: "reviewed",
    ids: { matterId: ready.matterId, runId: ready.runId, findingId: ready.findingId, memoId: null },
  });
  const done = await prepareMatter(site, { name: "Exported", exported: true });
  worlds.push({
    label: "exported",
    ids: {
      matterId: done.matterId,
      runId: done.runId,
      findingId: done.findingId,
      memoId: done.memoId,
    },
  });
  // A matter with nothing in it: the empty states of every page that can show it.
  const empty = newMatter(site.w, "Synthetic matter, empty");
  addMember(site, empty.matterId, VIEWER, "viewer");
  worlds.push({
    label: "empty",
    ids: { matterId: empty.matterId, runId: null, findingId: null, memoId: null },
  });
  // A review that failed at its first call, and then one held at its first call.
  mode = "fail";
  worlds.push(
    await worldOf("failed", async (matterId) => {
      site.w.services.runs.start(site.w.grant(site.w.associate, matterId), { workflowLabel: "v2" });
      await site.w.services.runs.idle();
    }),
  );
  mode = "hold";
  worlds.push(
    await worldOf("running", async (matterId) => {
      site.w.services.runs.start(site.w.grant(site.w.associate, matterId), { workflowLabel: "v2" });
      await hold.reached(1);
    }),
  );

  const browsers = new Map<string, Browser>();
  for (const person of PEOPLE)
    browsers.set(
      person.name,
      person.userId === null ? site.anonymous() : await site.as(person.userId),
    );

  const reviewed = worlds[0] as World;
  for (const route of pageRoutes()) {
    for (const person of PEOPLE) {
      const browser = browsers.get(person.name) as Browser;
      // A matter page is asked of every matter by the people who are on it. A person who is not on
      // it, or has no session, is refused the same way whatever the matter is, so one is enough.
      const here = route.kind !== "matter" || person.matterRole === null ? [reviewed] : worlds;
      for (const world of here) {
        const path = fill(route.path, world.ids);
        if (path === null) continue;
        const queries: Query[] = [{ query: "" }, ...(QUERIES[route.path]?.(world.ids) ?? [])];
        const asked =
          route.kind === "matter" && person.matterRole === null ? queries.slice(0, 1) : queries;
        for (const { query, status } of asked)
          await ask(
            browser,
            route,
            person,
            route.kind === "matter" ? world.label : "none",
            `${path}${query}`,
            status,
          );
      }
    }
  }
});

afterAll(async () => {
  hold.open();
  await site.w.services.runs.idle();
  cleanup();
});

// ---------------------------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------------------------

describe("the classification of the GET routes", () => {
  it("leaves no GET route unclassified: each is a page, is listed as not a page, or is JSON", () => {
    const left = unclassifiedGetRoutes(rows(), PAGE_GETS, Object.keys(NON_PAGE_GET));
    expect(
      left,
      `${left.join(", ")}: add it to PAGE_GETS (it is then audited in every role that can reach it), or to NON_PAGE_GET with a reason`,
    ).toEqual([]);
  });

  it("holds no classification for a route the application no longer has, or for one route twice", () => {
    expect(staleClassifications(rows(), PAGE_GETS, Object.keys(NON_PAGE_GET))).toEqual([]);
  });

  it("holds every route that is not a page to its word: none answers with a page", async () => {
    const done = (worlds[1] as World).ids;
    const engineer = await site.as(IDS.legalEngineer);
    const reviewer = await site.as(IDS.reviewer);
    const pages: string[] = [];
    const asked: string[] = [];
    const check = async (browser: Browser, template: string): Promise<void> => {
      const path = fill(template.replace(":name", "parol.css"), done);
      if (path === null) throw new Error(`${template} needs an id that the matter does not have`);
      const response = await browser.get(path);
      asked.push(`${response.status} ${template}`);
      if ((response.headers.get("content-type") ?? "").includes("text/html")) pages.push(template);
      await response.arrayBuffer();
    };
    for (const template of Object.keys(NON_PAGE_GET))
      await check(template.startsWith("/pilot") ? engineer : reviewer, template);
    // The JSON API: every GET probe of the tables, asked as the reviewer of a matter with a memo.
    const apiGets = [...MATTER_PROBES, ...OTHER_PROBES].filter(
      (probe) => probe.method === "GET" && isApiPath(probe.template),
    );
    expect(apiGets.length).toBeGreaterThan(8);
    for (const probe of apiGets) await check(reviewer, probe.template);
    expect(pages).toEqual([]);
    // Each was answered, not refused: a refusal is a page, and would hide one.
    expect(asked.filter((line) => !line.startsWith("200 "))).toEqual([]);
  });
});

describe("the probe tables", () => {
  const probeOf = (route: RouteReport): Probe | (typeof OTHER_PROBES)[number] | undefined =>
    route.kind === "matter"
      ? MATTER_PROBES.find((p) => p.method === "GET" && p.template === route.path)
      : OTHER_PROBES.find((p) => p.method === "GET" && p.template === route.path);

  it("hold a GET probe for every page route, which the authorization tests send", () => {
    const routes = pageRoutes();
    expect(routes.length).toBe(PAGE_GETS.length);
    const missing = routes.filter((route) => probeOf(route) === undefined).map((r) => r.path);
    expect(missing, `a page route with no probe: ${missing.join(", ")}`).toEqual([]);
  });

  it("name the same global action as the route they probe", () => {
    for (const route of pageRoutes().filter((r) => r.kind === "principal")) {
      const probe = OTHER_PROBES.find((p) => p.method === "GET" && p.template === route.path);
      expect(probe?.globalAction ?? null, route.path).toBe(route.globalAction);
    }
  });
});

describe("every page, as every kind of person", () => {
  it("is answered as the role tables say", () => {
    expect(problems.status).toEqual([]);
  });

  it("is audited in every role that can reach it, and in the refusal of every role that cannot", () => {
    const seen = new Set(answers.map((a) => `${a.route.path} ${a.person.name} ${a.status}`));
    const missing: string[] = [];
    for (const route of pageRoutes()) {
      for (const person of PEOPLE) {
        const status = expectedStatus(route, person);
        if (!seen.has(`${route.path} ${person.name} ${status}`))
          missing.push(`${route.path} as ${person.name} (${status})`);
      }
    }
    expect(missing).toEqual([]);
    // A page that was asked for and answered, not only a redirect: every page route was audited at least once.
    for (const route of pageRoutes())
      expect(
        answers.filter((a) => a.route.path === route.path && a.html !== null).length,
        route.path,
      ).toBeGreaterThan(0);
  });

  it("is audited on every matter that can show it, not only on the finished one", () => {
    for (const route of pageRoutes().filter((r) => r.kind === "matter")) {
      const labels = new Set(
        answers.filter((a) => a.route.path === route.path && a.status === 200).map((a) => a.world),
      );
      const wanted = worlds.filter((w) => fill(route.path, w.ids) !== null).map((w) => w.label);
      expect([...labels].sort(), route.path).toEqual([...wanted].sort());
    }
    expect(worlds.map((w) => w.label)).toEqual([
      "reviewed",
      "exported",
      "empty",
      "failed",
      "running",
    ]);
  });

  it("passes every accessibility rule", () => {
    expect(problems.rules).toEqual([]);
  });

  it("passes the invariants of every page", () => {
    expect(problems.invariants).toEqual([]);
  });

  it("sends a refusal as a page that passes too, and tells a visitor to sign in", () => {
    const refusals = answers.filter((a) => a.status === 403 || a.status === 404);
    expect(refusals.length).toBeGreaterThan(10);
    expect(refusals.every((a) => a.html !== null)).toBe(true);
    const visitors = answers.filter((a) => a.person.userId === null && a.route.kind !== "public");
    expect(visitors.length).toBeGreaterThan(5);
    expect(visitors.every((a) => a.status === 303 && a.location === "/")).toBe(true);
  });

  it("makes a missing matter and a matter the person has no part in the same page", () => {
    const outsiders = answers.filter(
      (a) => a.person.name === "a person with no part" && a.route.path === "/matters/:matterId",
    );
    expect(outsiders).toHaveLength(1);
    expect(outsiders[0]?.status).toBe(404);
  });
});

describe("the links and the forms of those pages", () => {
  it("lead only to routes the application has", () => {
    expect(problems.links).toEqual([]);
  });

  it("are POST forms to a real route, with a name on every field and a submit the keyboard can reach", () => {
    expect(problems.forms).toEqual([]);
    expect(liveFormActions.size).toBeGreaterThan(10);
  });

  it("leave no POST route without a form that sends to it, live or in a fixture", () => {
    const covered = new Set(liveFormActions);
    for (const [, make] of variants) {
      for (const form of all(parseHtml(make()), (el) => el.name === "form")) {
        const found = routeFor(site.app, "POST", pathOnly(attr(form, "action") ?? ""));
        if (found !== undefined) covered.add(found);
      }
    }
    const postRoutes = rows()
      .filter((route) => route.method === "POST" && route.kind !== "middleware")
      .filter((route) => !isApiPath(route.path))
      .map((route) => `POST ${route.path}`);
    expect(postRoutes.length).toBeGreaterThan(20);
    const listed = Object.keys(POST_WITHOUT_FORM).map((path) => `POST ${path}`);
    const without = postRoutes.filter((route) => !covered.has(route) && !listed.includes(route));
    expect(
      without,
      `a POST route that no form of any page sends to: ${without.join(", ")}. Add the form, or list it in POST_WITHOUT_FORM with the form that does the same`,
    ).toEqual([]);
    // An entry of the list is a route, and no form sends to it: otherwise it is stale.
    for (const route of listed) {
      expect(postRoutes, route).toContain(route);
      expect(covered.has(route), `${route} has a form now: take it off POST_WITHOUT_FORM`).toBe(
        false,
      );
    }
  });
});
