import { beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS, type GlobalAction } from "../../apps/parol/src/auth/actions.js";
import type { GlobalRole } from "../../apps/parol/src/contracts.js";
import { defineRoute } from "../../apps/parol/src/server/matter-route.js";
import type { Dataset } from "../src/parol/dataset.js";
import { DOCUMENTED_GLOBAL_ROLES } from "../src/parol/exposure/authorization.js";
import { mayLoad, runCanaryScan, type CanaryHooks } from "../src/parol/exposure/canary.js";
import { OTHER_PROBES } from "../src/parol/exposure/probes.js";
import { expectedBodies, CANARY_NAME_PREFIX } from "./parol-canary-support.js";
import {
  CANARY_SHAPE,
  ID_SHAPE,
  completeDataset,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * The canary scan reads every GET route that the probe tables name as every kind of reader, and
 * requires a page with a body from each reader that is to be let in. A page that only some global
 * roles may open is not one that a member is let into, so the scan requires it from the roles the
 * documented table lists, reads it as everyone else all the same, and searches the answer of a
 * reader who is refused for everything that reader must not see.
 *
 * No package has put such a page in its fragment of the probe tables yet. The fragment of the
 * evaluation comparison is replaced here by two probes written as the packages will write them
 * (the comparison page for the legal engineer and the administrator, and a page of the same kind
 * for the administrator alone, at a path of its own that no package will use), and the pages are
 * planted through the scan's hooks.
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
    {
      method: "GET",
      template: "/synthetic/audit",
      access: "principal",
      body: { kind: "none" },
      globalAction: "audit.read",
    },
  ],
  FORGED_BODIES_EVALUATIONS: {},
  EFFECTS_EVALUATIONS: {},
}));

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const ROLES: readonly (GlobalRole | null)[] = [null, "member", "legal_engineer", "admin"];

describe("mayLoad", () => {
  const publicRoute = { public: true };
  const anyPerson = { public: false };
  const gated = (globalAction: GlobalAction) => ({ public: false, globalAction });

  it("lets every reader load a public route, a visitor included", () => {
    for (const role of ROLES) expect(mayLoad(publicRoute, role), String(role)).toBe(true);
  });

  it("lets every signed-in reader load a route that needs a person only, and not a visitor", () => {
    expect(mayLoad(anyPerson, null)).toBe(false);
    for (const role of ROLES.filter((one) => one !== null))
      expect(mayLoad(anyPerson, role), String(role)).toBe(true);
  });

  it("lets a reader load a route that names a global action when the hand-written table lists the role", () => {
    for (const action of Object.keys(DOCUMENTED_GLOBAL_ROLES) as GlobalAction[])
      for (const role of ROLES)
        expect(mayLoad(gated(action), role), `${action} ${String(role)}`).toBe(
          role !== null && DOCUMENTED_GLOBAL_ROLES[action].includes(role),
        );
  });

  it("says, for the two pages of these tests, who loads what", () => {
    expect(mayLoad(gated("evaluation.read"), "member")).toBe(false);
    expect(mayLoad(gated("evaluation.read"), "legal_engineer")).toBe(true);
    expect(mayLoad(gated("evaluation.read"), "admin")).toBe(true);
    expect(mayLoad(gated("audit.read"), "legal_engineer")).toBe(false);
    expect(mayLoad(gated("audit.read"), "admin")).toBe(true);
    expect(mayLoad(gated("audit.read"), null)).toBe(false);
  });

  it("does not let the application's own table decide: the hand-written one does, so a page the application closed stops the scan", () => {
    // The application's table widened to the legal engineer changes nothing here: it is the
    // documented table that says who is to be let in.
    const table = GLOBAL_ACTIONS as unknown as Record<string, string[]>;
    table["audit.read"]!.push("legal_engineer");
    try {
      expect(mayLoad(gated("audit.read"), "legal_engineer")).toBe(false);
    } finally {
      table["audit.read"]!.pop();
    }
    // And the application's table narrowed to the administrator changes nothing either.
    const saved = table["evaluation.read"]!.splice(0);
    try {
      expect(mayLoad(gated("evaluation.read"), "legal_engineer")).toBe(true);
    } finally {
      table["evaluation.read"]!.push(...saved);
    }
    expect([...GLOBAL_ACTIONS["evaluation.read"]]).toEqual(["legal_engineer", "admin"]);
  });
});

describe("the canary scan, with gated pages planted through its hooks", () => {
  let dataset: Dataset;
  beforeAll(async () => {
    dataset = await completeDataset();
  });
  const scan = (hooks: CanaryHooks, extra: Partial<Parameters<typeof runCanaryScan>[0]> = {}) =>
    runCanaryScan({ dataset, root: ROOT, playbook, signal: never(), hooks, ...extra });

  const PAGE = "The page, for the people it is for";

  /** The pages, guarded with the action each probe names. */
  const guarded =
    (
      actions: Partial<Record<string, GlobalAction>> = {},
    ): NonNullable<CanaryHooks["beforeRoutes"]> =>
    (app) => {
      for (const [path, action] of [
        ["/evaluations", "evaluation.read"],
        ["/synthetic/audit", "audit.read"],
      ] as const)
        defineRoute(app, {
          method: "GET",
          path,
          access: "principal",
          globalAction: actions[path] ?? action,
          handler: (c) => c.text(PAGE),
        });
    };

  const failureOf = async (hooks: CanaryHooks): Promise<Error> => {
    const caught = await scan(hooks).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(caught, "the scan should have stopped").toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).not.toMatch(CANARY_SHAPE);
    expect(error.message).not.toMatch(ID_SHAPE);
    return error;
  };

  it("names both pages among the routes of the tables, with the action each one checks", () => {
    // Other packages may name pages of their own by then; these two are among them.
    const named = OTHER_PROBES.filter((probe) => probe.globalAction !== undefined);
    expect(named.map((probe) => `${probe.template} ${probe.globalAction}`)).toEqual(
      expect.arrayContaining(["/synthetic/audit audit.read", "/evaluations evaluation.read"]),
    );
  });

  it("finds nothing with the pages guarded, and fetches both pages", async () => {
    const result = await scan({ beforeRoutes: guarded() });
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(0);
    expect(result.hits).toEqual([]);
    // Both pages are among the routes fetched, and are counted in the figure of the sentence.
    expect(result.cases[0]!.routes).toEqual(
      expect.arrayContaining(["GET /evaluations", "GET /synthetic/audit"]),
    );
    expect(result.sentence).toContain(`all ${result.routesFetched} GET routes`);
  });

  it("scans the answer of a reader who is refused as an artefact, as it scans the answer of one who is let in", async () => {
    let findings = 0;
    const result = await scan({
      beforeRoutes: guarded(),
      afterReview: (site, context) => {
        findings = (
          site.repo.db
            .prepare("SELECT COUNT(*) AS n FROM findings WHERE matter_id = ?")
            .get(context.caseMatterId) as { n: number }
        ).n;
      },
    });
    expect(findings).toBeGreaterThan(0);
    // Each reader fetches each route of the lists once, so the figure includes the 403 of the
    // members for both pages: it is the same figure as for a page that answers everyone.
    expect(result.byKind.http_body).toBe(expectedBodies({ canaryMatters: 1, findings }));
  });

  it("counts the id of the other matter in the refusal of a member, as it would in a page", async () => {
    const result = await scan({
      beforeRoutes: (app, deps) => {
        // The shell's 403 for a person who is refused, replaced by the id of the canary matter.
        app.use("*", async (c, next) => {
          await next();
          if (c.req.path !== "/evaluations" || c.res.status !== 403) return;
          const row = deps.repo.db
            .prepare("SELECT id FROM matters WHERE name LIKE ?")
            .get(`${CANARY_NAME_PREFIX}%`) as { id: string } | undefined;
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(`refused ${row?.id ?? ""}`, { status: 403, headers });
        });
        guarded()(app, deps);
      },
    });
    expect(result.foreignSpanIdHits).toBeGreaterThan(0);
    const labels = new Set(result.hits.map((hit) => hit.label));
    // The case's own people are refused with it, and so are the canary matter's people (whose own
    // matter's id is in the URL of the other routes, not of this one).
    expect(labels).toContain("associate GET /evaluations");
    expect(labels).toContain("reviewer GET /evaluations");
    expect(labels).toContain("viewer GET /evaluations");
    // Nobody who is let in is refused, so no administrator and no legal engineer is among them.
    expect([...labels].some((label) => label.startsWith("administrator "))).toBe(false);
    expect([...labels].some((label) => label.startsWith("legal engineer "))).toBe(false);
  });

  it("stops the scan when the page that the legal engineer is documented to read is closed to them", async () => {
    // The page checks the audit action, which the legal engineer does not hold: a 403 for a reader
    // who is to be let in would make a scan of that page empty.
    const error = await failureOf({ beforeRoutes: guarded({ "/evaluations": "audit.read" }) });
    expect(error.message).toContain("did not load");
    expect(error.message).toContain("legal engineer GET /evaluations");
    expect(error.message).toContain("status 403");
  });

  it("stops the scan when the page that the administrator is documented to read does not load for them", async () => {
    const error = await failureOf({
      beforeRoutes: (app, deps) => {
        // Registered first, so that it answers before the guarded page does.
        app.get("/synthetic/audit", (c) => c.text("not here", 500));
        guarded()(app, deps);
      },
    });
    expect(error.message).toContain("did not load");
    expect(error.message).toContain("administrator GET /synthetic/audit");
    expect(error.message).toContain("status 500");
  });

  it("does not require the legal engineer, or a member, to load a page that is the administrator's alone", async () => {
    // The page checks the audit action, so they are refused with 403 and the scan goes on.
    const result = await scan({ beforeRoutes: guarded() });
    expect(result.hits).toEqual([]);
    expect(result.cases[0]!.routes).toContain("GET /synthetic/audit");
  });
});
