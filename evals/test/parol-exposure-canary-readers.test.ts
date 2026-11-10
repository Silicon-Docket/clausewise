import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_USER_IDS } from "../../apps/parol/src/store/index.js";
import {
  runCanaryScan,
  type CanaryHooks,
  type CanaryResult,
} from "../src/parol/exposure/canary.js";
import { MATTER_PROBES, OTHER_PROBES } from "../src/parol/exposure/probes.js";
import { createScanner } from "../src/parol/exposure/scan.js";
import type { Dataset } from "../src/parol/dataset.js";
import { expectedBodies } from "./parol-canary-support.js";
import {
  CANARY_SHAPE,
  completeDataset,
  DASHES,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * Who the canary scan reads as, and which routes it reads. A hole that only a global role, an
 * anonymous client, the canary matter's reviewer, or a route outside the matter routes can reach is
 * planted in a copy of the application that exists for the test, and the scan has to count it.
 * Nothing is planted in the real application, which gives zero (parol-exposure.test.ts).
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type BeforeRoutes = NonNullable<CanaryHooks["beforeRoutes"]>;

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const scan = (hooks?: CanaryHooks): Promise<CanaryResult> =>
  runCanaryScan({
    dataset,
    root: ROOT,
    playbook,
    signal: never(),
    ...(hooks === undefined ? {} : { hooks }),
  });

const CANARY_ASSOCIATE = "usr_exposure_bramblewick_associate";
const CANARY_REVIEWER = "usr_exposure_bramblewick_reviewer";

const labelsOf = (result: CanaryResult, token?: "canary" | "id"): string[] =>
  result.hits.filter((hit) => token === undefined || hit.token === token).map((hit) => hit.label);

describe("the real application", () => {
  let result: CanaryResult;
  let findings = 0;
  beforeAll(async () => {
    result = await scan({
      afterReview: (site, context) => {
        findings = (
          site.repo.db
            .prepare("SELECT COUNT(*) AS n FROM findings WHERE matter_id = ?")
            .get(context.caseMatterId) as { n: number }
        ).n;
      },
    });
  });

  it("gives zero, out of the bodies of all eight readers", () => {
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.readers).toEqual([
      "associate",
      "reviewer",
      "viewer",
      "canary associate",
      "canary reviewer",
      "administrator",
      "legal engineer",
      "anonymous",
    ]);
    // Each of the 8 readers fetches every route it can name, a route that takes a finding id once
    // for each finding of the case: readers times routes, and not a figure above which it passes.
    expect(findings).toBeGreaterThan(0);
    expect(result.byKind.http_body).toBe(expectedBodies({ canaryMatters: 1, findings }));
    expect(result.artefactsScanned).toBe(Object.values(result.byKind).reduce((a, b) => a + b, 0));
  });

  it("fetches every GET route of the probe tables, and says how many", () => {
    const templates = new Set(
      [...MATTER_PROBES, ...OTHER_PROBES]
        .filter((probe) => probe.method === "GET")
        .map((probe) => probe.template),
    );
    expect(result.routesFetched).toBe(templates.size);
    expect(templates).toContain("/api/session");
    expect(templates).toContain("/healthz");
    expect(templates).toContain("/assets/:name");
    expect(result.sentence).toContain(`all ${templates.size} GET routes`);
  });

  it("says in its sentence who read, what was held to what, what was checked, and what it cannot see", () => {
    const { sentence } = result;
    expect(sentence).not.toContain("every role");
    expect(sentence).toContain(
      "the case's associate, reviewer and viewer, the canary matter's associate and reviewer, the global administrator, the legal engineer and an anonymous client",
    );
    expect(sentence).toMatch(/held to nothing of either matter/);
    expect(sentence).toMatch(/not a language model/);
    expect(sentence).toMatch(/nothing is sent anywhere/);
    expect(sentence).toMatch(/Before counting, the scanner found every planted string and id/);
    expect(sentence).toMatch(
      /Not seen: text of the other matter without a canary string, id or name/,
    );
    expect(sentence).toMatch(/its members on the HTML pages/);
    expect(sentence).toMatch(/ids in prompts and answers \(the model is shown clause labels\)/);
    expect(sentence).toMatch(/response headers/);
    expect(sentence).toMatch(/query variants/);
    expect(sentence).toMatch(/wildcard handlers beyond one GET to one URL each, and runs/);
    expect(sentence).not.toMatch(/beyond one request each/);
    expect(sentence).toMatch(/of the canary matter \(it is never reviewed\)/);
  });

  it("says what was fetched, no more than the tables name, and for which side each artefact was searched", () => {
    const { sentence } = result;
    // The routes are the ones the probe tables name, and the claim is not that the application was checked.
    expect(sentence).not.toContain("checked against its own route list");
    expect(sentence).toContain(
      `GET routes the probe tables name (a GET route outside them stops the suite; the two static pages once, anonymously) were fetched as`,
    );
    // What the artefacts were searched for, and what the canary matter's own rows and pages were.
    expect(sentence).toMatch(
      /were scanned for the 4 canary strings and the ids and names of the other matter \(the canary matter's own rows and pages: for the case's ids and names only; its members on the JSON routes\): 0 canary strings and 0 foreign ids or names found/,
    );
  });

  it("writes a sentence the results file can hold: one line, 2000 characters at most, no dash", () => {
    expect(result.sentence.length).toBeLessThan(2000);
    expect(result.sentence).not.toContain("\n");
    expect(result.sentence).toMatch(/\.$/);
    expect(result.sentence).not.toMatch(DASHES);
    expect(result.sentence).not.toMatch(CANARY_SHAPE);
    expect(result.sentence).not.toMatch(ID_SHAPE);
  });

  it("reports the sightings of the distinctive fact as a number that is not a hit", () => {
    expect(result.factSightings).toBe(0);
    expect(result.cases.every((entry) => typeof entry.factSightings === "number")).toBe(true);
  });
});

describe("a route that no probe table lists", () => {
  it("stops the scan when the application has a GET route the scan would not fetch", async () => {
    const failure = await scan({
      beforeRoutes: (app) => void app.get("/api/extra-list", (c) => c.json({ matters: [] })),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureSuiteUnavailable" });
    expect((failure as Error).message).toContain("GET /api/extra-list");
  });

  it("stops the scan for a route registered for every method, which answers a GET too", async () => {
    const failure = await scan({
      beforeRoutes: (app) => void app.all("/export-all", (c) => c.text("all of it")),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureSuiteUnavailable" });
    expect((failure as Error).message).toContain("ALL /export-all");
  });

  it("does not stop for wildcard middleware that hands on, which answers a URL under its prefix as the application does", async () => {
    const result = await scan({
      beforeRoutes: (app) => {
        app.use("/api/*", async (_c, next) => next());
        app.use("*", async (_c, next) => next());
      },
    });
    expect(result.hits).toEqual([]);
  });

  it("does not stop for a POST route, which the scan does not read", async () => {
    const result = await scan({
      beforeRoutes: (app) => void app.post("/api/extra-write", (c) => c.json({})),
    });
    expect(result.hits).toEqual([]);
  });
});

describe("the routes that do not name a matter", () => {
  /** Adds a field to every JSON answer of a route, so that the answer is still the JSON the harness reads. */
  const adding =
    (path: string, field: () => unknown): BeforeRoutes =>
    (app) => {
      app.use(path, async (c, next) => {
        await next();
        if (c.req.method !== "GET" || c.res.status !== 200) return;
        const body = JSON.parse(await c.res.text()) as Record<string, unknown>;
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        c.res = new Response(JSON.stringify({ ...body, leaked: field() }), {
          status: 200,
          headers,
        });
      });
    };

  it("counts a canary string in /api/session, which the first version of the scan never fetched", async () => {
    const planted = dataset.keys.canary!.matters[0]!.strings[0]!;
    const result = await scan({ beforeRoutes: adding("/api/session", () => planted) });
    const labels = new Set(labelsOf(result, "canary"));
    for (const who of [
      "associate",
      "reviewer",
      "viewer",
      "administrator",
      "legal engineer",
      "anonymous",
    ])
      expect(labels, who).toContain(`${who} GET /api/session`);
    // The canary matter's own people may see their own string: it is not a leak to them.
    expect([...labels].some((label) => label.startsWith("bramblewick "))).toBe(false);
  });

  it("counts a canary string in the playbook list for the case's people and the two global roles", async () => {
    const planted = dataset.keys.canary!.matters[0]!.strings[1]!;
    const result = await scan({ beforeRoutes: adding("/api/playbooks", () => planted) });
    // The anonymous client is refused that route, so its answer is not a list that could leak.
    expect(labelsOf(result, "canary").sort()).toEqual(
      [
        "administrator GET /api/playbooks",
        "associate GET /api/playbooks",
        "legal engineer GET /api/playbooks",
        "reviewer GET /api/playbooks",
        "viewer GET /api/playbooks",
      ].sort(),
    );
  });

  it("fetches /healthz and the stylesheet once, anonymously, and every other route of the list as every caller", async () => {
    const real = createScanner();
    const seen: string[] = [];
    await scan({
      scanner: {
        scan: (target) => {
          // The scan for the distinctive fact is a second scan of the same body, with no ids.
          if (target.kind === "http_body" && target.forbid.ids.length > 0) seen.push(target.label);
          return real.scan(target);
        },
      },
    });
    const count = (label: string) => seen.filter((entry) => entry === label).length;
    expect(count("anonymous GET /healthz")).toBe(1);
    expect(count("anonymous GET /assets/:name")).toBe(1);
    expect(
      seen.filter((label) => label.includes("/healthz") || label.includes("/assets/")),
    ).toHaveLength(2);
    for (const who of [
      "associate",
      "reviewer",
      "viewer",
      "bramblewick associate",
      "bramblewick reviewer",
      "administrator",
      "legal engineer",
      "anonymous",
    ])
      for (const route of ["/", "/api/session", "/matters", "/api/matters", "/api/playbooks"])
        expect(count(`${who} GET ${route}`), `${who} ${route}`).toBe(1);
    // The people who belong to neither matter read the matter routes of the case and of the canary matter too.
    for (const who of ["administrator", "legal engineer", "anonymous"]) {
      expect(seen.some((label) => label.startsWith(`${who} on case GET /matters/:matterId`))).toBe(
        true,
      );
      expect(
        seen.some((label) => label.startsWith(`${who} on canary bramblewick GET /api/matters/`)),
      ).toBe(true);
    }
  });
});

describe("a hole that only a global role, or nobody, can reach", () => {
  /** The list of matters of one user shows every matter of two others, as a query by role would. */
  const listsEveryMatterFor =
    (userId: string): BeforeRoutes =>
    (_app, deps) => {
      const real = deps.repo.listMattersForUser;
      (deps.repo as { listMattersForUser: unknown }).listMattersForUser = (id: string) =>
        id === userId ? [...real(DEMO_USER_IDS.associate), ...real(CANARY_ASSOCIATE)] : real(id);
    };

  it("counts a list that shows the global administrator every matter", async () => {
    const result = await scan({ beforeRoutes: listsEveryMatterFor(DEMO_USER_IDS.admin) });
    expect(result.foreignSpanIdHits).toBeGreaterThan(0);
    const labels = new Set(labelsOf(result, "id"));
    expect(labels).toContain("administrator GET /matters");
    expect(labels).toContain("administrator GET /api/matters");
    expect([...labels].every((label) => label.startsWith("administrator "))).toBe(true);
  });

  it("counts a list that shows the legal engineer every matter", async () => {
    const result = await scan({ beforeRoutes: listsEveryMatterFor(DEMO_USER_IDS.legalEngineer) });
    const labels = new Set(labelsOf(result, "id"));
    expect(labels).toContain("legal engineer GET /api/matters");
    expect([...labels].every((label) => label.startsWith("legal engineer "))).toBe(true);
  });

  it("counts a global administrator who is taken for a member of every matter", async () => {
    const result = await scan({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
          real(matterId, userId) ??
          (userId === DEMO_USER_IDS.admin
            ? {
                matterId,
                userId,
                role: "viewer",
                grantedBy: userId,
                grantedAt: "2026-11-04T09:00:00.000Z",
              }
            : undefined);
      },
    });
    const labels = new Set(labelsOf(result));
    expect(result.canaryHits + result.foreignSpanIdHits).toBeGreaterThan(0);
    expect([...labels].some((label) => label.startsWith("administrator on case "))).toBe(true);
    expect([...labels].every((label) => label.startsWith("administrator "))).toBe(true);
  });

  it("counts an anonymous client who is shown the matters in the session", async () => {
    const result = await scan({
      beforeRoutes: (app, deps) => {
        app.use("/api/session", async (c, next) => {
          await next();
          const body = JSON.parse(await c.res.text()) as Record<string, unknown>;
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          // Signed in: the answer as it is. Not signed in: and every matter besides.
          if (body.user !== null) {
            c.res = new Response(JSON.stringify(body), { status: 200, headers });
            return;
          }
          const ids = (
            deps.repo.db.prepare("SELECT id FROM matters").all() as { id: string }[]
          ).map((row) => row.id);
          c.res = new Response(JSON.stringify({ ...body, matters: ids }), { status: 200, headers });
        });
      },
    });
    expect(new Set(labelsOf(result, "id"))).toContain("anonymous GET /api/session");
  });

  it("counts the canary matter's reviewer, who never read in the first version, when a hole lets them in", async () => {
    const result = await scan({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
          real(matterId, userId) ??
          (userId === CANARY_REVIEWER
            ? {
                matterId,
                userId,
                role: "viewer",
                grantedBy: userId,
                grantedAt: "2026-11-04T09:00:00.000Z",
              }
            : undefined);
      },
    });
    expect(result.foreignSpanIdHits).toBeGreaterThan(0);
    const labels = labelsOf(result, "id");
    expect(labels.every((label) => label.startsWith("bramblewick reviewer on case "))).toBe(true);
  });
});

describe("the sentence when there are hits", () => {
  it("stays within 2000 characters, however many hits and facts it lists, and names where the first were found", async () => {
    const result = await scan({
      beforeCapture: (inner, context) => ({
        provider: inner.provider,
        model: inner.model,
        disclosure: inner.disclosure,
        generate: ((request: Parameters<typeof inner.generate>[0]) => {
          const span = context.foreign[0]!.spans.find((s) => s.text.includes("CANARY-"))!;
          return inner.generate({
            ...request,
            prompt: `${request.prompt}\n[${span.id}] ${span.text} ${context.foreign[0]!.fact}`,
          });
        }) as typeof inner.generate,
      }),
    });
    expect(result.canaryHits).toBeGreaterThan(0);
    expect(result.factSightings).toBeGreaterThan(0);
    expect(result.sentence.length).toBeLessThan(2000);
    expect(result.sentence).toMatch(/first found: a canary string in prompt \(/);
    expect(result.sentence).toMatch(
      /distinctive fact appeared in \d+ artefacts, which is an attempt/,
    );
    expect(result.sentence).not.toMatch(CANARY_SHAPE);
    expect(result.sentence).not.toMatch(ID_SHAPE);
    expect(result.sentence).not.toMatch(DASHES);
  });

  it("stays within 2000 characters for the two cases of both splits, with the leak, the fact and the hits all there", async () => {
    const result = await runCanaryScan({
      dataset,
      root: ROOT,
      playbook,
      signal: never(),
      splits: ["dev", "heldout"],
      hooks: {
        beforeCapture: (inner, context) => ({
          provider: inner.provider,
          model: inner.model,
          disclosure: inner.disclosure,
          generate: ((request: Parameters<typeof inner.generate>[0]) => {
            const span = context.foreign[0]!.spans.find((s) => s.text.includes("CANARY-"))!;
            return inner.generate({
              ...request,
              prompt: `${request.prompt}\n[${span.id}] ${span.text} ${context.foreign[0]!.fact}`,
            });
          }) as typeof inner.generate,
        }),
      },
    });
    expect(result.cases).toHaveLength(2);
    expect(result.canaryHits).toBeGreaterThan(0);
    expect(result.factSightings).toBeGreaterThan(0);
    expect(result.sentence.length).toBeLessThan(2000);
    expect(result.sentence).toMatch(/distinctive fact appeared in \d+ artefacts/);
    expect(result.sentence).toMatch(/\.$/);
    expect(result.sentence).not.toMatch(DASHES);
  });
});
