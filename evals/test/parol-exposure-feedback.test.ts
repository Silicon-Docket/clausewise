import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  missedIssueFromBody,
  missedIssueFromForm,
  ratingFromBody,
  ratingFromForm,
} from "../../apps/parol/src/server/routes/feedback.js";
import type { FindingView } from "../../apps/parol/src/services/views.js";
import type { Dataset } from "../src/parol/dataset.js";
import type { SiteHooks } from "../src/parol/exposure/site.js";
import { decisionFor } from "../src/parol/exposure/review.js";
import { probeKey, type ProbeBody, type Scratch } from "../src/parol/exposure/probe-kit.js";
import {
  EFFECT_KEYS,
  FORGED_BODY_KEYS,
  FORGED_PROBES,
  MATTER_PROBES,
  NO_RECORD,
  effectOf,
  noRecordIds,
} from "../src/parol/exposure/probes.js";
import { OUTSIDER, runWith } from "./parol-authz-support.js";
import { completeDataset } from "./parol-exposure-support.js";

/**
 * The exposure suite and the reason code (package W2.6a, slice A). The suite's own reviewer accepts
 * what is verified and escalates the rest, and neither carries a reason code, so the review routes
 * keep their probe rows, their forged-id bodies and their effect bodies as they were. This test
 * pins that dependency: the day the suite's reviewer edits or rejects, its decision needs a code,
 * and this fails before the effect bodies start answering 400 for the wrong reason.
 *
 * Slice B adds the two probe rows of the report of a missed issue (the form and the JSON), each with
 * its forged-id body and its effect body, and proves on the real application that the effect body
 * writes when a let-in caller sends it and is seen when a hole lets a refused caller send it.
 *
 * Slice C adds the rating (a form and JSON, each with an effect body that needs a scratch matter
 * with a memo) and the read of a matter's feedback. The rating takes no id in its path, so it has
 * no forged-id body; the read changes nothing, so it has no effect body. The later slice (a note)
 * adds its probe rows below.
 */

const REVIEW_ROUTES = [
  "POST /matters/:matterId/findings/:findingId/reviews",
  "POST /api/matters/:matterId/findings/:findingId/reviews",
] as const;

const viewOf = (verificationState: string, status: string): FindingView =>
  ({
    issue: { verificationState, status },
    contentSha256: "a".repeat(64),
  }) as unknown as FindingView;

describe("the suite's own reviewer", () => {
  it("accepts what is verified and escalates the rest, and neither carries a code or a mark", () => {
    for (const [verification, status, decision] of [
      ["verified", "compliant", "accept"],
      ["verified", "deviation", "accept"],
      ["unverified", "deviation", "escalate"],
      ["verified", "undetermined", "escalate"],
    ] as const) {
      const request = decisionFor(viewOf(verification, status));
      expect(request.decision, `${verification} ${status}`).toBe(decision);
      expect(Object.keys(request).sort()).toEqual([
        "decision",
        "edits",
        "findingContentSha256",
        "reason",
      ]);
      expect(request.edits).toBeNull();
    }
  });
});

describe("the review routes in the probe tables", () => {
  const scratch: Scratch = {
    matterId: "mat_1",
    documentId: "doc_1",
    versionId: "ver_1",
    earlierVersionId: "ver_0",
    amendmentId: "doc_2",
    invitee: "usr_1",
    workflow: "v2",
    runId: "run_1",
    findingId: "fnd_1",
    decision: { decision: "accept", findingContentSha256: "b".repeat(64), reason: null },
  };

  it("are still probed, with a forged-id body and an effect body, as the reviewer's action", () => {
    for (const key of REVIEW_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key);
      expect(probe, key).toBeDefined();
      expect(probe).toMatchObject({ action: "review.decide", reaches: 400 });
      expect(FORGED_BODY_KEYS, key).toContain(key);
      expect(EFFECT_KEYS, key).toContain(key);
      // The body that must change the store is not the probe's own empty one.
      const effect = effectOf(probe!, scratch);
      expect(effect?.needs, key).toBe("run");
      expect(JSON.stringify(effect?.body), key).not.toBe(JSON.stringify(probe!.body));
    }
  });

  it("send a decision that needs no code, so it reaches the store and not the refusal of a missing one", () => {
    for (const key of REVIEW_ROUTES) {
      const effect = effectOf(
        MATTER_PROBES.find((p) => probeKey(p) === key)!,
        scratch,
      )!;
      const fields =
        effect.body.kind === "form"
          ? effect.body.fields
          : effect.body.kind === "json"
            ? (effect.body.json as Record<string, unknown>)
            : {};
      expect(["accept", "escalate"], key).toContain(fields["decision"]);
      expect(Object.keys(fields), key).not.toContain("reasonCode");
      expect(Object.keys(fields), key).not.toContain("minorEdit");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: the report of a missed issue
// ---------------------------------------------------------------------------------------------

const REPORT_ROUTES = [
  "POST /matters/:matterId/runs/:runId/missed-issues",
  "POST /api/matters/:matterId/runs/:runId/missed-issues",
] as const;

/** What a body carries, as the fields a route reads. */
const fieldsOf = (body: ProbeBody): Record<string, unknown> =>
  body.kind === "form"
    ? body.fields
    : body.kind === "json"
      ? (body.json as Record<string, unknown>)
      : {};

/** Runs the application's own reading of a body, so that a body that it refuses is found here. */
const parses = (key: (typeof REPORT_ROUTES)[number], body: ProbeBody): void => {
  if (body.kind === "form") missedIssueFromForm(body.fields);
  else if (body.kind === "json") missedIssueFromBody(body.json);
  else throw new Error(`${key} has a body that is neither a form nor JSON`);
};

describe("the report of a missed issue in the probe tables", () => {
  const scratch: Scratch = {
    matterId: "mat_1",
    documentId: "doc_1",
    versionId: "ver_1",
    earlierVersionId: "ver_0",
    amendmentId: "doc_2",
    invitee: "usr_1",
    workflow: "v2",
    runId: "run_1",
    findingId: "fnd_1",
  };

  it("has a row for the form and one for the JSON, for the action every role holds, reaching 400 with its own empty body", () => {
    for (const key of REPORT_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key);
      expect(probe, key).toBeDefined();
      expect(probe).toMatchObject({ action: "feedback.add", reaches: 400, method: "POST" });
      expect(probe!.fresh, key).toBeUndefined();
      expect(probe!.body.kind, key).toBe(key.includes("/api/") ? "json" : "form");
      expect(Object.keys(fieldsOf(probe!.body)), key).toEqual([]);
      // The empty body is refused by the application itself: no rule was chosen.
      expect(() => parses(key, probe!.body), key).toThrow();
    }
  });

  it("forges the run in the path, once for each route, with a body that gets past every check on the body", () => {
    for (const key of REPORT_ROUTES) {
      expect(FORGED_BODY_KEYS, key).toContain(key);
      const forged = FORGED_PROBES.filter((p) => `${p.method} ${p.template}` === key);
      expect(
        forged.map((p) => [p.position, p.via, p.reaches]),
        key,
      ).toEqual([["run", "path", 404]]);
      const request = forged[0]!.request(noRecordIds("mat_1"), NO_RECORD);
      // The id is the borrowed one, in the place under test, and the matter is the caller's own.
      expect(request.path, key).toContain(`/runs/${NO_RECORD.runId}/missed-issues`);
      expect(request.path, key).toContain("mat_1");
      // The body is one the application accepts, so only the lookup of the run can answer it with 404.
      expect(() => parses(key, request.body), key).not.toThrow();
    }
  });

  it("has an effect body for each, on a reviewed scratch matter, that the application accepts and the probe's own is not", () => {
    for (const key of REPORT_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key)!;
      expect(EFFECT_KEYS, key).toContain(key);
      const effect = effectOf(probe, scratch)!;
      expect(effect.target, key).toBe("scratch");
      expect(effect.needs, key).toBe("run");
      expect(JSON.stringify(effect.body), key).not.toBe(JSON.stringify(probe.body));
      // It is aimed at the scratch matter's review, not at ids of no record.
      const ids = effect.ids(scratch, noRecordIds("mat_other"));
      expect(ids.matterId, key).toBe("mat_1");
      expect(ids.runId, key).toBe("run_1");
      expect(() => parses(key, effect.body), key).not.toThrow();
      // And it is not the forged body: the two prove different things.
      const forged = FORGED_PROBES.find((p) => `${p.method} ${p.template}` === key)!;
      expect(JSON.stringify(effect.body), key).not.toBe(
        JSON.stringify(forged.request(noRecordIds("mat_1"), NO_RECORD).body),
      );
    }
  });

  it("send no field that names a person, a matter or a review in the body: those are the session's and the path's", () => {
    for (const key of REPORT_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key)!;
      const names = [
        ...Object.keys(fieldsOf(effectOf(probe, scratch)!.body)),
        ...Object.keys(
          fieldsOf(
            FORGED_PROBES.find((p) => `${p.method} ${p.template}` === key)!.request(
              noRecordIds(),
              NO_RECORD,
            ).body,
          ),
        ),
      ];
      for (const forbidden of ["userId", "matterId", "runId", "role", "kind"])
        expect(names, key).not.toContain(forbidden);
    }
  });
});

describe("the report of a missed issue on the real application", () => {
  let dataset: Dataset;
  beforeAll(async () => {
    dataset = await completeDataset();
  });
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
  const run = runWith(() => dataset);

  it("is shown to change the store for a caller who is let in, and is clean when the guard is whole", async () => {
    const result = await run({}, ["matrix", "effects", "forged"]);
    // Every cell reached the handler it was written to test, and none of the refused got data.
    expect(result.mismatches).toBe(0);
    expect(result.letInNotReached).toBe(0);
    expect(result.probesAnsweredWithData).toBe(0);
    expect(result.writesUnproven).toBe(0);
    expect([...result.writesWithoutBody].sort()).toEqual([
      "POST /api/matters/:matterId/runs/:runId/cancel",
      "POST /api/matters/:matterId/runs/:runId/resume",
      "POST /matters/:matterId/runs/:runId/cancel",
      "POST /matters/:matterId/runs/:runId/resume",
    ]);
    expect(result.byReason.changed_state).toBe(0);
    for (const key of REPORT_ROUTES) expect(result.writesWithoutBody, key).not.toContain(key);
    expect(result.writesWithEffect).toBe(result.writeRoutes - result.writesWithoutBody.length);
  });

  it("is seen when a hole lets a person with no part in the matter report: the cells of both routes are exposures", async () => {
    // A guard that takes the outsider for a viewer, which may add feedback: the hole the effect body is for.
    const result = await run(
      {
        beforeRoutes: (_app, deps) => {
          const real = deps.repo.getMember;
          (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
            userId === OUTSIDER
              ? { matterId, userId, role: "viewer", addedAt: "2026-11-01T00:00:00.000Z" }
              : real(matterId, userId);
        },
      },
      ["matrix", "effects"],
    );
    // The outsider is a viewer in the planted guard, and the writes a viewer may make are these: its
    // effect body, sent by the outsider on each route in each mode, changed the store. The reports
    // are two routes and the rating two more, the rating on a scratch matter that has a memo.
    expect(result.byReason.changed_state).toBe((REPORT_ROUTES.length + RATING_ROUTES.length) * 2);
    expect(result.probesAnsweredWithData).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice C: the rating of a matter, and the read of a matter's feedback
// ---------------------------------------------------------------------------------------------

const RATING_ROUTES = [
  "POST /matters/:matterId/rating",
  "POST /api/matters/:matterId/rating",
] as const;
const FEEDBACK_READ = "GET /api/matters/:matterId/feedback";

/** Runs the application's own reading of a rating body, so that a body it refuses is found here. */
const readsAsRating = (key: (typeof RATING_ROUTES)[number], body: ProbeBody): void => {
  if (body.kind === "form") ratingFromForm(body.fields);
  else if (body.kind === "json") ratingFromBody(body.json);
  else throw new Error(`${key} has a body that is neither a form nor JSON`);
};

describe("the rating in the probe tables", () => {
  const scratch: Scratch = {
    matterId: "mat_1",
    documentId: "doc_1",
    versionId: "ver_1",
    earlierVersionId: "ver_0",
    amendmentId: "doc_2",
    invitee: "usr_1",
    workflow: "v2",
    runId: "run_1",
    findingId: "fnd_1",
  };

  it("has a row for the form and one for the JSON, for the action every role holds, reaching 400 with its own empty body", () => {
    for (const key of RATING_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key);
      expect(probe, key).toBeDefined();
      expect(probe).toMatchObject({ action: "feedback.add", reaches: 400, method: "POST" });
      expect(probe!.fresh, key).toBeUndefined();
      expect(probe!.body.kind, key).toBe(key.includes("/api/") ? "json" : "form");
      expect(Object.keys(fieldsOf(probe!.body)), key).toEqual([]);
      // The empty body is refused by the application itself: no rating was chosen.
      expect(() => readsAsRating(key, probe!.body), key).toThrow();
    }
  });

  it("names no id in its path, so the suite forges none and the table holds no forged-id body for it", () => {
    for (const key of RATING_ROUTES) {
      expect(FORGED_BODY_KEYS, key).not.toContain(key);
      expect(
        FORGED_PROBES.filter((p) => `${p.method} ${p.template}` === key),
        key,
      ).toEqual([]);
      // The path holds the matter and nothing else.
      expect(
        key.split("/").filter((part) => part.startsWith(":")),
        key,
      ).toEqual([":matterId"]);
    }
  });

  it("has an effect body for each, on a scratch matter that has a memo, that the application accepts and the probe's own is not", () => {
    for (const key of RATING_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key)!;
      expect(EFFECT_KEYS, key).toContain(key);
      const effect = effectOf(probe, scratch)!;
      expect(effect.target, key).toBe("scratch");
      // A rating is given once the matter has a memo, so the matter must have been exported.
      expect(effect.needs, key).toBe("exported");
      expect(JSON.stringify(effect.body), key).not.toBe(JSON.stringify(probe.body));
      // It is aimed at the scratch matter, not at ids of no record.
      expect(effect.ids(scratch, noRecordIds("mat_other")).matterId, key).toBe("mat_1");
      expect(() => readsAsRating(key, effect.body), key).not.toThrow();
      // A mark of 4 and no words: the one body that is a rating and says nothing else.
      expect(fieldsOf(effect.body)["rating"], key).toEqual(key.includes("/api/") ? 4 : "4");
    }
  });

  it("send no field that names a person, a matter or a run in the body: those are the session's and the path's", () => {
    for (const key of RATING_ROUTES) {
      const probe = MATTER_PROBES.find((p) => probeKey(p) === key)!;
      const names = Object.keys(fieldsOf(effectOf(probe, scratch)!.body));
      expect(names.sort(), key).toEqual(["comment", "rating"]);
      for (const forbidden of ["userId", "matterId", "runId", "role", "kind"])
        expect(names, key).not.toContain(forbidden);
    }
  });

  it("has the read of a matter's feedback as a GET for the read action, with no effect body and no forged id", () => {
    const probe = MATTER_PROBES.find((p) => probeKey(p) === FEEDBACK_READ);
    expect(probe).toMatchObject({
      method: "GET",
      action: "matter.read",
      reaches: 200,
      body: { kind: "none" },
    });
    expect(EFFECT_KEYS).not.toContain(FEEDBACK_READ);
    expect(FORGED_BODY_KEYS).not.toContain(FEEDBACK_READ);
    expect(FORGED_PROBES.filter((p) => `${p.method} ${p.template}` === FEEDBACK_READ)).toEqual([]);
  });
});

describe("the rating on the real application", () => {
  let dataset: Dataset;
  beforeAll(async () => {
    dataset = await completeDataset();
  });
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
  const run = runWith(() => dataset);

  it("is shown to change the store for the caller who is let in, on a matter that has a memo, and is clean when the guard is whole", async () => {
    const result = await run({}, ["matrix", "effects"]);
    expect(result.mismatches).toBe(0);
    expect(result.letInNotReached).toBe(0);
    expect(result.writesUnproven).toBe(0);
    expect(result.byReason.changed_state).toBe(0);
    for (const key of RATING_ROUTES) expect(result.writesWithoutBody, key).not.toContain(key);
    // The read has a cell for each caller like any other route, and it sent nothing that writes.
    expect(result.probesAnsweredWithData).toBe(0);
  });

  it("sees a route that answers the read of a matter's feedback to a caller with no part in the matter: four refused callers, in two modes", async () => {
    // The hole the row is for: a route in front of the real one that answers whoever asks, with the
    // shape of the answer and none of the guard. The three members are let in anyway; the outsider,
    // the stranger, the administrator and the visitor are not, and each of them is answered.
    const answers: SiteHooks = {
      beforeRoutes: (app) =>
        app.get("/api/matters/:matterId/feedback", (c) =>
          c.json({ missedIssues: [], notes: [], myRating: null }),
        ),
    };
    const whole = await run({}, ["matrix"]);
    expect(whole.byReason.handler_answered).toBe(0);
    const holed = await run(answers, ["matrix"]);
    expect(holed.byReason.handler_answered).toBe(4 * 2);
    expect(holed.exposed.every((cell) => cell.probe === FEEDBACK_READ)).toBe(true);
  });
});
