import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import { MODE_WORDS, pageFileName } from "../../src/evaluations/index.js";
import { createApp } from "../../src/server/app.js";
import { describeRoutes } from "../../src/server/matter-route.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { createEvaluationService, type EvaluationService } from "../../src/services/evaluations.js";
import { urls } from "../../src/server/urls.js";
import { CASE_KEY, PRINCIPALS, comparisonPage, heldoutBody } from "../evaluations/fixtures.js";
import { memorySource } from "../evaluations/render.js";
import { all, attr, byTag, readable, type El } from "../pages/html.js";
import {
  Browser,
  IDS,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  type Site,
} from "./support.js";

/**
 * Spies that pass every call through. They exist so that a test can say that the disk was not
 * touched for a request that was refused or malformed.
 */
const spies = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const spy =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      spies.calls.push(name);
      return fn(...args);
    };
  return {
    ...actual,
    lstatSync: spy("lstatSync", actual.lstatSync),
    openSync: spy("openSync", actual.openSync),
    readdirSync: spy("readdirSync", actual.readdirSync),
    readFileSync: spy("readFileSync", actual.readFileSync),
  };
});

/**
 * `GET /evaluations`, through the real shell and the real routes over a folder of published
 * comparisons. The legal engineer and the administrator are let in; a member is refused with the
 * shell's own 403; a visitor is sent to sign in. The route reads files and changes nothing, so no
 * other method exists on the URL.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let root: string;
let folder: string;
let site: Site;
const simulated = comparisonPage();
const withHeldout = comparisonPage(heldoutBody(), "heldout");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "parol-eval-routes-"));
  folder = join(root, "evaluations");
  mkdirSync(folder);
  for (const page of [simulated, withHeldout])
    writeFileSync(join(folder, pageFileName(page.id)), JSON.stringify(page));
  site = makeSite({ evaluations: folder });
});

afterAll(() => {
  cleanup();
  rmSync(root, { recursive: true, force: true });
});

const MEMBERS = [
  ["the associate", IDS.associate],
  ["the reviewer", IDS.reviewer],
  ["the viewer", VIEWER],
  ["the outsider", OUTSIDER],
] as const;

const reads = (): number => spies.calls.length;
const bodyOf = async (response: Response): Promise<string> => response.text();

describe("who may open the page", () => {
  for (const [who, userId] of [
    ["the legal engineer", IDS.legalEngineer],
    ["the administrator", IDS.admin],
  ] as const)
    it(`lets in ${who}, to the list and to a comparison`, async () => {
      const browser = await site.as(userId);
      const list = await browser.page(urls.evaluations());
      expect(list.html).toContain("Published comparisons");
      expect(list.html).toContain(simulated.id.slice(0, 12));
      expect(list.html).toContain(withHeldout.id.slice(0, 12));
      const one = await browser.page(urls.evaluations({ comparison: simulated.id }));
      expect(one.html).toContain("Compare workflow versions");
      expect(one.html).toContain(MODE_WORDS.simulated);
      // The page is a well-formed page of the application like any other.
      expect(attr(byTag(one.root, "main")[0] as El, "id")).toBe("main");
    });

  for (const [who, userId] of MEMBERS)
    it(`refuses ${who}, a member, with the shell's 403 and nothing of the page`, async () => {
      const browser = await site.as(userId);
      const before = reads();
      for (const url of [
        urls.evaluations(),
        urls.evaluations({ comparison: simulated.id }),
        urls.evaluations({ comparison: "cmp_0000000000000000" }),
        "/evaluations?comparison=../x",
      ]) {
        const response = await browser.get(url);
        expect(response.status, url).toBe(403);
        const body = await bodyOf(response);
        expect(body).not.toContain(simulated.id);
        expect(body).not.toContain("Published comparisons");
        expect(body).not.toContain("Compare workflow versions");
      }
      // The guard answered before the handler: no folder was listed and no file read.
      expect(reads()).toBe(before);
    });

  it("gives every member the same body, and a missing comparison the same 403 as a published one", async () => {
    const bodies = new Set<string>();
    for (const [, userId] of MEMBERS) {
      const browser = await site.as(userId);
      for (const id of [simulated.id, "cmp_0000000000000000", "nonsense"])
        bodies.add(await bodyOf(await browser.get(`/evaluations?comparison=${id}`)));
      bodies.add(await bodyOf(await browser.get(urls.evaluations())));
    }
    expect(bodies.size).toBe(1);
    // The words of the 403 page are the shell's (and W2.9 may change them); what matters here is
    // that it is one page whatever was asked for, and says nothing of what the folder holds.
    const [body] = [...bodies];
    expect(body).toContain("<h1>");
    expect(body).not.toContain("cmp_");
  });

  it("sends a visitor to sign in, and reads nothing", async () => {
    const visitor = site.anonymous();
    const before = reads();
    for (const url of [urls.evaluations(), urls.evaluations({ comparison: simulated.id })]) {
      const response = await visitor.get(url);
      expect(response.status, url).toBe(303);
      expect(response.headers.get("location")).toBe("/");
    }
    expect(reads()).toBe(before);
  });

  it("checks the global role as the database has it for this request, not as a cookie says", async () => {
    const browser = await site.as(IDS.associate);
    expect((await browser.get(urls.evaluations())).status).toBe(403);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'legal_engineer' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.evaluations())).status).toBe(200);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'member' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.evaluations())).status).toBe(403);
  });
});

describe("the route's own guard", () => {
  /**
   * The same application, but with an evaluation service that answers anyone who asks (it is given
   * the administrator's principal whoever the caller is). The service checks the role too, so a
   * member is refused twice over; this takes the second away to show that the route refuses first.
   */
  function appWhoseServiceAnswersAnyone() {
    const asked: string[] = [];
    const inner = createEvaluationService(memorySource([simulated]));
    const evaluations: EvaluationService = {
      list: () => {
        asked.push("list");
        return inner.list(PRINCIPALS.admin);
      },
      comparison: (_principal, query) => {
        asked.push("comparison");
        return inner.comparison(PRINCIPALS.admin, query);
      },
    };
    const deps = { ...site.deps, services: { ...site.deps.services, evaluations } };
    const app = createApp(deps, { log: () => undefined, renderError: renderErrorPage });
    registerRoutes(app, deps);
    return { app, asked };
  }

  it("refuses a member before the handler and the service are reached, and lets the others in to both", async () => {
    const { app, asked } = appWhoseServiceAnswersAnyone();
    for (const [, userId] of MEMBERS) {
      const browser = new Browser(app);
      await browser.signIn(userId);
      for (const url of [urls.evaluations(), urls.evaluations({ comparison: simulated.id })])
        expect((await browser.get(url)).status, `${userId} ${url}`).toBe(403);
    }
    expect(asked).toEqual([]);
    for (const userId of [IDS.legalEngineer, IDS.admin]) {
      const browser = new Browser(app);
      await browser.signIn(userId);
      expect((await browser.get(urls.evaluations())).status).toBe(200);
      expect((await browser.get(urls.evaluations({ comparison: simulated.id }))).status).toBe(200);
    }
    expect(asked).toEqual(["list", "comparison", "list", "comparison"]);
  });
});

describe("what the query selects", () => {
  const MALFORMED = [
    "../x",
    "cmp_" + "0".repeat(15),
    "cmp_" + "0".repeat(17),
    "CMP_0123456789abcdef",
    "cmp_0123456789ABCDEF",
    "x".repeat(65),
    "",
    "cmp_0123456789abcdef.json",
    "cmp_0123456789abcdef%00",
  ];

  it("answers an id that is malformed, and an id that names nothing, with the same 404", async () => {
    const browser = await site.as(IDS.legalEngineer);
    const unknown = await browser.get("/evaluations?comparison=cmp_ffffffffffffffff");
    expect(unknown.status).toBe(404);
    const reference = await bodyOf(unknown);
    for (const id of MALFORMED) {
      const response = await browser.get(`/evaluations?comparison=${encodeURIComponent(id)}`);
      expect(response.status, id).toBe(404);
      expect(await bodyOf(response), id).toBe(reference);
    }
    expect(reference).not.toContain("cmp_ffffffffffffffff");
    // An id given twice is not one id, even when each is a published page.
    const twice = await browser.get(
      `/evaluations?comparison=${simulated.id}&comparison=${withHeldout.id}`,
    );
    expect(twice.status).toBe(404);
    expect(await bodyOf(twice)).toBe(reference);
  });

  it("does not touch the disk for an id that is not shaped like one", async () => {
    const browser = await site.as(IDS.legalEngineer);
    for (const id of MALFORMED) {
      const before = reads();
      const response = await browser.get(`/evaluations?comparison=${encodeURIComponent(id)}`);
      expect(response.status, id).toBe(404);
      expect(reads(), id).toBe(before);
    }
    // A well-formed id does read the folder.
    const before = reads();
    expect((await browser.get(urls.evaluations({ comparison: simulated.id }))).status).toBe(200);
    expect(reads()).toBeGreaterThan(before);
  });

  it("falls back to the first section for a split the document does not hold, without echoing it", async () => {
    const browser = await site.as(IDS.legalEngineer);
    const page = await browser.page(
      "/evaluations?comparison=" + simulated.id + "&split=%3Cb%3Ex%3C%2Fb%3E",
    );
    expect(page.html).not.toContain("<b>x</b>");
    expect(page.html).not.toContain("&lt;b&gt;x");
    const heldout = await browser.page(
      urls.evaluations({ comparison: withHeldout.id, split: "heldout" }),
    );
    expect(heldout.html).toContain("Sealed");
    const dev = await browser.page(urls.evaluations({ comparison: withHeldout.id, split: "dev" }));
    expect(dev.html).not.toContain("Sealed");
  });

  it("opens a changed slot's trail, and answers a slot that did not change with the page and a message", async () => {
    const browser = await site.as(IDS.legalEngineer);
    const trail = await browser.page(
      urls.evaluations({ comparison: simulated.id, caseKey: CASE_KEY, ruleKey: "dur-1" }),
    );
    expect(readable(byTag(trail.root, "h2").find((h) => attr(h, "id") === "trail") as El)).toBe(
      "Evidence trail for PAROL-D05 dur-1",
    );
    const missing = await browser.page(
      "/evaluations?comparison=" +
        simulated.id +
        "&case=PAROL-D05&rule=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    );
    expect(missing.html).toContain(
      "That slot is not among the slots that changed in this comparison.",
    );
    expect(missing.html).not.toContain("alert(1)");
    expect(missing.response.status).toBe(200);
    const half = await browser.page(`/evaluations?comparison=${simulated.id}&case=PAROL-D05`);
    expect(half.html).toContain("That slot is not among the slots that changed");
  });

  it("shows the empty page for a folder that does not exist, and for one with nothing in it", async () => {
    for (const evaluations of [join(root, "nowhere"), mkdtempSync(join(root, "empty-"))]) {
      const empty = makeSite({ evaluations });
      const browser = await empty.as(IDS.admin);
      const page = await browser.page(urls.evaluations());
      expect(page.html).toContain("No comparison has been published to this application.");
      expect((await browser.get(urls.evaluations({ comparison: simulated.id }))).status).toBe(404);
    }
  });

  it("shows the empty page for a site given no folder at all", async () => {
    const bare = makeSite();
    const browser = await bare.as(IDS.legalEngineer);
    expect((await browser.page(urls.evaluations())).html).toContain(
      "No comparison has been published",
    );
  });

  it("lists a file that cannot be used, and goes on", async () => {
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, pageFileName(simulated.id)), JSON.stringify(simulated));
    writeFileSync(join(broken, "cmp_aaaaaaaaaaaaaaaa.json"), "{");
    const browser = await makeSite({ evaluations: broken }).as(IDS.legalEngineer);
    const page = await browser.page(urls.evaluations());
    expect(page.html).toContain("cmp_aaaaaaaaaaaaaaaa.json");
    expect(page.html).toContain("Not JSON");
    expect(page.html).toContain(simulated.id.slice(0, 12));
  });
});

describe("the page changes nothing", () => {
  it("has no route under /evaluations but the one GET, and that route names its global action", () => {
    const routes = describeRoutes(site.app).filter((r) => r.path.startsWith("/evaluations"));
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /evaluations"]);
    const [route] = routes;
    expect(route?.kind).toBe("principal");
    expect(route?.globalAction).toBe("evaluation.read");
    expect(Object.keys(GLOBAL_ACTIONS)).toContain("evaluation.read");
    expect(GLOBAL_ACTIONS["evaluation.read"]).toEqual(["legal_engineer", "admin"]);
    // Nor a route under a longer path, or a wildcard that would answer it.
    const everything = describeRoutes(site.app).filter(
      (r) => r.method !== "GET" && (r.path.includes("evaluations") || r.path.endsWith("*")),
    );
    expect(everything.filter((r) => r.kind !== "middleware")).toEqual([]);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    it(`answers ${method} with the 404 of any URL nothing owns, and changes nothing`, async () => {
      const browser = await site.as(IDS.admin);
      const token = await browser.apiToken();
      const before = fingerprint(site);
      const reference = await browser.send(method, "/no-page-owns-this", {
        headers: { "x-csrf-token": token },
      });
      expect(reference.status).toBe(404);
      const referenceBody = await bodyOf(reference);
      for (const url of [
        "/evaluations",
        `/evaluations?comparison=${simulated.id}`,
        "/evaluations/anything",
      ])
        for (const headers of [{}, { "x-csrf-token": token }]) {
          const response = await browser.send(method, url, { headers });
          expect(response.status, `${method} ${url}`).toBe(404);
          expect(await bodyOf(response), `${method} ${url}`).toBe(referenceBody);
        }
      expect(fingerprint(site)).toEqual(before);
    });

  it("writes no audit event and leaves the folder as it was", async () => {
    const browser = await site.as(IDS.legalEngineer);
    const before = fingerprint(site);
    const files = readdirSync(folder).sort();
    const bytes = files.map((name) => readFileSync(join(folder, name), "utf8"));
    await browser.get(urls.evaluations());
    await browser.get(
      urls.evaluations({ comparison: simulated.id, caseKey: CASE_KEY, ruleKey: "dur-1" }),
    );
    expect(fingerprint(site)).toEqual(before);
    expect(readdirSync(folder).sort()).toEqual(files);
    expect(files.map((name) => readFileSync(join(folder, name), "utf8"))).toEqual(bytes);
  });
});

describe("the navigation", () => {
  it("shows the Evaluations link to the roles that may open the page, and to no one else", async () => {
    const links = async (userId: string): Promise<string[]> => {
      const page = await (await site.as(userId)).page(urls.matters());
      const nav = all(
        page.root,
        (el) => el.name === "nav" && attr(el, "aria-label") === "Primary",
      )[0] as El;
      return all(nav, (el) => el.name === "a").map((a) => readable(a));
    };
    expect(await links(IDS.legalEngineer)).toContain("Evaluations");
    expect(await links(IDS.admin)).toContain("Evaluations");
    expect(await links(IDS.associate)).not.toContain("Evaluations");
    expect(await links(IDS.reviewer)).not.toContain("Evaluations");
    expect(await links(VIEWER)).not.toContain("Evaluations");
  });
});

describe("the code behind the page", () => {
  const SRC = join(import.meta.dirname, "../../src");
  const evaluationFiles = [
    ...readdirSync(join(SRC, "evaluations")).map((name) => join(SRC, "evaluations", name)),
    join(SRC, "services/evaluations.ts"),
    join(SRC, "server/routes/evaluations.ts"),
    join(SRC, "server/pages/evaluations.tsx"),
  ];

  it("is found", () => {
    expect(evaluationFiles.map((p) => p.slice(SRC.length + 1)).sort()).toEqual([
      "evaluations/document.ts",
      "evaluations/draft.ts",
      "evaluations/index.ts",
      "evaluations/source.ts",
      "evaluations/words.ts",
      "server/pages/evaluations.tsx",
      "server/routes/evaluations.ts",
      "services/evaluations.ts",
    ]);
  });

  it("imports nothing from the store but its error classes, and no repository module", () => {
    for (const path of evaluationFiles) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/from "([^"]+)"/g)) {
        const spec = m[1] as string;
        if (/store\//.test(spec)) expect(spec, path).toMatch(/store\/errors\.js$/);
        expect(spec, path).not.toMatch(/repo-|\/db\.js|store\/index\.js|store\/repo/);
      }
    }
  });

  it("never holds a repository: the service is built from a source and the route reads services only", () => {
    const service = readFileSync(join(SRC, "services/evaluations.ts"), "utf8");
    expect(service).toMatch(/createEvaluationService\(source: ComparisonSource\)/);
    expect(service).not.toMatch(/\brepo\b|Repository/);
    const route = readFileSync(join(SRC, "server/routes/evaluations.ts"), "utf8");
    expect(route).not.toMatch(/\.repo\b|\bdeps\.files\b/);
    expect(route).toContain("deps.services");
  });
});
