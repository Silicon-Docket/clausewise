import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  READ_ONLY_GLOBAL_ACTIONS,
  defineMatterRoute,
  defineMiddleware,
  defineRoute,
  describeRoutes,
  findMatterUrlsWithoutGuard,
  findUnguardedMatterRoutes,
  isMatterScopedPath,
  type RouteMethod,
} from "../../src/server/matter-route.js";
import type { AppDeps } from "../../src/server/deps.js";
import {
  GLOBAL_ACTIONS,
  MATTER_ACTIONS,
  type GlobalAction,
  type MatterAction,
} from "../../src/auth/actions.js";
import { pageChrome } from "../../src/server/routes/shared.js";
import {
  Layout,
  NAV_ITEMS,
  navItemsFor,
  render,
  type NavItem,
} from "../../src/server/pages/layout.js";
import { SRC_ROOT, createParolProgram } from "../auth/brand-types.js";
import { findDirectRouteRegistrations } from "./shell-registration-scan.js";
import { ALL_ACTIONS, USERS, makeShell } from "./support-app.js";

/**
 * The rule: every route that can reach a matter goes through `defineMatterRoute`. The check reads
 * the application as it is (Hono's `app.routes`) and the record `defineMatterRoute` keeps, so it
 * holds for routes added by later work without anyone updating a list. It is proved here with
 * synthetic routes, including ones added the wrong way.
 */

const METHODS: RouteMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ok = (c: { text: (s: string) => Response }): Response => c.text("ok");

/** The shell's own middleware (app.ts): the context, the host guard, the user-info refusal, the body limit. */
const SHELL_MIDDLEWARE_COUNT = 4;

/** Every route that was registered another way than through the declaring functions, as `METHOD /path`. */
const undeclaredRoutes = (app: Hono): string[] =>
  describeRoutes(app)
    .filter((route) => route.kind === "unmanaged")
    .map((route) => `${route.method} ${route.path}`);

describe("the live application", () => {
  it("has no matter route that bypasses defineMatterRoute", () => {
    const { app } = makeShell();
    expect(findUnguardedMatterRoutes(app)).toEqual([]);
  });

  it("answers no matter URL by anything but a matter guard", () => {
    const { app } = makeShell();
    expect(findMatterUrlsWithoutGuard(app)).toEqual([]);
  });

  it("declares every route it owns: its middleware is recognised, and nothing is registered any other way", () => {
    const { app } = makeShell();
    // Not even a route for every method, whatever its path: a middleware is told from a handler by
    // the function that was registered and not by its path (see "a handler that answers").
    expect(undeclaredRoutes(app)).toEqual([]);
    const middleware = describeRoutes(app).filter((route) => route.kind === "middleware");
    expect(middleware.map((route) => `${route.method} ${route.path}`)).toEqual(
      Array(SHELL_MIDDLEWARE_COUNT).fill("ALL /*"),
    );
    const owned = describeRoutes(app)
      .filter((route) => route.kind !== "unmanaged")
      .map((route) => `${route.method} ${route.path} ${route.kind}`);
    expect(owned).toEqual(
      expect.arrayContaining([
        "GET /healthz public",
        "GET /assets/:name public",
        "POST /session public",
        "POST /session/end public",
      ]),
    );
  });

  // Whoever writes the page and API routes exports `registerRoutes(app, deps)` from
  // src/server/routes/index.ts: main.ts loads it by that name. This test then covers them with no
  // change. Until the file exists there is nothing to add, and the test is reported as skipped and
  // not as passed, so the gap is visible. Once the file exists the test cannot pass by finding
  // nothing: a missing export fails it, because main.ts would then serve the shell only.
  const routesFile = join(import.meta.dirname, "..", "..", "src", "server", "routes", "index.ts");
  it.skipIf(!existsSync(routesFile))(
    "holds for the routes the next phase adds (src/server/routes/index.ts)",
    async () => {
      const module = (await import(/* @vite-ignore */ routesFile)) as {
        registerRoutes?: (app: Hono, deps: AppDeps) => void;
      };
      expect(
        typeof module.registerRoutes,
        "src/server/routes/index.ts must export registerRoutes(app, deps), which main.ts loads",
      ).toBe("function");
      const shell = makeShell();
      module.registerRoutes!(shell.app, shell.deps);
      expect(findUnguardedMatterRoutes(shell.app)).toEqual([]);
      expect(findMatterUrlsWithoutGuard(shell.app)).toEqual([]);
      // And the routes it added really are there, so the check was not run on an empty app.
      expect(describeRoutes(shell.app).some((route) => route.kind === "matter")).toBe(true);
    },
  );
});

describe("no route is registered on the side", () => {
  /** Only the function that does the registering may call Hono's own methods. */
  const ALLOWED = new Set(["server/matter-route.ts"]);
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
    });

  it("finds no app.get, app.post, app.on or the like anywhere in src but defineMatterRoute", () => {
    const roots = sources(SRC_ROOT);
    expect(roots.length).toBeGreaterThan(20);
    const found = findDirectRouteRegistrations(createParolProgram(roots), ALLOWED).map(
      (f) => `${f.file}:${f.line} app.${f.method}`,
    );
    expect(found).toEqual([]);
  }, 120_000);

  describe("the scan itself", () => {
    const run = (body: string): string[] => {
      const path = join(SRC_ROOT, "__snippets__", "route.ts");
      const text = [
        `import { Hono } from "hono";`,
        `import type { Context } from "hono";`,
        `export function f(app: Hono, c: Context, sub = new Hono()): void {`,
        body,
        `}`,
      ].join("\n");
      return findDirectRouteRegistrations(
        createParolProgram([path], new Map([[path, text]])),
        new Set(),
      ).map((x) => x.method);
    };

    it("reports each registering method, on any Hono value", () => {
      expect(run(`app.get("/a", (x) => x.text("a"));`)).toEqual(["get"]);
      expect(
        run(`sub.post("/a", (x) => x.text("a")); sub.delete("/a", (x) => x.text("a"));`),
      ).toEqual(["post", "delete"]);
      expect(run(`app.on(["GET"], "/a", (x) => x.text("a"));`)).toEqual(["on"]);
      expect(run(`app.all("/a", (x) => x.text("a"));`)).toEqual(["all"]);
      expect(run(`new Hono().put("/a", (x) => x.text("a"));`)).toEqual(["put"]);
    });

    it("leaves alone what is not a route", () => {
      expect(
        run(
          `c.get("key"); c.req.header("x"); new Map<string, string>().get("k"); [1].includes(1);` +
            `app.use("*", async (_c, next) => next()); app.onError((_e, x) => x.text("e"));` +
            `app.route("/p", sub); app.notFound((x) => x.text("n"));`,
        ),
      ).toEqual([]);
    });
  });
});

describe("a handler that answers is not taken for the shell's middleware", () => {
  // A wildcard in the route list is middleware or a responder, and the path cannot say which: a
  // handler on `app.all('/files/*')`, `app.use('/files/*')`, a mounted application and a sub-
  // application's `all('/*')` register the same way the shell's own middleware does. The shell's
  // own is recognised by the function it registered.
  const responder = (c: { text: (s: string) => Response }): Response => c.text("ANSWERED");

  const ways: Record<string, (app: Hono) => void> = {
    "app.all on a prefix": (app) => app.all("/files/*", responder),
    "app.use on a prefix": (app) => app.use("/files/*", async (c) => responder(c)),
    "app.mount": (app) => app.mount("/files", () => new Response("ANSWERED")),
    "a mounted application's all('/*')": (app) => {
      const sub = new Hono();
      sub.all("/*", responder);
      app.route("/v2", sub);
    },
    "app.all('/*')": (app) => app.all("/*", responder),
    "app.use('*')": (app) => app.use("*", async (c) => responder(c)),
    "a handler that hands on, which the route list cannot tell from one that answers": (app) =>
      app.use("/files/*", async (_c, next) => next()),
  };

  for (const [label, add] of Object.entries(ways))
    it(`is reported as undeclared: ${label}`, async () => {
      const { app } = makeShell();
      add(app);
      const found = undeclaredRoutes(app);
      expect(found.length, label).toBeGreaterThan(0);
      expect(found.every((line) => line.startsWith("ALL "))).toBe(true);
      // The shell's own four are still recognised beside it.
      expect(describeRoutes(app).filter((route) => route.kind === "middleware")).toHaveLength(
        SHELL_MIDDLEWARE_COUNT,
      );
    });

  it("is reported when a middleware of the shell is replaced by a responder and the count is the same", () => {
    // Four routes for every method on `/*`, as in the shell: three of its kind and one that answers.
    const app = new Hono();
    defineMiddleware(app, async (_c, next) => next());
    defineMiddleware(app, async (_c, next) => next());
    defineMiddleware(app, async (_c, next) => next());
    app.use("*", async (c) => responder(c));
    const all = describeRoutes(app).filter(
      (route) => route.method === "ALL" && route.path === "/*",
    );
    expect(all).toHaveLength(SHELL_MIDDLEWARE_COUNT);
    expect(all.map((route) => route.kind)).toEqual([
      "middleware",
      "middleware",
      "middleware",
      "unmanaged",
    ]);
    expect(undeclaredRoutes(app)).toEqual(["ALL /*"]);
  });

  it("really answers, which is what the check is for", async () => {
    const { app } = makeShell();
    app.all("/files/*", responder);
    const response = await app.request("/files/anything");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ANSWERED");
    expect(undeclaredRoutes(app)).toEqual(["ALL /files/*"]);
  });
});

describe("routes declared the right way", () => {
  it("are all found as guarded, for every method and both prefixes", () => {
    const { app } = makeShell();
    for (const method of METHODS) {
      defineMatterRoute(app, {
        method,
        path: "/matters/:matterId/things",
        action: "matter.read",
        handler: ok,
      });
      defineMatterRoute(app, {
        method,
        path: "/api/matters/:matterId/things/:thingId",
        action: "matter.read",
        handler: ok,
      });
    }
    defineMatterRoute(app, {
      method: "GET",
      path: "/matters/:matterId",
      action: "matter.read",
      handler: ok,
    });
    defineMatterRoute(app, {
      method: "DELETE",
      path: "/api/matters/:matterId",
      action: "matter.delete",
      handler: ok,
    });
    expect(findUnguardedMatterRoutes(app)).toEqual([]);
    expect(describeRoutes(app).filter((route) => route.kind === "matter").length).toBe(
      METHODS.length * 2 + 2,
    );
  });

  it("record the action each route checks", () => {
    const { app } = makeShell();
    for (const action of Object.keys(MATTER_ACTIONS) as (keyof typeof MATTER_ACTIONS)[]) {
      defineMatterRoute(app, {
        method: "POST",
        path: `/api/matters/:matterId/${action}`,
        action,
        handler: ok,
      });
    }
    const recorded = describeRoutes(app)
      .filter((route) => route.kind === "matter")
      .map((route) => route.action);
    expect(new Set(recorded)).toEqual(new Set(Object.keys(MATTER_ACTIONS)));
  });

  it("are recorded as public or principal for the others", () => {
    const { app } = makeShell();
    defineRoute(app, { method: "GET", path: "/matters", access: "principal", handler: ok });
    defineRoute(app, { method: "POST", path: "/matters", access: "principal", handler: ok });
    defineRoute(app, { method: "GET", path: "/api/playbooks", access: "principal", handler: ok });
    const kinds = new Map(describeRoutes(app).map((r) => [`${r.method} ${r.path}`, r.kind]));
    expect(kinds.get("GET /matters")).toBe("principal");
    expect(kinds.get("POST /matters")).toBe("principal");
    expect(kinds.get("GET /api/playbooks")).toBe("principal");
    expect(findUnguardedMatterRoutes(app)).toEqual([]);
  });
});

describe("routes declared the wrong way", () => {
  const bypasses: Record<string, (app: Hono) => void> = {
    "app.get": (app) => app.get("/matters/:matterId/leak", (c) => c.text("x")),
    "app.post under /api": (app) => app.post("/api/matters/:matterId/leak", (c) => c.text("x")),
    "app.put, app.patch, app.delete": (app) => {
      app.put("/matters/:matterId/a", (c) => c.text("x"));
      app.patch("/matters/:matterId/b", (c) => c.text("x"));
      app.delete("/matters/:matterId/c", (c) => c.text("x"));
    },
    "app.all": (app) => app.all("/api/matters/:matterId/leak", (c) => c.text("x")),
    "app.on with several methods": (app) =>
      app.on(["GET", "POST"], "/matters/:matterId/leak", (c) => c.text("x")),
    "middleware on the matter prefix": (app) =>
      app.use("/matters/:matterId/*", async (_c, next) => next()),
    "a wildcard under matters": (app) => app.get("/matters/*", (c) => c.text("x")),
    "a wildcard under the api": (app) => app.all("/api/matters/*", (c) => c.text("x")),
    "another name for the parameter": (app) => app.get("/api/matters/:id/leak", (c) => c.text("x")),
    "a parameter with a pattern": (app) =>
      app.get("/matters/:matterId{[a-z0-9_]+}/leak", (c) => c.text("x")),
    "a prefix in front": (app) => app.get("/v2/api/matters/:matterId/leak", (c) => c.text("x")),
    "a matterId parameter elsewhere": (app) => app.get("/export/:matterId", (c) => c.text("x")),
    "a plain handler on the bare matter route": (app) =>
      app.get("/matters/:matterId", (c) => c.text("x")),
  };

  for (const [label, add] of Object.entries(bypasses)) {
    it(`is found: ${label}`, () => {
      const { app } = makeShell();
      add(app);
      const found = findUnguardedMatterRoutes(app);
      expect(found.length, label).toBeGreaterThan(0);
    });
  }

  it("names the one route that was added the wrong way among those added the right way", () => {
    const { app } = makeShell();
    defineMatterRoute(app, {
      method: "GET",
      path: "/matters/:matterId/documents",
      action: "matter.read",
      handler: ok,
    });
    app.get("/matters/:matterId/leak", (c) => c.text("x"));
    defineMatterRoute(app, {
      method: "POST",
      path: "/api/matters/:matterId/runs",
      action: "run.start",
      handler: ok,
    });
    expect(findUnguardedMatterRoutes(app)).toEqual(["GET /matters/:matterId/leak"]);
  });

  it("is found when a guard is copied onto another path or method", () => {
    const { app } = makeShell();
    defineMatterRoute(app, {
      method: "GET",
      path: "/matters/:matterId/documents",
      action: "matter.read",
      handler: ok,
    });
    const guard = app.routes.find(
      (route) => route.path === "/matters/:matterId/documents",
    )!.handler;
    app.get("/matters/:matterId/elsewhere", guard);
    app.post("/matters/:matterId/documents", guard);
    expect(findUnguardedMatterRoutes(app).sort()).toEqual([
      "GET /matters/:matterId/elsewhere",
      "POST /matters/:matterId/documents",
    ]);
  });

  it("is refused at registration when a route that reaches a matter uses defineRoute", () => {
    const { app } = makeShell();
    for (const path of [
      "/matters/:matterId/x",
      "/api/matters/:matterId/x",
      "/matters/:id/x",
      "/matters/*",
      "/export/:matterId",
    ])
      expect(() =>
        defineRoute(app, { method: "GET", path, access: "public", handler: ok }),
      ).toThrow(TypeError);
  });

  it("is refused at registration when defineMatterRoute is given a path it cannot authorize", () => {
    const { app } = makeShell();
    for (const path of [
      "/matters",
      "/matters/new",
      "/matters/:id/x",
      "/other/:matterId",
      "/api/other/matters/:matterId",
      "/matters/:matterIdentifier/x",
      "/MATTERS/:matterId",
    ])
      expect(() =>
        defineMatterRoute(app, { method: "GET", path, action: "matter.read", handler: ok }),
      ).toThrow(TypeError);
  });
});

describe("a state-changing action", () => {
  // Written out by hand from the HTTP API table in docs/parol/03, not computed from the table the
  // code uses: every GET in that table is one of the first four, every other row is not a GET.
  const READS: MatterAction[] = ["matter.read", "run.read", "finding.read", "memo.read"];
  const CHANGES: MatterAction[] = [
    "matter.update",
    "member.add",
    "document.write",
    "run.start",
    "run.resume",
    "review.decide",
    "memo.export",
    "feedback.add",
    "matter.delete",
  ];

  it("is every action that is not a read, so a new action is checked too", () => {
    expect([...READS, ...CHANGES].sort()).toEqual([...ALL_ACTIONS].sort());
  });

  it("cannot be bound to GET or HEAD, because those carry no CSRF token", () => {
    const { app } = makeShell();
    for (const action of CHANGES)
      for (const method of ["GET", "HEAD", "get", "head"])
        expect(
          () =>
            defineMatterRoute(app, {
              method: method as RouteMethod,
              path: "/matters/:matterId/runs/start",
              action,
              handler: ok,
            }),
          `${method} ${action}`,
        ).toThrow(TypeError);
    // Nothing was left registered by the refusals.
    expect(describeRoutes(app).filter((route) => route.kind === "matter")).toEqual([]);
  });

  it("can be bound to every other method, where the token is required", () => {
    const { app } = makeShell();
    for (const action of CHANGES)
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
        expect(() =>
          defineMatterRoute(app, {
            method,
            path: `/api/matters/:matterId/${action}/${method}`,
            action,
            handler: ok,
          }),
        ).not.toThrow();
  });

  it("leaves a read free to use GET, and to use POST as well", () => {
    const { app } = makeShell();
    for (const action of READS)
      for (const method of ["GET", "POST"] as const)
        expect(() =>
          defineMatterRoute(app, {
            method,
            path: `/api/matters/:matterId/${action}/${method}`,
            action,
            handler: ok,
          }),
        ).not.toThrow();
  });
});

describe("generic routes that answer matter URLs", () => {
  // None of these has `matters` or `:matterId` in its path, so the check of paths cannot see them,
  // yet each answers /matters/<id> and /api/matters/<id> without any authorization.
  const generic: Record<string, (app: Hono) => void> = {
    "a two-parameter route": (app) => app.get("/:area/:id", (c) => c.text("UNGUARDED")),
    "a three-parameter route": (app) => app.get("/:a/:b/:c", (c) => c.text("UNGUARDED")),
    "a deeper parameter route under the API": (app) =>
      app.post("/api/:area/:id/:what", (c) => c.text("UNGUARDED")),
    "a catch-all": (app) => app.get("*", (c) => c.text("UNGUARDED")),
    "a catch-all under the API": (app) => app.get("/api/*", (c) => c.text("UNGUARDED")),
    "a catch-all for writes": (app) => app.post("*", (c) => c.text("UNGUARDED")),
    "app.all with parameters": (app) => app.all("/:area/:id", (c) => c.text("UNGUARDED")),
    "a route declared with defineRoute": (app) =>
      defineRoute(app, { method: "GET", path: "/:area/:id", access: "public", handler: ok }),
    "a route declared as needing a person": (app) =>
      defineRoute(app, {
        method: "DELETE",
        path: "/api/:area/:id",
        access: "principal",
        handler: ok,
      }),
  };

  for (const [label, add] of Object.entries(generic))
    it(`is found: ${label}`, () => {
      const { app } = makeShell();
      add(app);
      const found = findMatterUrlsWithoutGuard(app);
      expect(found.length, label).toBeGreaterThan(0);
      // It names a concrete URL and what answered it, and never a value taken from a request.
      expect(found.every((line) => /^[A-Z]+ \/\S* answered by [A-Z]+ \S+$/.test(line))).toBe(true);
    });

  it("really does answer an anonymous request, which is what the check is for", async () => {
    const { app } = makeShell();
    app.get("/:area/:id", (c) => c.text(`UNGUARDED ${c.req.param("area")}`));
    const response = await app.request("/matters/m_probe");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("UNGUARDED matters");
    expect(findUnguardedMatterRoutes(app)).toEqual([]);
    expect(findMatterUrlsWithoutGuard(app).length).toBeGreaterThan(0);
  });

  it("is not triggered by global middleware, which every request passes through", () => {
    const { app } = makeShell();
    app.use("*", async (_c, next) => next());
    app.use("/*", async (_c, next) => next());
    app.use("/api/*", async (_c, next) => next());
    app.all("/api/*", async (_c, next) => next());
    defineMatterRoute(app, {
      method: "GET",
      path: "/matters/:matterId/documents",
      action: "matter.read",
      handler: ok,
    });
    expect(findMatterUrlsWithoutGuard(app)).toEqual([]);
  });

  it("is not triggered by routes that cannot answer a matter URL", () => {
    const { app } = makeShell();
    defineRoute(app, { method: "GET", path: "/api/playbooks", access: "principal", handler: ok });
    defineRoute(app, {
      method: "GET",
      path: "/api/playbooks/:slug",
      access: "principal",
      handler: ok,
    });
    defineRoute(app, { method: "GET", path: "/matters", access: "principal", handler: ok });
    defineRoute(app, { method: "POST", path: "/matters", access: "principal", handler: ok });
    defineRoute(app, { method: "GET", path: "/matters/new", access: "principal", handler: ok });
    expect(findMatterUrlsWithoutGuard(app)).toEqual([]);
  });

  it("depends on order: the first handler to match decides, as it does when a request arrives", () => {
    // A guard registered first answers its own URL, so a generic route after it is not reached
    // for that URL (it is still found for the URLs the guard does not cover).
    const after = makeShell().app;
    defineMatterRoute(after, {
      method: "GET",
      path: "/matters/:matterId/documents",
      action: "matter.read",
      handler: ok,
    });
    after.get("/:a/:b/:c", (c) => c.text("UNGUARDED"));
    const found = findMatterUrlsWithoutGuard(after);
    expect(found.some((line) => line.includes("/documents"))).toBe(false);
    expect(found.some((line) => line.startsWith("GET /matters/"))).toBe(true);

    // Registered before the guard, the generic route answers the guard's own URL.
    const before = makeShell().app;
    before.get("/:a/:b/:c", (c) => c.text("UNGUARDED"));
    defineMatterRoute(before, {
      method: "GET",
      path: "/matters/:matterId/documents",
      action: "matter.read",
      handler: ok,
    });
    expect(
      findMatterUrlsWithoutGuard(before).some((line) =>
        line.startsWith("GET /matters/probe/documents answered by GET /:a/:b/:c"),
      ),
    ).toBe(true);
  });

  it("does not freeze the application: routes can still be added after it has been asked", async () => {
    const { app } = makeShell();
    expect(findMatterUrlsWithoutGuard(app)).toEqual([]);
    defineMatterRoute(app, {
      method: "GET",
      path: "/matters/:matterId/later",
      action: "matter.read",
      handler: ok,
    });
    expect(findMatterUrlsWithoutGuard(app)).toEqual([]);
    expect((await app.request("/matters/m_x/later")).status).toBe(303);
  });

  it("covers a mounted sub-application", () => {
    const { app } = makeShell();
    const sub = new Hono();
    sub.get("/:area/:id", (c) => c.text("UNGUARDED"));
    app.route("/api", sub);
    expect(findMatterUrlsWithoutGuard(app).length).toBeGreaterThan(0);
  });
});

describe("mounted sub-applications", () => {
  it("are covered: a guarded route is accepted under a prefix and a plain one is found", () => {
    const { app } = makeShell();
    const good = new Hono();
    defineMatterRoute(good, {
      method: "GET",
      path: "/matters/:matterId/things",
      action: "matter.read",
      handler: ok,
    });
    app.route("/api", good);
    expect(findUnguardedMatterRoutes(app)).toEqual([]);

    const bad = new Hono();
    bad.get("/matters/:matterId/things", (c) => c.text("x"));
    app.route("/pages", bad);
    expect(findUnguardedMatterRoutes(app)).toEqual(["GET /pages/matters/:matterId/things"]);
  });

  it("are covered when the sub-application has an error handler of its own", () => {
    const { app } = makeShell();
    const sub = new Hono();
    sub.onError((_err, c) => c.text("sub error", 500));
    defineMatterRoute(sub, {
      method: "GET",
      path: "/matters/:matterId/things",
      action: "matter.read",
      handler: ok,
    });
    sub.get("/matters/:matterId/leak", (c) => c.text("x"));
    app.route("/", sub);
    expect(findUnguardedMatterRoutes(app)).toEqual(["GET /matters/:matterId/leak"]);
  });
});

describe("what counts as a matter path", () => {
  const matterPaths = [
    "/matters/:matterId",
    "/matters/:matterId/documents",
    "/api/matters/:matterId/spans/:spanId",
    "/matters/:id",
    "/matters/*",
    "/api/matters/*",
    "/matters/:matterId{[a-z]+}",
    "/v2/matters/:id/x",
    "/export/:matterId",
  ];
  const otherPaths = [
    "/",
    "/matters",
    "/matters/",
    "/matters/new",
    "/api/matters",
    "/api/playbooks",
    "/api/playbooks/:slug/versions",
    "/healthz",
    "/assets/:name",
    "/session",
    "/session/end",
    "*",
    "/*",
  ];
  for (const path of matterPaths)
    it(`treats ${path} as reaching a matter`, () => expect(isMatterScopedPath(path)).toBe(true));
  for (const path of otherPaths)
    it(`does not treat ${path} as reaching a matter`, () =>
      expect(isMatterScopedPath(path)).toBe(false));
});

// ---------------------------------------------------------------------------------------------
// Routes that name no matter and are gated by a global role
// ---------------------------------------------------------------------------------------------

describe("a route with a global action", () => {
  // Written out by hand from the plan (PLAN 1.4 P0.A item 1), not computed from the table the code
  // uses. A read is a GET that carries no token; every other action changes state.
  const EXPECTED_ROLES: Record<GlobalAction, readonly string[]> = {
    "evaluation.read": ["legal_engineer", "admin"],
    "pilot.read": ["legal_engineer", "admin"],
    "pilot.manage": ["legal_engineer", "admin"],
    "audit.read": ["admin"],
    "training.key": ["legal_engineer", "admin"],
  };
  const READS: GlobalAction[] = ["evaluation.read", "pilot.read", "audit.read", "training.key"];
  const CHANGES: GlobalAction[] = ["pilot.manage"];
  const ACTIONS = Object.keys(EXPECTED_ROLES) as GlobalAction[];
  // The demo users: the associate and the reviewer are members, the engineer and the admin are not.
  const PEOPLE = [
    { name: "associate", user: USERS.associate, role: "member" },
    { name: "reviewer", user: USERS.reviewer, role: "member" },
    { name: "legal engineer", user: USERS.engineer, role: "legal_engineer" },
    { name: "admin", user: USERS.admin, role: "admin" },
  ] as const;

  /** A throwaway shell with, for every action, a page GET (reads), a page POST and a JSON POST. */
  function gatedShell() {
    const shell = makeShell();
    const calls: string[] = [];
    for (const action of ACTIONS) {
      const handler = (c: { json: (x: unknown) => Response }): Response => {
        calls.push(action);
        return c.json({ ok: true, action });
      };
      if (READS.includes(action))
        defineRoute(shell.app, {
          method: "GET",
          path: `/__test/global/${action}`,
          access: "principal",
          globalAction: action,
          handler,
        });
      defineRoute(shell.app, {
        method: "POST",
        path: `/api/__test/global/${action}`,
        access: "principal",
        globalAction: action,
        handler,
      });
      defineRoute(shell.app, {
        method: "POST",
        path: `/__test/global/${action}`,
        access: "principal",
        globalAction: action,
        handler,
      });
    }
    return { shell, calls };
  }

  it("classifies every action as a read or as a change, and READ_ONLY_GLOBAL_ACTIONS is the reads", () => {
    expect([...READS, ...CHANGES].sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(GLOBAL_ACTIONS).sort()).toEqual([...ACTIONS].sort());
    expect([...READ_ONLY_GLOBAL_ACTIONS].sort()).toEqual([...READS].sort());
  });

  it("is recorded with its global action, and every other kind of route records none", () => {
    const { shell } = gatedShell();
    defineRoute(shell.app, { method: "GET", path: "/open", access: "principal", handler: ok });
    defineRoute(shell.app, { method: "GET", path: "/public", access: "public", handler: ok });
    defineMatterRoute(shell.app, {
      method: "GET",
      path: "/matters/:matterId/seen",
      action: "matter.read",
      handler: ok,
    });
    const routes = describeRoutes(shell.app);
    for (const action of ACTIONS) {
      const found = routes.filter((r) => r.path.endsWith(`/__test/global/${action}`));
      expect(found.length, action).toBe(READS.includes(action) ? 3 : 2);
      for (const route of found) {
        expect(route.kind).toBe("principal");
        expect(route.globalAction).toBe(action);
        expect(route.action).toBeNull();
      }
    }
    const others = routes.filter((r) => !r.path.includes("/__test/global/"));
    expect(others.length).toBeGreaterThan(4);
    for (const route of others)
      expect(route.globalAction, `${route.method} ${route.path}`).toBeNull();
    expect(others.some((r) => r.kind === "middleware")).toBe(true);
    expect(others.some((r) => r.kind === "matter")).toBe(true);
    // Nothing about a matter changes.
    expect(findUnguardedMatterRoutes(shell.app)).toEqual([]);
    expect(findMatterUrlsWithoutGuard(shell.app)).toEqual([]);
    expect(undeclaredRoutes(shell.app)).toEqual([]);
  });

  it("lets in the roles the table lists and answers 403 to the others, on GET and on POST", async () => {
    const { shell, calls } = gatedShell();
    let expectedCalls = 0;
    for (const person of PEOPLE) {
      const client = await shell.signIn(person.user);
      for (const action of ACTIONS) {
        const allowed = EXPECTED_ROLES[action].includes(person.role);
        const attempts: { label: string; send: () => Promise<Response> }[] = [
          {
            label: `POST /api ${action}`,
            send: () => client.post(`/api/__test/global/${action}`),
          },
          { label: `POST ${action}`, send: () => client.post(`/__test/global/${action}`) },
          ...(READS.includes(action)
            ? [{ label: `GET ${action}`, send: () => client.get(`/__test/global/${action}`) }]
            : []),
        ];
        for (const attempt of attempts) {
          const response = await attempt.send();
          expect(response.status, `${person.name} ${attempt.label}`).toBe(allowed ? 200 : 403);
          if (allowed) expectedCalls += 1;
        }
      }
    }
    // A handler ran only where the guard let the request in.
    expect(calls).toHaveLength(expectedCalls);
    expect(expectedCalls).toBeGreaterThan(20);
  });

  it("answers a person who may not with the fixed 403 of the shell, which says nothing of the action", async () => {
    const { shell } = gatedShell();
    const member = await shell.signIn(USERS.associate);
    const bodies = new Set<string>();
    for (const action of ACTIONS) {
      const response = await member.post(`/api/__test/global/${action}`);
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).not.toContain(action);
      expect(body).not.toContain("legal_engineer");
      bodies.add(body);
    }
    expect([...bodies]).toEqual([
      '{"error":{"kind":"forbidden","message":"You may not do that."}}',
    ]);
  });

  it("sends a visitor to sign in before it says anything about roles, and runs nothing", async () => {
    const { shell, calls } = gatedShell();
    const visitor = shell.anonymous();
    for (const action of ACTIONS) {
      const page = await visitor.post(`/__test/global/${action}`, {}, false);
      expect(page.status, action).toBe(303);
      expect(page.headers.get("location")).toBe("/");
      const api = await visitor.post(`/api/__test/global/${action}`, {}, false);
      expect(api.status, action).toBe(401);
      if (READS.includes(action)) {
        const read = await visitor.get(`/__test/global/${action}`);
        expect(read.status, action).toBe(303);
        expect(read.headers.get("location")).toBe("/");
      }
    }
    expect(calls).toEqual([]);
  });

  it("checks the CSRF token of a write before the global role", async () => {
    const { shell, calls } = gatedShell();
    const kind = async (response: Response): Promise<string> =>
      ((await response.json()) as { error: { kind: string } }).error.kind;
    const member = await shell.signIn(USERS.associate);
    const admin = await shell.signIn(USERS.admin);
    const path = "/api/__test/global/pilot.manage";
    // No token, and a wrong token: the form is refused as a form, for the person who may and the
    // person who may not alike, so a missing token tells no one what their role is.
    for (const client of [member, admin])
      for (const csrf of [false, "not-the-token"] as const) {
        const response = await client.post(path, {}, csrf);
        expect(response.status).toBe(403);
        expect(await kind(response)).toBe("csrf");
      }
    expect(calls).toEqual([]);
    // With the token, the role decides.
    const refused = await member.post(path);
    expect(refused.status).toBe(403);
    expect(await kind(refused)).toBe("forbidden");
    expect((await admin.post(path)).status).toBe(200);
    expect(calls).toEqual(["pilot.manage"]);
  });

  it("decides from the database on every request, so a role changed since sign-in counts at once", async () => {
    const { shell } = gatedShell();
    const person = await shell.signIn(USERS.admin);
    const path = "/__test/global/audit.read";
    expect((await person.get(path)).status).toBe(200);
    const setRole = (role: string): void => {
      shell.repo.db.prepare("UPDATE users SET global_role = ? WHERE id = ?").run(role, USERS.admin);
    };
    setRole("member");
    expect((await person.get(path)).status).toBe(403);
    setRole("legal_engineer");
    expect((await person.get(path)).status).toBe(403);
    expect((await person.get("/__test/global/evaluation.read")).status).toBe(200);
    setRole("admin");
    expect((await person.get(path)).status).toBe(200);
  });

  it("leaves a route with no global action open to every signed-in person", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/__test/open",
      access: "principal",
      handler: (c) => c.text("open"),
    });
    for (const person of PEOPLE)
      expect((await (await shell.signIn(person.user)).get("/__test/open")).status).toBe(200);
  });

  it("cannot be bound to GET or HEAD unless the action only reads, because those carry no token", () => {
    const { shell } = gatedShell();
    const before = describeRoutes(shell.app).length;
    for (const action of CHANGES)
      for (const method of ["GET", "HEAD", "get", "head"])
        expect(
          () =>
            defineRoute(shell.app, {
              method: method as RouteMethod,
              path: "/__test/changes",
              access: "principal",
              globalAction: action,
              handler: ok,
            }),
          `${method} ${action}`,
        ).toThrow(TypeError);
    // Nothing was left registered by the refusals.
    expect(describeRoutes(shell.app)).toHaveLength(before);
  });

  it("can be bound to a write method whatever the action, and to GET when the action only reads", () => {
    const { shell } = gatedShell();
    for (const action of ACTIONS)
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
        expect(() =>
          defineRoute(shell.app, {
            method,
            path: `/__test/more/${action}/${method}`,
            access: "principal",
            globalAction: action,
            handler: ok,
          }),
        ).not.toThrow();
    for (const action of READS)
      expect(() =>
        defineRoute(shell.app, {
          method: "GET",
          path: `/__test/more/${action}`,
          access: "principal",
          globalAction: action,
          handler: ok,
        }),
      ).not.toThrow();
  });

  it("is refused at registration for a public route, an unknown action or a path that reaches a matter", () => {
    const { shell } = gatedShell();
    const before = describeRoutes(shell.app).length;
    const spec = (extra: Record<string, unknown>) =>
      ({
        method: "POST",
        path: "/__test/refused",
        access: "principal",
        handler: ok,
        ...extra,
      }) as unknown as Parameters<typeof defineRoute>[1];
    // A public route that names an action would look gated and be open to everyone.
    expect(() =>
      defineRoute(shell.app, spec({ access: "public", globalAction: "pilot.read" })),
    ).toThrow(TypeError);
    for (const globalAction of ["nothing.read", "", "constructor", "__proto__", 7, null])
      expect(() => defineRoute(shell.app, spec({ globalAction })), String(globalAction)).toThrow(
        TypeError,
      );
    expect(() =>
      defineRoute(shell.app, spec({ path: "/matters/:matterId/x", globalAction: "pilot.read" })),
    ).toThrow(TypeError);
    expect(describeRoutes(shell.app)).toHaveLength(before);
  });
});

describe("pageChrome and the navigation", () => {
  const PEOPLE = [
    { user: USERS.associate, role: "member" },
    { user: USERS.reviewer, role: "member" },
    { user: USERS.engineer, role: "legal_engineer" },
    { user: USERS.admin, role: "admin" },
  ] as const;

  it("carries the global role of the person, read from the database for this request", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/__test/chrome",
      access: "principal",
      handler: (c, principal) => c.json(pageChrome(c, principal)),
    });
    for (const person of PEOPLE) {
      const client = await shell.signIn(person.user);
      const chrome = (await (await client.get("/__test/chrome")).json()) as { globalRole: string };
      expect(chrome.globalRole, person.user).toBe(person.role);
    }
    const admin = await shell.signIn(USERS.admin);
    shell.repo.db.prepare("UPDATE users SET global_role = 'member' WHERE id = ?").run(USERS.admin);
    const demoted = (await (await admin.get("/__test/chrome")).json()) as { globalRole: string };
    expect(demoted.globalRole).toBe("member");
  });

  it("shows a link gated by a global action to the roles the action lists and to no one else", async () => {
    const shell = makeShell();
    defineRoute(shell.app, {
      method: "GET",
      path: "/__test/page",
      access: "principal",
      handler: (c, principal) =>
        c.html(render(Layout({ title: "Page", chrome: pageChrome(c, principal) }))),
    });
    const items = NAV_ITEMS as NavItem[];
    const original = [...items];
    const links = (html: string): string[] =>
      [...html.matchAll(/<li><a href="([^"]+)">([^<]+)<\/a><\/li>/g)].map((m) => m[2] as string);
    const expectedFor = (role: string, action: GlobalAction): boolean =>
      (GLOBAL_ACTIONS[action] as readonly string[]).includes(role);
    try {
      // One item per action, then one that is shown to everyone.
      for (const action of Object.keys(GLOBAL_ACTIONS) as GlobalAction[])
        items.push({ label: `Gate ${action}`, href: `/__test/gate/${action}`, global: action });
      for (const person of PEOPLE) {
        const client = await shell.signIn(person.user);
        const shown = links(await (await client.get("/__test/page")).text());
        // The links the table gives this role among the real ones (some are for everyone, some are
        // gated), then one link for each action this role holds among the test ones.
        const wanted = [
          ...navItemsFor(person.role, original).map((item) => item.label),
          ...(Object.keys(GLOBAL_ACTIONS) as GlobalAction[])
            .filter((action) => expectedFor(person.role, action))
            .map((action) => `Gate ${action}`),
        ];
        expect(shown, person.user).toEqual(wanted);
      }
      // A visitor sees none of the gated links; the page itself is the sign-in page there, so the
      // frame is checked with no role.
      const visitorFrame = render(
        Layout({ title: "Page", chrome: { userName: null, csrfToken: "t" } }),
      );
      expect(links(visitorFrame)).toEqual(
        navItemsFor(undefined, original).map((item) => item.label),
      );
    } finally {
      items.splice(0, items.length, ...original);
    }
  });
});
