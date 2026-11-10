import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/server/deps.js";

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

const spies = vi.hoisted(() => ({
  calls: [] as { name: string; app: unknown; deps: unknown }[],
}));

vi.mock("../../src/server/routes/evaluations.js", () => ({
  registerEvaluationRoutes: (app: unknown, deps: unknown) =>
    spies.calls.push({ name: "registerEvaluationRoutes", app, deps }),
}));
vi.mock("../../src/server/routes/feedback-routes.js", () => ({
  registerFeedbackRoutes: (app: unknown, deps: unknown) =>
    spies.calls.push({ name: "registerFeedbackRoutes", app, deps }),
}));
vi.mock("../../src/server/routes/pilot.js", () => ({
  registerPilotRoutes: (app: unknown, deps: unknown) =>
    spies.calls.push({ name: "registerPilotRoutes", app, deps }),
}));
vi.mock("../../src/server/routes/audit.js", () => ({
  registerAuditRoutes: (app: unknown, deps: unknown) =>
    spies.calls.push({ name: "registerAuditRoutes", app, deps }),
}));
vi.mock("../../src/server/routes/training.js", () => ({
  registerTrainingRoutes: (app: unknown, deps: unknown) =>
    spies.calls.push({ name: "registerTrainingRoutes", app, deps }),
}));

describe("registerRoutes", () => {
  it("calls each package's registrar once, with the application and its dependencies, after the pages and the API", async () => {
    const { registerRoutes } = await import("../../src/server/routes/index.js");
    const { describeRoutes } = await import("../../src/server/matter-route.js");
    const app = new Hono();
    const deps = {
      services: { matters: {}, runs: {}, reviews: {} },
      repo: {},
      config: {},
    } as unknown as AppDeps;
    registerRoutes(app, deps);
    expect(spies.calls.map((call) => call.name)).toEqual(REGISTRARS.map((r) => r.name));
    for (const call of spies.calls) {
      expect(call.app, call.name).toBe(app);
      expect(call.deps, call.name).toBe(deps);
    }
    // The pages and the API were registered by then: the spies add nothing.
    expect(describeRoutes(app).length).toBeGreaterThan(40);
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
