import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Dataset } from "../src/parol/dataset.js";
import { UNROUTED_ACTORS } from "../src/parol/exposure/authorization.js";
import { isApi, noRecordIds, unroutedRequests } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { failure, runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * The route list cannot tell a wildcard that hands on from one that answers, and it lets an `ALL`
 * route at a probed path through for every method. What the suite does instead is ask: a URL that
 * no route owns, sent every method by a visitor, an outsider and a member, must get the 404 that
 * any URL nothing owns gets. A route that answers is found whatever the list says about it.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});
const run = runWith(() => dataset);

const plan = unroutedRequests(noRecordIds());
/** The cells that a route answering every URL of the API would answer: each request, as each caller, in both modes. */
const apiCells =
  plan.filter((request) => isApi(request.template)).length * UNROUTED_ACTORS.length * 2;
const answers = (): NonNullable<SiteHooks["afterRoutes"]> => (app) =>
  void app.all("/api/matters/:matterId/*", (c) => c.json({ everything: "for anyone" }));

describe("the cells for URLs that no route owns, on the application as it is", () => {
  it("are all answered with the 404 of a URL that nothing owns, by all three callers, in both modes", async () => {
    const result = await run({}, ["unrouted"]);
    expect(result.unroutedCells).toBe(plan.length * UNROUTED_ACTORS.length * 2);
    expect(result.unroutedRequests).toBe(plan.length);
    // They are counted as cells, and only they ran.
    expect(result.probesRun).toBe(result.unroutedCells);
    expect(result.matrixCells + result.forgedCells + result.listCells).toBe(0);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
    expect(result.exposed).toEqual([]);
    expect(result.sentence).toContain(
      `${result.unroutedCells} in which a visitor, an outsider and a member sent ${plan.length} requests to URLs no route owns`,
    );
  });

  it("are left out when the group is not asked for, and not counted", async () => {
    const result = await run({}, ["matrix"]);
    expect(result.unroutedCells).toBe(0);
    expect(result.unroutedRequests).toBe(0);
    expect(result.sentence).not.toContain("URLs no route owns");
  });
});

describe("a route that hands on", () => {
  it("is let through and found clean: a wildcard that calls the next handler leaves the 404", async () => {
    const result = await run(
      {
        beforeRoutes: (app) => {
          for (const prefix of ["/api/matters/*", "/matters/*"])
            app.use(prefix, async (_c, next) => {
              await next();
            });
        },
        afterRoutes: (app) => {
          app.all("/api/matters/:matterId/*", async (_c, next) => {
            await next();
          });
          app.all("/matters/:matterId/export/*", async (_c, next) => {
            await next();
          });
        },
      },
      ["matrix", "unrouted"],
    );
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
    // The wildcard under a longer prefix is among the shapes sent.
    expect(result.unroutedRequests).toBeGreaterThan(plan.length);
  });
});

describe("a wildcard at a prefix that names no matter", () => {
  it("is asked every method as well, and found clean when it hands on: middleware at /api, /legacy and every path", async () => {
    const result = await run(
      {
        beforeRoutes: (app) => {
          app.use("*", async (_c, next) => {
            await next();
          });
          app.use("/api/*", async (_c, next) => {
            await next();
          });
        },
        afterRoutes: (app) =>
          void app.all("/legacy/*", async (_c, next) => {
            await next();
          }),
      },
      ["unrouted"],
    );
    // Three URLs, in every method: the root, the API and the prefix that names nothing. The shell's
    // own middleware, which is registered for every path, adds none: the plan above has only the shapes.
    expect(result.unroutedRequests).toBe(plan.length + 3 * 5);
    expect(result.unroutedCells).toBe((plan.length + 3 * 5) * UNROUTED_ACTORS.length * 2);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
    expect(result.exposed).toEqual([]);
  });
});

describe("a route that answers more than it is listed for", () => {
  it("is found when app.all with a wildcard answers every URL under a matter's API, and the route list lets it through", async () => {
    const hook: SiteHooks = { afterRoutes: answers() };
    // As far as the list of routes and the matrix go, nothing is wrong: the real routes come first.
    const listed = await run(hook, ["matrix"]);
    expect(listed.probesAnsweredWithData).toBe(0);
    expect(listed.mismatches).toBe(0);
    const result = await run(hook, ["unrouted"]);
    expect(apiCells).toBeGreaterThan(300);
    expect(result.probesAnsweredWithData).toBe(apiCells);
    expect(result.byReason.handler_answered).toBe(apiCells);
    // Every kind of caller, a visitor included, and the names say where.
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(UNROUTED_ACTORS));
    expect(result.exposed.every((cell) => cell.probe.includes("/api/matters/:matterId"))).toBe(
      true,
    );
    expect(result.mismatches).toBe(0);
    expect(result.sentence).toContain(`${apiCells} were answered with data`);
    expect(result.sentence).toContain("First exposed: ");
  });

  it("is found when app.use with a wildcard answers every URL under a matter's pages", async () => {
    const result = await run(
      {
        afterRoutes: (app) =>
          void app.use("/matters/*", async (c) => c.text("everything for anyone")),
      },
      ["unrouted"],
    );
    // A wildcard under the matter's pages adds the one URL it names, in every method, to the shapes sent.
    const sent = unroutedRequests(noRecordIds(), ["/matters/*"]);
    expect(sent.length).toBe(plan.length + 5);
    const pageCells =
      sent.filter((request) => !isApi(request.template)).length * UNROUTED_ACTORS.length * 2;
    expect(result.unroutedRequests).toBe(sent.length);
    expect(result.probesAnsweredWithData).toBe(pageCells);
    expect(result.exposed.every((cell) => !cell.probe.includes("/api/"))).toBe(true);
  });

  it("is found when the wildcard sits under a longer prefix, because the URL it answers is built from the route", async () => {
    // The shapes after the matter's own URL never reach `/export/...`; only the route's own path does.
    const result = await run(
      {
        afterRoutes: (app) =>
          void app.use("/api/matters/:matterId/export/*", async (c) =>
            c.json({ everything: "yes" }),
          ),
      },
      ["unrouted"],
    );
    // That one URL, in every method, for every caller, in both modes.
    expect(result.probesAnsweredWithData).toBe(5 * UNROUTED_ACTORS.length * 2);
    expect(
      result.exposed.every((cell) => cell.probe.includes("/export/unrouted/unrouted (no route)")),
    ).toBe(true);
  });

  it("is found when app.all with a wildcard at a prefix that names no matter answers a POST with data, as an app.post there is", async () => {
    const hook: SiteHooks = {
      afterRoutes: (app) =>
        void app.all("/legacy/*", (c) =>
          c.req.method === "POST" ? c.json({ everything: "for anyone" }) : c.notFound(),
        ),
    };
    // The matrix has nothing to send it, and the canary scan reads it with a GET, which it does not answer.
    const listed = await run(hook, ["matrix"]);
    expect(listed.probesAnsweredWithData).toBe(0);
    const result = await run(hook, ["unrouted"]);
    // The one method it answers, as each of the three callers, in both modes.
    expect(result.probesAnsweredWithData).toBe(UNROUTED_ACTORS.length * 2);
    expect(result.byReason.handler_answered).toBe(UNROUTED_ACTORS.length * 2);
    expect(
      result.exposed.every((cell) => cell.probe === "POST /legacy/unrouted/unrouted (no route)"),
    ).toBe(true);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(UNROUTED_ACTORS));
    expect(result.mismatches).toBe(0);
    // The URL it answers is one more, in every method, among the shapes sent.
    expect(result.unroutedRequests).toBe(plan.length + 5);
  });

  it("is found when an ALL route at a probed path answers a method the table does not probe on it", async () => {
    const hook: SiteHooks = {
      afterRoutes: (app) =>
        void app.all("/api/matters/:matterId", (c, next) =>
          c.req.method === "PUT" ? c.json({ answered: true }) : next(),
        ),
    };
    // The route is let through for every method, and the matrix sends it none of the ones it answers.
    const listed = await run(hook, ["matrix"]);
    expect(listed.probesAnsweredWithData).toBe(0);
    const result = await run(hook, ["unrouted"]);
    expect(result.probesAnsweredWithData).toBe(UNROUTED_ACTORS.length * 2);
    expect(
      result.exposed.every((cell) => cell.probe === "PUT /api/matters/:matterId (unprobed method)"),
    ).toBe(true);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(UNROUTED_ACTORS));
  });

  it("is found when the answer is a 404 that is not the application's own", async () => {
    const result = await run(
      {
        afterRoutes: (app) =>
          void app.all("/matters/:matterId/*", (c) =>
            c.json({ error: { kind: "no_such_thing" } }, 404),
          ),
      },
      ["unrouted"],
    );
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
    expect(result.byReason.refusal_differs).toBe(result.probesAnsweredWithData);
    expect(result.byReason.handler_answered).toBe(0);
  });
});

describe("a route registered another way that names no matter", () => {
  const writes = ["post", "put", "patch", "delete"] as const;

  for (const method of writes)
    it(`stops the suite for an unmanaged ${method.toUpperCase()} that the table sends nothing to`, async () => {
      const error = await failure(
        run(
          { beforeRoutes: (app) => void app[method]("/api/search", (c) => c.json({ found: [] })) },
          ["matrix"],
        ),
      );
      expect(error.name).toBe("ExposureSuiteUnavailable");
      expect(error.message).toContain(`${method.toUpperCase()} /api/search`);
      expect(error.message).toContain("defineRoute");
    });

  it("stops the suite for an unmanaged read at a path that names no matter and is not in the list", async () => {
    const error = await failure(
      run(
        { beforeRoutes: (app) => void app.get("/api/overview", (c) => c.json({ matters: [] })) },
        ["matrix"],
      ),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("GET /api/overview");
  });

  it("lets through a route the table does send a request to, because the cells will find what it gives away", async () => {
    const result = await run(
      { beforeRoutes: (app) => void app.get("/api/playbooks", (c) => c.json({ playbooks: [] })) },
      ["lists"],
    );
    // Answers a visitor, which the lists group counts.
    expect(result.probesAnsweredWithData).toBe(2);
  });

  it("does not stop the suite for the application as it is: the routes it registers another way are middleware", async () => {
    const result = await run({}, ["lists"]);
    expect(result.probesAnsweredWithData).toBe(0);
  });
});
