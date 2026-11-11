import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { WORKFLOW_FIELD } from "../../src/server/pages/matter.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { urls } from "../../src/server/urls.js";
import { all, attr, hasClass, parseHtml } from "../pages/html.js";
import { attachSpend, reviewBound } from "../usage/spend-support.js";
import {
  Browser,
  IDS,
  OUTSIDER,
  VIEWER,
  cleanup,
  makeSite,
  newMatter,
  uploadCase,
} from "./support.js";

afterAll(cleanup);

/**
 * A review the spend guard refuses is a conflict the person can act on, and it has words of its own
 * (the two limits, the bound that was planned, and what to do). The shell's page for a conflict says
 * only "the matter changed, reload the page", which would be wrong for it. This shows that no route
 * of the application sends a refusal of the guard to that page, in two parts.
 *
 * First, by reading the source: the guard is asked about in two places, the start of a review and the
 * resume of one, both in `services/runs.ts`; those two functions are called from the routes in four
 * places (the page and the JSON API for each); and the two calls of the page routes are the bodies
 * of `answerInPlace`, which answers a refusal on the matter's own page. A fifth place, or a call that
 * is not inside `answerInPlace`, fails the test, so that whoever adds one has to decide how its
 * refusal is shown.
 *
 * Second, by sending the four requests to a server whose guard refuses every review, as every kind
 * of caller: the associate, who may start a review, gets the matter's page with the guard's words (or
 * the JSON error), and no other caller gets as far as the guard (the shell refuses them first, for
 * the role or because the matter is not theirs).
 */

// ---------------------------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------------------------

const SRC = join(import.meta.dirname, "../../src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every file of `src` that holds `pattern`, with the number of matches. */
function where(pattern: RegExp): Record<string, number> {
  const found: Record<string, number> = {};
  for (const path of sourceFiles(SRC)) {
    const count = [...readFileSync(path, "utf8").matchAll(pattern)].length;
    if (count > 0) found[relative(SRC, path)] = count;
  }
  return found;
}

describe("where the spend guard is asked, and where its refusal can go", () => {
  it("is asked about in the start and the resume of a review, and nowhere else", () => {
    expect(where(/\.preflight\(/g)).toEqual({ "services/runs.ts": 2 });
    // And the error is made in the guard only.
    expect(where(/new SpendRefusedError\(/g)).toEqual({ "usage/guard.ts": 2 });
  });

  it("has the two functions called from the routes in four places only", () => {
    // `startRun` (routes/operations.ts) is the one function the routes use to start a review. The
    // demonstration data starts reviews without a request, and is not a route.
    expect(where(/\bruns\.start\(/g)).toEqual({
      "server/routes/operations.ts": 1,
      "seed.ts": 1,
      "demo/pilot-demo.ts": 1,
    });
    expect(where(/\bstartRun\(/g)).toEqual({
      "server/routes/api.ts": 1,
      // The definition.
      "server/routes/operations.ts": 1,
      "server/routes/pages.ts": 1,
    });
    expect(where(/\bruns\.resume\(/g)).toEqual({
      "server/routes/api.ts": 1,
      "server/routes/pages.ts": 1,
    });
  });

  it("calls both from the page routes inside answerInPlace, so a refusal is answered on the matter's page", () => {
    const pages = readFileSync(join(SRC, "server/routes/pages.ts"), "utf8");
    // Each route that calls answerInPlace closes the call at the indent of its handler: six spaces
    // for a handler that is an async function with a block, four for one that is an expression.
    const bodies = [
      ...pages.matchAll(
        /answerInPlace\(c, am, [\s\S]*?\n {6}\}\)|answerInPlace\(c, am, [\s\S]*?\n {4}\}\)/g,
      ),
    ].map((match) => match[0]);
    expect(bodies.length).toBeGreaterThan(10);
    expect(bodies.filter((body) => /\bstartRun\(/.test(body))).toHaveLength(1);
    expect(bodies.filter((body) => /\bruns\.resume\(/.test(body))).toHaveLength(1);
    // And the page routes hold no call of either outside those bodies.
    let outside = pages;
    for (const body of bodies) outside = outside.replace(body, "");
    expect(outside).not.toMatch(/\bstartRun\(|\bruns\.resume\(/);
  });
});

// ---------------------------------------------------------------------------------------------
// The four requests
// ---------------------------------------------------------------------------------------------

const NO_LIMIT_LEFT = { perReviewUsd: 1e-9, perDayUsd: 1e-9 };
const FORM = { "content-type": "application/x-www-form-urlencoded" };

interface Caller {
  name: string;
  userId: string | null;
}
const CALLERS: Caller[] = [
  { name: "the associate", userId: IDS.associate },
  { name: "the reviewing attorney", userId: IDS.reviewer },
  { name: "a viewer", userId: VIEWER },
  { name: "a person outside the matter", userId: OUTSIDER },
  { name: "an administrator", userId: IDS.admin },
  { name: "a visitor", userId: null },
];

describe("the four requests, to a server whose guard refuses every review", () => {
  it("refuses in place on the matter's page, or in JSON, for the associate, and asks the guard about nobody else", async () => {
    const site = makeSite();
    // A review that was made under a guard that let it through, so that the resume has a run of the
    // same provider and model to ask about.
    const open = attachSpend(site.w, site.w.model, {
      limits: { perReviewUsd: reviewBound("v2") * 10, perDayUsd: reviewBound("v2") * 100 },
    });
    const { matterId, am } = newMatter(open);
    await uploadCase(open, matterId);
    const run = open.services.runs.start(am, { workflowLabel: "v2" });
    await open.services.runs.idle();
    // The same store and files, under a guard that refuses every review.
    const refusing = open.restart(NO_LIMIT_LEFT);
    const asked = vi.spyOn(refusing.guard, "preflight");
    const deps = { ...site.deps, services: refusing.services };
    const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
    registerRoutes(app, deps);

    const requests = [
      {
        route: "POST /matters/:matterId/runs",
        send: async (b: Browser) =>
          b.send("POST", urls.runs(matterId), {
            headers: FORM,
            body: new URLSearchParams({
              _csrf: await b.apiToken(),
              [WORKFLOW_FIELD]: "v2",
            }).toString(),
          }),
      },
      {
        route: "POST /matters/:matterId/runs/:runId/resume",
        send: async (b: Browser) =>
          b.send("POST", urls.runResume(matterId, run.id), {
            headers: FORM,
            body: new URLSearchParams({ _csrf: await b.apiToken() }).toString(),
          }),
      },
      {
        route: "POST /api/matters/:matterId/runs",
        send: (b: Browser) => b.api("POST", `/api/matters/${matterId}/runs`, { workflow: "v2" }),
      },
      {
        route: "POST /api/matters/:matterId/runs/:runId/resume",
        send: (b: Browser) => b.api("POST", `/api/matters/${matterId}/runs/${run.id}/resume`),
      },
    ];

    for (const caller of CALLERS) {
      const browser = new Browser(app);
      if (caller.userId !== null) await browser.signIn(caller.userId);
      for (const request of requests) {
        const before = asked.mock.calls.length;
        const response = await request.send(browser);
        const reachedTheGuard = asked.mock.calls.length > before;
        const here = `${caller.name}: ${request.route}`;
        if (caller.userId !== IDS.associate) {
          // Refused by the shell before the guard: the role, or a matter that is not theirs, or no
          // session. Never 409, which is what a refusal of the guard would be.
          expect(reachedTheGuard, here).toBe(false);
          expect(response.status, here).not.toBe(409);
          await response.arrayBuffer();
          continue;
        }
        expect(reachedTheGuard, here).toBe(true);
        expect(response.status, here).toBe(409);
        if (request.route.includes("/api/")) {
          const body = (await response.json()) as { error: { kind: string; message: string } };
          expect(body.error.kind, here).toBe("spend_refused");
          expect(body.error.message, here).toMatch(/limit/);
          continue;
        }
        const html = await response.text();
        const root = parseHtml(html);
        const alerts = all(root, (el) => attr(el, "role") === "alert");
        expect(alerts, here).toHaveLength(1);
        // The notice of the matter's page, not the shell's error page for a conflict.
        expect(hasClass(alerts[0]!, "notice-error"), here).toBe(true);
        expect(
          all(root, (el) => hasClass(el, "error-page")),
          here,
        ).toEqual([]);
        expect(html, here).toMatch(/could cost up to \$/);
        expect(html, here).not.toContain(
          "The matter changed, or the request does not fit its state",
        );
        expect(html, here).toContain(`action="${urls.runs(matterId)}"`);
      }
    }
  });
});
