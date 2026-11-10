import JSZip from "jszip";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_USER_IDS } from "../../apps/parol/src/store/index.js";
import type { AppDeps } from "../../apps/parol/src/server/deps.js";
import {
  runCanaryScan,
  type CanaryHooks,
  type CanaryResult,
} from "../src/parol/exposure/canary.js";
import type { Dataset } from "../src/parol/dataset.js";
import { createScanner, type Scanner } from "../src/parol/exposure/scan.js";
import { namesCanaryMatter } from "./parol-canary-support.js";
import {
  CANARY_SHAPE,
  completeDataset,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * A matter's name, its client's name and its members are what a page of the application shows of
 * it, and none of them is an id. A leak of one of them has to be counted as a leak of the matter,
 * in both directions, in every channel, with no false hit on the pages that print them by design.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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

const canaryMatter = () => dataset.keys.canary!.matters[0]!;
const CANARY_NAME = "Canary matter bramblewick (synthetic)";
const CASE_NAME = "PAROL-D10 review (exposure scan)";
const caseClient = (): string =>
  dataset.keys.cases.find((entry) => entry.case === "PAROL-D10")!.intake.clientLegalName;

const hitsOf = (result: CanaryResult, kind: string) =>
  result.hits.filter((hit) => hit.kind === kind);
const labelsOf = (result: CanaryResult, kind: string): string[] =>
  hitsOf(result, kind).map((hit) => hit.label);

/** The request changed on its way into the capture, and so in the record of it. */
function changing(
  inner: ObjectGenerator,
  change: (request: GenerateObjectRequest<unknown>) => GenerateObjectRequest<unknown>,
): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    generate: ((request: GenerateObjectRequest<unknown>) =>
      inner.generate(change(request))) as ObjectGenerator["generate"],
  };
}

describe("the real application", () => {
  it("gives zero, though the pages print the canary matter's people and its own pages print its name", async () => {
    const bodies = new Map<string, string>();
    const real = createScanner();
    const recording: Scanner = {
      scan(target) {
        if (target.kind === "http_body" && typeof target.content !== "string")
          bodies.set(target.label, Buffer.from(target.content).toString("utf8").toLowerCase());
        return real.scan(target);
      },
    };
    const result = await scan({ scanner: recording });
    expect(result.hits).toEqual([]);
    expect(result.canaryHits + result.foreignSpanIdHits).toBe(0);
    const page = (label: string): string => bodies.get(label) ?? "";
    // The member picker prints every user of the application on the pages, so the case's people
    // see the canary matter's people there and their names are not searched for in a page.
    expect(page("associate GET /matters/:matterId")).toContain("synthetic bramblewick associate");
    expect(page("administrator GET /matters")).toContain("usr_exposure_bramblewick_associate");
    // The canary matter's own people see its name and its client's name on their own pages.
    expect(page("bramblewick associate GET /matters/:matterId")).toContain(
      CANARY_NAME.toLowerCase(),
    );
    expect(page("bramblewick associate GET /api/matters/:matterId")).toContain(
      canaryMatter().clientLegalName.toLowerCase(),
    );
    // And the JSON of the case's people holds none of the canary matter's people.
    expect(page("associate GET /api/matters/:matterId")).not.toContain("bramblewick");
  });
});

describe("the name of a matter and its client", () => {
  it("is counted on a page of the stranger when the page prints the canary matter's name and nothing else of it", async () => {
    const result = await scan({
      beforeRoutes: (app) => {
        app.use("/matters", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || c.res.status !== 200) return;
          const body = await c.res.text();
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(`${body}<p>${CANARY_NAME}</p>`, { status: 200, headers });
        });
      },
    });
    const labels = new Set(labelsOf(result, "http_body"));
    for (const who of ["associate", "reviewer", "viewer", "administrator", "legal engineer"])
      expect(labels, who).toContain(`${who} GET /matters`);
    // The canary matter's own people print their matter's name: not a leak to them.
    expect([...labels].some((label) => label.startsWith("bramblewick "))).toBe(false);
    expect(result.hits.every((hit) => hit.token === "id")).toBe(true);
    expect(result.canaryHits).toBe(0);
  });

  it("is counted in a prompt that carries the canary matter's client name", async () => {
    const result = await scan({
      beforeCapture: (inner) =>
        changing(inner, (request) => ({
          ...request,
          prompt: `${request.prompt}\nClient: ${canaryMatter().clientLegalName}`,
        })),
    });
    const prompts = hitsOf(result, "prompt");
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.every((hit) => hit.token === "id")).toBe(true);
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(prompts.length);
  });

  it("is counted in a model answer that carries the canary matter's name", async () => {
    const result = await scan({
      model: (inner) => ({
        provider: inner.provider,
        model: inner.model,
        disclosure: inner.disclosure,
        generate: (async (request: GenerateObjectRequest<unknown>) => {
          const answer = await inner.generate(request);
          return typeof answer === "object" && answer !== null
            ? { ...answer, note: CANARY_NAME }
            : answer;
        }) as ObjectGenerator["generate"],
      }),
    });
    const answers = hitsOf(result, "model_response");
    expect(answers.length).toBeGreaterThan(0);
    expect(answers.every((hit) => hit.token === "id")).toBe(true);
  });

  it("is counted in the services' log and in the exported memo", async () => {
    const result = await scan({
      afterReview: (site) => {
        site.serviceLog.push(`a line about ${canaryMatter().clientLegalName}`);
      },
      wrapMemoBuilder: (real) => async (input) => {
        const zip = await JSZip.loadAsync(await real(input));
        const xml = await zip.file("word/document.xml")!.async("string");
        zip.file(
          "word/document.xml",
          xml.replace("</w:body>", `<w:p><w:r><w:t>${CANARY_NAME}</w:t></w:r></w:p></w:body>`),
        );
        return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
      },
    });
    expect(hitsOf(result, "log")).toEqual([
      { kind: "log", label: "service log", token: "id", index: expect.any(Number) },
    ]);
    expect(hitsOf(result, "memo")).toHaveLength(1);
  });

  it("is counted in the case's rows when a row of the case holds the canary matter's client name", async () => {
    const result = await scan({
      afterReview: (site, context) => {
        site.repo.db
          .prepare(
            `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, text, created_at)
             VALUES ('fbk_planted_name', ?, NULL, NULL, ?, 'comment', ?, '2026-11-04T10:00:00.000Z')`,
          )
          .run(context.caseMatterId, "usr_demo_associate", canaryMatter().clientLegalName);
      },
    });
    expect(hitsOf(result, "store_rows")).toEqual([
      { kind: "store_rows", label: "case feedback", token: "id", index: expect.any(Number) },
    ]);
  });
});

describe("the name of the case, the other way", () => {
  it("is counted on a page of the canary matter's own people that prints the case's matter name", async () => {
    const result = await scan({
      beforeRoutes: (app, deps) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || c.res.status !== 200) return;
          if (!namesCanaryMatter(deps, c.req.path)) return;
          const body = await c.res.text();
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(`${body}\n${CASE_NAME}`, { status: 200, headers });
        });
      },
    });
    const labels = new Set(labelsOf(result, "http_body"));
    for (const who of ["associate", "reviewer"])
      expect(labels, who).toContain(`bramblewick ${who} GET /api/matters/:matterId`);
    expect([...labels].every((label) => label.startsWith("bramblewick "))).toBe(true);
    expect(result.canaryHits).toBe(0);
  });

  it("is counted in a row of the canary matter that holds the case's client name", async () => {
    const result = await scan({
      afterReview: (site, context) => {
        site.repo.db
          .prepare(
            `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, text, created_at)
             VALUES ('fbk_planted_name2', ?, NULL, NULL, ?, 'comment', ?, '2026-11-04T10:00:00.000Z')`,
          )
          .run(context.foreign[0]!.matterId, "usr_exposure_bramblewick_associate", caseClient());
      },
    });
    expect(hitsOf(result, "store_rows")).toEqual([
      { kind: "store_rows", label: "bramblewick feedback", token: "id", index: expect.any(Number) },
    ]);
  });
});

describe("the members of a matter", () => {
  /** A list of members that ignores the matter it is asked for, as a missing filter does. */
  const everyMembersList: NonNullable<CanaryHooks["beforeRoutes"]> = (_app, deps) => {
    const real = deps.repo.listMembers;
    (deps.repo as { listMembers: unknown }).listMembers = (_matterId: string) =>
      (
        deps.repo.db.prepare("SELECT DISTINCT matter_id FROM matter_members").all() as {
          matter_id: string;
        }[]
      ).flatMap((row) => real(row.matter_id));
  };

  it("is counted in the JSON of a matter that lists the other matter's people, which names no id of it", async () => {
    const result = await scan({ beforeRoutes: everyMembersList });
    const labels = new Set(labelsOf(result, "http_body"));
    // The case's people get the canary matter's people; the canary matter's people get the case's.
    for (const who of ["associate", "reviewer", "viewer"])
      expect(labels, who).toContain(`${who} GET /api/matters/:matterId`);
    for (const who of ["associate", "reviewer"])
      expect(labels, who).toContain(`bramblewick ${who} GET /api/matters/:matterId`);
    // Only in the JSON routes: the pages print every user anyway, by design.
    expect([...labels].every((label) => label.includes(" GET /api/"))).toBe(true);
    expect(result.hits.every((hit) => hit.token === "id")).toBe(true);
    expect(result.canaryHits).toBe(0);
  });

  it("does not turn the member picker of the pages into a hit", async () => {
    // With the same hole, the HTML pages of the case print the canary matter's people too, as they
    // do in the real application. They are not hits.
    const result = await scan({ beforeRoutes: everyMembersList });
    expect(labelsOf(result, "http_body").filter((label) => !label.includes(" GET /api/"))).toEqual(
      [],
    );
  });
});

/** The routes under one matter's id (`/api/matters/<id>`, and below it). The list of matters is not one. */
const UNDER_A_MATTER = /^\/api\/matters\/[^/]+/;

/**
 * Adds a text to the JSON answer of a GET (whatever the status, so a refusal carries it too) to
 * the paths `where` picks. The answer stays JSON, so that a reader who may hold the text is not
 * stopped by a damaged body. Restricting the paths is what lets a test tell one reader set from
 * another: `/api/matters/*` in Hono also matches the list, which other readers' sets cover.
 */
function leaking(
  text: (deps: AppDeps) => string,
  where: (deps: AppDeps, path: string) => boolean,
): NonNullable<CanaryHooks["beforeRoutes"]> {
  return (app, deps) => {
    app.use("/api/*", async (c, next) => {
      await next();
      if (c.req.method !== "GET" || !where(deps, c.req.path)) return;
      // A file (the memo) is not JSON, and a damaged package would stop the scan for another reason.
      if (!(c.res.headers.get("content-type") ?? "").includes("json")) return;
      const parsed: unknown = JSON.parse(await c.res.text());
      const changed = JSON.stringify(
        Array.isArray(parsed)
          ? [...parsed, text(deps)]
          : { ...(parsed as Record<string, unknown>), leak: text(deps) },
      );
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(changed, { status: c.res.status, headers });
    });
  };
}

/** The readers of one route whose read was a hit, as their labels name them without the route. */
function readersAt(result: CanaryResult, route: string): string[] {
  return labelsOf(result, "http_body")
    .filter((label) => label.endsWith(` ${route}`))
    .map((label) => label.slice(0, -(route.length + 1)))
    .sort();
}

const ONE_MATTER = "GET /api/matters/:matterId";
const THE_LIST = "GET /api/matters";
const CASE_PEOPLE = ["associate", "reviewer", "viewer"];
const STRANGERS = ["administrator", "legal engineer", "anonymous"];
const CANARY_PEOPLE = ["bramblewick associate", "bramblewick reviewer"];

describe("each name, in each direction, for each kind of reader", () => {
  // One leak of one name on every route under a matter's id, the case's and the canary matter's.
  // Who is held to what is the point: a reader set that lacks the name lets it through unseen.
  const names: Record<string, { text: () => string; readers: () => string[] }> = {
    "the case's matter name": {
      text: () => CASE_NAME,
      readers: () => [
        // On the case's routes: the canary matter's people and the strangers.
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
        // On the canary matter's routes: its own people, and the strangers.
        ...CANARY_PEOPLE,
        ...STRANGERS.map((who) => `${who} on canary bramblewick`),
      ],
    },
    "the case's client name": {
      text: () => caseClient(),
      readers: () => [
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
        ...CANARY_PEOPLE,
        ...STRANGERS.map((who) => `${who} on canary bramblewick`),
      ],
    },
    "the canary matter's name": {
      text: () => CANARY_NAME,
      readers: () => [
        // On the case's routes: its own people, the canary matter's people, the strangers.
        ...CASE_PEOPLE,
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
        // On the canary matter's routes: the case's people and the strangers, not its own people.
        ...CASE_PEOPLE.map((who) => `${who} on canary bramblewick`),
        ...STRANGERS.map((who) => `${who} on canary bramblewick`),
      ],
    },
    "the canary matter's client name": {
      text: () => canaryMatter().clientLegalName,
      readers: () => [
        ...CASE_PEOPLE,
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
        ...CASE_PEOPLE.map((who) => `${who} on canary bramblewick`),
        ...STRANGERS.map((who) => `${who} on canary bramblewick`),
      ],
    },
  };

  for (const [what, { text, readers }] of Object.entries(names))
    it(`counts ${what} for exactly the readers who may not see it`, async () => {
      const result = await scan({
        beforeRoutes: leaking(
          () => text(),
          (_deps, path) => UNDER_A_MATTER.test(path),
        ),
      });
      expect(readersAt(result, ONE_MATTER)).toEqual(readers().sort());
      expect(result.canaryHits).toBe(0);
      expect(result.hits.every((hit) => hit.token === "id")).toBe(true);
    });
});

describe("each member, in each direction, for each kind of reader", () => {
  const canaryUser = () => ({
    id: "usr_exposure_bramblewick_associate",
    name: () => `Synthetic ${canaryMatter().name} associate`,
  });
  const caseUser = () => ({
    id: DEMO_USER_IDS.associate,
    name: (deps: AppDeps) => deps.repo.getUser(DEMO_USER_IDS.associate)!.displayName,
  });
  const onCaseRoutes = (deps: AppDeps, path: string): boolean =>
    UNDER_A_MATTER.test(path) && !namesCanaryMatter(deps, path);
  const onCanaryRoutes = (deps: AppDeps, path: string): boolean =>
    UNDER_A_MATTER.test(path) && namesCanaryMatter(deps, path);
  const onTheList = (_deps: AppDeps, path: string): boolean => path === "/api/matters";

  // The member of the other matter, on each kind of route. A member is not forbidden to the
  // readers of its own matter, and is forbidden to everyone else, strangers included.
  const scenarios: Record<
    string,
    {
      user: typeof canaryUser | typeof caseUser;
      where: (deps: AppDeps, path: string) => boolean;
      route: string;
      readers: string[];
    }
  > = {
    "a canary matter's person on the case's routes": {
      user: canaryUser,
      where: onCaseRoutes,
      route: ONE_MATTER,
      readers: [
        ...CASE_PEOPLE,
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
      ],
    },
    "a person of the case on the case's routes": {
      user: caseUser,
      where: onCaseRoutes,
      route: ONE_MATTER,
      readers: [
        ...CANARY_PEOPLE.map((who) => `${who} on case`),
        ...STRANGERS.map((who) => `${who} on case`),
      ],
    },
    "a canary matter's person on the canary matter's routes": {
      user: canaryUser,
      where: onCanaryRoutes,
      route: ONE_MATTER,
      readers: [
        ...CASE_PEOPLE.map((who) => `${who} on canary bramblewick`),
        ...STRANGERS.map((who) => `${who} on canary bramblewick`),
      ],
    },
    "a person of the case on the canary matter's routes": {
      user: caseUser,
      where: onCanaryRoutes,
      route: ONE_MATTER,
      readers: [...CANARY_PEOPLE, ...STRANGERS.map((who) => `${who} on canary bramblewick`)],
    },
    "a canary matter's person on the list of matters, which names no matter": {
      user: canaryUser,
      where: onTheList,
      route: THE_LIST,
      readers: [...CASE_PEOPLE, ...STRANGERS],
    },
    "a person of the case on the list of matters, which names no matter": {
      user: caseUser,
      where: onTheList,
      route: THE_LIST,
      readers: [...CANARY_PEOPLE, ...STRANGERS],
    },
  };

  for (const [what, scenario] of Object.entries(scenarios))
    for (const kind of ["id", "display name"] as const)
      it(`counts ${what}, by ${kind} alone, for exactly the readers who may not see it`, async () => {
        const result = await scan({
          beforeRoutes: leaking((deps) => {
            const user = scenario.user();
            return kind === "id" ? user.id : user.name(deps);
          }, scenario.where),
        });
        expect(readersAt(result, scenario.route)).toEqual([...scenario.readers].sort());
        expect(result.canaryHits).toBe(0);
        expect(result.hits.every((hit) => hit.token === "id")).toBe(true);
      });
});

describe("what is printed", () => {
  it("holds no name, no id and no canary string of a hit", async () => {
    const result = await scan({
      beforeCapture: (inner) =>
        changing(inner, (request) => ({
          ...request,
          prompt: `${request.prompt}\n${canaryMatter().clientLegalName} ${CANARY_NAME}`,
        })),
    });
    expect(result.foreignSpanIdHits).toBeGreaterThan(0);
    // A hit on a name is not called an id.
    expect(result.sentence).toMatch(/first found: an id or name in prompt \(/);
    const printed = JSON.stringify([result.hits, result.sentence]);
    expect(printed).not.toContain(canaryMatter().clientLegalName);
    expect(printed).not.toContain(CANARY_NAME);
    expect(printed).not.toMatch(CANARY_SHAPE);
    expect(printed).not.toMatch(ID_SHAPE);
  });
});
