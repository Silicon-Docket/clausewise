import { beforeAll, describe, expect, it, vi } from "vitest";
import { readPrincipal } from "../../apps/parol/src/auth/identity.js";
import type { Dataset } from "../src/parol/dataset.js";
import {
  runAuthorizationProbes,
  type AuthorizationGroup,
  type AuthorizationResult,
} from "../src/parol/exposure/authorization.js";
import { composeExposureRecord } from "../src/parol/exposure/index.js";
import { FORGED_PROBES, MATTER_PROBES } from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { exposureCount } from "../src/parol/suites.js";
import { completeDataset, never, playbook, ROOT } from "./parol-exposure-support.js";

/**
 * Negative tests for the authorization half of the exposure suite: each way the application could
 * be wrong that the suite did not see before is planted here, in a copy of the application that
 * exists for the test, and the suite has to count it (or, for a route nobody wrote a probe for,
 * refuse to run). The real application, with nothing planted, gives zero (parol-exposure.test.ts).
 *
 * A test asks for the groups of cells that can find its fault and no more, because the whole
 * suite is some seconds of work and the faults are many.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const run = (
  hooks: SiteHooks,
  groups?: readonly AuthorizationGroup[],
): Promise<AuthorizationResult> =>
  runAuthorizationProbes({
    dataset,
    root: ROOT,
    playbook,
    signal: never(),
    hooks,
    ...(groups === undefined ? {} : { groups }),
  });

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** The matter that a row of `table` belongs to, whichever matter that is. */
const ownerOf =
  (deps: { repo: { db: { prepare(sql: string): { get(...a: string[]): unknown } } } }) =>
  (table: string, id: string): string | undefined =>
    (
      deps.repo.db.prepare(`SELECT matter_id AS owner FROM ${table} WHERE id = ?`).get(id) as
        { owner: string } | undefined
    )?.owner;

const STRANGER = "usr_exposure_stranger";
const OUTSIDER = "usr_exposure_outsider";

// ---------------------------------------------------------------------------------------------
// #30: a matter route that was not made with defineMatterRoute
// ---------------------------------------------------------------------------------------------

describe("a route that names a matter and was registered outside defineMatterRoute", () => {
  it("stops the suite when the probe table has no probe for it", async () => {
    const error = await failure(
      run(
        {
          beforeRoutes: (app) =>
            void app.get("/api/matters/:matterId/export-all", (c) => c.json({ everything: [] })),
        },
        ["matrix"],
      ),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("GET /api/matters/:matterId/export-all");
    expect(error.message).toContain("defineMatterRoute");
  });

  it("stops the suite for a write, and for a route that takes the matter under another name", async () => {
    const error = await failure(
      run(
        {
          beforeRoutes: (app) =>
            void app.post("/api/matters/:id/transfer", (c) => c.json({ moved: true }, 201)),
        },
        ["matrix"],
      ),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("POST /api/matters/:id/transfer");
  });

  it("stops the suite for app.all on a path the table does not have", async () => {
    const error = await failure(
      run(
        { beforeRoutes: (app) => void app.all("/matters/:matterId/anything", (c) => c.text("")) },
        ["matrix"],
      ),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("ALL /matters/:matterId/anything");
  });

  it("stops the suite for a generic route that would answer a matter's URL", async () => {
    const error = await failure(
      run({ beforeRoutes: (app) => void app.get("/:a/:b/:c", (c) => c.json({})) }, ["matrix"]),
    );
    expect(error.name).toBe("ExposureSuiteUnavailable");
    expect(error.message).toContain("would answer a URL that names a matter");
    expect(error.message).toContain("answered by GET /:a/:b/:c");
  });

  it("probes a route of that kind that the table does have, as every caller, and counts what it gives away", async () => {
    // A write registered by hand: no guard, no token check, an answer for anyone.
    const result = await run(
      {
        beforeRoutes: (app) =>
          void app.post("/api/matters/:matterId/members", (c) => c.json({}, 201)),
      },
      ["matrix"],
    );
    // Every caller but the associate (the only role that may add a member), in each of two modes.
    expect(result.probesAnsweredWithData).toBe(6 * 2);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(
      new Set(["reviewer", "viewer", "outsider", "stranger", "admin", "anonymous"]),
    );
    expect(
      result.exposed.every((cell) => cell.probe === "POST /api/matters/:matterId/members"),
    ).toBe(true);
    expect(result.byReason.handler_answered).toBe(6 * 2);
  });

  it("lets a wildcard middleware through, because it answers nothing itself", async () => {
    const result = await run(
      {
        beforeRoutes: (app) =>
          void app.use("/api/matters/*", async (_c, next) => {
            await next();
          }),
      },
      ["matrix"],
    );
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// #31: an id of another matter in a request for this one
// ---------------------------------------------------------------------------------------------

describe("a lookup that ignores the matter", () => {
  it("is counted when a run, a finding or a memo of another matter is read through this one", async () => {
    const result = await run(
      {
        beforeRoutes: (_app, deps) => {
          const owner = ownerOf(deps);
          const repo = deps.repo as unknown as Record<string, (...a: string[]) => unknown>;
          for (const [method, table] of [
            ["getRun", "runs"],
            ["getFinding", "findings"],
            ["getMemo", "memos"],
          ] as const) {
            const real = repo[method]!.bind(deps.repo);
            repo[method] = (matterId, id) =>
              real(matterId!, id!) ??
              (owner(table, id!) === undefined ? undefined : real(owner(table, id!)!, id!));
          }
        },
      },
      ["forged"],
    );
    expect(result.forgedCells).toBe(FORGED_PROBES.length * 2);
    expect(result.matrixCells).toBe(0);
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
    expect(result.byReason.handler_answered).toBeGreaterThan(0);
    expect(result.byReason.carried_data).toBeGreaterThan(0);
    // Reads of the run, its status page, its findings, the finding and the memo file, in two modes.
    const reads = [
      "GET /api/matters/:matterId/runs/:runId",
      "GET /api/matters/:matterId/findings/:findingId",
    ];
    for (const read of reads)
      expect(result.exposed.some((cell) => cell.probe.startsWith(read))).toBe(true);
    // Only the forged cells are exposed: the matrix was not run, and every cell names the place of the id.
    expect(result.exposed.every((cell) => cell.probe.includes(" in the "))).toBe(true);
  });

  it("is counted when a document of another matter is removed through this one, and that matter's rows change", async () => {
    const result = await run(
      {
        beforeRoutes: (_app, deps) => {
          const owner = ownerOf(deps);
          const repo = deps.repo as unknown as Record<string, (...a: unknown[]) => unknown>;
          // The check of the document and the removal both look the document up by its id alone.
          for (const method of ["getDocument", "removeDocument"]) {
            const real = repo[method]!.bind(deps.repo);
            repo[method] = (matterId, documentId, ...rest) =>
              real(owner("documents", documentId as string) ?? matterId, documentId, ...rest);
          }
        },
      },
      ["forged"],
    );
    // The page removes the other matter's amendment (a redirect, which is not a success): only the
    // rows say so. The same request through the API finds the document gone, as it would any other.
    const removed = result.exposed.filter(
      (cell) =>
        cell.probe ===
        "POST /matters/:matterId/documents/:documentId/remove (document in the path)",
    );
    expect(removed).toHaveLength(2);
    expect(removed.every((cell) => cell.reasons.includes("changed_state"))).toBe(true);
    expect(result.byReason.changed_state).toBe(2);
    expect(result.byReason.handler_answered).toBe(0);
  });

  it("is counted when only the answer differs: a header that says the record exists elsewhere", async () => {
    const result = await run(
      {
        beforeRoutes: (app, deps) => {
          const owner = ownerOf(deps);
          for (const prefix of ["/matters/*", "/api/matters/*"])
            app.use(prefix, async (c, next) => {
              await next();
              const parts = c.req.path.split("/");
              const at = parts.indexOf("runs");
              const id = at === -1 ? undefined : parts[at + 1];
              if (id !== undefined && owner("runs", id) !== undefined)
                c.res.headers.set("x-record", "exists");
            });
        },
      },
      ["forged"],
    );
    const inPath = FORGED_PROBES.filter(
      (probe) => probe.position === "run" && probe.via === "path",
    );
    expect(inPath.length).toBeGreaterThanOrEqual(8);
    expect(result.probesAnsweredWithData).toBe(inPath.length * 2);
    expect(result.byReason.refusal_differs).toBe(inPath.length * 2);
    expect(result.byReason.handler_answered).toBe(0);
    expect(result.byReason.carried_data).toBe(0);
  });

  it("is not a finding when the request never reaches the lookup: that cell is a mismatch that did not reach its handler", async () => {
    // Every write under a matter is turned away before the guard, as a rule on the request might.
    const result = await run(
      {
        beforeRoutes: (app) => {
          for (const prefix of ["/matters/*", "/api/matters/*"])
            app.use(prefix, async (c, next) => {
              if (c.req.method === "GET") return next();
              return c.json({ error: { kind: "blocked" } }, 403);
            });
        },
      },
      ["forged"],
    );
    const writes = FORGED_PROBES.filter((probe) => probe.method !== "GET");
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.letInNotReached).toBe(writes.length * 2);
    expect(result.mismatches).toBe(result.letInNotReached);
  });
});

// ---------------------------------------------------------------------------------------------
// #34: the answer for a matter that does not exist is fictional in every segment
// ---------------------------------------------------------------------------------------------

describe("an existence oracle on a sub-resource id", () => {
  it("is counted when a refusal for a person with no part in the matter differs only because the run exists", async () => {
    const result = await run(
      {
        beforeRoutes: (app, deps) => {
          const owner = ownerOf(deps);
          // The status is still the one for a matter that does not exist. Only a header tells that
          // the run in the URL is real, wherever the matter in the URL points.
          for (const prefix of ["/matters/*", "/api/matters/*"])
            app.use(prefix, async (c, next) => {
              await next();
              const parts = c.req.path.split("/");
              const at = parts.indexOf("runs");
              const id = at === -1 ? undefined : parts[at + 1];
              if (c.res.status === 404 && id !== undefined && owner("runs", id) !== undefined)
                c.res.headers.set("x-record", "exists");
            });
        },
      },
      ["matrix"],
    );
    const runRoutes = MATTER_PROBES.filter((probe) => probe.template.includes(":runId"));
    // The outsider, the stranger and the administrator, on every route that names a run, in two modes.
    expect(result.byReason.refusal_differs).toBe(runRoutes.length * 3 * 2);
    expect(result.probesAnsweredWithData).toBe(runRoutes.length * 3 * 2);
    expect(result.byReason.handler_answered).toBe(0);
    expect(result.byReason.carried_data).toBe(0);
    expect(result.exposed.every((cell) => cell.reasons.join() === "refusal_differs")).toBe(true);
    expect(result.exposed.every((cell) => cell.probe.includes(":runId"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// #32: a let-in cell that never reaches its handler
// ---------------------------------------------------------------------------------------------

describe("cells that never reach the handler", () => {
  it("are counted apart, are not an exposure, are in the sentence, and do not stop the suite", async () => {
    // A rule on the request that the probe client does not meet, before the guard, for every write.
    const result = await run(
      {
        beforeRoutes: (app) => {
          for (const prefix of ["/matters/*", "/api/matters/*"])
            app.use(prefix, async (c, next) => {
              if (c.req.method === "GET") return next();
              return c.json({ error: { kind: "forbidden" } }, 403);
            });
        },
      },
      ["matrix", "effects"],
    );
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.letInNotReached).toBeGreaterThan(30);
    expect(result.mismatches).toBeGreaterThanOrEqual(result.letInNotReached);
    // The role-refused writes match vacuously (a 403 where a 403 is expected), so they are not counted as missed.
    expect(result.mismatches).toBeGreaterThan(result.letInNotReached);
    expect(result.sentence).toContain(
      `${result.letInNotReached} of them cells whose caller should have been let in and was not`,
    );
    expect(result.sentence).toContain("did not reach their handler");
    expect(result.sentence).not.toContain(
      "every cell whose caller should have been let in reached",
    );
    // The writes were never shown to change the store, and the sentence does not say they were.
    expect(result.writesWithEffect).toBeLessThan(result.writeRoutes - 4);
    // The record carries both numbers, which is what gate G1 reads.
    const record = composeExposureRecord({
      authorization: result,
      canary: {
        artefactsScanned: 1,
        canaryHits: 0,
        foreignSpanIdHits: 0,
        factSightings: 0,
        sentence: "x.",
      },
      uploads: { sentence: "x." },
    });
    expect(record.letInNotReached).toBe(result.letInNotReached);
    expect(record.mismatches).toBe(result.mismatches);
    expect(exposureCount(record)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// #35: what a refused caller could change
// ---------------------------------------------------------------------------------------------

describe("a refused caller that changes the store", () => {
  it("is counted when a row is updated and the number of rows is the same", async () => {
    const result = await run(
      {
        beforeRoutes: (app, deps) => {
          // An update, not an insert or a delete: a count of rows would not move.
          app.patch("/api/matters/:matterId", (c) => {
            deps.repo.db
              .prepare("UPDATE matters SET name = name || '!' WHERE id = ?")
              .run(c.req.param("matterId"));
            return c.json({ done: true });
          });
        },
      },
      ["matrix"],
    );
    // Every caller but the associate, in two modes.
    expect(result.byReason.changed_state).toBe(6 * 2);
    expect(result.byReason.handler_answered).toBe(6 * 2);
  });

  it("is counted on a route that checks its body first, because the callers who must be refused are sent a body that is good", async () => {
    const hook: SiteHooks = {
      beforeRoutes: (app, deps) => {
        app.post("/api/matters/:matterId/members", async (c) => {
          const body = (await c.req.json().catch(() => ({}))) as {
            userId?: unknown;
            role?: unknown;
          };
          if (typeof body.userId !== "string" || typeof body.role !== "string")
            return c.json({ error: { kind: "invalid_request" } }, 400);
          deps.repo.addMember(c.req.param("matterId"), body.userId, body.role as "viewer", {
            actorId: body.userId,
          });
          return c.json({ members: [] }, 201);
        });
      },
    };
    // With the body that is built to change nothing, the route answers 400 to everyone, as it
    // does for a matter that does not exist: nothing is found. That is the blind spot.
    const blind = await run(hook, ["matrix"]);
    expect(blind.byReason.changed_state).toBe(0);
    expect(blind.probesAnsweredWithData).toBe(0);
    // With a body that would add a member, the refused callers are found.
    const seen = await run(hook, ["matrix", "effects"]);
    expect(seen.byReason.changed_state).toBeGreaterThan(0);
    expect(seen.byReason.handler_answered).toBeGreaterThan(0);
    expect(
      new Set(seen.exposed.map((cell) => cell.actor)).has("outsider") &&
        new Set(seen.exposed.map((cell) => cell.actor)).has("anonymous"),
    ).toBe(true);
    expect(seen.exposed.every((cell) => cell.probe === "POST /api/matters/:matterId/members")).toBe(
      true,
    );
  });

  it("is told apart from the control: a body that changes nothing for a caller who is let in stops the suite", async () => {
    const failed = await failure(
      run(
        {
          beforeRoutes: (_app, deps) => {
            const repo = deps.repo as unknown as Record<string, (...a: unknown[]) => unknown>;
            const real = repo.addMember!.bind(deps.repo);
            // The person the probes add is never added: the body is good and still changes nothing.
            repo.addMember = (matterId, userId, role, opts) =>
              userId === "usr_exposure_invitee" ? undefined : real(matterId, userId, role, opts);
          },
        },
        ["matrix", "effects"],
      ),
    );
    expect(failed).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(failed.message).toContain("POST /api/matters/:matterId/members");
    expect(failed.message).toContain("No count can be trusted");
  });
});

// ---------------------------------------------------------------------------------------------
// #36: a person who is a member of another matter
// ---------------------------------------------------------------------------------------------

describe("a member of another matter", () => {
  it("is counted when a membership of any matter is taken for a membership of this one, on the writes too", async () => {
    const result = await run(
      {
        beforeRoutes: (_app, deps) => {
          const real = deps.repo.getMember;
          // An unscoped lookup: the first role the person holds anywhere.
          (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) => {
            const own = real(matterId, userId);
            if (own !== undefined || userId !== STRANGER) return own;
            const row = deps.repo.db
              .prepare(
                "SELECT role, granted_by AS grantedBy, granted_at AS grantedAt FROM matter_members WHERE user_id = ? ORDER BY role LIMIT 1",
              )
              .get(userId) as { role: string; grantedBy: string; grantedAt: string } | undefined;
            return row === undefined ? undefined : { matterId, userId, ...row };
          };
        },
      },
      ["matrix"],
    );
    // The stranger, and nobody else: the outsider belongs to no matter, and is still refused.
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(["stranger"]));
    expect(result.probesAnsweredWithData).toBeGreaterThanOrEqual(2 * 20);
    expect(result.exposed.length).toBeGreaterThan(0);
    // Writes are among the cells found, not only reads.
    expect(result.byReason.handler_answered).toBeGreaterThanOrEqual(2 * 20);
  });

  it("is not found by a person who belongs to no matter at all", async () => {
    // The same hole, aimed at the outsider, who has no membership to be mistaken for another.
    const result = await run(
      {
        beforeRoutes: (_app, deps) => {
          const real = deps.repo.getMember;
          (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) => {
            const own = real(matterId, userId);
            if (own !== undefined || userId !== OUTSIDER) return own;
            const row = deps.repo.db
              .prepare(
                "SELECT role, granted_by AS grantedBy, granted_at AS grantedAt FROM matter_members WHERE user_id = ? ORDER BY role LIMIT 1",
              )
              .get(userId) as { role: string; grantedBy: string; grantedAt: string } | undefined;
            return row === undefined ? undefined : { matterId, userId, ...row };
          };
        },
      },
      ["matrix"],
    );
    expect(result.probesAnsweredWithData).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// #33: the routes that name no matter
// ---------------------------------------------------------------------------------------------

describe("a list that shows a person matters they have no part in", () => {
  /** Adds the title and id of every matter to the answer of GET /api/matters, for whoever `who` picks. */
  const leakTo =
    (
      who: (userId: string, globalRole: string) => boolean,
    ): NonNullable<SiteHooks["beforeRoutes"]> =>
    (app, deps) => {
      app.use("/api/matters", async (c, next) => {
        await next();
        if (c.req.method !== "GET" || c.res.status !== 200) return;
        const principal = readPrincipal(c);
        if (principal === null || !who(principal.userId, principal.globalRole)) return;
        const all = deps.repo.db.prepare("SELECT id, name FROM matters").all();
        c.res = new Response(JSON.stringify({ matters: all }), {
          status: 200,
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      });
    };

  it("is counted when the administrator, the one caller with a global role, is shown every matter", async () => {
    const result = await run({ beforeRoutes: leakTo((_id, role) => role === "admin") }, ["lists"]);
    expect(result.listCells).toBeGreaterThan(90);
    expect(result.probesAnsweredWithData).toBe(2);
    expect(result.exposed.map((cell) => `${cell.probe} as ${cell.actor}`)).toEqual([
      "GET /api/matters as admin",
      "GET /api/matters as admin",
    ]);
    expect(result.byReason.carried_data).toBe(2);
  });

  it("is counted when a signed-in person with no membership is shown every matter", async () => {
    const result = await run({ beforeRoutes: leakTo((id) => id === OUTSIDER) }, ["lists"]);
    expect(result.probesAnsweredWithData).toBe(2);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(["outsider"]));
  });

  it("is counted when a member of one matter is shown the other, and the first one's member is not exempt from the second", async () => {
    const result = await run({ beforeRoutes: leakTo(() => true) }, ["lists"]);
    // Everyone signed in sees both matters: each is a member of at most one of them. The visitor is turned away.
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(
      new Set(["associate", "reviewer", "viewer", "outsider", "stranger", "admin"]),
    );
    expect(result.probesAnsweredWithData).toBe(6 * 2);
  });

  it("is counted when a visitor is answered by a route that needs a person", async () => {
    const result = await run(
      { beforeRoutes: (app) => void app.get("/api/playbooks", (c) => c.json({ playbooks: [] })) },
      ["lists"],
    );
    expect(result.probesAnsweredWithData).toBe(2);
    expect(result.exposed.every((cell) => cell.actor === "anonymous")).toBe(true);
    expect(result.byReason.handler_answered).toBe(2);
  });

  it("is told apart from a list that hides nothing: the real application gives none", async () => {
    const result = await run({}, ["lists"]);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.mismatches).toBe(0);
  });
});
