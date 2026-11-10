import JSZip from "jszip";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
    const printed = JSON.stringify([result.hits, result.sentence]);
    expect(printed).not.toContain(canaryMatter().clientLegalName);
    expect(printed).not.toContain(CANARY_NAME);
    expect(printed).not.toMatch(CANARY_SHAPE);
    expect(printed).not.toMatch(ID_SHAPE);
  });
});
