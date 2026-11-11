import { beforeAll, describe, expect, it, vi } from "vitest";
import { DEMO_USER_IDS } from "../../apps/parol/src/store/index.js";
import {
  runCanaryScan,
  STORE_SCOPES,
  storeRows,
  type CanaryHooks,
  type CanaryResult,
} from "../src/parol/exposure/canary.js";
import {
  CANARY_OWN_PAGES,
  requireOwnPagesAmong,
  requireRoutesFetched,
} from "../src/parol/exposure/canary-controls.js";
import type { Dataset } from "../src/parol/dataset.js";
import type { CapturingGenerator } from "../src/parol/exposure/model.js";
import { createScanner, type Scanner } from "../src/parol/exposure/scan.js";
import {
  expectedBodies,
  MATTER_GET,
  namesCanaryMatter,
  OTHER_GET_NOT_STATIC,
  spyScanner,
  STATIC_PAGES,
} from "./parol-canary-support.js";
import {
  CANARY_SHAPE,
  completeDataset,
  ID_SHAPE,
  never,
  playbook,
  ROOT,
} from "./parol-exposure-support.js";

/**
 * Guards of the canary scan that no other test could fail: each is shown here with the fault or the
 * leak planted in a copy of the application (or in the scanner) that exists for the test. A guard
 * that can be removed or emptied with every test still green is a guard on paper.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let dataset: Dataset;
beforeAll(async () => {
  dataset = await completeDataset();
});

const scan = (hooks?: CanaryHooks, edited?: Dataset): Promise<CanaryResult> =>
  runCanaryScan({
    dataset: edited ?? dataset,
    root: ROOT,
    playbook,
    signal: never(),
    ...(hooks === undefined ? {} : { hooks }),
  });

const failureOf = async (hooks?: CanaryHooks, edited?: Dataset): Promise<Error> => {
  const caught = await scan(hooks, edited).then(
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

const controlFailure = (error: Error) =>
  expect(error).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });

const hitsOf = (result: CanaryResult, kind: string, token: "canary" | "id") =>
  result.hits.filter((hit) => hit.kind === kind && hit.token === token);

const CANARY_ASSOCIATE = "usr_exposure_bramblewick_associate";
const canaryString = (): string => dataset.keys.canary!.matters[0]!.strings[0]!;

// ---------------------------------------------------------------------------------------------
// The four pages of the canary matter that its own people must be let into
// ---------------------------------------------------------------------------------------------

describe("the pages of its own matter that the canary matter's people must be let into", () => {
  /** Answers every GET under the canary matter as the plant says, and every other request as the application. */
  const damaging =
    (damage: (c: { res: Response; req: { path: string } }) => Promise<Response | undefined>) =>
    (
      hooks: { beforeRoutes: NonNullable<CanaryHooks["beforeRoutes"]> } = {
        beforeRoutes: () => {},
      },
    ): CanaryHooks => ({
      beforeRoutes: (app, deps) => {
        hooks.beforeRoutes(app, deps);
        app.use("*", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || c.res.status !== 200) return;
          if (!namesCanaryMatter(deps, c.req.path)) return;
          const replaced = await damage(c);
          if (replaced !== undefined) c.res = replaced;
        });
      },
    });

  it("are the four that load for them, among the routes they read", () => {
    expect([...CANARY_OWN_PAGES].sort()).toEqual(
      [
        "GET /api/matters/:matterId",
        "GET /api/matters/:matterId/runs",
        "GET /matters/:matterId",
        "GET /matters/:matterId/memos",
      ].sort(),
    );
    for (const page of CANARY_OWN_PAGES) expect(MATTER_GET.map((t) => `GET ${t}`)).toContain(page);
  });

  it("are all read by both of them, so that emptying the loop is seen", async () => {
    const { scanner, seen } = spyScanner();
    await scan({ scanner });
    const labels = new Set(seen.filter((s) => s.kind === "http_body").map((s) => s.label));
    for (const who of ["associate", "reviewer"])
      for (const page of CANARY_OWN_PAGES)
        expect(labels, `${who} ${page}`).toContain(`bramblewick ${who} ${page}`);
  });

  it("stop the scan when they answer a canary matter's own people with a 404", async () => {
    const error = await failureOf(
      damaging(async (c) => new Response("Not found.", { status: 404, headers: c.res.headers }))(),
    );
    // A page that did not load is not a fault of a control: it is the suite that cannot read.
    expect(error.name).toBe("EvalError");
    expect(error.message).toMatch(
      /did not load \(bramblewick (associate|reviewer) GET \S+, status 404\)/,
    );
    expect(error).toMatchObject({ exitCode: 1 });
  });

  it("stop the scan, as a control failure, when they answer with an empty body", async () => {
    const error = await failureOf(
      damaging(async (c) => {
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        return new Response("", { status: 200, headers });
      })(),
    );
    controlFailure(error);
    expect(error.message).toMatch(/empty body/);
  });

  it("stop the scan, as a control failure, when a JSON page does not parse", async () => {
    const error = await failureOf(
      damaging(async (c) => {
        if (!(c.res.headers.get("content-type") ?? "").includes("json")) return undefined;
        const headers = new Headers(c.res.headers);
        headers.delete("content-length");
        return new Response("{not json", { status: 200, headers });
      })(),
    );
    controlFailure(error);
    expect(error.message).toMatch(/does not parse/);
  });

  it("are not held to anything for the routes with made-up ids, which a canary matter may not have", async () => {
    // The canary matter is never reviewed, so a run, a finding, a memo and a file are 404 for its own
    // people, and the scan reads them without a status check. The clean application gives zero.
    const result = await scan();
    expect(result.hits).toEqual([]);
  });

  it("stop the suite when the probe tables no longer name one of them", () => {
    const labels = MATTER_GET.map((template) => `GET ${template}`);
    expect(() => requireOwnPagesAmong(labels)).not.toThrow();
    for (const page of CANARY_OWN_PAGES) {
      const failure = (() => {
        try {
          requireOwnPagesAmong(labels.filter((label) => label !== page));
        } catch (error) {
          return error as Error;
        }
        return undefined;
      })();
      expect(failure, page).toMatchObject({ name: "ExposureSuiteUnavailable" });
      expect(failure!.message).toContain(page);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// What the scan reads, and how often
// ---------------------------------------------------------------------------------------------

describe("what the scan says it read", () => {
  let result: CanaryResult;
  let reads: string[] = [];
  let findings = 0;
  beforeAll(async () => {
    const { scanner, seen } = spyScanner();
    result = await scan({
      scanner,
      afterReview: (site, context) => {
        findings = (
          site.repo.db
            .prepare("SELECT COUNT(*) AS n FROM findings WHERE matter_id = ?")
            .get(context.caseMatterId) as { n: number }
        ).n;
      },
    });
    reads = seen.filter((s) => s.kind === "http_body").map((s) => s.label);
  });

  it("reads exactly as many bodies as readers times routes", () => {
    expect(findings).toBeGreaterThan(0);
    expect(result.byKind.http_body).toBe(expectedBodies({ canaryMatters: 1, findings }));
    expect(reads).toHaveLength(result.byKind.http_body);
  });

  it("reads every GET route as every reader that can name it, and the static pages once", () => {
    const matter = MATTER_GET.map((t) => `GET ${t}`);
    const others = OTHER_GET_NOT_STATIC.map((t) => `GET ${t}`);
    const expected = new Set<string>();
    for (const who of ["associate", "reviewer", "viewer"]) {
      for (const route of [...matter, ...others]) expected.add(`${who} ${route}`);
      for (const route of matter) expected.add(`${who} on canary bramblewick ${route}`);
    }
    for (const who of ["associate", "reviewer"]) {
      for (const route of matter) expected.add(`bramblewick ${who} on case ${route}`);
      for (const route of [...matter, ...others]) expected.add(`bramblewick ${who} ${route}`);
    }
    for (const who of ["administrator", "legal engineer", "anonymous"]) {
      for (const route of others) expected.add(`${who} ${route}`);
      for (const route of matter) {
        expected.add(`${who} on case ${route}`);
        expected.add(`${who} on canary bramblewick ${route}`);
      }
    }
    for (const page of STATIC_PAGES) expected.add(`anonymous GET ${page}`);
    expect(new Set(reads)).toEqual(expected);
    // And not the static pages as anyone else.
    for (const page of STATIC_PAGES)
      expect(reads.filter((label) => label.endsWith(`GET ${page}`))).toEqual([
        `anonymous GET ${page}`,
      ]);
  });

  it("counts the routes it fetched from what it fetched", () => {
    const fetched = new Set(result.cases.flatMap((entry) => entry.routes));
    expect(result.routesFetched).toBe(fetched.size);
    expect([...fetched].sort()).toEqual(
      [...MATTER_GET, ...OTHER_GET_NOT_STATIC, ...STATIC_PAGES].map((t) => `GET ${t}`).sort(),
    );
    expect(result.sentence).toContain(`all ${result.routesFetched} GET routes`);
  });

  it("stops, as a control failure, when a route of the tables was never fetched", () => {
    const known = new Set(["GET /a", "GET /b", "GET /c"]);
    expect(() => requireRoutesFetched(new Set(known), known)).not.toThrow();
    const failure = (() => {
      try {
        requireRoutesFetched(new Set(["GET /a", "GET /c"]), known);
      } catch (error) {
        return error as Error;
      }
      return undefined;
    })();
    expect(failure).toMatchObject({ name: "ExposureControlFailure", exitCode: 2 });
    expect(failure!.message).toContain("1 of the 3 GET routes");
    expect(failure!.message).toContain("GET /b");
  });
});

// ---------------------------------------------------------------------------------------------
// Leaks planted in each direction and channel
// ---------------------------------------------------------------------------------------------

describe("a leak that only one direction or one channel can show", () => {
  it("is counted when a hole lets a case member read the canary matter (the case's people on its routes)", async () => {
    const result = await scan({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.getMember;
        (deps.repo as { getMember: unknown }).getMember = (matterId: string, userId: string) =>
          real(matterId, userId) ??
          (userId === DEMO_USER_IDS.associate &&
          deps.repo.getMatter(matterId)?.name.startsWith("Canary matter ")
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
    const labels = hitsOf(result, "http_body", "id").map((hit) => hit.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((label) => label.startsWith("associate on canary bramblewick "))).toBe(
      true,
    );
  });

  it("is counted when the canary matter's own pages carry an id of the case (their own routes)", async () => {
    let caseMatterId = "";
    const result = await scan({
      afterReview: (_site, context) => {
        caseMatterId = context.caseMatterId;
      },
      beforeRoutes: (app, deps) => {
        app.use("/api/matters/*", async (c, next) => {
          await next();
          if (c.req.method !== "GET" || c.res.status !== 200) return;
          if (caseMatterId === "" || !namesCanaryMatter(deps, c.req.path)) return;
          const body = await c.res.text();
          const headers = new Headers(c.res.headers);
          headers.delete("content-length");
          c.res = new Response(`${body}\n${caseMatterId}`, { status: 200, headers });
        });
      },
    });
    const labels = new Set(hitsOf(result, "http_body", "id").map((hit) => hit.label));
    expect([...labels].length).toBeGreaterThan(0);
    for (const who of ["associate", "reviewer"])
      expect(labels, who).toContain(`bramblewick ${who} GET /api/matters/:matterId`);
    expect([...labels].every((label) => label.startsWith("bramblewick "))).toBe(true);
    expect(result.canaryHits).toBe(0);
  });

  it("is counted when a row of the canary matter holds an id of the case (the canary matter's rows)", async () => {
    const result = await scan({
      afterReview: (site, context) => {
        site.repo.db
          .prepare(
            `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, text, created_at)
             VALUES (?, ?, NULL, NULL, ?, 'comment', ?, ?)`,
          )
          .run(
            "fbk_planted_canary_side",
            context.foreign[0]!.matterId,
            CANARY_ASSOCIATE,
            `copied from ${context.caseMatterId}`,
            "2026-11-04T10:00:00.000Z",
          );
      },
    });
    expect(hitsOf(result, "store_rows", "id")).toEqual([
      { kind: "store_rows", label: "bramblewick feedback", token: "id", index: 0 },
    ]);
    expect(result.canaryHits).toBe(0);
    expect(result.foreignSpanIdHits).toBe(1);
  });

  it("is counted when a canary string is in the services' log (the log)", async () => {
    const result = await scan({
      afterReview: (site, context) => {
        site.serviceLog.push(`a line with ${context.foreign[0]!.strings[0]!} in it`);
      },
    });
    expect(result.hits).toEqual([{ kind: "log", label: "service log", token: "canary", index: 0 }]);
    expect(result.canaryHits).toBe(1);
  });

  it("is counted in each table that a canary string can be written to (the tables of stored rows)", async () => {
    const planted: string[] = [];
    const result = await scan({
      afterReview: (site, context) => {
        const text = context.foreign[0]!.strings[0]!;
        const db = site.repo.db;
        for (const [table, where] of STORE_SCOPES) {
          const params = (where.match(/\?/g) ?? []).map(() => context.caseMatterId);
          const columns = (
            db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[]
          ).filter(
            (column) =>
              column.type.toUpperCase() === "TEXT" &&
              // Not a key or a reference: the row would leave the scope it was found by.
              column.name !== "id" &&
              !column.name.endsWith("_id"),
          );
          for (const column of columns) {
            try {
              const changed = db
                .prepare(
                  `UPDATE ${table} SET ${column.name} = COALESCE(${column.name}, '') || ? WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT 1)`,
                )
                .run(` ${text}`, ...params);
              if (Number(changed.changes) > 0) {
                planted.push(table);
                break;
              }
            } catch {
              // A trigger, a check or a key refuses this column: try the next one.
            }
          }
        }
      },
    });
    // Every table the plant reached is found by the scan, as a case table, and nothing else is.
    const found = hitsOf(result, "store_rows", "canary").map((hit) => hit.label);
    expect(found.sort()).toEqual(planted.map((table) => `case ${table}`).sort());
    // The tables that take a write without a trigger or a check refusing it. The others (the spans,
    // the findings, the reviews, the memos, the audit trail, and since migration 004 the model
    // calls, which are never edited once recorded) refuse one and are shown below.
    expect(planted).toEqual(
      expect.arrayContaining([
        "matters",
        "matter_members",
        "documents",
        "document_versions",
        "runs",
        "run_stages",
      ]),
    );
    expect(planted).not.toContain("model_calls");
  });

  it("is counted in every table of the scan, case side and canary side, whatever a table refuses to take", async () => {
    // A string is added to the text of each table's rows on its way to the scanner. That shows that
    // each table is scanned, for the right side's tokens, which the planted rows above show for the
    // tables that take a write.
    let caseMatterId = "";
    const real = createScanner();
    const adding: Scanner = {
      async scan(target) {
        if (target.kind !== "store_rows" || typeof target.content !== "string")
          return real.scan(target);
        if (target.label.startsWith("case "))
          return real.scan({ ...target, content: `${target.content} ${canaryString()}` });
        if (target.label.startsWith("bramblewick "))
          return real.scan({ ...target, content: `${target.content} ${caseMatterId}` });
        return real.scan(target);
      },
    };
    const result = await scan({
      scanner: adding,
      afterReview: (_site, context) => {
        caseMatterId = context.caseMatterId;
      },
    });
    const tables = STORE_SCOPES.map(([table]) => table).sort();
    expect(
      hitsOf(result, "store_rows", "canary")
        .map((hit) => hit.label)
        .sort(),
    ).toEqual(tables.map((table) => `case ${table}`).sort());
    expect(
      hitsOf(result, "store_rows", "id")
        .map((hit) => hit.label)
        .sort(),
    ).toEqual(tables.map((table) => `bramblewick ${table}`).sort());
  });

  it("is counted in the two tables that a review does not fill (feedback and eval_slot_results)", async () => {
    const result = await scan({
      afterReview: (site, context) => {
        const text = context.foreign[0]!.strings[0]!;
        const db = site.repo.db;
        db.prepare(
          `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, text, created_at)
           VALUES ('fbk_planted_case', ?, NULL, NULL, ?, 'comment', ?, '2026-11-04T10:00:00.000Z')`,
        ).run(context.caseMatterId, DEMO_USER_IDS.associate, `noted ${text}`);
        const run = db
          .prepare("SELECT id FROM runs WHERE matter_id = ? LIMIT 1")
          .get(context.caseMatterId) as { id: string };
        const workflow = db.prepare("SELECT id FROM workflow_versions LIMIT 1").get() as {
          id: string;
        };
        const playbookVersion = db.prepare("SELECT id FROM playbook_versions LIMIT 1").get() as {
          id: string;
        };
        db.prepare(
          "INSERT INTO eval_datasets (id, label, dev_sha256, heldout_sha256, created_at) VALUES ('evd_planted', 'planted', 'a', 'b', '2026-11-04T10:00:00.000Z')",
        ).run();
        db.prepare(
          `INSERT INTO eval_runs (id, dataset_id, split, workflow_version_id, playbook_version_id, model, repeats, price_table_sha256, results_path, started_at)
           VALUES ('evr_planted', 'evd_planted', 'dev', ?, ?, 'planted', 1, 'c', 'planted.json', '2026-11-04T10:00:00.000Z')`,
        ).run(workflow.id, playbookVersion.id);
        db.prepare(
          `INSERT INTO eval_slot_results (eval_run_id, case_key, rule_key, repeat, run_id, expected_status, got_status, scores_json)
           VALUES ('evr_planted', 'PAROL-D10', 'planted', 1, ?, 'x', 'y', ?)`,
        ).run(run.id, JSON.stringify({ note: text }));
      },
    });
    expect(
      hitsOf(result, "store_rows", "canary")
        .map((hit) => hit.label)
        .sort(),
    ).toEqual(["case eval_slot_results", "case feedback"]);
  });

  it("holds rows in every table of the scan after a review, but those two", async () => {
    // A table that is scanned for nothing because it is empty is a table whose leak cannot be seen:
    // so a review fills all but two, and a change that empties one of the others is noticed.
    let empty: string[] = [];
    await scan({
      afterReview: (site, context) => {
        empty = storeRows(site, context.caseMatterId)
          .filter((table) => table.content === "[]")
          .map((table) => table.label);
      },
    });
    expect(empty.sort()).toEqual(["eval_slot_results", "feedback"]);
    expect(STORE_SCOPES.map(([table]) => table)).toEqual(
      expect.arrayContaining(["audit_events", "runs", "model_calls", "findings", "matter_members"]),
    );
  });

  it("is not seen in the pages of a stranger when the administrator's own list does not load", async () => {
    // A 500 for the administrator's list is a body with nothing in it that a leak could be in, so
    // a stranger who cannot be let into the routes it should be let into stops the scan.
    const error = await failureOf({
      beforeRoutes: (_app, deps) => {
        const real = deps.repo.listMattersForUser;
        (deps.repo as { listMattersForUser: unknown }).listMattersForUser = (userId: string) => {
          if (userId === DEMO_USER_IDS.admin) throw new Error("planted fault");
          return real(userId);
        };
      },
    });
    expect(error.name).toBe("EvalError");
    expect(error.message).toMatch(/did not load \(administrator GET \S+, status 500\)/);
  });
});

// ---------------------------------------------------------------------------------------------
// Controls that stop the scan
// ---------------------------------------------------------------------------------------------

describe("the controls that stop the scan", () => {
  /** Notes the capturing generator of the scan, so that a test can reach what it recorded. */
  const withCapture = () => {
    const holder: { capture?: CapturingGenerator } = {};
    return {
      holder,
      beforeCapture: ((inner: unknown) => {
        holder.capture = inner as CapturingGenerator;
        return inner;
      }) as NonNullable<CanaryHooks["beforeCapture"]>,
    };
  };

  it("stops when the services' log is empty", async () => {
    const error = await failureOf({
      afterReview: (site) => {
        site.serviceLog.length = 0;
      },
    });
    controlFailure(error);
    expect(error.message).toMatch(/log is empty/);
  });

  it("stops when a request has no answer and no failure on record", async () => {
    const { holder, beforeCapture } = withCapture();
    const error = await failureOf({
      beforeCapture,
      afterReview: () => {
        holder.capture!.captured.responses.pop();
      },
    });
    controlFailure(error);
    expect(error.message).toMatch(/requests were recorded with/);
  });

  it("stops, as an error of the suite, when the review sent nothing to the model", async () => {
    const { holder, beforeCapture } = withCapture();
    const error = await failureOf({
      beforeCapture,
      afterReview: () => {
        holder.capture!.captured.requests.length = 0;
        holder.capture!.captured.responses.length = 0;
      },
    });
    expect(error.name).toBe("EvalError");
    expect(error.message).toMatch(/sent nothing to the scripted model/);
  });

  it("stops, as a control failure, when the canary matter has no canary string to scan for", async () => {
    const edited = await completeDataset((keys) => {
      keys.canary!.matters[0]!.strings = [];
    });
    const error = await failureOf(undefined, edited);
    controlFailure(error);
    expect(error.message).toMatch(/no spans or no canary strings/);
  });

  it("stops when the case's own rows do not hold an id the scan looks for", async () => {
    let caseMatterId = "";
    const real = createScanner();
    // A scanner that cannot find anything in the case's rows: the control scans them one token at a time.
    const blind: Scanner = {
      async scan(target) {
        if (
          target.label === "own rows" &&
          typeof target.content === "string" &&
          target.content.includes(caseMatterId)
        )
          return [];
        return real.scan(target);
      },
    };
    const error = await failureOf({
      scanner: blind,
      afterReview: (_site, context) => {
        caseMatterId = context.caseMatterId;
      },
    });
    controlFailure(error);
    expect(error.message).toMatch(/rows of the case matter of PAROL-D10 do not hold/);
  });

  it("stops when a matter's own rows do not hold its name or its client's, which are scanned for", async () => {
    const real = createScanner();
    const blindTo = (name: string): Scanner => ({
      async scan(target) {
        if (
          target.label === "own rows" &&
          target.forbid.ids.length === 1 &&
          target.forbid.ids[0]!.toLowerCase() === name.toLowerCase()
        )
          return [];
        return real.scan(target);
      },
    });
    const client = dataset.keys.canary!.matters[0]!.clientLegalName;
    let error = await failureOf({ scanner: blindTo(client) });
    controlFailure(error);
    expect(error.message).toMatch(/canary matter bramblewick \(its name and client\) do not hold/);
    error = await failureOf({ scanner: blindTo("PAROL-D10 review (exposure scan)") });
    controlFailure(error);
    expect(error.message).toMatch(/case matter of PAROL-D10 \(its name and client\) do not hold/);
  });

  it("stops when the scanner cannot find an id inside a compressed Word file, though it finds strings there", async () => {
    const real = createScanner();
    const noIdsInPackages: Scanner = {
      async scan(target) {
        const hits = await real.scan(target);
        return typeof target.content === "string"
          ? hits
          : hits.filter((hit) => hit.token === "canary");
      },
    };
    const error = await failureOf({ scanner: noIdsInPackages });
    controlFailure(error);
    expect(error.message).toMatch(/id it was given.*compressed Word file/);
  });
});
