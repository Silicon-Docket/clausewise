import { beforeAll, describe, expect, it, vi } from "vitest";
import { readPrincipal } from "../../apps/parol/src/auth/identity.js";
import { defineMiddleware } from "../../apps/parol/src/server/matter-route.js";
import { checkRoutes, runCanaryScan, type CanaryHooks } from "../src/parol/exposure/canary.js";
import type { Dataset } from "../src/parol/dataset.js";
import { SiteClient, type App } from "../src/parol/exposure/site.js";
import { newApp } from "./parol-canary-support.js";
import {
  CANARY_SHAPE,
  completeDataset,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * Which routes the canary scan fetches, and what it does about the ones it cannot fetch as routes.
 * A route that answers a GET and that no probe table lists is a leak that the scan would count as
 * zero, so the application's route list is read (a GET route, and a route for every method at an
 * exact path, that no table lists stop the suite) and each wildcard that is not the shell's own
 * middleware is asked what it answers, because a responder on `app.all('/files/*')` and middleware
 * that hands on have the same path.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const scan = (hooks: CanaryHooks) =>
  runCanaryScan({ dataset, root: ROOT, playbook, signal: never(), hooks });

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

const unavailable = (error: Error) =>
  expect(error).toMatchObject({ name: "ExposureSuiteUnavailable" });

/** A handler that answers a GET with something of its own, as a static file server or a proxy would. */
const answer = (c: { text: (s: string) => Response }): Response => c.text("ANSWERED");

describe("a wildcard route that is not the shell's own middleware", () => {
  const answering: Record<string, [path: string, plant: NonNullable<CanaryHooks["beforeRoutes"]>]> =
    {
      "app.all on a prefix": ["/files/*", (app) => void app.all("/files/*", answer)],
      "app.use on a prefix": [
        "/files/*",
        (app) => void app.use("/files/*", async (c) => answer(c)),
      ],
      "app.mount": ["/files/*", (app) => void app.mount("/files", () => new Response("ANSWERED"))],
      "the all('/*') of a mounted application": [
        "/v2/*",
        (app) => {
          const sub = newApp();
          sub.all("/*", answer);
          app.route("/v2", sub);
        },
      ],
      "app.all('/*') as a fallback": ["/*", (app) => void app.all("/*", answer)],
      "app.use('*') that answers": ["/*", (app) => void app.use("*", async (c) => answer(c))],
      "a wildcard under a matter's own path": [
        "/matters/:matterId/export/*",
        (app) => void app.all("/matters/:matterId/export/*", answer),
      ],
    };

  for (const [label, [path, plant]] of Object.entries(answering))
    it(`stops the suite when it answers: ${label}`, async () => {
      const error = await failureOf({ beforeRoutes: plant });
      unavailable(error);
      expect(error.message).toContain(`ALL ${path}`);
      expect(error.message).toMatch(/not its own middleware/);
    });

  it("stops the suite when it answers only a person who is signed in", async () => {
    const error = await failureOf({
      beforeRoutes: (app) =>
        void app.use("/files/*", async (c, next) => {
          if (readPrincipal(c) !== null) return answer(c);
          await next();
        }),
    });
    unavailable(error);
    expect(error.message).toContain("ALL /files/*");
  });

  it("stops the suite when it answers only an anonymous client", async () => {
    const error = await failureOf({
      beforeRoutes: (app) =>
        void app.use("/files/*", async (c, next) => {
          if (readPrincipal(c) === null) return answer(c);
          await next();
        }),
    });
    unavailable(error);
    expect(error.message).toContain("ALL /files/*");
  });

  it("names every such route and nothing else", async () => {
    const error = await failureOf({
      beforeRoutes: (app) => {
        app.use("/api/*", async (_c, next) => next());
        app.all("/files/*", answer);
        app.all("/docs/*", answer);
      },
    });
    unavailable(error);
    expect(error.message).toContain("ALL /files/*");
    expect(error.message).toContain("ALL /docs/*");
    expect(error.message).not.toContain("ALL /api/*");
  });

  it("does not stop the suite when it hands on, whatever it does to the answers it gets", async () => {
    const result = await scan({
      beforeRoutes: (app) => {
        app.use("/files/*", async (_c, next) => next());
        app.use("/api/*", async (_c, next) => next());
        app.use("*", async (_c, next) => next());
        // It changes the answer to a read it knows, and leaves the answer to a URL no route owns.
        app.use("/api/session", async (c, next) => {
          await next();
          c.res.headers.set("x-seen", "yes");
        });
      },
    });
    expect(result.hits).toEqual([]);
  });
});

describe("a route that no probe table lists", () => {
  it("stops the suite for a GET route and for a route for every method at an exact path", async () => {
    unavailable(
      await failureOf({ beforeRoutes: (app) => void app.get("/api/extra-list", answer) }),
    );
    const error = await failureOf({ beforeRoutes: (app) => void app.all("/export-all", answer) });
    unavailable(error);
    expect(error.message).toContain("ALL /export-all");
  });

  it("stops the suite for a GET route on a wildcard, which is a route that answers", async () => {
    const error = await failureOf({ beforeRoutes: (app) => void app.get("/files/*", answer) });
    unavailable(error);
    expect(error.message).toContain("GET /files/*");
  });
});

describe("the check on its own, with applications the suite never builds", () => {
  /** The application as the suite meets it: three of the shell's middleware that hand on, and nothing else. */
  const shell = (extra: (app: App) => void = () => {}): App => {
    const app = newApp();
    for (let i = 0; i < 3; i += 1) defineMiddleware(app, async (_c, next) => next());
    extra(app);
    return app;
  };
  const siteOf = (app: App) => ({
    app,
    anonymous: () => new SiteClient(app),
    signIn: async () => new SiteClient(app),
  });
  const referenceOf = (app: App) => () => ({
    anonymous: () => new SiteClient(app),
    signIn: async () => new SiteClient(app),
    close: () => {},
  });

  it("lets the shell's own middleware through without asking anything, even one that would answer", async () => {
    const app = shell();
    defineMiddleware(app, async (c) => answer(c));
    const makeReference = vi.fn(referenceOf(shell()));
    await expect(checkRoutes(siteOf(app), makeReference)).resolves.toBeUndefined();
    // Recognised by the function that was registered, so there was nothing to ask.
    expect(makeReference).not.toHaveBeenCalled();
  });

  it("stops for a middleware replaced by a responder when the number of such routes is the same", async () => {
    // Four routes for every method on `/*`, as in the shell: three of its own and one that answers.
    const app = shell((a: App) => void a.use("*", async (c) => answer(c)));
    const same = shell();
    defineMiddleware(same, async (_c, next) => next());
    expect(
      app.routes.filter(
        (r: { method: string; path: string }) => r.method === "ALL" && r.path === "/*",
      ),
    ).toHaveLength(4);
    expect(
      same.routes.filter(
        (r: { method: string; path: string }) => r.method === "ALL" && r.path === "/*",
      ),
    ).toHaveLength(4);
    await expect(checkRoutes(siteOf(app), referenceOf(same))).rejects.toMatchObject({
      name: "ExposureSuiteUnavailable",
    });
    await expect(checkRoutes(siteOf(same), referenceOf(same))).resolves.toBeUndefined();
  });

  it("stops for a responder that is registered the way the shell registers middleware, but not through it", async () => {
    const app = shell((a: App) => void a.all("/files/*", answer));
    await expect(checkRoutes(siteOf(app), referenceOf(shell()))).rejects.toThrow(/ALL \/files\/\*/);
  });

  it("closes the copy of the application it asked, whatever the answer", async () => {
    const close = vi.fn();
    const reference = () => ({ ...referenceOf(shell())(), close });
    await expect(
      checkRoutes(siteOf(shell((a: App) => void a.all("/files/*", answer))), reference),
    ).rejects.toThrow();
    await expect(
      checkRoutes(
        siteOf(shell((a: App) => void a.use("/files/*", async (_c, next) => next()))),
        reference,
      ),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("asks nothing when the application has no wildcard of another kind", async () => {
    const makeReference = vi.fn(referenceOf(shell()));
    await checkRoutes(siteOf(shell()), makeReference);
    expect(makeReference).not.toHaveBeenCalled();
  });
});
