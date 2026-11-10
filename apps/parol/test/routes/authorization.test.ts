import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MATTER_ACTIONS, type MatterAction } from "../../src/auth/actions.js";
import type { MatterRole } from "../../src/contracts.js";
import { describeRoutes } from "../../src/server/matter-route.js";
import { urls } from "../../src/server/urls.js";
import { EXPECTED_ROLES, snapshot } from "../server/support-app.js";
import { MATTER_PROBES, OTHER_PROBES, initFor, isApi, pathFor, type Probe } from "./probes.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  addMember,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The authorization probe matrix of docs/parol/05 over every route that names a matter, pages and
 * JSON alike, with the answer for each cell derived from `MATTER_ACTIONS`: a member in a role the
 * action allows gets the handler, a member without the role gets 403, a person with no part in the
 * matter gets 404 (and exactly the answer a matter that does not exist gets), and a visitor with no
 * session is sent to sign in (pages) or told to (JSON).
 *
 * The request of every cell is the same request (probes.ts), so the cells differ in the caller and
 * in nothing else. Whether the guard let a request in is read from the access log, which names the
 * matter only once authorization has confirmed it, and not from the status alone, because a
 * handler can answer 404 or 409 for its own reasons.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ACTORS = [
  "associate",
  "reviewer",
  "viewer",
  "outsider",
  "stranger",
  "admin",
  "anonymous",
] as const;
type Actor = (typeof ACTORS)[number];

const USER_OF: Record<Actor, string | null> = {
  associate: IDS.associate,
  reviewer: IDS.reviewer,
  viewer: VIEWER,
  outsider: OUTSIDER,
  stranger: OTHER_ASSOCIATE,
  admin: IDS.admin,
  anonymous: null,
};
const ROLE_OF: Partial<Record<Actor, MatterRole>> = {
  associate: "associate",
  reviewer: "reviewer",
  viewer: "viewer",
};

const NO_SUCH_MATTER = "mat_0000000000000000";

/** The statement of the relaxed rule, written here and not read from the code it checks. */
const RELAXED: Partial<Record<MatterAction, readonly MatterRole[]>> = {
  "review.decide": ["associate"],
  "memo.export": ["associate"],
};

type Outcome = { status: number; letIn: boolean };

/** What a caller must get for a probe, from the action table alone. */
function expectedFor(probe: Probe, actor: Actor, relaxed: boolean): Outcome {
  const api = isApi(probe.template);
  if (actor === "anonymous") return { status: api ? 401 : 303, letIn: false };
  const role = ROLE_OF[actor];
  if (probe.action === "matter.delete") {
    // Deletion is the creator's, or an administrator's, and is decided apart from the table, which
    // lists no role for it.
    expect(MATTER_ACTIONS["matter.delete"]).toEqual([]);
    if (actor === "associate" || actor === "admin") return { status: probe.reaches, letIn: true };
    return { status: role === undefined ? 404 : 403, letIn: false };
  }
  if (role === undefined) return { status: 404, letIn: false };
  const table = MATTER_ACTIONS[probe.action] as readonly MatterRole[];
  const allowed = table.includes(role) || (relaxed && (RELAXED[probe.action] ?? []).includes(role));
  return allowed ? { status: probe.reaches, letIn: true } : { status: 403, letIn: false };
}

/** What the access log says of the last request: the person and the matter the guard confirmed. */
function lastLine(site: Site): { user: string; matter: string; status: number } {
  const line = site.logs.at(-1) ?? "";
  const field = (name: string): string => new RegExp(`(?:^| )${name}=(\\S+)`).exec(line)?.[1] ?? "";
  return { user: field("user"), matter: field("matter"), status: Number(field("status")) };
}

async function freshMatter(site: Site): Promise<string> {
  const summary = site.w.services.matters.create(site.w.associate, {
    name: "A matter made for one request",
    clientLegalName: "Lanternfish Software, Inc.",
    playbookVersionId: null,
    reviewerUserId: IDS.reviewer,
  });
  addMember(site, summary.id, VIEWER, "viewer");
  return summary.id;
}

describe.each([{ relaxed: false }, { relaxed: true }])(
  "the authorization matrix (single-person demonstration: $relaxed)",
  ({ relaxed }) => {
    let site: Site;
    let ids: Prepared;
    const browsers = new Map<Actor, Browser>();

    beforeAll(async () => {
      site = makeSite({ relaxed });
      ids = await prepareMatter(site);
      for (const actor of ACTORS) {
        const user = USER_OF[actor];
        browsers.set(actor, user === null ? site.anonymous() : await site.as(user));
      }
    });

    /** A request as a caller sends it, with that caller's own token. */
    async function send(actor: Actor, probe: Probe, matterId: string): Promise<Response> {
      const browser = browsers.get(actor)!;
      const token = actor === "anonymous" ? null : await browser.apiToken();
      return browser.send(
        probe.method,
        pathFor(probe.template, ids, matterId),
        initFor(probe, token),
      );
    }

    for (const probe of MATTER_PROBES) {
      describe(`${probe.method} ${probe.template}`, () => {
        for (const actor of ACTORS) {
          const wanted = expectedFor(probe, actor, relaxed);
          it(`answers ${actor} with ${wanted.status}${wanted.letIn ? " (let in)" : ""}`, async () => {
            const matterId = probe.fresh === true ? await freshMatter(site) : ids.matterId;
            const before = fingerprint(site);
            const response = await send(actor, probe, matterId);
            expect(response.status).toBe(wanted.status);

            const line = lastLine(site);
            expect(line.status).toBe(wanted.status);
            expect(line.user).toBe(USER_OF[actor] ?? "-");
            // The log names the matter only once the guard has confirmed the caller may act on it.
            expect(line.matter).toBe(wanted.letIn ? matterId : "-");

            if (actor === "anonymous" && !isApi(probe.template)) {
              expect(response.headers.get("location")).toBe(urls.home());
            }
            if (!wanted.letIn) {
              // A refused request changed nothing.
              expect(fingerprint(site)).toEqual(before);
            }
            if (actor === "outsider" || actor === "stranger" || actor === "admin") {
              if (wanted.status === 404) {
                // The answer for a matter the caller has no part in is the answer for a matter
                // that does not exist: the same status, headers and body.
                const nothing = await send(actor, probe, NO_SUCH_MATTER);
                expect(await snapshot(nothing)).toEqual(await snapshot(response.clone()));
              }
            }
          });
        }
      });
    }

    it("is the hand-written table of docs/parol/03 and 06, action by action", () => {
      for (const action of Object.keys(MATTER_ACTIONS) as MatterAction[])
        expect([...MATTER_ACTIONS[action]].sort(), action).toEqual(
          [...EXPECTED_ROLES[action]].sort(),
        );
    });
  },
);

describe("the matrix covers the routes the application has", () => {
  const site = makeSite();
  const routes = describeRoutes(site.app).filter(
    (route) => route.kind !== "unmanaged" && route.kind !== "middleware",
  );
  const key = (method: string, path: string): string => `${method} ${path}`;

  it("has a probe for every route that names a matter, with the action the route checks", () => {
    const probes = new Map(MATTER_PROBES.map((p) => [key(p.method, p.template), p]));
    const matterRoutes = routes.filter((route) => route.kind === "matter");
    const missing = matterRoutes
      .filter((route) => !probes.has(key(route.method, route.path)))
      .map((route) => key(route.method, route.path));
    expect(missing, "routes without a probe: add one to test/routes/probes.ts").toEqual([]);
    for (const route of matterRoutes)
      expect(probes.get(key(route.method, route.path))?.action, key(route.method, route.path)).toBe(
        route.action,
      );
  });

  it("has no probe for a route that is not there", () => {
    const registered = new Set(routes.map((route) => key(route.method, route.path)));
    const stale = MATTER_PROBES.map((p) => key(p.method, p.template)).filter(
      (probe) => !registered.has(probe),
    );
    expect(stale).toEqual([]);
  });

  it("has a probe for every other route, with the access the route declares", () => {
    const probes = new Map(OTHER_PROBES.map((p) => [key(p.method, p.template), p]));
    const others = routes.filter((route) => route.kind !== "matter");
    const missing = others
      .filter((route) => !probes.has(key(route.method, route.path)))
      .map((route) => key(route.method, route.path));
    expect(missing, "routes without a probe: add one to test/routes/probes.ts").toEqual([]);
    for (const route of others)
      expect(probes.get(key(route.method, route.path))?.access, key(route.method, route.path)).toBe(
        route.kind,
      );
    const registered = new Set(others.map((route) => key(route.method, route.path)));
    expect(
      OTHER_PROBES.map((p) => key(p.method, p.template)).filter((k) => !registered.has(k)),
    ).toEqual([]);
  });

  it("registers a read on GET only for an action that reads", () => {
    const reads = new Set<MatterAction>(["matter.read", "run.read", "finding.read", "memo.read"]);
    for (const route of routes)
      if (route.kind === "matter" && route.method === "GET")
        expect(reads.has(route.action!), key(route.method, route.path)).toBe(true);
  });
});

describe("the routes that do not name a matter", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
  });

  it("send a visitor with no session to sign in, or tell a script to", async () => {
    const anonymous = site.anonymous();
    for (const probe of OTHER_PROBES) {
      if (probe.access !== "principal") continue;
      const response = await anonymous.send(
        probe.method,
        probe.template,
        initFor({ ...probe }, null),
      );
      expect(response.status, `${probe.method} ${probe.template}`).toBe(
        isApi(probe.template) ? 401 : 303,
      );
      if (!isApi(probe.template)) expect(response.headers.get("location")).toBe(urls.home());
    }
  });

  it("serve the public ones to a visitor with no session", async () => {
    const anonymous = site.anonymous();
    for (const path of ["/", "/healthz", "/assets/parol.css", "/api/session"]) {
      expect((await anonymous.get(path)).status, path).toBe(200);
    }
  });
});
