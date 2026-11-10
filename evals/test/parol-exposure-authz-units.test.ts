import { describe, expect, it } from "vitest";
import { createRepository, openDatabase } from "../../apps/parol/src/store/index.js";
import {
  ACTORS,
  AUTHORIZATION_SENTENCE_BUDGET,
  SENTENCE_CUT,
  UNROUTED_ACTORS,
  classifyForged,
  classifyListing,
  classifyUnrouted,
  expectedFor,
  expectedList,
  fingerprint,
  sentenceLadder,
  sentenceOf,
  storeWatch,
  type AuthorizationResult,
  type Expected,
  type Observed,
  type Snapshot,
} from "../src/parol/exposure/authorization.js";
import {
  EFFECT_KEYS,
  FORGED_BODY_KEYS,
  FORGED_PROBES,
  LIST_PROBES,
  MATTER_PROBES,
  NO_RECORD,
  UNROUTED_METHODS,
  effectOf,
  forgedProbesFor,
  initFor,
  isApi,
  noRecordIds,
  pathFor,
  probeKeyOf,
  subResourcesOf,
  unroutedRequests,
  type Probe,
  type ProbeIds,
  type Scratch,
} from "../src/parol/exposure/probes.js";
import { SUITE_SENTENCE_MAX } from "../src/parol/results.js";
import { longestExposed, worstResult } from "./parol-authz-support.js";
import { DASHES, ID_SHAPE } from "./parol-exposure-support.js";

/**
 * The classifiers of the forged-id cells and of the lists, the store hash, the sentence and the
 * tables of the authorization half of the exposure suite, on synthetic values made for the test.
 */

const notFound: Snapshot = {
  status: 404,
  headers: [["content-type", "application/json"]],
  body: '{"error":{"kind":"not_found"}}',
};
const observed = (over: Partial<Observed> = {}): Observed => ({
  ...notFound,
  letIn: true,
  stateChanged: false,
  ...over,
});
const forbidden = ["Second Matter Title", "run_00000000feedface"];

describe("a forged-id cell", () => {
  const classify = (seen: Observed, expectedStatus = 404, invented: Snapshot = notFound) =>
    classifyForged({ expectedStatus, observed: seen, invented, forbidden });

  it("is expected when the member is let in and gets the answer for an id of no record", () => {
    expect(classify(observed())).toEqual({ verdict: "expected" });
  });

  it("is an exposure when it succeeds, whatever it holds", () => {
    expect(classify(observed({ status: 200, body: "{}" }))).toMatchObject({
      verdict: "exposure",
      reasons: expect.arrayContaining(["handler_answered"]),
    });
    expect(classify(observed({ status: 204, body: "" }))).toMatchObject({ verdict: "exposure" });
  });

  it("is an exposure when the body holds the title or an id of the other matter", () => {
    for (const leak of forbidden)
      expect(classify(observed({ body: `see ${leak.toUpperCase()}` }))).toMatchObject({
        verdict: "exposure",
        reasons: expect.arrayContaining(["carried_data"]),
      });
  });

  it("is an exposure when the answer differs from the one for an id of no record in status, header or body", () => {
    for (const change of [
      { status: 403 },
      { status: 409 },
      { body: '{"error":{"kind":"conflict"}}' },
      { headers: [...notFound.headers, ["x-record", "exists"]] as [string, string][] },
    ])
      expect(classify(observed(change))).toMatchObject({
        verdict: "exposure",
        reasons: ["refusal_differs"],
      });
  });

  it("is an exposure when a row of the store changed, whatever the answer", () => {
    expect(classify(observed({ stateChanged: true }))).toMatchObject({
      verdict: "exposure",
      reasons: ["changed_state"],
    });
  });

  it("is a mismatch, and not an exposure, when it did not get to the lookup: the same answer as for no record, but not 404", () => {
    const invalid: Snapshot = { ...notFound, status: 400 };
    expect(classify(observed({ status: 400 }), 404, invalid)).toEqual({ verdict: "mismatch" });
  });

  it("is a mismatch when the guard did not let the member in, though the answer is the right one", () => {
    expect(classify(observed({ letIn: false }))).toEqual({ verdict: "mismatch" });
  });

  it("takes a 200 for a page that ignores a finding it cannot select, and counts the page that shows it", () => {
    const page: Snapshot = {
      status: 200,
      headers: [["content-type", "text/html"]],
      body: "<p>none</p>",
    };
    expect(classify(observed({ ...page }), 200, page)).toEqual({ verdict: "expected" });
    const shown = observed({ ...page, body: "<p>run_00000000feedface</p>" });
    expect(classify(shown, 200, page)).toMatchObject({
      verdict: "exposure",
      reasons: expect.arrayContaining(["carried_data", "refusal_differs"]),
    });
  });
});

describe("a read of a route that names no matter", () => {
  const letIn: Expected = { kind: "let_in", status: 200 };
  const visitor: Expected = { kind: "refused", status: 401, caller: "visitor" };
  const classify = (expected: Expected, seen: Observed) =>
    classifyListing({ expected, observed: seen, forbidden });

  it("is expected when the answer is the right status and holds nothing of a matter the caller has no part in", () => {
    expect(classify(letIn, observed({ status: 200, body: "{}" }))).toEqual({ verdict: "expected" });
    expect(classify(visitor, observed({ status: 401 }))).toEqual({ verdict: "expected" });
  });

  it("is an exposure when the body holds the title or an id of a matter the caller has no part in", () => {
    expect(classify(letIn, observed({ status: 200, body: "Second Matter Title" }))).toMatchObject({
      verdict: "exposure",
      reasons: ["carried_data"],
    });
  });

  it("is an exposure when a visitor is answered with a success", () => {
    expect(classify(visitor, observed({ status: 200, body: "{}" }))).toMatchObject({
      verdict: "exposure",
      reasons: ["handler_answered"],
    });
  });

  it("is a mismatch when a person who should be answered is not", () => {
    expect(classify(letIn, observed({ status: 500, body: "" }))).toEqual({ verdict: "mismatch" });
  });

  it("sends a visitor to the start page on a page, and tells a script on the API", () => {
    const page = LIST_PROBES.find((probe) => probe.template === "/matters")!;
    const api = LIST_PROBES.find((probe) => probe.template === "/api/matters")!;
    const open = LIST_PROBES.find((probe) => probe.access === "public")!;
    expect(expectedList(page, "anonymous")).toEqual({
      kind: "refused",
      status: 303,
      caller: "visitor",
      location: "/",
    });
    expect(expectedList(api, "anonymous")).toEqual({
      kind: "refused",
      status: 401,
      caller: "visitor",
    });
    expect(expectedList(open, "anonymous")).toEqual({ kind: "let_in", status: 200 });
    for (const actor of ["associate", "outsider", "admin"] as const)
      expect(expectedList(api, actor)).toEqual({ kind: "let_in", status: 200 });
  });

  it("reads the routes that only read, and none of the posts that would sign a client in or out", () => {
    expect(LIST_PROBES.length).toBeGreaterThanOrEqual(5);
    expect(LIST_PROBES.every((probe) => probe.method === "GET")).toBe(true);
    const templates = LIST_PROBES.map((probe) => probe.template);
    for (const wanted of ["/", "/matters", "/api/matters", "/api/playbooks"])
      expect(templates).toContain(wanted);
  });
});

describe("a request to a URL that no route owns", () => {
  const reference: Snapshot = notFound;
  const classify = (seen: Observed) => classifyUnrouted({ observed: seen, reference, forbidden });

  it("is expected when the answer is the 404 that a URL nothing owns gets", () => {
    expect(classify(observed({ letIn: false }))).toEqual({ verdict: "expected" });
  });

  it("is an exposure when anything but that 404 answers it, a refusal or a redirect included, because a handler answered", () => {
    for (const status of [200, 201, 204, 303, 400, 401, 403, 405, 500])
      expect(classify(observed({ status, letIn: false })), String(status)).toMatchObject({
        verdict: "exposure",
        reasons: expect.arrayContaining(["handler_answered"]),
      });
  });

  it("is an exposure when the guard let a caller in, whatever the status", () => {
    expect(classify(observed({ letIn: true }))).toMatchObject({
      verdict: "exposure",
      reasons: ["handler_answered"],
    });
  });

  it("is an exposure when a 404 holds data of a matter, or a row changed, or the 404 is not the reference", () => {
    expect(classify(observed({ letIn: false, body: "Second Matter Title" }))).toMatchObject({
      reasons: expect.arrayContaining(["carried_data"]),
    });
    expect(classify(observed({ letIn: false, stateChanged: true }))).toMatchObject({
      reasons: ["changed_state"],
    });
    expect(classify(observed({ letIn: false, body: '{"error":{"kind":"gone"}}' }))).toMatchObject({
      verdict: "exposure",
      reasons: ["refusal_differs"],
    });
    expect(
      classify(observed({ letIn: false, headers: [...notFound.headers, ["x-extra", "1"]] })),
    ).toMatchObject({ verdict: "exposure", reasons: ["refusal_differs"] });
  });

  it("is sent by a visitor, an outsider and a member, in every method, to shapes that no route owns", () => {
    expect([...UNROUTED_ACTORS]).toEqual(["anonymous", "outsider", "associate"]);
    expect([...UNROUTED_METHODS]).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const ids = noRecordIds("mat_3333333333333333");
    const requests = unroutedRequests(ids);
    const names = requests.map((request) => request.name);
    expect(new Set(names).size).toBe(names.length);
    // Segments no route has, after the matter, deep and shallow, for pages and the API, in every method.
    for (const prefix of ["/matters/:matterId", "/api/matters/:matterId"])
      for (const tail of ["unrouted", "unrouted/unrouted", "unrouted/unrouted/unrouted"])
        for (const method of UNROUTED_METHODS)
          expect(names, `${method} ${prefix}/${tail}`).toContain(
            `${method} ${prefix}/${tail} (no route)`,
          );
    // Every probed route under every method the table does not probe on it, and under none it probes.
    const probed = new Set(MATTER_PROBES.map(probeKeyOf));
    const templates = new Set(MATTER_PROBES.map((probe) => probe.template));
    for (const template of templates)
      for (const method of UNROUTED_METHODS) {
        const listed = names.includes(`${method} ${template} (unprobed method)`);
        expect(listed, `${method} ${template}`).toBe(!probed.has(`${method} ${template}`));
      }
    expect(requests.length).toBe(
      2 * 3 * UNROUTED_METHODS.length +
        templates.size * UNROUTED_METHODS.length -
        MATTER_PROBES.length,
    );
    // No placeholder is left in a path, the matter is the one given, and no name holds an id.
    for (const request of requests) {
      expect(request.path, request.name).not.toMatch(/:[A-Za-z]/);
      expect(request.path, request.name).toContain("mat_3333333333333333");
      expect(request.name).not.toMatch(ID_SHAPE);
      expect(request.name).not.toMatch(DASHES);
    }
  });

  it("carries a body that a write would carry: nothing on a read, JSON for the API and a form for a page", () => {
    const requests = unroutedRequests(noRecordIds());
    for (const request of requests) {
      if (request.method === "GET") expect(request.body.kind).toBe("none");
      else
        expect(request.body.kind, request.name).toBe(
          request.template.startsWith("/api/") ? "json" : "form",
        );
    }
  });

  it("reaches the URL that each wildcard route answers, with the wildcard filled in, and only once", () => {
    const requests = unroutedRequests(noRecordIds("mat_3333333333333333"), [
      "/api/matters/:matterId/export/*",
      "/api/matters/:matterId/*",
      "/other/:matterId/*",
    ]);
    const paths = requests
      .filter((request) => request.method === "PUT")
      .map((request) => request.path);
    expect(paths).toContain("/api/matters/mat_3333333333333333/export/unrouted/unrouted");
    expect(paths).toContain("/other/mat_3333333333333333/unrouted/unrouted");
    // The wildcard that fills in to a URL already in the list adds nothing.
    expect(
      paths.filter((path) => path === "/api/matters/mat_3333333333333333/unrouted/unrouted"),
    ).toHaveLength(1);
  });

  it("fills in a wildcard at a prefix that names no matter as well, as the API or a page by its prefix, in every method", () => {
    const wildcards = ["/legacy/*", "/*", "/api/*", "/api/v2/:thing/*"];
    const requests = unroutedRequests(noRecordIds(), wildcards);
    for (const [template, path] of [
      ["/legacy/unrouted/unrouted", "/legacy/unrouted/unrouted"],
      ["/unrouted/unrouted", "/unrouted/unrouted"],
      ["/api/unrouted/unrouted", "/api/unrouted/unrouted"],
      ["/api/v2/:thing/unrouted/unrouted", "/api/v2/unrouted/unrouted/unrouted"],
    ] as const) {
      const asked = requests.filter((request) => request.template === template);
      expect(
        asked.map((request) => request.method),
        template,
      ).toEqual([...UNROUTED_METHODS]);
      for (const request of asked) {
        expect(request.path, request.name).toBe(path);
        expect(request.name).toBe(`${request.method} ${template} (no route)`);
        expect(request.name).not.toMatch(ID_SHAPE);
        if (request.method === "GET") expect(request.body.kind).toBe("none");
        else expect(request.body.kind, request.name).toBe(isApi(template) ? "json" : "form");
      }
    }
    // Nothing else is added: the shapes of a matter's URL are the same, and each wildcard adds one URL in five methods.
    expect(requests.length).toBe(
      unroutedRequests(noRecordIds()).length + wildcards.length * UNROUTED_METHODS.length,
    );
  });
});

describe("the hash of the store", () => {
  function repo() {
    const made = createRepository(openDatabase(":memory:"));
    made.seedDemoUsers();
    return { repo: made };
  }

  it("moves when a row is updated and the number of rows is the same", () => {
    const site = repo();
    const before = fingerprint(site);
    site.repo.db.prepare("UPDATE users SET display_name = 'Someone else' WHERE demo = 1").run();
    expect(fingerprint(site)).not.toBe(before);
    expect(fingerprint(site)).toBe(fingerprint(site));
  });

  it("says nothing changed after a request that wrote nothing, and after a write that put back what was there", () => {
    const site = repo();
    const watch = storeWatch(site);
    const start = watch.take();
    site.repo.db.prepare("SELECT * FROM users").all();
    expect(watch.changedSince(start)).toBe(false);
    site.repo.db.prepare("UPDATE users SET display_name = display_name").run();
    expect(watch.changedSince(start)).toBe(false);
    site.repo.db
      .prepare("UPDATE users SET display_name = 'Changed' WHERE id = 'usr_demo_admin'")
      .run();
    expect(watch.changedSince(start)).toBe(true);
  });

  it("takes a point of its own after something outside a cell wrote, so that the write is not the cell's", () => {
    const site = repo();
    const watch = storeWatch(site);
    const first = watch.take();
    site.repo.db
      .prepare(
        "UPDATE users SET display_name = 'Made for the next cell' WHERE id = 'usr_demo_admin'",
      )
      .run();
    const second = watch.take();
    expect(second.hash).not.toBe(first.hash);
    expect(watch.changedSince(second)).toBe(false);
  });
});

const resume = [
  "POST /matters/:matterId/runs/:runId/resume",
  "POST /matters/:matterId/runs/:runId/cancel",
  "POST /api/matters/:matterId/runs/:runId/resume",
  "POST /api/matters/:matterId/runs/:runId/cancel",
];

/** The two modes of every cell: with the segregation of duties on, and relaxed. */
const MODES = [false, true] as const;

/**
 * The counts of the run on the real application, for the sentence of a clean run, taken from the
 * tables and from the documented roles and not typed in: a route added to a table moves them by
 * itself. The expected answers are those of `expectedFor`, cell by cell.
 */
const matrix = MODES.flatMap((relaxed) =>
  MATTER_PROBES.flatMap((probe) => ACTORS.map((actor) => expectedFor(probe, actor, relaxed))),
);
const unroutedPlan = unroutedRequests(noRecordIds());
const forgedCells = FORGED_PROBES.length * MODES.length;
const listCells = LIST_PROBES.length * ACTORS.length * MODES.length;
const unroutedCells = unroutedPlan.length * UNROUTED_ACTORS.length * MODES.length;
const writeRoutes = MATTER_PROBES.filter((probe) => probe.method !== "GET").length;
const CLEAN = {
  matrixCells: matrix.length,
  shouldBeLetIn: matrix.filter((cell) => cell.kind === "let_in").length,
  mustBeRefused: matrix.filter((cell) => cell.kind === "refused").length,
  comparedWithMissing: matrix.filter((cell) => cell.kind === "refused" && cell.caller !== "role")
    .length,
  forgedCells,
  listCells,
  unroutedCells,
  routes: MATTER_PROBES.length,
  forgedRequests: FORGED_PROBES.length,
  forgedPlaces: FORGED_PROBES.filter((probe) => !probe.consistent).length,
  listRoutes: LIST_PROBES.length,
  unroutedRequests: unroutedPlan.length,
  writeRoutes,
  // Every write route but the four whose body is a conflict whoever sends it (`resume`).
  writesWithEffect: writeRoutes - resume.length,
} as const;

const cleanResult = (
  over: Partial<AuthorizationResult> = {},
): Omit<AuthorizationResult, "sentence"> => ({
  probesRun: CLEAN.matrixCells + CLEAN.forgedCells + CLEAN.listCells + CLEAN.unroutedCells,
  probesAnsweredWithData: 0,
  byReason: { handler_answered: 0, carried_data: 0, refusal_differs: 0, changed_state: 0 },
  mismatches: 0,
  letInNotReached: 0,
  shouldBeLetIn: CLEAN.shouldBeLetIn,
  mustBeRefused: CLEAN.mustBeRefused,
  comparedWithMissing: CLEAN.comparedWithMissing,
  matrixCells: CLEAN.matrixCells,
  forgedCells: CLEAN.forgedCells,
  listCells: CLEAN.listCells,
  unroutedCells: CLEAN.unroutedCells,
  routes: CLEAN.routes,
  forgedRequests: CLEAN.forgedRequests,
  forgedPlaces: CLEAN.forgedPlaces,
  listRoutes: CLEAN.listRoutes,
  unroutedRequests: CLEAN.unroutedRequests,
  callers: ACTORS.length,
  modes: MODES.length,
  writeRoutes: CLEAN.writeRoutes,
  writesWithEffect: CLEAN.writesWithEffect,
  writesWithoutBody: resume,
  writesUnproven: 0,
  tableDrift: 0,
  exposed: [],
  mismatched: [],
  ...over,
});

describe("the sentence", () => {
  const result = cleanResult;

  it("counts cells, not requests, and states the counts it is given", () => {
    const sentence = sentenceOf(result({ probesRun: 1234, matrixCells: 999 }));
    expect(sentence).toMatch(/^Authorization probes: sent 1234 cells /);
    expect(sentence).toContain(`999 for ${CLEAN.routes} routes`);
    expect(sentence).not.toMatch(/^Authorization probes: sent \d+ requests/);
    expect(sentence).not.toMatch(DASHES);
    expect(sentence).not.toMatch(ID_SHAPE);
    expect(sentence).not.toContain("\n");
    expect(sentence).toMatch(/\.$/);
  });

  it("says that the model is a scripted oracle and not a language model", () => {
    expect(sentenceOf(result())).toContain("scripted key oracle, which is not a language model");
  });

  it("says how many cells did not reach their handler, or that every one did", () => {
    expect(sentenceOf(result())).toContain(
      "every cell whose caller should have been let in reached its handler",
    );
    const missed = sentenceOf(result({ mismatches: 244, letInNotReached: 128 }));
    expect(missed).toContain(
      "244 answered differently from the expected answer without exposing anything",
    );
    expect(missed).toContain("128 of them cells whose caller should have been let in and was not");
    expect(missed).toContain("did not reach their handler");
    expect(missed).not.toContain("every cell whose caller should have been let in reached");
  });

  it("counts the requests of the forged ids against the places they go, and the cells that are the same request again", () => {
    const sentence = sentenceOf(result());
    const pairs = CLEAN.forgedRequests - CLEAN.forgedPlaces;
    expect(sentence).toContain(
      `${CLEAN.forgedCells} in which a member of the matter named a record of another matter`,
    );
    expect(sentence).toContain(
      `${CLEAN.forgedRequests} requests in ${CLEAN.forgedPlaces} places (a path, a body or a query string)`,
    );
    expect(sentence).toContain(`${pairs} of them with every id from one record of that matter`);
    expect(sentence).not.toMatch(/in each of \d+ places/);
    // Without a route that names several ids there is no such form to speak of.
    const none = sentenceOf(result({ forgedRequests: CLEAN.forgedPlaces }));
    expect(none).toContain(`${CLEAN.forgedPlaces} requests in ${CLEAN.forgedPlaces} places`);
    expect(none).not.toContain("with every id from one record");
  });

  it("counts the cells for URLs that no route owns, says what was sent, and what must come back", () => {
    const sentence = sentenceOf(result());
    expect(sentence).toContain(
      `${CLEAN.unroutedCells} in which a visitor, an outsider and a member sent ${CLEAN.unroutedRequests} requests to URLs no route owns`,
    );
    expect(sentence).toContain("which must get the 404 any such URL gets");
    const without = sentenceOf(
      result({ unroutedCells: 0, probesRun: result().probesRun - CLEAN.unroutedCells }),
    );
    expect(without).not.toContain("URLs no route owns");
  });

  it("says what was compared for changes, and does not claim a body for the write routes that were not proven", () => {
    expect(sentenceOf(result())).toContain("a hash of every row of every table");
    expect(sentenceOf(result())).toContain(
      `on ${CLEAN.writesWithEffect} of ${CLEAN.writeRoutes} write routes`,
    );
    const none = sentenceOf(result({ writesWithEffect: 0, writesWithoutBody: [] }));
    expect(none).not.toContain("write routes (");
    expect(none).toContain(
      `none of the ${CLEAN.writeRoutes} write routes was shown to have a body that changes the store for a caller who is let in.`,
    );
  });

  it("says no more of the write routes when none was shown to change the store than the counts say, in every wording", () => {
    // Every body was stopped before the guard (a rule before the routes that answers each write with a refusal):
    // the routes that have one are not routes whose bodies change nothing, and none was sent to a handler.
    const stopped = result({ writesWithEffect: 0, writesUnproven: CLEAN.writesWithEffect });
    const rungs = sentenceLadder(stopped);
    for (const [at, rung] of rungs.entries()) {
      expect(rung, `rung ${at}`).not.toContain("was sent one");
      expect(rung, `rung ${at}`).not.toContain("was sent a body");
      expect(rung, `rung ${at}`).not.toContain("change nothing");
      expect(rung, `rung ${at}`).toContain(
        `none of the ${CLEAN.writeRoutes} write routes was shown to`,
      );
    }
    // The fullest says it in the words of the other branch; the short ones in its short words.
    const without = resume.length;
    const stoppedCount = CLEAN.writesWithEffect;
    expect(rungs[0]).toContain(
      `none of the ${CLEAN.writeRoutes} write routes was shown to have a body that changes the store for a caller who is let in ` +
        `(${without}, ending in resume and cancel, have none, and ${stoppedCount} had one that was stopped before the guard).`,
    );
    expect(rungs[2]).toContain(
      `none of the ${CLEAN.writeRoutes} write routes was shown to change the store, ${without} have none, ${stoppedCount} stopped before the guard.`,
    );
    expect(rungs[3]).toContain(
      `none of the ${CLEAN.writeRoutes} write routes was shown to change the store, ${without} have none, ${stoppedCount} stopped before the guard.`,
    );
    // Without a route that has no body, and with none stopped, the clause has nothing to add.
    const bare = sentenceLadder(result({ writesWithEffect: 0, writesWithoutBody: [] }));
    expect(bare[2]).toContain(
      `none of the ${CLEAN.writeRoutes} write routes was shown to change the store.`,
    );
    // The routes that have no body are said from the data too, not as a fixed claim.
    const lone = sentenceOf(
      result({
        writesWithEffect: 0,
        writesWithoutBody: ["DELETE /matters/:matterId/x/:id/archive"],
      }),
    );
    expect(lone).toContain("(1, ending in archive, have none)");
  });

  it("derives what it says of the other write routes from the routes, and does not call them unable to change anything", () => {
    // Four routes have no body that changes the store: the sentence names what they end in.
    const some = sentenceOf(result());
    expect(some).toContain(
      `on ${CLEAN.writesWithEffect} of ${CLEAN.writeRoutes} write routes (${resume.length}, ending in resume and cancel, have none)`,
    );
    expect(some).not.toContain("cannot change");
    expect(some).not.toContain("answered the same whoever sends them");
    expect(some).not.toContain("finished run");
    // Routes that have one and were not proven in every mode are said apart.
    const unproven = sentenceLadder(
      result({ writesWithEffect: CLEAN.writesWithEffect - 2, writesUnproven: 2 }),
    )[1]!;
    expect(unproven).toContain(
      `on ${CLEAN.writesWithEffect - 2} of ${CLEAN.writeRoutes} write routes (${resume.length}, ending in resume and cancel, have none, and 2 had one that was stopped before the guard)`,
    );
    // None without a body, none unproven: nothing in brackets.
    const all = sentenceOf(result({ writeRoutes: CLEAN.writesWithEffect, writesWithoutBody: [] }));
    expect(all).toContain(
      `on ${CLEAN.writesWithEffect} of ${CLEAN.writesWithEffect} write routes.`,
    );
    // Another set of routes is named by its own ends.
    const other = sentenceOf(
      result({ writesWithoutBody: ["DELETE /matters/:matterId/x/:id/archive"] }),
    );
    expect(other).toContain("(1, ending in archive, have none)");
  });

  it("always says what the probes cannot see, in every wording and whatever groups ran", () => {
    const fixed =
      "Not seen: evidence ids inside a decision body, the sign-in, sign-out and create-a-matter POSTs, " +
      "and any difference between the two matters but their title and ids (matter B is built from the same case).";
    const bare = result({
      matrixCells: 0,
      forgedCells: 0,
      listCells: 0,
      unroutedCells: 0,
      probesRun: 0,
    });
    for (const one of [result(), bare, result({ exposed: longestExposed(8), tableDrift: 9 })]) {
      expect(sentenceOf(one)).toContain(fixed);
      for (const rung of sentenceLadder(one)) expect(rung).toContain(fixed);
    }
  });

  it("names a group only when it ran", () => {
    const only = sentenceOf(
      result({
        matrixCells: 0,
        listCells: 0,
        unroutedCells: 0,
        probesRun: CLEAN.forgedCells,
        shouldBeLetIn: 0,
        mustBeRefused: 0,
      }),
    );
    expect(only).toContain(
      `${CLEAN.forgedCells} in which a member of the matter named a record of another matter`,
    );
    expect(only).not.toContain("routes that name no matter and only read");
    expect(only).not.toContain("URLs no route owns");
    expect(only).not.toContain("hash of every row");
  });

  it("names the first exposed cells, by route, caller and mode, and nothing of their content", () => {
    const sentence = sentenceOf(
      result({
        probesAnsweredWithData: 1,
        exposed: [
          { probe: "GET /api/matters", actor: "admin", relaxed: true, reasons: ["carried_data"] },
        ],
      }),
    );
    expect(sentence).toContain("First exposed: GET /api/matters as admin (relaxed).");
  });
});

describe("the sentence of a run that found something", () => {
  const worst = worstResult;

  it("is the longest name of each table, so that the test is about the real worst case", () => {
    const names = longestExposed(8).map((finding) => finding.probe);
    expect(names).toHaveLength(8);
    expect(Math.min(...names.map((name) => name.length))).toBeGreaterThan(75);
    // A name of a forged request that is the other form of a route is among the longest.
    expect(names.some((name) => name.includes("of one record of the other matter"))).toBe(true);
  });

  it("fits the budget, which is under the limit of the results file, and keeps the counts, the unreached clause, the drift and the first exposed cell", () => {
    const sentence = sentenceOf(worst());
    expect(AUTHORIZATION_SENTENCE_BUDGET).toBeLessThan(SUITE_SENTENCE_MAX);
    expect(sentence.length).toBeLessThanOrEqual(AUTHORIZATION_SENTENCE_BUDGET);
    expect(sentence).not.toContain(SENTENCE_CUT);
    expect(sentence).toContain("sent 9999 cells");
    expect(sentence).toContain("9999 were answered with data");
    expect(sentence).toContain(
      "999 of them cells whose caller should have been let in and was not",
    );
    expect(sentence).toContain("The action table differs from the documented one in 99 places.");
    expect(sentence).toContain("First exposed: ");
    expect(sentence).toContain(" as anonymous (relaxed)");
    expect(sentence).toContain("Not seen: ");
    expect(sentence).not.toMatch(DASHES);
    expect(sentence).not.toMatch(ID_SHAPE);
    expect(sentence).toMatch(/\.$/);
  });

  it("fits the budget as well when no write route was shown to change the store: the wording of that case is not the longer", () => {
    // Every write route either has no body or had one stopped before the guard, at the widest counts.
    const stopped = { ...worst(), writesWithEffect: 0, writesUnproven: 99 };
    const rungs = sentenceLadder(stopped);
    for (let at = 1; at < rungs.length; at += 1)
      expect(rungs[at]!.length, `rung ${at}`).toBeLessThanOrEqual(rungs[at - 1]!.length);
    // Not longer than the wording for routes that were shown to change it, rung for rung.
    const shown = sentenceLadder(worst());
    for (const [at, rung] of rungs.entries())
      expect(rung.length, `rung ${at}`).toBeLessThanOrEqual(shown[at]!.length);
    const sentence = sentenceOf(stopped);
    expect(sentence.length).toBeLessThanOrEqual(AUTHORIZATION_SENTENCE_BUDGET);
    expect(sentence).not.toContain(SENTENCE_CUT);
    expect(sentence).toContain("sent 9999 cells");
    expect(sentence).toContain("write routes was shown to");
    expect(sentence).toContain("99 stopped before the guard");
    expect(sentence).toContain("First exposed: ");
    expect(sentence).toContain("Not seen: ");
    expect(sentence).not.toContain("was sent one");
    expect(sentence).not.toMatch(DASHES);
  });

  it("gives way in the order the explanations matter: the callers, then the paragraph about changes, then the names", () => {
    const rungs = sentenceLadder(worst());
    expect(rungs.length).toBeGreaterThanOrEqual(5);
    for (let at = 1; at < rungs.length; at += 1)
      expect(rungs[at]!.length, `rung ${at}`).toBeLessThanOrEqual(rungs[at - 1]!.length);
    const [full, noCallers, shortEffects, shortCells, twoNames, oneName] = rungs as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    expect(full).toContain("a member of another matter only");
    expect(noCallers).not.toContain("a member of another matter only");
    expect(noCallers).toContain("Changes were found by comparing a hash");
    expect(shortEffects).not.toContain("Changes were found by comparing a hash");
    expect(shortEffects).toContain("Changes: a hash of every row");
    expect(shortEffects).toContain("which must be answered as an id of no record is");
    expect(shortCells).not.toContain("which must be answered as an id of no record is");
    const named = (text: string) => (text.split("First exposed: ")[1] ?? "").split("; ").length;
    expect([named(shortCells), named(twoNames), named(oneName)]).toEqual([3, 2, 1]);
    // The first rung that fits is the one used, and it is not the fullest when the fullest does not fit.
    expect(sentenceOf(worst())).toBe(rungs.find((text) => text.length <= 1900));
    expect(full.length).toBeGreaterThan(AUTHORIZATION_SENTENCE_BUDGET);
  });

  it("is the fullest wording that fits: a run that found nothing keeps everything but the caller kinds if it must", () => {
    const clean = sentenceLadder(cleanResult());
    const used = sentenceOf(cleanResult());
    expect(used).toBe(clean.find((text) => text.length <= AUTHORIZATION_SENTENCE_BUDGET));
    expect(used).toContain("Changes were found by comparing a hash");
    expect(used).toContain("which must get the 404 any such URL gets");
  });

  it("never throws: a sentence that fits no wording is cut and says so", () => {
    const huge = { ...worst(), exposed: [{ ...worst().exposed[0]!, probe: "P".repeat(5000) }] };
    const sentence = sentenceOf(huge);
    expect(sentence.length).toBeLessThanOrEqual(AUTHORIZATION_SENTENCE_BUDGET);
    expect(sentence.endsWith(SENTENCE_CUT)).toBe(true);
    expect(sentence).toMatch(/\.$/);
    expect(sentence).not.toMatch(DASHES);
  });
});

describe("the tables of probes", () => {
  const withIds = MATTER_PROBES.filter((probe) => subResourcesOf(probe.template).length > 0);

  it("forge an id in every place a route takes one in its path, and so do routes added later", () => {
    expect(withIds.length).toBeGreaterThanOrEqual(19);
    for (const probe of withIds)
      expect(
        FORGED_PROBES.some(
          (forged) =>
            forged.via === "path" &&
            forged.method === probe.method &&
            forged.template === probe.template,
        ),
        probeKeyOf(probe),
      ).toBe(true);
  });

  it("forge the ids in a body and a query string as well, and name no id", () => {
    expect(FORGED_PROBES.filter((probe) => probe.via !== "path").length).toBeGreaterThanOrEqual(5);
    for (const forged of FORGED_PROBES) {
      expect(forged.name).not.toMatch(ID_SHAPE);
      expect(forged.name).not.toMatch(DASHES);
      expect(["document", "version", "run", "finding", "memo"]).toContain(forged.position);
    }
  });

  it("put the borrowed id in the one place under test and the caller's own matter everywhere else", () => {
    const own: ProbeIds = {
      matterId: "mat_1111111111111111",
      firstDocumentId: "doc_1111111111111111",
      versionId: "ver_1111111111111111",
      runId: "run_1111111111111111",
      findingId: "fnd_1111111111111111",
      memoId: "memo_1111111111111111",
    };
    const borrowed = {
      documentId: "doc_2222222222222222",
      versionId: "ver_2222222222222222",
      runId: "run_2222222222222222",
      findingId: "fnd_2222222222222222",
      memoId: "memo_2222222222222222",
      findingContentSha256: "2".repeat(64),
    };
    for (const forged of FORGED_PROBES) {
      const { path, body } = forged.request(own, borrowed);
      expect(path, forged.name).toContain("mat_1111111111111111");
      expect(path, forged.name).not.toContain("mat_2222222222222222");
      const sent = path + JSON.stringify(body);
      expect(sent, forged.name).toMatch(/_2222222222222222/);
      expect(path, forged.name).not.toMatch(/:[a-zA-Z]+Id/);
    }
  });

  it("forge a route that names several ids in both forms: the other matter's id with the caller's own, and every id from one record", () => {
    const own: ProbeIds = {
      matterId: "mat_1111111111111111",
      firstDocumentId: "doc_1111111111111111",
      versionId: "ver_1111111111111111",
      runId: "run_1111111111111111",
      findingId: "fnd_1111111111111111",
      memoId: "memo_1111111111111111",
    };
    const borrowed = {
      documentId: "doc_2222222222222222",
      versionId: "ver_2222222222222222",
      runId: "run_2222222222222222",
      findingId: "fnd_2222222222222222",
      memoId: "memo_2222222222222222",
      findingContentSha256: "2".repeat(64),
    };
    const several = FORGED_PROBES.filter((probe) => probe.pairedWith.length > 0);
    const routes = [...new Set(several.map((probe) => `${probe.method} ${probe.template}`))];
    // The page form and the PATCH body: the two places where a document and a version are named together.
    expect(routes.sort()).toEqual([
      "PATCH /api/matters/:matterId",
      "POST /matters/:matterId/documents/:documentId/operative",
    ]);
    for (const route of routes) {
      const ofRoute = several.filter((probe) => `${probe.method} ${probe.template}` === route);
      const mixed = ofRoute.filter((probe) => !probe.consistent);
      const whole = ofRoute.filter((probe) => probe.consistent);
      expect(mixed.length, route).toBeGreaterThanOrEqual(2);
      expect(whole, route).toHaveLength(1);
      for (const probe of mixed) {
        const { path, body } = probe.request(own, borrowed);
        const sent = path + JSON.stringify(body);
        // One of the two is the other matter's and the other is the caller's own.
        expect(sent, probe.name).toMatch(
          /(doc_2222222222222222.*ver_1111111111111111|ver_2222222222222222.*doc_1111111111111111|doc_1111111111111111.*ver_2222222222222222|ver_1111111111111111.*doc_2222222222222222)/,
        );
      }
      const { path, body } = whole[0]!.request(own, borrowed);
      const sent = path + JSON.stringify(body);
      expect(sent).toContain("doc_2222222222222222");
      expect(sent).toContain("ver_2222222222222222");
      expect(sent).not.toContain("doc_1111111111111111");
      expect(sent).not.toContain("ver_1111111111111111");
      // The matter in the path is the caller's own, as in every forged request.
      expect(path).toContain("mat_1111111111111111");
      expect(path).not.toContain("mat_2222222222222222");
      expect(whole[0]!.name).not.toMatch(ID_SHAPE);
      expect(whole[0]!.via).toBe("body");
    }
    // The routes with one id (and the run page, which picks its finding from the run's own list) have the one form.
    expect(FORGED_PROBES.filter((probe) => probe.consistent)).toHaveLength(2);
    expect(
      FORGED_PROBES.filter((probe) => probe.pairedWith.length === 0 && probe.consistent),
    ).toHaveLength(0);
  });

  describe("a route that names several ids in its path", () => {
    const own: ProbeIds = {
      matterId: "mat_1111111111111111",
      firstDocumentId: "doc_1111111111111111",
      versionId: "ver_1111111111111111",
      runId: "run_1111111111111111",
      findingId: "fnd_1111111111111111",
      memoId: "memo_1111111111111111",
    };
    const borrowed = {
      documentId: "doc_2222222222222222",
      versionId: "ver_2222222222222222",
      runId: "run_2222222222222222",
      findingId: "fnd_2222222222222222",
      memoId: "memo_2222222222222222",
      findingContentSha256: "2".repeat(64),
    };
    const theirs = (path: string): number => path.match(/_2222222222222222/g)?.length ?? 0;
    /** A route the application does not have yet, with two ids, and one with three, as a developer might add them. */
    const added: Probe[] = [
      {
        method: "GET",
        template: "/matters/:matterId/runs/:runId/findings/:findingId",
        action: "finding.read",
        body: { kind: "none" },
        reaches: 200,
      },
      {
        method: "POST",
        template: "/api/matters/:matterId/documents/:documentId/versions/:versionId/runs/:runId",
        action: "run.start",
        body: { kind: "json", json: {} },
        reaches: 400,
      },
    ];

    /** Each route of the table with several ids has its mixed forms and one form with every id from one record. */
    function check(table: readonly Probe[]): number {
      const forged = forgedProbesFor(table);
      let checked = 0;
      for (const probe of table.filter((entry) => subResourcesOf(entry.template).length >= 2)) {
        const several = subResourcesOf(probe.template).length;
        const ofRoute = forged.filter(
          (entry) => entry.method === probe.method && entry.template === probe.template,
        );
        const mixed = ofRoute.filter((entry) => !entry.consistent);
        const whole = ofRoute.filter((entry) => entry.consistent);
        const name = probeKeyOf(probe);
        expect(mixed, name).toHaveLength(several);
        expect(whole, name).toHaveLength(1);
        // Mixed: one id is the other matter's and the rest are the caller's own.
        for (const entry of mixed) {
          const { path } = entry.request(own, borrowed);
          expect(theirs(path), entry.name).toBe(1);
          expect(path, entry.name).toContain("mat_1111111111111111");
        }
        // Consistent: every id the path names is from the one record of the other matter, the matter is the caller's.
        const { path } = whole[0]!.request(own, borrowed);
        expect(theirs(path), whole[0]!.name).toBe(several);
        expect(path.replace("mat_1111111111111111", ""), whole[0]!.name).not.toContain(
          "_1111111111111111",
        );
        expect(path.endsWith("_2222222222222222"), whole[0]!.name).toBe(true);
        expect(path).toContain("mat_1111111111111111");
        expect(path).not.toMatch(/:[a-zA-Z]+Id/);
        expect(whole[0]!.name).not.toMatch(ID_SHAPE);
        expect(whole[0]!.name).not.toMatch(DASHES);
        // Every id it names is in the path, so it is a form of the path and not of a body.
        expect(whole[0]!.via).toBe("path");
        expect(whole[0]!.consistent).toBe(true);
        checked += 1;
      }
      return checked;
    }

    it("has a form with every id from one record of the other matter, for each route of the table that has several", () => {
      // The application has none today, so this holds the table to it when one is added.
      check(MATTER_PROBES);
      expect(FORGED_PROBES.filter((entry) => entry.consistent)).toHaveLength(2);
    });

    it("has that form for a route added to the table, without anyone listing it: with two ids and with three", () => {
      expect(check([...MATTER_PROBES, ...added])).toBe(added.length);
      const forged = forgedProbesFor([...MATTER_PROBES, ...added]);
      const twins = forged.filter(
        (entry) => entry.consistent && added.some((probe) => probe.template === entry.template),
      );
      expect(twins.map((entry) => entry.name).sort()).toEqual([
        "GET /matters/:matterId/runs/:runId/findings/:findingId (finding and run of one record of the other matter)",
        "POST /api/matters/:matterId/documents/:documentId/versions/:versionId/runs/:runId (document and run and version of one record of the other matter)",
      ]);
      // The routes of the application keep the two forms they had.
      expect(
        forged.filter(
          (entry) => entry.consistent && !added.some((probe) => probe.template === entry.template),
        ),
      ).toHaveLength(2);
    });
  });

  it("give well formed ids of no record in every segment, and only those", () => {
    for (const id of Object.values(noRecordIds())) expect(id).toMatch(/^[a-z]+_0000000000000000$/);
    const ids = noRecordIds();
    for (const probe of MATTER_PROBES) {
      const path = pathFor(probe.template, ids);
      expect(path).not.toMatch(/:[a-zA-Z]+/);
      expect(path.replace(/\/(?:api\/)?matters\/mat_0000000000000000/, "")).not.toMatch(
        /_[0-9a-f]*[1-9a-f][0-9a-f]*\b/,
      );
    }
    expect(NO_RECORD.findingContentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keep no body for a route that is not in the table", () => {
    const keys = new Set(MATTER_PROBES.map(probeKeyOf));
    for (const key of [...EFFECT_KEYS, ...FORGED_BODY_KEYS]) expect(keys.has(key), key).toBe(true);
  });

  it("have a body that changes the store for every write but the resume and the cancel of a finished run", () => {
    const scratch: Scratch = {
      matterId: "mat_3333333333333333",
      documentId: "doc_3333333333333333",
      versionId: "ver_3333333333333333",
      earlierVersionId: "ver_3333333333333332",
      amendmentId: "doc_3333333333333332",
      invitee: "usr_x",
      workflow: "v2",
    };
    const writes = MATTER_PROBES.filter((probe) => probe.method !== "GET");
    const without = writes.filter((probe) => effectOf(probe, scratch) === null).map(probeKeyOf);
    expect(without.sort()).toEqual([
      "POST /api/matters/:matterId/runs/:runId/cancel",
      "POST /api/matters/:matterId/runs/:runId/resume",
      "POST /matters/:matterId/runs/:runId/cancel",
      "POST /matters/:matterId/runs/:runId/resume",
    ]);
    const ids = noRecordIds();
    // A body that is not the probe's own, so that it is not the one built to change nothing.
    for (const probe of writes) {
      const effect = effectOf(probe, scratch);
      if (effect === null || probe.fresh === true || probe.template.endsWith("/memos")) continue;
      // A route with no body is made to change something by what it names (the removal of the amendment).
      if (probe.body.kind === "none") {
        expect(effect.ids(scratch, ids).firstDocumentId, probeKeyOf(probe)).toBe(
          scratch.amendmentId,
        );
        continue;
      }
      expect(JSON.stringify(effect.body), probeKeyOf(probe)).not.toBe(JSON.stringify(probe.body));
    }
  });

  it("build a multipart body with a file where a route needs one", () => {
    const upload = FORGED_PROBES.find(
      (probe) => probe.template === "/api/matters/:matterId/documents/:documentId/versions",
    )!;
    const own: ProbeIds = {
      matterId: "mat_1",
      firstDocumentId: "doc_1",
      versionId: "ver_1",
      runId: "run_1",
      findingId: "fnd_1",
      memoId: "memo_1",
    };
    const { body, path } = upload.request(own, { ...NO_RECORD });
    const init = initFor({ method: upload.method, template: upload.template, body }, "tok");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBeInstanceOf(File);
    expect(path).toContain(NO_RECORD.documentId);
    expect(init.headers["x-csrf-token"]).toBe("tok");
  });
});
