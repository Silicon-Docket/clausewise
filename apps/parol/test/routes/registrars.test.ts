import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/server/deps.js";
import { describeRoutes } from "../../src/server/matter-route.js";

/**
 * `registerRoutes` adds the routes of the pages and the API and then calls one registrar for each
 * package that adds routes of its own: evaluations, feedback, pilot, audit and training. Each lives
 * in a module of its own, so that no package edits `routes/index.ts` when it arrives. The registrars
 * are replaced here by spies, because they register nothing until their package arrives, and a call
 * that is missing would go unseen until then.
 */

const REGISTRARS = [
  { file: "evaluations", name: "registerEvaluationRoutes" },
  { file: "feedback-routes", name: "registerFeedbackRoutes" },
  { file: "pilot", name: "registerPilotRoutes" },
  { file: "audit", name: "registerAuditRoutes" },
  { file: "training", name: "registerTrainingRoutes" },
] as const;

/** A call of a registrar: its arguments, and the routes the application held at the moment of the call. */
interface Call {
  name: string;
  app: unknown;
  deps: unknown;
  seen: string[];
}

const spies = vi.hoisted(() => ({
  calls: [] as Call[],
  /** Set by the test to read the routes of an application (`describeRoutes`), as `METHOD path`. */
  routesOf: (_app: unknown): string[] => [],
}));

/** Records a call, with the routes registered before it. The spies add no route of their own. */
const record = (name: string, app: unknown, deps: unknown): number =>
  spies.calls.push({ name, app, deps, seen: spies.routesOf(app) });

vi.mock("../../src/server/routes/evaluations.js", () => ({
  registerEvaluationRoutes: (app: unknown, deps: unknown) =>
    record("registerEvaluationRoutes", app, deps),
}));
vi.mock("../../src/server/routes/feedback-routes.js", () => ({
  registerFeedbackRoutes: (app: unknown, deps: unknown) =>
    record("registerFeedbackRoutes", app, deps),
}));
vi.mock("../../src/server/routes/pilot.js", () => ({
  registerPilotRoutes: (app: unknown, deps: unknown) => record("registerPilotRoutes", app, deps),
}));
vi.mock("../../src/server/routes/audit.js", () => ({
  registerAuditRoutes: (app: unknown, deps: unknown) => record("registerAuditRoutes", app, deps),
}));
vi.mock("../../src/server/routes/training.js", () => ({
  registerTrainingRoutes: (app: unknown, deps: unknown) =>
    record("registerTrainingRoutes", app, deps),
}));

describe("registerRoutes", () => {
  it("calls each package's registrar once, with the application and its dependencies, after the pages and the API", async () => {
    const { registerRoutes } = await import("../../src/server/routes/index.js");
    spies.routesOf = (app) => describeRoutes(app as Hono).map((r) => `${r.method} ${r.path}`);
    const app = new Hono();
    const deps = {
      services: { matters: {}, runs: {}, reviews: {} },
      repo: {},
      config: {},
    } as unknown as AppDeps;
    expect(describeRoutes(app)).toEqual([]);
    registerRoutes(app, deps);
    expect(spies.calls.map((call) => call.name)).toEqual(REGISTRARS.map((r) => r.name));
    for (const call of spies.calls) {
      expect(call.app, call.name).toBe(app);
      expect(call.deps, call.name).toBe(deps);
    }
    // The spies add no route, so every route there is now is the work of registerPageRoutes and
    // registerApiRoutes. Each registrar must already have seen all of them when it was called: a
    // registrar called before either of them would see fewer, or none.
    const routes = describeRoutes(app).map((r) => `${r.method} ${r.path}`);
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toContain("GET /matters");
    expect(routes).toContain("GET /api/matters");
    for (const call of spies.calls) {
      expect(call.seen, call.name).toContain("GET /matters");
      expect(call.seen, call.name).toContain("GET /api/matters");
      expect(call.seen, call.name).toEqual(routes);
    }
  });
});

describe("the registrar modules", () => {
  for (const { file, name } of REGISTRARS)
    it(`${file}.ts exports ${name}, which takes the application and its dependencies`, async () => {
      const actual = await vi.importActual<Record<string, unknown>>(
        `../../src/server/routes/${file}.js`,
      );
      expect(typeof actual[name]).toBe("function");
      expect((actual[name] as (...args: unknown[]) => unknown).length).toBe(2);
    });
});
