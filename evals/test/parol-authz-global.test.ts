import { beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS, type GlobalAction } from "../../apps/parol/src/auth/actions.js";
import { readPrincipal } from "../../apps/parol/src/auth/identity.js";
import type { GlobalRole } from "../../apps/parol/src/contracts.js";
import { GLOBAL_ROLES } from "../../apps/parol/src/contracts.js";
import { defineRoute } from "../../apps/parol/src/server/matter-route.js";
import type { Dataset } from "../src/parol/dataset.js";
import {
  ACTORS,
  DOCUMENTED_GLOBAL_ROLES,
  GLOBAL_ROLE_OF,
  classifyListing,
  expectedList,
  requireScratchLevelBuilt,
  tableDrift,
  type Observed,
} from "../src/parol/exposure/authorization.js";
import type { OtherProbe, ScratchLevel } from "../src/parol/exposure/probes.js";
import { LIST_PROBES } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { failure, runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * The exposure suite knows which pages only some global roles may open, and expects of each caller
 * what the hand-written table says: 403 for a signed-in caller whose global role the table does not
 * list, the page for one it does, and the sign-in for a visitor. The packages that add such a page
 * (the evaluation comparison, the audit log, the trainer's key, the pilot measures) fill their own
 * fragment of the probe tables; none has yet, so the fragment of the evaluation comparison is
 * replaced here by one probe, exactly as that package will write it, and the routes are planted
 * through the suite's hooks. The suite counts, as exposures, the planted route that answers a
 * member, and these tests fail when the role check of `expectedList` is taken out.
 */

vi.mock("../src/parol/exposure/probes-evaluations.js", () => ({
  MATTER_PROBES_EVALUATIONS: [],
  OTHER_PROBES_EVALUATIONS: [
    {
      method: "GET",
      template: "/evaluations",
      access: "principal",
      body: { kind: "none" },
      globalAction: "evaluation.read",
    },
  ],
  FORGED_BODIES_EVALUATIONS: {},
  EFFECTS_EVALUATIONS: {},
}));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const GATED = "/evaluations";
const gatedProbe = LIST_PROBES.find((probe) => probe.template === GATED)!;

/** The callers whose global role is member, from the table, and the others. */
const MEMBERS = ACTORS.filter((actor) => GLOBAL_ROLE_OF[actor] === "member");
const MODES = 2;

const probeOf = (over: Partial<OtherProbe>): OtherProbe => ({
  method: "GET",
  template: "/synthetic/page",
  access: "principal",
  body: { kind: "none" },
  ...over,
});

// ---------------------------------------------------------------------------------------------
// What a caller should get
// ---------------------------------------------------------------------------------------------

describe("the answer expected of a route that names a global action", () => {
  it("is the one the probe table says: the plant of these tests is a probe in the lists, with the action", () => {
    expect(gatedProbe).toMatchObject({
      method: "GET",
      access: "principal",
      globalAction: "evaluation.read",
    });
  });

  it("is 403 for a signed-in caller of a global role the documented table does not list, the page for one it does", () => {
    const evaluations = probeOf({ template: GATED, globalAction: "evaluation.read" });
    for (const actor of ["associate", "reviewer", "viewer", "outsider", "stranger"] as const)
      expect(expectedList(evaluations, actor), actor).toEqual({
        kind: "refused",
        status: 403,
        caller: "role",
      });
    expect(expectedList(evaluations, "admin")).toEqual({ kind: "let_in", status: 200 });
  });

  it("sends a visitor to sign in before it looks at a role: a page to the start page, the API told", () => {
    const page = probeOf({ globalAction: "audit.read" });
    expect(expectedList(page, "anonymous")).toEqual({
      kind: "refused",
      status: 303,
      caller: "visitor",
      location: "/",
    });
    const api = probeOf({ template: "/api/synthetic", globalAction: "audit.read" });
    expect(expectedList(api, "anonymous")).toEqual({
      kind: "refused",
      status: 401,
      caller: "visitor",
    });
  });

  it("is the old answer for a route with no global action: every signed-in caller is let in, a visitor is sent away", () => {
    const open = probeOf({});
    for (const actor of ACTORS)
      expect(expectedList(open, actor), actor).toEqual(
        actor === "anonymous"
          ? { kind: "refused", status: 303, caller: "visitor", location: "/" }
          : { kind: "let_in", status: 200 },
      );
    const publicRoute = probeOf({ access: "public" });
    for (const actor of ACTORS)
      expect(expectedList(publicRoute, actor)).toEqual({ kind: "let_in", status: 200 });
  });

  it("follows the hand-written table for every action and every caller, and refuses a caller of no role", () => {
    for (const action of Object.keys(DOCUMENTED_GLOBAL_ROLES) as GlobalAction[])
      for (const actor of ACTORS) {
        const expected = expectedList(probeOf({ globalAction: action }), actor);
        const role = GLOBAL_ROLE_OF[actor];
        if (actor === "anonymous") expect(expected.kind, `${action} ${actor}`).toBe("refused");
        else if (role !== null && DOCUMENTED_GLOBAL_ROLES[action].includes(role))
          expect(expected, `${action} ${actor}`).toEqual({ kind: "let_in", status: 200 });
        else
          expect(expected, `${action} ${actor}`).toEqual({
            kind: "refused",
            status: 403,
            caller: "role",
          });
      }
  });

  it("gives every action the administrator and no action the member, so a signed-in suite caller is told apart by the table alone", () => {
    for (const action of Object.keys(DOCUMENTED_GLOBAL_ROLES) as GlobalAction[]) {
      expect(DOCUMENTED_GLOBAL_ROLES[action], action).toContain("admin");
      expect(DOCUMENTED_GLOBAL_ROLES[action], action).not.toContain("member");
    }
    // The suite has no legal engineer among its callers: the role is in the table, not in the cells.
    expect(Object.values(GLOBAL_ROLE_OF)).not.toContain("legal_engineer");
    expect([...new Set(Object.values(GLOBAL_ROLE_OF))].sort()).toEqual(
      [null, "admin", "member"].sort(),
    );
  });

  it("refuses to guess for an action the documented table does not list", () => {
    expect(() =>
      expectedList(probeOf({ globalAction: "nothing.read" as GlobalAction }), "associate"),
    ).toThrow(/documented table does not list/);
  });

  it("holds a visitor and a member refused by the classifier as expected, and a member answered with the page as an exposure", () => {
    const refusedMember = expectedList(gatedProbe, "associate");
    const seen = (over: Partial<Observed> = {}): Observed => ({
      status: 403,
      headers: [["content-type", "text/html"]],
      body: "<p>You may not do that</p>",
      letIn: false,
      stateChanged: false,
      ...over,
    });
    const classify = (expected: ReturnType<typeof expectedList>, observed: Observed) =>
      classifyListing({ expected, observed, forbidden: ["A Matter Title"] });
    expect(classify(refusedMember, seen())).toEqual({ verdict: "expected" });
    expect(classify(refusedMember, seen({ status: 200, body: "<p>the page</p>" }))).toEqual({
      verdict: "exposure",
      reasons: ["handler_answered"],
    });
    // A refusal still may not carry a matter the caller has no part in.
    expect(classify(refusedMember, seen({ body: "A Matter Title" }))).toEqual({
      verdict: "exposure",
      reasons: ["carried_data"],
    });
    // Answered with something else than the refusal, and not a success: a mismatch, and not an exposure.
    expect(classify(refusedMember, seen({ status: 404 }))).toEqual({ verdict: "mismatch" });
    // The administrator is expected to be answered, and a 403 for the administrator is a cell that did not reach.
    expect(classify(expectedList(gatedProbe, "admin"), seen({ status: 200 }))).toEqual({
      verdict: "expected",
    });
    expect(classify(expectedList(gatedProbe, "admin"), seen())).toEqual({ verdict: "mismatch" });
  });
});

// ---------------------------------------------------------------------------------------------
// The two tables
// ---------------------------------------------------------------------------------------------

describe("the drift between the application's global actions and the documented ones", () => {
  /** Changes the application's table, and puts it back whatever happens. */
  function withActions<T>(change: (table: Record<string, string[]>) => void, body: () => T): T {
    const table = GLOBAL_ACTIONS as unknown as Record<string, string[]>;
    const saved = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, [...v]]));
    try {
      change(table);
      return body();
    } finally {
      for (const key of Object.keys(table)) delete table[key];
      Object.assign(table, saved);
    }
  }

  it("is none: the application's table is the hand-written one, for every action", () => {
    expect(tableDrift()).toEqual([]);
    for (const action of Object.keys(DOCUMENTED_GLOBAL_ROLES) as GlobalAction[])
      expect([...GLOBAL_ACTIONS[action]].sort(), action).toEqual(
        [...DOCUMENTED_GLOBAL_ROLES[action]].sort(),
      );
  });

  it("names a role the application added to an action", () => {
    expect(withActions((table) => table["audit.read"]!.push("legal_engineer"), tableDrift)).toEqual(
      ["audit.read legal_engineer"],
    );
    expect(withActions((table) => table["pilot.read"]!.push("member"), tableDrift)).toEqual([
      "pilot.read member",
    ]);
  });

  it("names a role the application took away from an action", () => {
    expect(
      withActions((table) => {
        table["pilot.manage"] = table["pilot.manage"]!.filter((role) => role !== "legal_engineer");
      }, tableDrift),
    ).toEqual(["pilot.manage legal_engineer"]);
  });

  it("names every role of an action that one table has and the other does not", () => {
    // Documented and not built.
    expect(
      withActions((table) => {
        delete table["training.key"];
      }, tableDrift).sort(),
    ).toEqual(["training.key admin", "training.key legal_engineer"]);
    // Built and not documented.
    expect(
      withActions((table) => {
        table["synthetic.read"] = ["admin", "member"];
      }, tableDrift).sort(),
    ).toEqual(["synthetic.read admin", "synthetic.read member"]);
  });

  it("does not name an action twice, or a pair that agrees", () => {
    const drift = withActions((table) => {
      table["audit.read"]!.push("legal_engineer");
      table["evaluation.read"]!.push("member");
    }, tableDrift);
    expect(drift.sort()).toEqual(["audit.read legal_engineer", "evaluation.read member"]);
    expect(new Set(drift).size).toBe(drift.length);
  });

  it("covers the three global roles in the application's list of them", () => {
    const named = new Set<GlobalRole>(Object.values(DOCUMENTED_GLOBAL_ROLES).flat());
    for (const role of GLOBAL_ROLES)
      if (role !== "member") expect(named.has(role), role).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The scratch levels
// ---------------------------------------------------------------------------------------------

describe("the levels a scratch matter can be taken to", () => {
  // A record keyed by the type: a level added to the type is a compile error here until it is
  // listed, and so until someone decides whether the suite can build it.
  const LEVELS: Record<ScratchLevel, boolean> = {
    documents: true,
    run: true,
    decided: true,
    exported: false,
  };

  it("are built for the first three, and refused for `exported` until the package that needs it fills the branch", () => {
    for (const [level, built] of Object.entries(LEVELS) as [ScratchLevel, boolean][]) {
      if (built) expect(() => requireScratchLevelBuilt(level), level).not.toThrow();
      else
        expect(() => requireScratchLevelBuilt(level), level).toThrow(
          /needs a scratch matter taken to the level "exported", which the authorization probes cannot build yet/,
        );
    }
  });

  it("stop the suite with the error of an unavailable suite, and not an exposure", () => {
    try {
      requireScratchLevelBuilt("exported");
    } catch (error) {
      expect(error).toMatchObject({ name: "ExposureSuiteUnavailable" });
      return;
    }
    throw new Error("the level should have been refused");
  });
});

// ---------------------------------------------------------------------------------------------
// The suite against routes planted through its hooks
// ---------------------------------------------------------------------------------------------

describe("the suite, with a gated page planted through its hooks", () => {
  let dataset: Dataset;
  beforeAll(async () => {
    dataset = await completeDataset();
  });
  const run = runWith(() => dataset);
  const lists = ["lists"] as const;

  /** The right guard: a signed-in person is needed, and the global action of the probe. */
  const gated =
    (action: GlobalAction = "evaluation.read"): NonNullable<SiteHooks["beforeRoutes"]> =>
    (app) =>
      defineRoute(app, {
        method: "GET",
        path: GATED,
        access: "principal",
        globalAction: action,
        handler: (c) => c.text("The evaluation page, for the legal engineer or the administrator"),
      });

  /** The hole: the page answers every signed-in caller, a member too. */
  const answersEverySignedIn: NonNullable<SiteHooks["beforeRoutes"]> = (app) =>
    void app.get(GATED, (c) =>
      readPrincipal(c) === null ? c.redirect("/", 303) : c.text("The evaluation page"),
    );

  it("finds nothing in a page guarded with the action of its probe, and every cell answered as the table says", async () => {
    const result = await run({ beforeRoutes: gated() }, lists);
    expect(result.listCells).toBe(LIST_PROBES.length * ACTORS.length * MODES);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.exposed).toEqual([]);
    // Members were refused with 403, the administrator was let in and the visitor sent away: every
    // cell is as expected. Without the role check in `expectedList`, a member's 403 is a mismatch.
    expect(result.mismatches).toBe(0);
    expect(result.letInNotReached).toBe(0);
    expect(result.tableDrift).toBe(0);
  });

  it("counts a page that answers every signed-in caller as an exposure for each member, in both modes, and for no one else", async () => {
    const result = await run({ beforeRoutes: answersEverySignedIn }, lists);
    const cells = MEMBERS.length * MODES;
    expect(result.probesAnsweredWithData).toBe(cells);
    expect(result.byReason.handler_answered).toBe(cells);
    expect(result.byReason.carried_data + result.byReason.refusal_differs).toBe(0);
    expect(result.byReason.changed_state).toBe(0);
    // Named by route and caller, and by no one else: not the administrator, not the visitor.
    expect(result.exposed.every((cell) => cell.probe === `GET ${GATED}`)).toBe(true);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(MEMBERS));
    expect(new Set(result.exposed.map((cell) => cell.relaxed))).toEqual(new Set([false, true]));
    // Every other cell was as expected: the administrator got the page, the visitor was sent away.
    expect(result.mismatches).toBe(0);
    expect(result.sentence).toContain(`${cells} were answered with data`);
    expect(result.sentence).toContain(`First exposed: GET ${GATED} as ${MEMBERS[0]}`);
  });

  it("counts a refusal of a member that carries the title of a matter the member has no part in", async () => {
    const hook: SiteHooks = {
      beforeRoutes: (app, deps) => {
        // The shell's 403 for a member, replaced by every title in the store. Registered before the
        // route, so that it wraps it.
        app.use("*", async (c, next) => {
          await next();
          if (c.req.path !== GATED || c.res.status !== 403) return;
          const titles = (
            deps.repo.db.prepare("SELECT name FROM matters").all() as { name: string }[]
          )
            .map((row) => row.name)
            .join(" ");
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(titles, { status: 403, headers });
        });
        gated()(app, deps);
      },
    };
    const result = await run(hook, lists);
    // Each member holds a part in at most one of the two matters and is refused with the other's title.
    expect(result.byReason.carried_data).toBe(MEMBERS.length * MODES);
    expect(result.byReason.handler_answered).toBe(0);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(MEMBERS));
  });

  it("stops the suite for a page guarded with no global action, before any cell is sent", async () => {
    const error = await failure(
      run(
        {
          beforeRoutes: (app) =>
            defineRoute(app, {
              method: "GET",
              path: GATED,
              access: "principal",
              handler: (c) => c.text("The evaluation page"),
            }),
        },
        lists,
      ),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("another global action than the application checks for");
    expect(error.message).toContain(`GET ${GATED}`);
  });

  it("stops the suite for a page guarded with another global action than its probe names", async () => {
    const error = await failure(run({ beforeRoutes: gated("audit.read") }, lists));
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("another global action than the application checks for");
    expect(error.message).toContain(`GET ${GATED}`);
  });

  it("counts the cells where the application lets in a role the documentation refuses, and says the tables differ", async () => {
    const table = GLOBAL_ACTIONS as unknown as Record<string, string[]>;
    table["evaluation.read"]!.push("member");
    try {
      const result = await run({ beforeRoutes: gated() }, lists);
      // The route guards with the application's own table, which now lets members in.
      expect(result.tableDrift).toBe(1);
      expect(result.probesAnsweredWithData).toBe(MEMBERS.length * MODES);
      expect(result.byReason.handler_answered).toBe(MEMBERS.length * MODES);
      expect(result.sentence).toContain(
        "The action table differs from the documented one in 1 places.",
      );
    } finally {
      table["evaluation.read"]!.pop();
    }
    expect(tableDrift()).toEqual([]);
  });

  it("stops the suite when a caller holds another global role in the store than the suite's table says", async () => {
    const error = await failure(
      run(
        {
          beforeRoutes: (app, deps) => {
            gated()(app, deps);
            deps.repo.db
              .prepare("UPDATE users SET global_role = 'admin' WHERE id = 'usr_demo_associate'")
              .run();
          },
        },
        lists,
      ),
    );
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(error.message).toContain("another global role for associate");
    expect(error.message).not.toContain("usr_demo");
  });
});
