import JSZip from "jszip";
import type { GenerateObjectRequest, ObjectGenerator } from "@clausewise/llm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authorizeMatter } from "../../apps/parol/src/auth/authorize.js";
import { DEMO_USER_IDS } from "../../apps/parol/src/store/index.js";
import { BRAMBLEWICK_STRINGS } from "../../fixtures/parol/canary.js";
import {
  runAuthorizationProbes,
  type AuthorizationResult,
} from "../src/parol/exposure/authorization.js";
import {
  runCanaryScan,
  type CanaryHooks,
  type CanaryResult,
} from "../src/parol/exposure/canary.js";
import { runExposureSuite } from "../src/parol/exposure/index.js";
import type { Scanner } from "../src/parol/exposure/scan.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { exposureChecked, exposureCount } from "../src/parol/suites.js";
import { CANARY_SHAPE, completeDataset, never, playbook, ROOT } from "./parol-exposure-support.js";
import type { Dataset } from "../src/parol/dataset.js";

/**
 * Negative tests. A security test that cannot fail proves nothing, so each way the application or
 * its model could leak is planted here, in a copy of the application that exists for the test, and
 * the suite has to count it. The canary strings are the synthetic ones of fixtures/parol/canary.ts.
 *
 * The real application, with nothing planted, gives zero in each of these (parol-exposure.test.ts).
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const common = () => ({ dataset, root: ROOT, playbook, signal: never() });
const canary = (hooks?: CanaryHooks): Promise<CanaryResult> =>
  runCanaryScan({ ...common(), ...(hooks === undefined ? {} : { hooks }) });
const authorization = (hooks?: SiteHooks): Promise<AuthorizationResult> =>
  runAuthorizationProbes({ ...common(), ...(hooks === undefined ? {} : { hooks }) });

/** A generator that is the given one with its `generate` replaced. */
function wrap(
  inner: ObjectGenerator,
  generate: (request: GenerateObjectRequest<unknown>) => Promise<unknown>,
): ObjectGenerator {
  return {
    provider: inner.provider,
    model: inner.model,
    disclosure: inner.disclosure,
    generate: ((request: GenerateObjectRequest<unknown>) =>
      generate(request)) as ObjectGenerator["generate"],
  };
}

const hitsOf = (result: CanaryResult, kind: string, token?: "canary" | "id") =>
  result.hits.filter((hit) => hit.kind === kind && (token === undefined || hit.token === token));

describe("the canary scan on the real application", () => {
  it("finds nothing, out of a nonzero number of artefacts (the baseline of these tests)", async () => {
    const result = await canary();
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(0);
    expect(result.artefactsScanned).toBeGreaterThan(100);
    expect(result.hits).toEqual([]);
  });
});

describe("(a) a leaky service double: a prompt builder that includes a span of the other matter", () => {
  it("is counted as a canary string and as a foreign span id, in the prompt that carried it", async () => {
    let seen = 0;
    let stringsInSpan = 0;
    const result = await canary({
      beforeCapture: (inner, context) =>
        wrap(inner, async (request) => {
          const other = context.foreign[0]!;
          const span = other.spans.find((s) => other.strings.some((x) => s.text.includes(x)))!;
          stringsInSpan = other.strings.filter((x) => span.text.includes(x)).length;
          // Only the first prompt is leaky, so the count is exact.
          const leaky =
            seen++ === 0
              ? { ...request, prompt: `${request.prompt}\n[${span.id}] ${span.text}` }
              : request;
          return inner.generate(leaky);
        }),
    });
    expect(stringsInSpan).toBeGreaterThan(0);
    expect(hitsOf(result, "prompt", "canary")).toHaveLength(stringsInSpan);
    expect(hitsOf(result, "prompt", "id")).toHaveLength(1);
    expect(result.canaryHits).toBe(stringsInSpan);
    expect(result.foreignSpanIdHits).toBe(1);
    // The leak is in the prompt and in no other place: nothing downstream used it.
    expect(result.hits.every((hit) => hit.kind === "prompt")).toBe(true);
    // The record says where, and never what.
    expect(result.sentence).toMatch(/first found: a canary string in prompt \(/);
    expect(result.sentence).not.toMatch(CANARY_SHAPE);
  });

  it("is counted again for every prompt that leaks", async () => {
    const result = await canary({
      beforeCapture: (inner, context) =>
        wrap(inner, (request) => {
          const span = context.foreign[0]!.spans[1]!;
          return inner.generate({ ...request, prompt: `${request.prompt}\n[${span.id}]` });
        }),
    });
    expect(result.foreignSpanIdHits).toBe(hitsOf(result, "prompt", "id").length);
    expect(result.foreignSpanIdHits).toBeGreaterThanOrEqual(9);
  });
});

describe("(b) a model response that echoes a canary string", () => {
  it("is counted in the model answers", async () => {
    const result = await canary({
      model: (inner, context) =>
        wrap(inner, async (request) => {
          const answer = (await inner.generate(request)) as Record<string, unknown>;
          return request.schemaName === "analyze_rule"
            ? {
                ...answer,
                explanation: `The clause matches the terms of the other matter, ${context.foreign[0]!.strings[0]}.`,
              }
            : answer;
        }),
    });
    // One answer for each of the eight rules.
    expect(hitsOf(result, "model_response", "canary")).toHaveLength(8);
    expect(result.canaryHits).toBeGreaterThanOrEqual(8);
    // The scan follows the echo to where the application put it.
    expect(hitsOf(result, "http_body").length).toBeGreaterThan(0);
    expect(hitsOf(result, "store_rows").length).toBeGreaterThan(0);
  });

  it("is counted when the model only echoes the id of a span of the other matter", async () => {
    const result = await canary({
      model: (inner, context) =>
        wrap(inner, async (request) => {
          const answer = (await inner.generate(request)) as Record<string, unknown>;
          return request.schemaName === "analyze_rule"
            ? { ...answer, explanation: `See ${context.foreign[0]!.spans[0]!.id}.` }
            : answer;
        }),
    });
    expect(hitsOf(result, "model_response", "id")).toHaveLength(8);
    expect(result.foreignSpanIdHits).toBeGreaterThanOrEqual(8);
    expect(result.canaryHits).toBe(0);
  });
});

describe("the distinctive fact of the other matter", () => {
  it("is an attempt and not a breach: it is reported, and it is not counted as a hit", async () => {
    const result = await canary({
      model: (inner, context) =>
        wrap(inner, async (request) => {
          const answer = (await inner.generate(request)) as Record<string, unknown>;
          return request.schemaName === "analyze_rule"
            ? { ...answer, explanation: `The other matter says: ${context.foreign[0]!.fact}.` }
            : answer;
        }),
    });
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(0);
    expect(result.factSightings).toBeGreaterThan(8);
    expect(result.sentence).toMatch(
      /distinctive fact appeared in \d+ artefacts, which is an attempt/,
    );
  });
});

describe("(c) an exported memo or a response body that carries a canary string", () => {
  const planted = BRAMBLEWICK_STRINGS[0];

  it("is counted when the memo carries it", async () => {
    const result = await canary({
      wrapMemoBuilder: (real) => async (input) => {
        const zip = await JSZip.loadAsync(await real(input));
        const xml = await zip.file("word/document.xml")!.async("string");
        // Split across two runs, as Word would, so the scan has to read the package and not the bytes.
        const half = Math.floor(planted.length / 2);
        const paragraph =
          `<w:p><w:r><w:t>${planted.slice(0, half)}</w:t></w:r>` +
          `<w:r><w:t>${planted.slice(half)}</w:t></w:r></w:p>`;
        zip.file("word/document.xml", xml.replace("</w:body>", `${paragraph}</w:body>`));
        return zip.generateAsync({ type: "uint8array" });
      },
    });
    expect(hitsOf(result, "memo", "canary")).toHaveLength(1);
    // The same file reached every role that downloads it, over both routes.
    const downloads = hitsOf(result, "http_body", "canary");
    expect(downloads).toHaveLength(6);
    expect(downloads.every((hit) => hit.label.includes("/memos/:memoId/file"))).toBe(true);
    expect(result.canaryHits).toBe(7);
  });

  it("is counted when a response body carries it", async () => {
    const result = await canary({
      beforeRoutes: (app) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          const type = c.res.headers.get("content-type") ?? "";
          if (c.req.method !== "GET" || c.res.status !== 200 || !type.includes("json")) return;
          const body = await c.res.text();
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(`${body}\n${planted}`, { status: 200, headers });
        });
      },
    });
    expect(result.canaryHits).toBeGreaterThan(0);
    expect(result.hits.every((hit) => hit.kind === "http_body" && hit.token === "canary")).toBe(
      true,
    );
    expect(result.foreignSpanIdHits).toBe(0);
  });

  it("is counted when a row of the store carries it, with the id of a span of the other matter", async () => {
    const result = await canary({
      afterReview: (site, context) => {
        const span = context.foreign[0]!.spans[0]!;
        site.repo.db
          .prepare(
            `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, text, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'comment', ?, ?)`,
          )
          .run(
            "fbk_planted_for_the_test",
            context.caseMatterId,
            DEMO_USER_IDS.associate,
            `${planted} copied from ${span.id}`,
            "2026-11-04T10:00:00.000Z",
          );
      },
    });
    expect(hitsOf(result, "store_rows", "canary")).toEqual([
      { kind: "store_rows", label: "case feedback", token: "canary", index: 0 },
    ]);
    expect(hitsOf(result, "store_rows", "id")).toHaveLength(1);
    expect(result.canaryHits).toBe(1);
    expect(result.foreignSpanIdHits).toBe(1);
  });
});

describe("a person who belongs to the canary matter only", () => {
  it("is counted when a hole lets them read the case matter, because they get its ids", async () => {
    const result = await canary({
      beforeRoutes: (_app, deps) => {
        // Membership is broken for this one person: anyone is taken to be a viewer of any matter.
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
          real(matterId, userId) ??
          (userId === "usr_exposure_bramblewick_associate"
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
    const labels = new Set(hitsOf(result, "http_body", "id").map((hit) => hit.label));
    expect([...labels].every((label) => label.startsWith("bramblewick associate on case"))).toBe(
      true,
    );
  });
});

describe("the scanner has to find its own control before a count is reported", () => {
  it("throws, with exit code 2, when the scanner finds nothing", async () => {
    const blind: Scanner = { scan: async () => [] };
    const failure = await canary({ scanner: blind }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect((failure as Error).message).not.toMatch(
      /CANARY-[A-Z]+-[0-9a-f]{12}|(ver|mat|doc)_[0-9a-f]{8}/i,
    );
  });

  it("throws when the scanner cannot read a Word file, which is where the memo is", async () => {
    const real = (await import("../src/parol/exposure/scan.js")).createScanner();
    const textOnly: Scanner = {
      scan: (target) =>
        typeof target.content === "string" ? real.scan(target) : Promise.resolve([]),
    };
    await expect(canary({ scanner: textOnly })).rejects.toMatchObject({
      name: "ExposureControlFailure",
    });
  });

  it("throws when the scanner reports a hit in every artefact", async () => {
    const eager: Scanner = {
      scan: async (target) => [
        { kind: target.kind, label: target.label, token: "canary", index: 0 },
      ],
    };
    await expect(canary({ scanner: eager })).rejects.toMatchObject({
      name: "ExposureControlFailure",
    });
  });
});

describe("the data check has to be able to see data", () => {
  it("throws, with exit code 2, when no answer a member reads holds the matter's title, text or ids", async () => {
    const failure = await authorization({
      beforeRoutes: (app) => {
        // Every answer to a read is emptied, so a member's answer has nothing a stranger's could leak.
        app.use("*", async (c, next) => {
          await next();
          if (c.req.method === "GET" && c.res.status === 200 && c.req.path.includes("/matters/")) {
            const headers = new Headers(c.res.headers);
            headers.delete("content-length");
            c.res = new Response("{}", { status: 200, headers });
          }
        });
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect((failure as Error).message).toContain("title and text and ids");
  });

  it("throws, with exit code 2, when a canary matter's own rows do not hold the strings the key lists for it", async () => {
    const odd = await completeDataset((keys) => {
      keys
        .canary!.matters.find((matter) => matter.id === "bramblewick")!
        .strings.push("CANARY-BRAMBLEWICK-000000000000");
    });
    const failure = await runCanaryScan({
      root: ROOT,
      dataset: odd,
      playbook,
      signal: never(),
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect((failure as Error).message).toContain("bramblewick");
    expect((failure as Error).message).not.toMatch(/CANARY-[A-Z]+-[0-9a-f]{12}/i);
  });
});

describe("(d) an application built with a planted authorization hole", () => {
  it("counts a route that answers a person who is not a member, and says which callers got through", async () => {
    const result = await authorization({
      beforeRoutes: (app, deps) => {
        // A matter route registered by hand, without the guard, that serves the view of any matter.
        app.get("/api/matters/:matterId", (c) => {
          const owner = deps.repo.getUser(DEMO_USER_IDS.associate)!;
          const am = authorizeMatter(
            deps.repo,
            { userId: owner.id, displayName: owner.displayName, globalRole: owner.globalRole },
            c.req.param("matterId"),
            "matter.read",
          );
          return c.json(deps.services.matters.view(am));
        });
      },
    });
    // Four callers with no right to the matter, in each of two modes.
    expect(result.probesAnsweredWithData).toBe(8);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(
      new Set(["outsider", "stranger", "admin", "anonymous"]),
    );
    expect(result.exposed.every((cell) => cell.probe === "GET /api/matters/:matterId")).toBe(true);
    expect(result.byReason.handler_answered).toBe(8);
    expect(result.byReason.carried_data).toBe(8);
    // The members who are let in by the hand-made route are not what the table expects (the guard did not log them).
    expect(result.mismatches).toBeGreaterThan(0);
    expect(result.probesRun).toBe(504);
  });

  it("counts a guard that wrongly takes one person for a member, on every route", async () => {
    const result = await authorization({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
          real(matterId, userId) ??
          (userId === "usr_exposure_outsider"
            ? {
                matterId,
                userId,
                role: "associate",
                grantedBy: userId,
                grantedAt: "2026-11-04T09:00:00.000Z",
              }
            : undefined);
      },
    });
    expect(result.probesAnsweredWithData).toBeGreaterThanOrEqual(36);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(["outsider"]));
    expect(result.byReason.handler_answered).toBeGreaterThanOrEqual(30);
  });

  it("counts a route that does not answer with data but is let through to change something", async () => {
    // A write that a viewer must not make, allowed by widening the role in the check only.
    const result = await authorization({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) => {
          const member = real(matterId, userId);
          return member !== undefined && userId === "usr_exposure_viewer"
            ? { ...member, role: "associate" }
            : member;
        };
      },
    });
    const viewer = result.exposed.filter((cell) => cell.actor === "viewer");
    expect(viewer.length).toBeGreaterThan(0);
    expect(viewer.every((cell) => cell.reasons.includes("handler_answered"))).toBe(true);
  });
});

describe("(e) a refusal that reveals that the matter exists", () => {
  it("is counted when the body of the refusal differs from the body for a matter that does not exist", async () => {
    const result = await authorization({
      beforeRoutes: (app, deps) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          const id = c.req.path.split("/")[3] ?? "";
          if (c.res.status === 404 && deps.repo.getMatter(id) !== undefined) {
            c.res = new Response(
              JSON.stringify({
                error: { kind: "not_a_member", message: "you are not a member of this matter" },
              }),
              { status: 404, headers: { "content-type": "application/json; charset=UTF-8" } },
            );
          }
        });
      },
    });
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
    expect(result.byReason.refusal_differs).toBe(result.probesAnsweredWithData);
    expect(result.byReason.handler_answered).toBe(0);
    expect(result.byReason.carried_data).toBe(0);
    expect(result.exposed.every((cell) => cell.reasons.join() === "refusal_differs")).toBe(true);
    // Every JSON route, for the three kinds of caller with no part in the matter, in two modes.
    // An administrator may delete a matter, so that route is refused to two of the three.
    expect(result.probesAnsweredWithData).toBe((17 * 3 - 1) * 2);
  });

  it("is counted when the status of the refusal differs (a 403 where a missing matter gets 404)", async () => {
    const result = await authorization({
      beforeRoutes: (app, deps) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          const id = c.req.path.split("/")[3] ?? "";
          if (c.res.status === 404 && deps.repo.getMatter(id) !== undefined)
            c.res = new Response(await c.res.text(), { status: 403, headers: c.res.headers });
        });
      },
    });
    expect(result.byReason.refusal_differs).toBe((17 * 3 - 1) * 2);
  });

  it("is counted when only a header of the refusal differs", async () => {
    const result = await authorization({
      beforeRoutes: (app, deps) => {
        app.use("/matters/*", async (c, next) => {
          await next();
          const id = c.req.path.split("/")[2] ?? "";
          if (c.res.status === 404 && deps.repo.getMatter(id) !== undefined)
            c.res.headers.set("x-matter-state", "exists");
        });
      },
    });
    expect(result.byReason.refusal_differs).toBeGreaterThan(0);
    expect(result.exposed.every((cell) => !cell.probe.includes("/api/"))).toBe(true);
  });
});

describe("the record of all three sub-suites with faults planted", () => {
  it("reports every kind of exposure in one record, and gate G1 reads it as nonzero", async () => {
    const record = await runExposureSuite(
      { root: ROOT, dataset, playbook, signal: never() },
      {
        authorization: {
          beforeRoutes: (app, deps) => {
            app.get("/api/matters/:matterId/runs", (c) => {
              const owner = deps.repo.getUser(DEMO_USER_IDS.associate)!;
              const am = authorizeMatter(
                deps.repo,
                { userId: owner.id, displayName: owner.displayName, globalRole: owner.globalRole },
                c.req.param("matterId"),
                "run.read",
              );
              return c.json({ runs: deps.services.runs.list(am) });
            });
          },
        },
        canary: {
          beforeCapture: (inner, context) =>
            wrap(inner, (request) => {
              const span = context.foreign[0]!.spans.find((s) => s.text.includes("CANARY-"))!;
              return inner.generate({
                ...request,
                prompt: `${request.prompt}\n[${span.id}] ${span.text}`,
              });
            }),
        },
      },
    );
    expect(record.probesRun).toBe(504);
    expect(record.artefactsScanned).toBeGreaterThan(100);
    expect(record.probesAnsweredWithData).toBeGreaterThan(0);
    expect(record.canaryHits).toBeGreaterThan(0);
    expect(record.foreignSpanIdHits).toBeGreaterThan(0);
    expect(exposureCount(record)).toBe(
      record.probesAnsweredWithData + record.canaryHits + record.foreignSpanIdHits,
    );
    expect(exposureCount(record)).toBeGreaterThan(0);
    expect(exposureChecked(record)).toBe(record.probesRun + record.artefactsScanned);
    expect(record.suites).toHaveLength(3);
  });
});
