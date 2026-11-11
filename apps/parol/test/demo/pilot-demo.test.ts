import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAll } from "../../src/boot/register.js";
import { REASON_CODES } from "../../src/contracts.js";
import { DEMO_MATTERS } from "../../src/demo/matters.js";
import {
  PILOT_DEMO_NOTICE,
  PilotDemoError,
  createSteppingClock,
  seedPilotDemo,
  type PilotDemoDocument,
  type PilotDemoReport,
  type SteppingClock,
} from "../../src/demo/pilot-demo.js";
import { createSimulatedModel } from "../../src/demo/simulated-model.js";
import { MEASURE_IDS } from "../../src/pilot/types.js";
import { parseEnv } from "../../src/main.js";
import {
  SeedError,
  describeSeed,
  parseSeedArgs,
  runSeed,
  seedDemo,
  workedExampleDocuments,
} from "../../src/seed.js";
import { createApp } from "../../src/server/app.js";
import type { AppConfig, AppDeps } from "../../src/server/deps.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { createServices } from "../../src/services/index.js";
import type { Services } from "../../src/services/types.js";
import {
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  openDatabase,
  type Repository,
} from "../../src/store/index.js";
import { expectAccessible } from "../a11y/rules.js";
import { ROOT } from "../integration/pipeline.js";
import { readable } from "../pages/html.js";
import { Browser } from "../routes/support.js";
import { SECRET } from "../server/support-app.js";

/**
 * The demonstration scenario of the pilot measures (package W2.6b, `pnpm parol:seed --pilot-demo`).
 *
 * What these tests hold the seed to: that it goes through the services (every step is an audited
 * call), that it is backdated and never later than the moment it runs, that it is idempotent and
 * refuses what it cannot finish, that the pilot scope stays empty and the synthetic scope has a value
 * in every measure, and that the numbers on the page come from the rows it left behind. No test here
 * states what the scripted reader found or what a measure comes to: where a figure is checked it is
 * counted from the stored rows with SQL, apart from the code that computes the measures. Everything
 * is synthetic and the reader is the scripted simulation.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const DAY = 86_400_000;
/** The moment the seed is run, in these tests. */
const ANCHOR = new Date("2026-11-11T12:00:00.000Z");
/** Before it: when the prompts and the playbook of a data folder were registered. */
const EARLIER = new Date("2026-11-10T08:00:00.000Z");
/** Twenty-nine days before the day of the anchor, worked out here and not read from the seed. */
const START_DATE = new Date(Date.UTC(2026, 10, 11) - 29 * DAY).toISOString().slice(0, 10);

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "parol-pilot-demo-"));
  roots.push(root);
  return root;
}

interface Built {
  root: string;
  clock: SteppingClock;
  repo: Repository;
  files: FileStore;
  services: Services;
  report: PilotDemoReport;
}

interface Plain {
  root: string;
  clock: SteppingClock;
  repo: Repository;
  files: FileStore;
  services: Services;
  documents: PilotDemoDocument[];
}

/** A data folder in memory whose repository and services follow a clock the scenario moves. */
function plain(): Plain {
  const root = folder();
  const clock = createSteppingClock(EARLIER);
  const repo = createRepository(openDatabase(":memory:"), { now: clock.now });
  const files = new FileStore(join(root, "matters"));
  const services = createServices({
    repo,
    files,
    generator: createSimulatedModel(),
    config: { relaxedSegregation: false },
    now: clock.now,
    log: () => {},
  });
  registerAll(repo, { seedDemoUsers: true });
  return { root, clock, repo, files, services, documents: workedExampleDocuments() };
}

async function build(): Promise<Built> {
  const world = plain();
  const report = await seedPilotDemo({
    repo: world.repo,
    services: world.services,
    clock: world.clock,
    documents: world.documents,
    anchor: ANCHOR,
  });
  return { ...world, report };
}

const principalOf = (repo: Repository, userId: string) => {
  const user = repo.getUser(userId)!;
  return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
};

const rows = <T>(repo: Repository, sql: string, ...params: (string | number)[]): T[] =>
  repo.db.prepare(sql).all(...params) as unknown as T[];
const one = <T>(repo: Repository, sql: string, ...params: (string | number)[]): T =>
  rows<T>(repo, sql, ...params)[0]!;
const count = (repo: Repository, sql: string, ...params: (string | number)[]): number =>
  one<{ n: number }>(repo, sql, ...params).n;

/** Every table's row count, so that "changes nothing" is not only about matters. */
function census(repo: Repository): Record<string, number> {
  const tables = rows<{ name: string }>(
    repo,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  return Object.fromEntries(
    tables.map(({ name }) => [name, count(repo, `SELECT COUNT(*) AS n FROM ${name}`)]),
  );
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

// ---------------------------------------------------------------------------------------------

describe("the stepping clock", () => {
  it("returns the instant it is at and then moves on by one step, so that no two readings are equal", () => {
    const clock = createSteppingClock(new Date("2026-01-05T09:00:00.000Z"), 250);
    const readings = [clock.now(), clock.now(), clock.now()].map((d) => d.toISOString());
    expect(readings).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T09:00:00.250Z",
      "2026-01-05T09:00:00.500Z",
    ]);
    expect(new Set(readings).size).toBe(readings.length);
  });

  it("jumps where it is told, forwards or back, and goes on from there", () => {
    const clock = createSteppingClock(new Date("2026-01-05T09:00:00.000Z"));
    clock.set(new Date("2026-03-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-03-01T00:00:01.000Z");
    clock.set(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("can be handed on as a bare function, which is how the repository and the services take it", () => {
    const { now } = createSteppingClock(new Date("2026-01-05T09:00:00.000Z"));
    expect(now().getTime()).toBeLessThan(now().getTime());
  });
});

describe("the scenario, built through the services", () => {
  let built: Built;
  beforeAll(async () => {
    built = await build();
  });

  it("makes two baseline and four assisted matters, each the associate's, with the attorney on it and the worked example in it", () => {
    const { repo, services, report } = built;
    expect(report.created).toBe(true);
    expect(report.matters.map((m) => m.kind)).toEqual([
      "baseline",
      "baseline",
      "assisted",
      "assisted",
      "assisted",
      "assisted",
    ]);
    expect(new Set(report.matters.map((m) => m.name)).size).toBe(report.matters.length);
    const worked = DEMO_MATTERS.find((m) => m.key === "lanternfish")!;
    const alex = principalOf(repo, DEMO_USER_IDS.associate);
    for (const made of report.matters) {
      const matter = repo.getMatter(made.matterId)!;
      // Every matter is synthetic, made by the demo associate, with the attorney as its reviewer.
      expect(matter.synthetic, made.name).toBe(true);
      expect(matter.createdBy, made.name).toBe(DEMO_USER_IDS.associate);
      expect(repo.getMember(made.matterId, DEMO_USER_IDS.associate)?.role).toBe("associate");
      expect(repo.getMember(made.matterId, DEMO_USER_IDS.reviewer)?.role).toBe("reviewer");
      expect(matter.playbookVersionId, made.name).not.toBeNull();
      // The documents are the worked example's, read from the dataset's own files.
      const titles = rows<{ title: string }>(
        repo,
        "SELECT title FROM documents WHERE matter_id = ? ORDER BY title",
        made.matterId,
      ).map((d) => d.title);
      expect(titles, made.name).toEqual(worked.documents.map((d) => d.title).sort());
    }
    // And the services list them for the associate and for nobody who is not on them.
    expect(
      services.matters
        .list(alex)
        .filter((m) => m.role === "associate")
        .map((m) => m.name)
        .sort(),
    ).toEqual(report.matters.map((m) => m.name).sort());
    expect(services.matters.list(principalOf(repo, DEMO_USER_IDS.legalEngineer))).toEqual([]);
  });

  it("goes through the services: every step it reports is an audited event, and the log is still a chain", () => {
    const { repo, report } = built;
    const events = (action: string): number =>
      count(repo, "SELECT COUNT(*) AS n FROM audit_events WHERE action = ?", action);
    const d = report.done;
    expect(events("pilot.calendar")).toBe(1);
    expect(events("pilot.participants")).toBe(1);
    expect(events("matter.create")).toBe(d.matters);
    expect(events("time.start")).toBe(d.sittings);
    expect(events("time.stop")).toBe(d.sittings);
    expect(events("reference.save")).toBe(d.referenceLists);
    expect(events("run.create")).toBe(d.reviews);
    expect(events("review.decide")).toBe(d.decisions);
    expect(events("memo.export")).toBe(d.memos);
    expect(events("feedback.add")).toBe(d.reports + d.ratings);
    // The scenario did something of every kind, so none of these is a zero equal to a zero.
    for (const [kind, done] of Object.entries(d)) expect(done, kind).toBeGreaterThan(0);
    expect(repo.verifyAuditChain()).toMatchObject({ ok: true });
  });

  it("dates the pilot back from the day it is run, and writes nothing later than that moment", () => {
    const { repo, report } = built;
    expect(report.startDate).toBe(START_DATE);
    expect(repo.getPilotAdmin().calendar?.startDate).toBe(START_DATE);
    const start = Date.parse(`${START_DATE}T00:00:00.000Z`);
    const days = (iso: string): number => Math.floor((Date.parse(iso) - start) / DAY);
    // What the scenario stored, leaving out the registration of prompts and the playbook, which a
    // data folder has before the seed starts and which these tests do at their own earlier moment.
    const stamps = [
      ...rows<{ at: string }>(
        repo,
        "SELECT at FROM audit_events WHERE action NOT IN ('prompt.register','workflow.register','playbook.import','playbook.approve')",
      ).map((e) => e.at),
      ...rows<{ t: string }>(repo, "SELECT started_at AS t FROM runs").map((r) => r.t),
      ...rows<{ t: string }>(repo, "SELECT created_at AS t FROM feedback").map((r) => r.t),
      ...rows<{ t: string }>(repo, "SELECT started_at AS t FROM time_entries").map((r) => r.t),
      ...rows<{ t: string }>(repo, "SELECT stopped_at AS t FROM time_entries").map((r) => r.t),
      ...rows<{ t: string }>(repo, "SELECT exported_at AS t FROM memos").map((r) => r.t),
    ];
    expect(stamps.length).toBeGreaterThan(100);
    for (const stamp of stamps) expect(Date.parse(stamp), stamp).toBeLessThan(ANCHOR.getTime());
    // It starts on the first day of the calendar and reaches into week 5, the current one, and the
    // last thing that happened was the day before the run.
    expect(Math.min(...stamps.map(days))).toBe(0);
    const last = Math.max(...stamps.map(days));
    expect(Math.floor(last / 7)).toBe(4);
    expect(last).toBe(Math.floor((ANCHOR.getTime() - start) / DAY) - 1);
  });

  it("puts the reviews where the pilot has them: the baseline matters read in week 2, the assisted ones in weeks 3 to 5", () => {
    const { repo, report } = built;
    const start = Date.parse(`${START_DATE}T00:00:00.000Z`);
    const weekOf = (iso: string): number => Math.floor((Date.parse(iso) - start) / DAY / 7) + 1;
    for (const made of report.matters) {
      const runs = rows<{ started_at: string; purpose: string }>(
        repo,
        "SELECT started_at, purpose FROM runs WHERE matter_id = ?",
        made.matterId,
      );
      expect(runs, made.name).toHaveLength(1);
      expect(runs[0]!.purpose).toBe("matter");
      const week = weekOf(runs[0]!.started_at);
      if (made.kind === "baseline") expect(week, made.name).toBe(2);
      else expect(week, made.name).toBeGreaterThanOrEqual(3);
      // The matter itself was made no later than its review.
      const created = repo.getMatter(made.matterId)!.createdAt;
      expect(Date.parse(created), made.name).toBeLessThan(Date.parse(runs[0]!.started_at));
      if (made.kind === "baseline") expect(weekOf(created), made.name).toBe(1);
    }
    // The assisted matters are spread over more than one week, so that repeat usage has something to count.
    const assistedWeeks = new Set(
      report.matters
        .filter((m) => m.kind === "assisted")
        .map((m) =>
          weekOf(
            one<{ started_at: string }>(
              repo,
              "SELECT started_at FROM runs WHERE matter_id = ?",
              m.matterId,
            ).started_at,
          ),
        ),
    );
    expect(assistedWeeks.size).toBeGreaterThan(1);
  });

  it("writes each reference list before its matter was read, and never after", () => {
    const { repo, report } = built;
    const lists = report.matters.filter(
      (m) =>
        rows(repo, "SELECT 1 FROM reference_issues WHERE matter_id = ?", m.matterId).length > 0,
    );
    expect(lists.map((m) => m.kind)).toEqual(["baseline", "baseline"]);
    for (const made of lists) {
      const run = one<{ started_at: string }>(
        repo,
        "SELECT started_at FROM runs WHERE matter_id = ?",
        made.matterId,
      );
      const recorded = rows<{ recorded_at: string; recorded_by: string }>(
        repo,
        "SELECT recorded_at, recorded_by FROM reference_issues WHERE matter_id = ?",
        made.matterId,
      );
      for (const issue of recorded) {
        expect(Date.parse(issue.recorded_at), made.name).toBeLessThan(Date.parse(run.started_at));
        expect(issue.recorded_by).toBe(DEMO_USER_IDS.reviewer);
      }
    }
    // Both kinds of issue are there: a rule of the playbook, and an issue no rule covers.
    const issues = rows<{ rule_key: string | null }>(repo, "SELECT rule_key FROM reference_issues");
    expect(issues.some((i) => i.rule_key !== null)).toBe(true);
    expect(issues.some((i) => i.rule_key === null)).toBe(true);
  });

  it("times each person on one thing at a time, from a Start to a Stop, and leaves no timer running", () => {
    const { repo, report } = built;
    const entries = rows<{
      user_id: string;
      started_at: string;
      stopped_at: string | null;
      role: string;
    }>(
      repo,
      "SELECT user_id, started_at, stopped_at, role FROM time_entries ORDER BY user_id, started_at",
    );
    expect(entries).toHaveLength(report.done.sittings);
    for (const entry of entries) expect(entry.stopped_at).not.toBeNull();
    expect(new Set(entries.map((e) => e.role))).toEqual(new Set(["associate", "reviewer"]));
    for (const user of [DEMO_USER_IDS.associate, DEMO_USER_IDS.reviewer]) {
      const mine = entries.filter((e) => e.user_id === user);
      expect(mine.length, user).toBeGreaterThan(1);
      for (let i = 1; i < mine.length; i += 1)
        expect(mine[i]!.started_at >= mine[i - 1]!.stopped_at!, user).toBe(true);
    }
  });

  it("gives the reviewing attorney a spread of decisions, with the reason codes the store requires", () => {
    const { repo } = built;
    const current = rows<{
      decision: string;
      reason_code: string | null;
      minor_edit: number | null;
      reviewer_id: string;
    }>(
      repo,
      "SELECT decision, reason_code, minor_edit, reviewer_id FROM reviews WHERE validity = 'current'",
    );
    expect(new Set(current.map((r) => r.decision))).toEqual(
      new Set(["accept", "edit", "reject", "escalate"]),
    );
    for (const r of current) expect(r.reviewer_id).toBe(DEMO_USER_IDS.reviewer);
    for (const r of current.filter((d) => d.decision === "edit" || d.decision === "reject"))
      expect(REASON_CODES as readonly string[]).toContain(r.reason_code);
    for (const r of current.filter((d) => d.decision === "accept" || d.decision === "escalate"))
      expect(r.reason_code).toBeNull();
    // Edits are both ways: one marked minor, and one that is not (a change of status never is).
    const edits = current.filter((d) => d.decision === "edit");
    expect(edits.some((r) => r.minor_edit === 1)).toBe(true);
    expect(edits.some((r) => r.minor_edit === 0)).toBe(true);
    // More than one reason code is used by the rejections and edits together.
    expect(
      new Set(current.filter((d) => d.reason_code !== null).map((d) => d.reason_code)).size,
    ).toBeGreaterThan(1);
  });

  it("exports memos for some assisted matters and not for all, and rates only what has a memo", () => {
    const { repo, report } = built;
    const assisted = report.matters.filter((m) => m.kind === "assisted");
    const exported = assisted.filter(
      (m) => count(repo, "SELECT COUNT(*) AS n FROM memos WHERE matter_id = ?", m.matterId) > 0,
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.length).toBeLessThan(assisted.length);
    expect(report.matters.filter((m) => m.kind === "baseline" && exported.includes(m))).toEqual([]);
    for (const made of report.matters) {
      const ratings = count(
        repo,
        "SELECT COUNT(*) AS n FROM feedback WHERE kind = 'rating' AND matter_id = ?",
        made.matterId,
      );
      if (!exported.includes(made)) expect(ratings, made.name).toBe(0);
    }
    // Ratings come from both people, so that the response rate is not a restatement of one of them.
    expect(
      new Set(
        rows<{ user_id: string }>(repo, "SELECT user_id FROM feedback WHERE kind = 'rating'").map(
          (r) => r.user_id,
        ),
      ).size,
    ).toBe(2);
    // A report on a matter nobody exported is there too: the page counts it as outside.
    const unexported = assisted.filter((m) => !exported.includes(m));
    expect(
      unexported.some(
        (m) =>
          count(
            repo,
            "SELECT COUNT(*) AS n FROM feedback WHERE kind = 'missed_issue' AND matter_id = ?",
            m.matterId,
          ) > 0,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

describe("what the pilot page makes of it", () => {
  let built: Built;
  beforeAll(async () => {
    built = await build();
  });
  const admin = (b: Built) => principalOf(b.repo, DEMO_USER_IDS.admin);

  it("leaves the pilot scope empty, whatever was stored, and says why", () => {
    const { services, report } = built;
    const view = services.pilot.measures(admin(built), "pilot");
    const population = (code: string): number =>
      view.measures.population.find((p) => p.code === code)!.count;
    expect(population("matters_total")).toBe(report.matters.length);
    expect(population("matters_synthetic")).toBe(report.matters.length);
    expect(population("matters_in_scope")).toBe(0);
    expect(view.measures.rows.length).toBeGreaterThan(20);
    for (const row of view.measures.rows) {
      expect(row.status, `${row.measure} ${row.key}`).toBe("no_data");
      expect(row.reason).toBe("all_excluded");
    }
    expect(view.emptyNote).toContain("No pilot data");
    expect(view.banner).toBeNull();
  });

  it("gives every measure a value in the synthetic scope, and no value only where nobody could have acted yet", () => {
    const { services, report } = built;
    const view = services.pilot.measures(admin(built), "synthetic");
    expect(view.banner).toContain("SYNTHETIC SCOPE");
    expect(view.measures.calendar?.startDate).toBe(START_DATE);
    for (const id of MEASURE_IDS) {
      const ofMeasure = view.measures.rows.filter((r) => r.measure === id);
      expect(
        ofMeasure.some((r) => r.status === "value"),
        id,
      ).toBe(true);
    }
    const noValue = view.measures.rows.filter((r) => r.status === "no_data");
    expect(noValue.length).toBeGreaterThan(0);
    for (const row of noValue) {
      // Weeks 1 and 2 hold no decision, export, report or rating: those are the phases without data.
      expect(row.reason, `${row.measure} ${row.key}`).toBe("no_denominator");
      expect(["baseline", "shadow"], `${row.measure} ${row.key}`).toContain(row.key);
      expect(row.breakdown).toBe("phase");
    }
    // And the population says how many matters were counted, apart from the figures themselves.
    expect(view.measures.population.find((p) => p.code === "matters_in_scope")!.count).toBe(
      report.matters.length,
    );
  });

  it("computes the figures from the stored rows: each agrees with a count made apart from the measures module", () => {
    const { services, repo } = built;
    const view = services.pilot.measures(admin(built), "synthetic");
    const row = (measure: string, breakdown: string, key = "") =>
      view.measures.rows.find(
        (r) => r.measure === measure && r.breakdown === breakdown && r.key === key,
      )!;
    const population = (code: string): number =>
      view.measures.population.find((p) => p.code === code)!.count;

    // Completion: matters with a memo over matters with a review started.
    const started = count(
      repo,
      "SELECT COUNT(DISTINCT matter_id) AS n FROM runs WHERE purpose = 'matter'",
    );
    const exported = count(repo, "SELECT COUNT(DISTINCT matter_id) AS n FROM memos");
    expect(row("completion", "overall")).toMatchObject({
      numerator: exported,
      denominator: started,
    });
    expect(population("matters_exported")).toBe(exported);

    // Corrections, and the minor-edit row, over the decisions that count.
    const decided = count(repo, "SELECT COUNT(*) AS n FROM reviews WHERE validity = 'current'");
    const corrected = count(
      repo,
      "SELECT COUNT(*) AS n FROM reviews WHERE validity = 'current' AND decision IN ('edit','reject')",
    );
    expect(row("correction_rate", "overall")).toMatchObject({
      numerator: corrected,
      denominator: decided,
    });
    const byCode = REASON_CODES.map(
      (code) => row("correction_rate", "reason_code", code).numerator,
    );
    expect(byCode.reduce((a, b) => a! + b!, 0)).toBe(corrected);
    for (const code of REASON_CODES)
      expect(row("correction_rate", "reason_code", code).numerator).toBe(
        count(
          repo,
          "SELECT COUNT(*) AS n FROM reviews WHERE validity = 'current' AND reason_code = ?",
          code,
        ),
      );
    expect(row("accepted_or_minor", "overall")).toMatchObject({
      numerator: count(
        repo,
        "SELECT COUNT(*) AS n FROM reviews WHERE validity = 'current' AND (decision = 'accept' OR (decision = 'edit' AND minor_edit = 1))",
      ),
      denominator: decided,
    });
    expect(row("escalation_reviewer", "of_decided", "decided")).toMatchObject({
      numerator: count(
        repo,
        "SELECT COUNT(*) AS n FROM reviews WHERE validity = 'current' AND decision = 'escalate'",
      ),
      denominator: decided,
    });

    // Findings of the reviews, the denominator of the system's own escalations.
    const findings = count(repo, "SELECT COUNT(*) AS n FROM findings");
    expect(row("escalation_system", "overall").denominator).toBe(findings);
    expect(population("findings")).toBe(findings);

    // Ratings: the median of the stored marks, with the number of marks as its n.
    const marks = rows<{ rating: number }>(
      repo,
      "SELECT rating FROM feedback WHERE kind = 'rating'",
    ).map((r) => r.rating);
    expect(row("satisfaction_rating", "overall")).toMatchObject({
      denominator: marks.length,
      value: median(marks),
    });
    for (const mark of [1, 2, 3, 4, 5])
      expect(row("satisfaction_rating", "distribution", String(mark)).numerator).toBe(
        marks.filter((m) => m === mark).length,
      );

    // Missed issues on exported matters, and the ones outside them.
    const reports = count(
      repo,
      "SELECT COUNT(*) AS n FROM feedback WHERE kind = 'missed_issue' AND matter_id IN (SELECT matter_id FROM memos)",
    );
    expect(row("missed_issue_rate", "overall")).toMatchObject({
      numerator: reports,
      denominator: exported,
    });
    expect(population("missed_reports_outside")).toBe(
      count(repo, "SELECT COUNT(*) AS n FROM feedback WHERE kind = 'missed_issue'") - reports,
    );

    // Timers: every closed entry is counted, and the sum of the two roles' sittings is the file's total.
    expect(population("time_entries_counted")).toBe(
      count(repo, "SELECT COUNT(*) AS n FROM time_entries WHERE stopped_at IS NOT NULL"),
    );
    expect(population("time_entries_open")).toBe(0);
    expect(population("reference_issues_compared")).toBe(
      count(repo, "SELECT COUNT(*) AS n FROM reference_issues"),
    );
    expect(population("participants_trained")).toBe(
      count(repo, "SELECT COUNT(*) AS n FROM pilot_participants"),
    );
  });

  it("gives the CSV of each scope: the scope on every row and, for the synthetic one, the word in the file name", () => {
    const { services } = built;
    for (const scope of ["pilot", "synthetic"] as const) {
      const file = services.pilot.csv(admin(built), scope);
      const lines = file.body.split("\r\n");
      expect(lines.at(-1)).toBe("");
      expect(lines[0]).toMatch(/^scope,/);
      for (const line of lines.slice(1, -1)) expect(line.startsWith(`${scope},`), line).toBe(true);
      expect(file.fileName.includes("SYNTHETIC")).toBe(scope === "synthetic");
    }
  });

  it("shows on the page what the service gives: the empty pilot scope, then the synthetic one with its banner and its values", async () => {
    const { repo, files, report } = built;
    // The server is another process after a seed, so its clock is its own.
    const services = createServices({
      repo,
      files,
      generator: createSimulatedModel(),
      config: { relaxedSegregation: false },
      now: () => ANCHOR,
      log: () => {},
    });
    const config: AppConfig = {
      demoIdentity: true,
      cookieSecret: SECRET,
      secureCookies: false,
      maxUploadBytes: 1024 * 1024,
    };
    const deps: AppDeps = { repo, services, config, now: () => ANCHOR };
    const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
    registerRoutes(app, deps);

    const sam = new Browser(app);
    await sam.signIn(DEMO_USER_IDS.admin);

    const pilot = await sam.page("/pilot");
    const pilotText = readable(expectAccessible(pilot.html));
    expect(pilotText).toContain("No pilot data");
    expect(pilotText).toContain(`This database holds ${report.matters.length} matters`);
    expect(pilotText).not.toContain("SYNTHETIC SCOPE");

    const synthetic = await sam.page("/pilot?scope=synthetic");
    const syntheticText = readable(expectAccessible(synthetic.html));
    expect(syntheticText).toContain("SYNTHETIC SCOPE");
    expect(syntheticText).toContain("not pilot data");
    expect(syntheticText).not.toContain("No pilot data");
    // The result cells are the service's own words for each row, row by row.
    const view = services.pilot.measures(principalOf(repo, DEMO_USER_IDS.admin), "synthetic");
    for (const table of view.tables)
      for (const tableRow of table.rows)
        for (const cell of tableRow.cells.filter((c) => !c.noData && c.text.length > 0))
          expect(syntheticText, cell.text).toContain(cell.text);

    const csv = await sam.get("/pilot/measures.csv?scope=synthetic");
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toContain("SYNTHETIC");
    const body = await csv.text();
    expect(
      body
        .split("\r\n")
        .slice(1, -1)
        .every((l) => l.startsWith("synthetic,")),
    ).toBe(true);

    // A member sees none of it.
    const alex = new Browser(app);
    await alex.signIn(DEMO_USER_IDS.associate);
    expect((await alex.get("/pilot")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe("running it again, and what it will not do", () => {
  it("changes nothing the second time: not a row of any table, and says it was already there", async () => {
    const world = plain();
    const first = await seedPilotDemo({ ...world, anchor: ANCHOR });
    const before = census(world.repo);
    const head = world.repo.auditHead();
    // A later day gives another start date; the matters are what is recognised, so nothing is added.
    const second = await seedPilotDemo({
      ...world,
      anchor: new Date(ANCHOR.getTime() + 3 * DAY),
    });
    expect(second.created).toBe(false);
    expect(second.startDate).toBe(first.startDate);
    expect(second.matters).toEqual(first.matters);
    expect(Object.values(second.done).every((n) => n === 0)).toBe(true);
    expect(census(world.repo)).toEqual(before);
    expect(world.repo.auditHead()).toEqual(head);
  });

  it("recognises its matters by name and owner: a matter of that name that is someone else's is not its own", async () => {
    const world = plain();
    const lee = principalOf(world.repo, DEMO_USER_IDS.legalEngineer);
    const theirs = world.services.matters.create(lee, {
      name: "Demonstration baseline 1",
      clientLegalName: "Someone Else, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const report = await seedPilotDemo({ ...world, anchor: ANCHOR });
    expect(report.created).toBe(true);
    expect(report.matters.map((m) => m.matterId)).not.toContain(theirs.id);
    // Theirs was not touched: no timer, no document, no run.
    for (const table of ["documents", "runs", "time_entries", "reference_issues"])
      expect(
        count(world.repo, `SELECT COUNT(*) AS n FROM ${table} WHERE matter_id = ?`, theirs.id),
        table,
      ).toBe(0);
  });

  it("refuses to replace a pilot calendar that is already set, and writes nothing", async () => {
    const world = plain();
    world.services.pilot.setCalendar(principalOf(world.repo, DEMO_USER_IDS.admin), {
      startDate: "2026-01-05",
    });
    const before = census(world.repo);
    const error = await seedPilotDemo({ ...world, anchor: ANCHOR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PilotDemoError);
    expect((error as Error).message).toMatch(/calendar is already set/);
    expect((error as Error).message).toMatch(/fresh data folder/);
    expect(census(world.repo)).toEqual(before);
    expect(world.repo.getPilotAdmin().calendar?.startDate).toBe("2026-01-05");
  });

  it("refuses to finish what an earlier run left half done, and writes nothing", async () => {
    const world = plain();
    world.services.matters.create(principalOf(world.repo, DEMO_USER_IDS.associate), {
      name: "Demonstration assisted 3",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const before = census(world.repo);
    const error = await seedPilotDemo({ ...world, anchor: ANCHOR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PilotDemoError);
    expect((error as Error).message).toMatch(/stopped half way/);
    expect(census(world.repo)).toEqual(before);
  });

  it("ends at the start, before it has written anything, when it has no documents to upload", async () => {
    const world = plain();
    const before = census(world.repo);
    const error = await seedPilotDemo({ ...world, documents: [], anchor: ANCHOR }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PilotDemoError);
    expect((error as Error).message).toMatch(/no documents/);
    expect(census(world.repo)).toEqual(before);
  });

  it("is given the dataset's own files, and says what to run when one is missing", () => {
    const documents = workedExampleDocuments();
    const worked = DEMO_MATTERS.find((m) => m.key === "lanternfish")!;
    expect(documents.map((d) => d.document.title)).toEqual(worked.documents.map((d) => d.title));
    for (const d of documents) expect(d.bytes.length, d.document.title).toBeGreaterThan(0);
    const error = (() => {
      try {
        workedExampleDocuments(join(folder(), "no-such-folder"));
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toMatch(/pnpm fixtures:parol/);
  });

  it("says in a sentence, and not as a store error, that a person already has a timer running", async () => {
    const world = plain();
    const alex = principalOf(world.repo, DEMO_USER_IDS.associate);
    const other = world.services.matters.create(alex, {
      name: "Some other matter",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: DEMO_USER_IDS.reviewer,
    });
    world.repo.startTimer(other.id, { userId: alex.userId });
    const error = await seedPilotDemo({ ...world, anchor: ANCHOR }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PilotDemoError);
    expect((error as Error).message).toMatch(/already has a timer running/);
    expect((error as Error).message).not.toContain(other.id);
  });
});

// ---------------------------------------------------------------------------------------------

describe("what the seed file is allowed to be", () => {
  const source = readFileSync(join(ROOT, "apps", "parol", "src", "demo", "pilot-demo.ts"), "utf8");

  it("does not compute a measure, build a CSV or read a fixture of results: it only calls the services", () => {
    expect(source).not.toMatch(/from "\.\.\/pilot\//);
    for (const word of [
      "computePilotMeasures",
      "presentMeasures",
      "PilotMeasures",
      "MeasureRow",
      "toCsv",
      "loadPilotRecords",
      "f1Records",
    ])
      expect(source, word).not.toContain(word);
    // It does not open the database either: no SQL in the seed.
    expect(source).not.toMatch(/\.db\b|\.prepare\(|SELECT |INSERT /);
  });

  it("states what the data is, in words the page and the summary share, and never calls it adoption, accuracy or time saved", () => {
    expect(PILOT_DEMO_NOTICE).toContain("Demonstration data");
    expect(PILOT_DEMO_NOTICE).toContain("scripted reader");
    expect(PILOT_DEMO_NOTICE).toContain("demonstration identities");
    expect(PILOT_DEMO_NOTICE).toContain("not a pilot result");
    // The comment at the top of the file may deny those words; the text the people read does not use them.
    expect(PILOT_DEMO_NOTICE).not.toMatch(/adoption|accuracy|time saved|saving/i);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the option --pilot-demo", () => {
  it("is accepted with the others, in any order, once", () => {
    expect(parseSeedArgs(["--pilot-demo"])).toEqual({ runs: [], pilotDemo: true });
    expect(parseSeedArgs(["--run", "v1", "--pilot-demo", "--training", "--pilot-demo"])).toEqual({
      runs: ["v1"],
      training: true,
      pilotDemo: true,
    });
    expect(parseSeedArgs(["--", "--pilot-demo"])).toEqual({ runs: [], pilotDemo: true });
  });

  it("is absent unless asked for, so the default seed is the one it always was", () => {
    expect(parseSeedArgs([])).toEqual({ runs: [] });
    expect(parseSeedArgs(["--run", "v2"])).not.toHaveProperty("pilotDemo");
    expect(parseSeedArgs(["--training"])).not.toHaveProperty("pilotDemo");
  });

  it("is not a word that can be abbreviated or given a value", () => {
    for (const args of [
      ["--pilot"],
      ["--pilot-demo=yes"],
      ["--pilot-demo", "yes"],
      ["pilot-demo"],
      ["--demo"],
    ])
      expect(() => parseSeedArgs(args), args.join(" ")).toThrow(SeedError);
  });

  it("is named in the usage line a refused option is answered with", () => {
    try {
      parseSeedArgs(["--nope"]);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("--pilot-demo");
    }
  });
});

describe("the command with --pilot-demo", () => {
  const demo = (dataDir: string) => ({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir });
  const censusOf = (dataDir: string): Record<string, number> => {
    const db = openDatabase(join(dataDir, "parol.sqlite"));
    try {
      return census(createRepository(db));
    } finally {
      db.close();
    }
  };

  it("seeds the pilot demonstration on top of the demonstration matters, and says what it is and is not", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    const report = await runSeed(demo(dataDir), ["--pilot-demo"], (l) => lines.push(l));
    expect(report.matters.map((m) => m.key)).toEqual(["lanternfish", "heronbridge"]);
    expect(report.pilotDemo).toMatchObject({ created: true });
    expect(report.pilotDemo!.matters).toHaveLength(6);
    const text = lines.join("\n");
    expect(text).toContain("Pilot demonstration: 6 matters made (2 baseline, 4 assisted)");
    expect(text).toContain(PILOT_DEMO_NOTICE);
    expect(text).toContain("reviews by the scripted reader");
    expect(text).toContain("use a fresh data folder");
    expect(text).toContain("http://127.0.0.1:8787/pilot?scope=synthetic");
    expect(text).toContain("The pilot scope, http://127.0.0.1:8787/pilot, stays empty");
    expect(text).toContain("Lee Okafor (legal engineer) or Sam Patel (admin)");
    expect(text).toContain(`The pilot calendar starts on ${report.pilotDemo!.startDate} (UTC)`);
    // What each person can see is asked again once the scenario is in: the associate and the attorney
    // are on all of its matters, and the legal engineer on none of them.
    const seen = (name: string) => report.people.find((p) => p.name.startsWith(name))!.matters;
    for (const made of report.pilotDemo!.matters) {
      expect(seen("Alex"), made.name).toContain(made.name);
      expect(seen("Dana"), made.name).toContain(made.name);
      expect(seen("Lee"), made.name).not.toContain(made.name);
      expect(seen("Sam"), made.name).not.toContain(made.name);
    }
    expect(text).toContain(
      `Alex Ruiz (associate): ${seen("Alex")
        .map((n) => `"${n}"`)
        .join(", ")}`,
    );
    // It is a demonstration and nothing else: none of the words a result would use.
    expect(text).not.toMatch(/adoption|accuracy|time saved|saving/i);
    // And no passage of a document: the lines name matters, people and counts.
    const amendment = readFileSync(
      join(ROOT, "fixtures", "parol", "files", "parol-d05-amendment-1.txt"),
      "utf8",
    );
    for (const passage of amendment.split(/\n+/).filter((p) => p.length > 40))
      expect(text, passage).not.toContain(passage);
  });

  it("dates what it made back from the day it is run: the calendar 29 days back, and no stored time later than the command", async () => {
    const dataDir = join(folder(), "data");
    const before = Date.now();
    const report = await runSeed(demo(dataDir), ["--pilot-demo"], () => {});
    const after = Date.now();
    const dayOf = (ms: number): string =>
      new Date(Math.floor(ms / DAY) * DAY - 29 * DAY).toISOString().slice(0, 10);
    // Run across midnight, either day is the right one.
    expect([dayOf(before), dayOf(after)]).toContain(report.pilotDemo!.startDate);

    // The repository and the services of the command follow the scenario's clock: what they wrote is
    // dated in the weeks since the calendar began, and none of it is later than the command.
    const db = openDatabase(join(dataDir, "parol.sqlite"));
    try {
      const repo = createRepository(db);
      const start = Date.parse(`${report.pilotDemo!.startDate}T00:00:00.000Z`);
      const times = (sql: string): number[] =>
        rows<{ t: string }>(repo, sql).map((r) => Date.parse(r.t));
      const written = [
        ...times("SELECT started_at AS t FROM runs"),
        ...times("SELECT exported_at AS t FROM memos"),
        ...times("SELECT created_at AS t FROM feedback"),
        ...times("SELECT started_at AS t FROM time_entries"),
        ...times("SELECT stopped_at AS t FROM time_entries"),
        ...times("SELECT recorded_at AS t FROM reference_issues"),
        ...times("SELECT set_at AS t FROM pilot_calendar"),
      ];
      expect(written.length).toBeGreaterThan(50);
      for (const at of written) expect(at).toBeLessThan(before);
      // The first review is in week 2 or later, and the last thing written is in week 5.
      expect(Math.min(...times("SELECT started_at AS t FROM runs"))).toBeGreaterThanOrEqual(
        start + 7 * DAY,
      );
      expect(Math.floor((Math.max(...written) - start) / DAY / 7)).toBe(4);

      // The services follow it too, and not only the store: a memo says on what day it was exported,
      // and that is the day the scenario put it on and not the day the command ran.
      const files = new FileStore(join(dataDir, "matters"));
      const memos = rows<{ exported_at: string; storage_path: string }>(
        repo,
        "SELECT exported_at, storage_path FROM memos",
      );
      expect(memos.length).toBeGreaterThan(0);
      for (const memo of memos) {
        const zip = await JSZip.loadAsync(new Uint8Array(files.read(memo.storage_path)));
        const text = (await zip.file("word/document.xml")!.async("string")).replace(/<[^>]+>/g, "");
        const on = new Date(memo.exported_at);
        const month = on.toLocaleString("en-GB", { month: "long", timeZone: "UTC" });
        expect(text).toContain(`on ${on.getUTCDate()} ${month} ${on.getUTCFullYear()} (UTC)`);
      }
    } finally {
      db.close();
    }
  });

  it("makes nothing the second time, and says so", async () => {
    const dataDir = join(folder(), "data");
    await runSeed(demo(dataDir), ["--pilot-demo"], () => {});
    const before = censusOf(dataDir);
    const lines: string[] = [];
    const second = await runSeed(demo(dataDir), ["--pilot-demo"], (l) => lines.push(l));
    expect(second.pilotDemo).toMatchObject({ created: false });
    expect(lines.join("\n")).toContain("Pilot demonstration: already there, nothing to add");
    expect(censusOf(dataDir)).toEqual(before);
  });

  it("is not part of the default seed: without the option there is no calendar, no timer and no reference list", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    const report = await runSeed(demo(dataDir), [], (l) => lines.push(l));
    expect(report.pilotDemo).toBeNull();
    expect(lines.join("\n")).not.toContain("Pilot demonstration");
    const counts = censusOf(dataDir);
    for (const table of [
      "pilot_calendar",
      "pilot_participants",
      "time_entries",
      "reference_issues",
    ])
      expect(counts[table], table).toBe(0);
    // And the matters it always makes are the two it always made.
    expect(counts["matters"]).toBe(2);
  });

  it("refuses, in the seed's own words, when a calendar was set by someone else", async () => {
    const dataDir = join(folder(), "data");
    // Another data folder state: the seed has run, a calendar is set, and the scenario is not there.
    await runSeed(demo(dataDir), [], () => {});
    const db = openDatabase(join(dataDir, "parol.sqlite"));
    try {
      const repo = createRepository(db);
      const services = createServices({
        repo,
        files: new FileStore(join(dataDir, "matters")),
        generator: createSimulatedModel(),
        config: { relaxedSegregation: false },
        now: () => ANCHOR,
        log: () => {},
      });
      services.pilot.setCalendar(principalOf(repo, DEMO_USER_IDS.admin), {
        startDate: "2026-01-05",
      });
    } finally {
      db.close();
    }
    const before = censusOf(dataDir);
    const error = await runSeed(demo(dataDir), ["--pilot-demo"], () => {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedError);
    expect((error as Error).message).toMatch(/pilot calendar is already set/);
    expect(censusOf(dataDir)).toEqual(before);
  });

  it("leaves a training matter out of both scopes when both options are given, and the scenario's matters in the synthetic one", async () => {
    const dataDir = join(folder(), "data");
    const report = await runSeed(demo(dataDir), ["--training", "--pilot-demo"], () => {});
    expect(report.training).not.toBeNull();
    const db = openDatabase(join(dataDir, "parol.sqlite"));
    try {
      const repo = createRepository(db);
      const services = createServices({
        repo,
        files: new FileStore(join(dataDir, "matters")),
        generator: createSimulatedModel(),
        config: { relaxedSegregation: false },
        now: () => ANCHOR,
        log: () => {},
      });
      const sam = principalOf(repo, DEMO_USER_IDS.admin);
      const population = (scope: "pilot" | "synthetic", code: string): number =>
        services.pilot.measures(sam, scope).measures.population.find((p) => p.code === code)!.count;
      expect(population("synthetic", "matters_training")).toBe(1);
      // Two demonstration matters, the six of the scenario and the training matter, which is in no scope.
      expect(population("synthetic", "matters_total")).toBe(
        2 + report.pilotDemo!.matters.length + 1,
      );
      expect(population("synthetic", "matters_in_scope")).toBe(
        2 + report.pilotDemo!.matters.length,
      );
      expect(population("pilot", "matters_in_scope")).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("describeSeed", () => {
  it("prints nothing about the pilot demonstration when there is none, and the same lines as before", async () => {
    const world = plain();
    const report = await seedDemo({ repo: world.repo, files: world.files });
    expect(report.pilotDemo).toBeNull();
    const settings = parseEnv({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: "/data" });
    expect(describeSeed(report, settings).join("\n")).not.toContain("Pilot demonstration");
  });
});

describe("pnpm parol:seed --pilot-demo, as a process", () => {
  it("seeds the scenario with the lone -- that pnpm passes on, and says it was already there the second time", () => {
    const tsx = join(ROOT, "node_modules", ".bin", "tsx");
    const run = (dataDir: string) =>
      spawnSync(
        tsx,
        [
          "--tsconfig",
          join(ROOT, "apps", "parol", "tsconfig.json"),
          join(ROOT, "apps", "parol", "src", "seed.ts"),
          "--",
          "--pilot-demo",
        ],
        {
          cwd: ROOT,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
            PAROL_DEMO_IDENTITY: "1",
            PAROL_DATA_DIR: dataDir,
          },
          encoding: "utf8",
        },
      );
    const dataDir = join(folder(), "data");
    const first = run(dataDir);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("Pilot demonstration: 6 matters made (2 baseline, 4 assisted)");
    expect(first.stdout).toContain("It is not a pilot result.");
    const again = run(dataDir);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("Pilot demonstration: already there, nothing to add");
  });
});
