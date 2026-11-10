import { beforeAll, describe, expect, it, vi } from "vitest";
import { readPrincipal } from "../../apps/parol/src/auth/identity.js";
import type { Dataset } from "../src/parol/dataset.js";
import { textWindows } from "../src/parol/exposure/authorization.js";
import { composeExposureRecord } from "../src/parol/exposure/index.js";
import {
  LIST_PROBES,
  MATTER_PROBES,
  type OtherProbe,
  type Probe,
} from "../src/parol/exposure/probes.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { exposureCount } from "../src/parol/suites.js";
import { OUTSIDER, STRANGER, failure, runWith } from "./parol-authz-support.js";
import { completeDataset, reviewedUnder } from "./parol-exposure-support.js";

/**
 * The checks the authorization suite makes on itself, and what it does when a request does not
 * reach the handler it was written to test. A count of zero out of requests that never got to the
 * code under test says nothing, so each of these has to stop the run, or take the gate out of
 * evaluation, and say so.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});
const run = runWith(() => dataset);

const JSON_HEADERS = { "content-type": "application/json; charset=UTF-8" };

// ---------------------------------------------------------------------------------------------
// A body meant to change the store that is stopped before the guard
// ---------------------------------------------------------------------------------------------

describe("a control request that is stopped before the guard", () => {
  /** Turns away, before any route, a write whose body `blocks` says is the body meant to change the store. */
  const blockBodies =
    (blocks: (body: string, type: string) => boolean): NonNullable<SiteHooks["beforeRoutes"]> =>
    (app) =>
      void app.use("*", async (c, next) => {
        if (c.req.method !== "GET") {
          const body = await c.req.raw.clone().text();
          if (blocks(body, c.req.header("content-type") ?? ""))
            return c.json({ error: { kind: "blocked" } }, 403);
        }
        await next();
      });

  const recordOf = (authorization: Awaited<ReturnType<typeof run>>) =>
    composeExposureRecord({
      workflow: reviewedUnder(),
      authorization,
      canary: {
        artefactsScanned: 1,
        canaryHits: 0,
        foreignSpanIdHits: 0,
        factSightings: 0,
        sentence: "x.",
      },
      uploads: { sentence: "x." },
    });

  it("is counted as a cell whose caller should have been let in and was not, and does not stop the suite", async () => {
    // The person the writes try to add is named in two bodies: the page form and the API's, in two modes.
    const result = await run(
      { beforeRoutes: blockBodies((body) => body.includes("usr_exposure_invitee")) },
      ["matrix", "effects"],
    );
    expect(result.letInNotReached).toBe(2 * 2);
    expect(result.mismatches).toBeGreaterThanOrEqual(result.letInNotReached);
    expect(result.probesAnsweredWithData).toBe(0);
    // The suite still ran every cell: the control request is not a cell, so it is not counted among them.
    expect(result.matrixCells).toBe(MATTER_PROBES.length * 7 * 2);
    expect(result.probesRun).toBe(result.matrixCells);
    // The record carries both numbers, which is what gate G1 reads to leave the gate not evaluated.
    const record = recordOf(result);
    expect(record.letInNotReached).toBe(result.letInNotReached);
    expect(record.mismatches).toBe(result.mismatches);
    expect(exposureCount(record)).toBe(0);
  });

  it("takes the routes out of the count of those proven to change the store, and says what happened to them in the sentence", async () => {
    const result = await run(
      { beforeRoutes: blockBodies((body) => body.includes("usr_exposure_invitee")) },
      ["matrix", "effects"],
    );
    expect(result.writesWithoutBody).toHaveLength(4);
    expect(result.writesUnproven).toBe(2);
    expect(result.writesWithEffect).toBe(
      result.writeRoutes - result.writesWithoutBody.length - result.writesUnproven,
    );
    expect(result.sentence).toContain("stopped before the guard");
    expect(result.sentence).toContain(
      `${result.letInNotReached} of them cells whose caller should have been let in and was not`,
    );
    expect(result.sentence).toContain("did not reach their handler");
    // What it used to say of the routes it dropped: that they cannot change the store.
    expect(result.sentence).not.toContain("cannot change");
    expect(result.sentence).not.toContain("answered the same whoever sends them");
    expect(result.sentence).not.toContain(
      "every cell whose caller should have been let in reached",
    );
  });

  it("is counted for every route whose body is stopped, in both modes: the multipart bodies that carry a file", async () => {
    const result = await run(
      {
        beforeRoutes: blockBodies(
          (body, type) => type.startsWith("multipart/") && body.includes("amendment-2.txt"),
        ),
      },
      ["matrix", "effects"],
    );
    // The page and the API, for a new document and for a new version, in two modes.
    expect(result.letInNotReached).toBe(4 * 2);
    expect(result.writesUnproven).toBe(4);
    expect(result.mismatches).toBeGreaterThanOrEqual(result.letInNotReached);
    expect(result.sentence).toContain("stopped before the guard");
  });

  it("says that no write route was shown to change the store when every write under a matter was turned away, and not that their bodies change nothing", async () => {
    // A rule before the routes (a CSRF layer, a firewall) that answers every write under a matter with a refusal.
    const result = await run(
      {
        beforeRoutes: (app) =>
          void app.use("*", async (c, next) => {
            const path = new URL(c.req.url).pathname;
            if (c.req.method !== "GET" && /^(?:\/api)?\/matters\//.test(path))
              return c.json({ error: { kind: "blocked" } }, 403);
            await next();
          }),
      },
      ["matrix", "effects"],
    );
    // Not one body reached a handler, so no route was shown to change the store; four have no body at all.
    expect(result.writesWithEffect).toBe(0);
    expect(result.writesWithoutBody).toHaveLength(4);
    expect(result.writesUnproven).toBe(result.writeRoutes - 4);
    expect(result.writesUnproven).toBeGreaterThan(0);
    expect(result.letInNotReached).toBeGreaterThan(0);
    expect(result.probesAnsweredWithData).toBe(0);
    const { sentence } = result;
    expect(sentence).toContain(
      `none of the ${result.writeRoutes} write routes was shown to have a body that changes the store for a caller who is let in`,
    );
    expect(sentence).toContain(
      `${result.writesUnproven} had one that was stopped before the guard`,
    );
    expect(sentence).toContain("4, ending in resume and cancel, have none");
    // The old words said the opposite of what happened: that no write route was sent a body, and that such bodies change nothing.
    expect(sentence).not.toContain("was sent one");
    expect(sentence).not.toContain("change nothing even if they get through");
    expect(sentence).toContain("did not reach their handler and so tested nothing past the guard");
  });

  it("is told apart from a body that the guard let in and that changed nothing, which stops the run", async () => {
    // Not stopped before the guard: let in, and nothing changes. That is the control failing.
    const error = await failure(
      run(
        {
          beforeRoutes: (_app, deps) => {
            const repo = deps.repo as unknown as Record<string, (...a: unknown[]) => unknown>;
            const real = repo.addMember!.bind(deps.repo);
            repo.addMember = (matterId, userId, role, opts) =>
              userId === "usr_exposure_invitee" ? undefined : real(matterId, userId, role, opts);
          },
        },
        ["matrix", "effects"],
      ),
    );
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
  });
});

// ---------------------------------------------------------------------------------------------
// The controls: the check for data has to be able to see data
// ---------------------------------------------------------------------------------------------

describe("the title of a matter in the list its member reads", () => {
  /** Empties the list for whoever `who` picks. */
  const emptiedFor =
    (who: (userId: string) => boolean): NonNullable<SiteHooks["beforeRoutes"]> =>
    (app) =>
      void app.use("/api/matters", async (c, next) => {
        await next();
        const principal = readPrincipal(c);
        if (c.req.method !== "GET" || c.res.status !== 200) return;
        if (principal === null || !who(principal.userId)) return;
        c.res = new Response('{"matters":[]}', { status: 200, headers: JSON_HEADERS });
      });

  it("stops the run, with exit code 2, when the list is empty for everyone", async () => {
    const error = await failure(run({ beforeRoutes: emptiedFor(() => true) }, ["lists"]));
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(error.message).toContain("title in the list its member reads");
    expect(error.message).toContain("No count can be trusted");
  });

  it("stops the run, with exit code 2, when the list is empty for the member of the second matter alone", async () => {
    const error = await failure(
      run({ beforeRoutes: emptiedFor((id) => id === STRANGER) }, ["lists"]),
    );
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(error.message).toContain("title in the list its member reads");
  });
});

describe("the ids of the second matter in what its member reads", () => {
  it("stops the run, with exit code 2, when its member is shown nothing of it", async () => {
    const error = await failure(
      run(
        {
          beforeRoutes: (app) =>
            void app.use("/api/matters/*", async (c, next) => {
              await next();
              if (c.req.method !== "GET" || c.res.status !== 200) return;
              if (readPrincipal(c)?.userId !== STRANGER) return;
              c.res = new Response("{}", { status: 200, headers: JSON_HEADERS });
            }),
        },
        ["forged"],
      ),
    );
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(error.message).toContain("second matter's ids");
    expect(error.message).toContain("No count can be trusted");
  });
});

// ---------------------------------------------------------------------------------------------
// The tables of probes must be the application's routes
// ---------------------------------------------------------------------------------------------

describe("a probe for a route that the application does not have", () => {
  it("stops the suite when it is in the table of the routes that name a matter", async () => {
    const table = MATTER_PROBES as unknown as Probe[];
    table.push({ ...MATTER_PROBES[0]!, template: "/matters/:matterId/no-such-route" });
    try {
      const error = await failure(run({}, ["lists"]));
      expect(error.name).toBe("ExposureSuiteUnavailable");
      expect(error.message).toContain("probes for routes the application does not have");
      expect(error.message).toContain("GET /matters/:matterId/no-such-route");
    } finally {
      table.pop();
    }
    expect(MATTER_PROBES.some((probe) => probe.template.includes("no-such-route"))).toBe(false);
  });

  it("stops the suite when it is in the list of the routes that name no matter", async () => {
    const table = LIST_PROBES as unknown as OtherProbe[];
    table.push({
      method: "GET",
      template: "/api/no-such-list",
      access: "principal",
      body: { kind: "none" },
    });
    try {
      const error = await failure(run({}, ["lists"]));
      expect(error.name).toBe("ExposureSuiteUnavailable");
      expect(error.message).toContain("has routes the application does not have");
      expect(error.message).toContain("GET /api/no-such-list");
    } finally {
      table.pop();
    }
    expect(LIST_PROBES.some((probe) => probe.template.includes("no-such-list"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// A refusal or a list that carries only a window of a document's text
// ---------------------------------------------------------------------------------------------

describe("a body that holds a window of a document's text and nothing else", () => {
  /** Answers the outsider's refusals, and the list it reads, with a stretch of a document, in the status they had. */
  const leaksText: NonNullable<SiteHooks["beforeRoutes"]> = (app, deps) =>
    void app.use("*", async (c, next) => {
      await next();
      if (readPrincipal(c)?.userId !== OUTSIDER) return;
      const path = c.req.path;
      const refused =
        c.res.status === 404 && (path.startsWith("/matters/") || path.startsWith("/api/matters/"));
      const listed = c.req.method === "GET" && path === "/api/matters" && c.res.status === 200;
      if (!refused && !listed) return;
      const texts = (
        deps.repo.db.prepare("SELECT text FROM source_spans").all() as { text: string }[]
      ).map((row) => row.text);
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(textWindows(texts, 1)[0]!, { status: c.res.status, headers });
    });

  it("is counted as data in the refusals of the matrix, though no title and no id is in it", async () => {
    const result = await run({ beforeRoutes: leaksText }, ["matrix"]);
    expect(result.byReason.carried_data).toBeGreaterThan(0);
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
    expect(new Set(result.exposed.map((cell) => cell.actor))).toEqual(new Set(["outsider"]));
  });

  it("is counted as data in the list that a person with no matter reads", async () => {
    const result = await run({ beforeRoutes: leaksText }, ["lists"]);
    expect(result.byReason.carried_data).toBe(2);
    expect(result.probesAnsweredWithData).toBe(2);
    expect(result.exposed.map((cell) => `${cell.probe} as ${cell.actor}`)).toEqual([
      "GET /api/matters as outsider",
      "GET /api/matters as outsider",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// A list route that fails for everyone
// ---------------------------------------------------------------------------------------------

describe("a list route that answers 500 to everyone", () => {
  it("is counted as cells whose caller should have been let in and was not, so that gate G1 is not evaluated", async () => {
    const result = await run(
      { beforeRoutes: (app) => void app.get("/api/playbooks", (c) => c.json({}, 500)) },
      ["lists"],
    );
    // Six callers are to be let in, in two modes; the visitor is told to sign in and gets a 500 instead.
    expect(result.letInNotReached).toBe(6 * 2);
    expect(result.mismatches).toBe(7 * 2);
    expect(result.mismatches).toBeGreaterThan(result.letInNotReached);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.sentence).toContain("cells whose caller should have been let in and was not");
    expect(result.sentence).not.toContain(
      "every cell whose caller should have been let in reached",
    );
  });
});
