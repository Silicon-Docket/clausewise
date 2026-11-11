import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictError, DEMO_USER_IDS } from "../../apps/parol/src/store/index.js";
import {
  runCanaryScan,
  type CanaryHooks,
  type CanaryResult,
  type LeakContext,
} from "../src/parol/exposure/canary.js";
import type { Dataset } from "../src/parol/dataset.js";
import type { ExposureSite } from "../src/parol/exposure/site.js";
import {
  CANARY_SHAPE,
  completeDataset,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * The timers and the reference list of the pilot measures (W2.6b) in the canary scan. Both tables
 * are read by the scan (`STORE_SCOPES`), and a table that is empty on both sides could never show a
 * leak. So the suite writes one timer and one reference list, through the real service, for the
 * matter of the case and for the canary matter, the two sides of the scan. These tests show what it
 * writes, that the scan stops when it writes nothing, and that a leak of either table is counted
 * only because the other side has rows in it.
 *
 * Every plant is made in the store of the scan, an in-memory database that exists for that scan
 * alone: nothing is written to a file of the tree, and a trigger that is dropped here is dropped in
 * that scratch store only.
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

const failureOf = async (hooks?: CanaryHooks): Promise<Error> => {
  const caught = await scan(hooks).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(caught, "the scan should have stopped").toBeInstanceOf(Error);
  const error = caught as Error;
  // Nothing printed holds a canary string or an id.
  expect(error.message).not.toMatch(CANARY_SHAPE);
  expect(error.message).not.toMatch(ID_SHAPE);
  return error;
};

const hitsOf = (result: CanaryResult, kind: string, token: "canary" | "id") =>
  result.hits.filter((hit) => hit.kind === kind && hit.token === token);

const CASE_ASSOCIATE = DEMO_USER_IDS.associate;
const CASE_REVIEWER = DEMO_USER_IDS.reviewer;
const CANARY_ASSOCIATE = "usr_exposure_bramblewick_associate";
const CANARY_REVIEWER = "usr_exposure_bramblewick_reviewer";

type Row = Record<string, unknown>;
const rowsOf = (site: ExposureSite, table: string, matterId: string): Row[] =>
  site.repo.db
    .prepare(`SELECT * FROM ${table} WHERE matter_id = ? ORDER BY rowid`)
    .all(matterId) as Row[];
const actionsOf = (site: ExposureSite, matterId: string): { action: string; actor: string }[] =>
  (
    site.repo.db
      .prepare("SELECT action, actor_id FROM audit_events WHERE matter_id = ? ORDER BY seq")
      .all(matterId) as { action: string; actor_id: string }[]
  ).map((row) => ({ action: row.action, actor: row.actor_id }));

/** The ids a plant needs: the case's matter and the canary matter's. */
const idsOf = (context: LeakContext & { caseMatterId: string }) => ({
  caseMatterId: context.caseMatterId,
  canaryMatterId: context.foreign[0]!.matterId,
});

// ---------------------------------------------------------------------------------------------
// What the suite writes
// ---------------------------------------------------------------------------------------------

describe("the timer and the reference list that the suite writes for the scan's matters", () => {
  it("are one closed timer of the associate and a two-issue list of the reviewer, on each side, made through the services", async () => {
    const seen: Record<string, { timers: Row[]; issues: Row[]; actions: unknown[] }> = {};
    let firstRule = "";
    await scan({
      afterReview: (site, context) => {
        firstRule = site.repo.listRules(site.playbookVersionId)[0]!.key;
        const ids = idsOf(context);
        for (const [side, matterId] of [
          ["case", ids.caseMatterId],
          ["canary", ids.canaryMatterId],
        ] as const)
          seen[side] = {
            timers: rowsOf(site, "time_entries", matterId),
            issues: rowsOf(site, "reference_issues", matterId),
            actions: actionsOf(site, matterId),
          };
      },
    });
    expect(firstRule).not.toBe("");
    const people = {
      case: { associate: CASE_ASSOCIATE, reviewer: CASE_REVIEWER },
      canary: { associate: CANARY_ASSOCIATE, reviewer: CANARY_REVIEWER },
    };
    for (const side of ["case", "canary"] as const) {
      const { timers, issues, actions } = seen[side]!;
      // One timer, the associate's, started and stopped.
      expect(timers, side).toHaveLength(1);
      expect(timers[0], side).toMatchObject({ user_id: people[side].associate, role: "associate" });
      expect(typeof timers[0]!.stopped_at, side).toBe("string");
      expect(String(timers[0]!.stopped_at) >= String(timers[0]!.started_at), side).toBe(true);
      // A rule slot of the matter's playbook and one issue that no rule covers, the reviewer's.
      expect(
        issues.map((issue) => [issue.ordinal, issue.rule_key, issue.severity, issue.recorded_by]),
        side,
      ).toEqual([
        [0, firstRule, "high", people[side].reviewer],
        [1, null, "low", people[side].reviewer],
      ]);
      // Through the services: the application's own audit trail says who did what.
      expect(
        actions.filter((event) =>
          ["time.start", "time.stop", "reference.save"].includes(
            (event as { action: string }).action,
          ),
        ),
        side,
      ).toEqual([
        { action: "reference.save", actor: people[side].reviewer },
        { action: "time.start", actor: people[side].associate },
        { action: "time.stop", actor: people[side].associate },
      ]);
    }
    // The list of the case is saved before the review is started: the review closes it.
    const order = (seen.case!.actions as { action: string }[]).map((event) => event.action);
    expect(order.indexOf("reference.save")).toBeGreaterThan(-1);
    expect(order.indexOf("reference.save")).toBeLessThan(order.indexOf("run.create"));
  });

  it("stop the scan, as a control failure, when the services write nothing for a matter", async () => {
    const error = await failureOf({
      beforeRoutes: (_app, deps) => {
        const pilot = deps.services.pilot as unknown as Record<string, unknown>;
        pilot.saveReferenceList = () => undefined;
        pilot.startTimer = () => undefined;
        pilot.stopTimer = () => undefined;
      },
    });
    expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(error.message).toMatch(/no timer or no reference list/);
  });

  it.each([
    ["saveReferenceList", /could not save a reference list \(reference_locked\)/],
    ["startTimer", /could not run a timer \(timer_open\)/],
  ])(
    "stop the scan, as an error of the suite, when the service refuses (%s), and say the step and the code only",
    async (method, expected) => {
      const error = await failureOf({
        beforeRoutes: (_app, deps) => {
          const pilot = deps.services.pilot as unknown as Record<string, unknown>;
          pilot[method] = () => {
            throw new ConflictError(
              method === "startTimer" ? "timer_open" : "reference_locked",
              "words of a refusal that must not be repeated",
            );
          };
        },
      });
      expect(error.name).toBe("EvalError");
      expect(error.message).toMatch(expected);
      expect(error.message).not.toContain("words of a refusal");
    },
  );
});

// ---------------------------------------------------------------------------------------------
// What the scan can now see
// ---------------------------------------------------------------------------------------------

describe("a foreign matter id in the timers or the reference list", () => {
  type Plant = (site: ExposureSite, ids: ReturnType<typeof idsOf>) => void;
  const NOW = "2026-11-04T10:00:00.000Z";

  const cases: { name: string; label: string; plant: Plant }[] = [
    {
      // A timer row made for the case's matter whose id carries the canary matter's id. (A closed
      // timer takes no update, and a new one takes an id of any text.)
      name: "in a timer of the case's matter",
      label: "case time_entries",
      plant: (site, ids) =>
        site.repo.db
          .prepare(
            "INSERT INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', ?)",
          )
          .run(`tim_planted_${ids.canaryMatterId}`, ids.caseMatterId, CASE_ASSOCIATE, NOW),
    },
    {
      // The list of the case is closed by its review: the database refuses any edit, so the
      // trigger that holds it is dropped in the scratch store before the row is changed.
      name: "in a reference issue of the case's matter",
      label: "case reference_issues",
      plant: (site, ids) => {
        site.repo.db.exec("DROP TRIGGER reference_issues_immutable");
        site.repo.db
          .prepare(
            "UPDATE reference_issues SET recorded_at = recorded_at || ' ' || ? WHERE matter_id = ?",
          )
          .run(ids.canaryMatterId, ids.caseMatterId);
      },
    },
    {
      name: "in a timer of the canary matter, an id of the case",
      label: "bramblewick time_entries",
      plant: (site, ids) =>
        site.repo.db
          .prepare(
            "INSERT INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', ?)",
          )
          .run(`tim_planted_${ids.caseMatterId}`, ids.canaryMatterId, CANARY_ASSOCIATE, NOW),
    },
    {
      // The canary matter is never reviewed, so its list is open to one more issue.
      name: "in a reference issue of the canary matter, an id of the case",
      label: "bramblewick reference_issues",
      plant: (site, ids) =>
        site.repo.db
          .prepare(
            `INSERT INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at)
             VALUES (?, ?, NULL, 'medium', 7, ?, ?)`,
          )
          .run(`ref_planted_${ids.caseMatterId}`, ids.canaryMatterId, CANARY_REVIEWER, NOW),
    },
  ];

  it.each(cases)("is counted as a leak, once, in the rows of the table ($name)", async (entry) => {
    const result = await scan({
      afterReview: (site, context) => entry.plant(site, idsOf(context)),
    });
    expect(hitsOf(result, "store_rows", "id").map((hit) => hit.label)).toEqual([entry.label]);
    expect(result.foreignSpanIdHits).toBe(1);
    expect(result.canaryHits).toBe(0);
  });

  it("is not counted when nothing is planted (the plants above are what the scan found)", async () => {
    const result = await scan();
    expect(result.hits).toEqual([]);
    expect(result.foreignSpanIdHits + result.canaryHits).toBe(0);
  });
});

describe("a route that gives its reader every row of a table of the pilot measures", () => {
  /**
   * Answers every JSON read under a matter with the whole of the table as well, every matter's
   * rows, in a field of its own, so that the body still parses.
   */
  const dumping =
    (table: string): NonNullable<CanaryHooks["beforeRoutes"]> =>
    (app, deps) => {
      app.use("/api/matters/*", async (c, next) => {
        await next();
        if (c.req.method !== "GET" || c.res.status !== 200) return;
        if (!(c.res.headers.get("content-type") ?? "").includes("json")) return;
        const body = (await c.res.json()) as unknown;
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        const leaked = deps.repo.db.prepare(`SELECT * FROM ${table}`).all();
        c.res = new Response(JSON.stringify({ body, leaked }), { status: 200, headers });
      });
    };

  it.each(["time_entries", "reference_issues"])(
    "is counted in %s, for the case's readers and for the canary matter's, because both matters have rows in it",
    async (table) => {
      const result = await scan({ beforeRoutes: dumping(table) });
      const labels = hitsOf(result, "http_body", "id").map((hit) => hit.label);
      // The case's readers are sent the canary matter's rows, and the canary matter's the case's.
      expect(labels.some((label) => /^(associate|reviewer|viewer) GET /.test(label))).toBe(true);
      expect(labels.some((label) => label.startsWith("bramblewick "))).toBe(true);
      expect(result.foreignSpanIdHits).toBeGreaterThan(0);
      expect(result.canaryHits).toBe(0);
    },
  );

  it.each(["time_entries", "reference_issues"])(
    "goes unseen in %s where no matter has a row in it, which is why the suite writes them",
    async (table) => {
      const result = await scan({
        beforeRoutes: dumping(table),
        afterReview: (site) => {
          // As the tables were before the suite wrote them: empty. (The list of a reviewed matter
          // is closed by a trigger, which the scratch store drops.)
          site.repo.db.exec("DROP TRIGGER IF EXISTS reference_issues_closed_delete");
          site.repo.db.exec(`DELETE FROM ${table}`);
        },
      });
      expect(result.hits).toEqual([]);
    },
  );
});
