import { describe, expect, it } from "vitest";
import { createRepository, openDatabase } from "../../apps/parol/src/store/index.js";
import {
  classifyForged,
  classifyListing,
  expectedList,
  fingerprint,
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
  effectOf,
  initFor,
  noRecordIds,
  pathFor,
  probeKeyOf,
  subResourcesOf,
  type ProbeIds,
  type Scratch,
} from "../src/parol/exposure/probes.js";
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

describe("the sentence", () => {
  const result = (
    over: Partial<AuthorizationResult> = {},
  ): Omit<AuthorizationResult, "sentence"> => ({
    probesRun: 652,
    probesAnsweredWithData: 0,
    byReason: { handler_answered: 0, carried_data: 0, refusal_differs: 0, changed_state: 0 },
    mismatches: 0,
    letInNotReached: 0,
    shouldBeLetIn: 128,
    mustBeRefused: 376,
    comparedWithMissing: 284,
    matrixCells: 504,
    forgedCells: 50,
    listCells: 98,
    routes: 36,
    forgedRequests: 25,
    listRoutes: 7,
    callers: 7,
    modes: 2,
    writeRoutes: 24,
    writesWithEffect: 20,
    tableDrift: 0,
    exposed: [],
    mismatched: [],
    ...over,
  });

  it("counts cells, not requests, and states the counts it is given", () => {
    const sentence = sentenceOf(result({ probesRun: 1234, matrixCells: 999 }));
    expect(sentence).toMatch(/^Authorization probes: sent 1234 cells /);
    expect(sentence).toContain("999 for 36 routes");
    expect(sentence).not.toMatch(/\d+ requests/);
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

  it("says what was compared for changes, and does not claim a body for the write routes that were not proven", () => {
    expect(sentenceOf(result())).toContain("a hash of every row of every table");
    expect(sentenceOf(result())).toContain("on 20 of 24 write routes");
    const none = sentenceOf(result({ writesWithEffect: 0 }));
    expect(none).not.toContain("write routes (the others");
    expect(none).toContain("none of the 24 write routes was sent one");
  });

  it("names a group only when it ran", () => {
    const only = sentenceOf(
      result({ matrixCells: 0, listCells: 0, probesRun: 50, shouldBeLetIn: 0, mustBeRefused: 0 }),
    );
    expect(only).toContain("50 in which a member of the matter named a record of another matter");
    expect(only).not.toContain("routes that name no matter and only read");
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
