import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { calendarEnd } from "../../src/pilot/calendar.js";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import {
  ConflictError,
  MAX_PARTICIPANTS,
  NotFoundError,
  PILOT_REFUSAL_CODES,
  StoreError,
  ValidationError,
  createRepository,
  openDatabase,
  tablesHoldingMatter,
} from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  makeWorld,
  seedPrompts,
  startRun,
  type MatterFixture,
  type World,
} from "./fixtures.js";

/**
 * The pilot measures' own tables (migration 008): the calendar, the roster of trained people, the
 * timers and the shadow-mode reference list. What the database refuses is tested with raw SQL, the
 * way a bug or an attacker with the file would write it, and where the code checks the same rule
 * first, the check is shown to hold without the trigger or the index. Every figure is invented.
 */

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const q = <T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T =>
  w.db.prepare(sql).get(...params) as T;
const rows = <T = Record<string, unknown>>(
  sql: string,
  ...params: (string | number | null)[]
): T[] => w.db.prepare(sql).all(...params) as T[];
const raw =
  (sql: string, ...params: (string | number | null)[]) =>
  () =>
    w.db.prepare(sql).run(...params);

/** The refusal codes every test below has seen, so that the last test can say none was left unraised. */
const seen = new Set<string>();

/** What `fn` threw, with its code noted. Throws if it did not throw. */
function refused(fn: () => unknown): StoreError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    seen.add((error as StoreError).code);
    return error as StoreError;
  }
  throw new Error("expected a refusal");
}

const associate = { actorId: ACTORS.associate };

/** The four tables of migration 008. */
const TABLES = ["pilot_calendar", "pilot_participants", "reference_issues", "time_entries"];

/** A matter with the associate (its creator) and the reviewer, the playbook pinned, nothing run. */
function matterWithReviewer(): MatterFixture {
  const m = addMatter(w);
  w.repo.addMember(m.id, ACTORS.reviewer, "reviewer", associate);
  return m;
}

const eventsOf = (action: string) => w.repo.listAuditEvents({ action });
const noList = { rules: [], outsideHigh: 0, outsideMedium: 0, outsideLow: 0 };

// ---------------------------------------------------------------------------------------------
describe("migration 008", () => {
  it("adds four tables, four named indexes and thirteen triggers to a fresh database", () => {
    const names = (type: string): string[] =>
      rows<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = ? AND tbl_name IN (${TABLES.map(() => "?").join(",")})
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        type,
        ...TABLES,
      ).map((row) => row.name);
    expect(names("table")).toEqual(TABLES);
    expect(names("index")).toEqual([
      "reference_issues_by_matter",
      "reference_issues_one_per_rule",
      "time_entries_by_matter",
      "time_entries_one_open_per_user",
    ]);
    expect(names("trigger")).toEqual([
      "pilot_calendar_no_delete",
      "pilot_calendar_no_replace",
      "pilot_calendar_no_update",
      "pilot_participants_no_replace",
      "reference_issues_closed_delete",
      "reference_issues_closed_insert",
      "reference_issues_immutable",
      "reference_issues_no_replace",
      "reference_issues_reviewer",
      "time_entries_member",
      "time_entries_no_replace",
      "time_entries_start_open",
      "time_entries_stop_once",
    ]);
  });

  it("holds no column that can hold text: a timer, an issue, a date and a roster are codes and times", () => {
    const columns = TABLES.flatMap((table) =>
      rows<{ name: string; type: string }>(`PRAGMA table_info(${table})`).map(
        (c) => `${table}.${c.name}`,
      ),
    );
    expect(columns.sort()).toEqual(
      [
        "pilot_calendar.seq",
        "pilot_calendar.start_date",
        "pilot_calendar.set_by",
        "pilot_calendar.set_at",
        "pilot_participants.user_id",
        "pilot_participants.recorded_by",
        "pilot_participants.recorded_at",
        "time_entries.id",
        "time_entries.matter_id",
        "time_entries.user_id",
        "time_entries.role",
        "time_entries.started_at",
        "time_entries.stopped_at",
        "reference_issues.id",
        "reference_issues.matter_id",
        "reference_issues.rule_key",
        "reference_issues.severity",
        "reference_issues.ordinal",
        "reference_issues.recorded_by",
        "reference_issues.recorded_at",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("a training matter", () => {
  /** The training matter of the associate, with the reviewer on it: the pilot measures leave it out. */
  function trainingMatter() {
    const created = w.repo.createMatter({
      name: "Training: Lanternfish / Corvane NDA (T01)",
      clientLegalName: "Lanternfish Software, Inc.",
      createdBy: ACTORS.associate,
      synthetic: true,
      trainingKey: "T01",
    });
    w.repo.addMember(created.id, ACTORS.reviewer, "reviewer", associate);
    return created;
  }
  /** A timer as an earlier build left it: the database does not hold the rule, the code does. */
  const plantTimer = (matterId: string, userId: string, role: string) =>
    w.db
      .prepare(
        "INSERT INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("tim_earlier", matterId, userId, role, "2026-11-01T08:00:00.000Z");

  it("takes no timer, which no measure counts and the page does not offer: a closed refusal and nothing written", () => {
    const m = trainingMatter();
    const events = w.repo.countAuditEvents();
    for (const userId of [ACTORS.associate, ACTORS.reviewer]) {
      const error = refused(() => w.repo.startTimer(m.id, { userId }));
      expect(error, userId).toBeInstanceOf(ConflictError);
      expect(error.code, userId).toBe("timer_training");
    }
    expect(q("SELECT COUNT(*) AS n FROM time_entries")).toEqual({ n: 0 });
    expect(w.repo.countAuditEvents()).toBe(events);
    // The person is free to time an ordinary matter, which the refused start did not block.
    const ordinary = matterWithReviewer();
    expect(w.repo.startTimer(ordinary.id, { userId: ACTORS.associate }).matterId).toBe(ordinary.id);
  });

  it("takes no reference list, from the reviewer or anyone: a closed refusal and nothing written", () => {
    const m = trainingMatter();
    const events = w.repo.countAuditEvents();
    const error = refused(() =>
      w.repo.saveReferenceList(
        m.id,
        { rules: [], outsideHigh: 1, outsideMedium: 0, outsideLow: 2 },
        { userId: ACTORS.reviewer },
      ),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("reference_training");
    expect(q("SELECT COUNT(*) AS n FROM reference_issues")).toEqual({ n: 0 });
    expect(w.repo.countAuditEvents()).toBe(events);
    // The role is still asked first: an associate is told it is the reviewer's to record.
    expect(
      refused(() =>
        w.repo.saveReferenceList(
          m.id,
          { rules: [], outsideHigh: 0, outsideMedium: 0, outsideLow: 0 },
          { userId: ACTORS.associate },
        ),
      ).code,
    ).toBe("reference_role");
  });

  it("can still have a running timer stopped, one that a database made earlier holds", () => {
    const m = trainingMatter();
    plantTimer(m.id, ACTORS.associate, "associate");
    // The stray timer blocks nothing it should not: it is open, so a start elsewhere is refused ...
    const ordinary = matterWithReviewer();
    expect(refused(() => w.repo.startTimer(ordinary.id, { userId: ACTORS.associate })).code).toBe(
      "timer_open",
    );
    // ... and the person can put it away, on the training matter, from the server's clock.
    w.clock.tick(5_000);
    const stopped = w.repo.stopTimer(m.id, { userId: ACTORS.associate });
    expect(stopped).toMatchObject({ id: "tim_earlier", seconds: expect.any(Number) });
    expect(stopped.stoppedAt).not.toBeNull();
    expect(w.repo.startTimer(ordinary.id, { userId: ACTORS.associate }).matterId).toBe(ordinary.id);
  });
});

// ---------------------------------------------------------------------------------------------
describe("INSERT OR REPLACE over every unique key of the four tables", () => {
  /**
   * A replace deletes the row that holds a key and then inserts, and no UPDATE or DELETE trigger
   * sees it. Each case below collides on one key with a row that has a different value in every
   * other key, so that it is the key and not the id that the guard has to name. Each is run twice:
   * with the guard, which refuses and leaves the table as it was, and without it (the trigger
   * dropped), where the replace succeeds and the row that held the key is gone. The second run is
   * what shows that the first is the guard's doing.
   */
  interface Case {
    name: string;
    table: string;
    guard: string;
    /** Other triggers that would also see the deleted row (the database runs recursive triggers). */
    alsoSees?: string[];
    /** Makes the row that holds the key; returns the parameters of the colliding statement. */
    setup: () => (string | number | null)[];
    sql: string;
    /** The pattern the guard's message matches. */
    refusal: RegExp;
  }

  const CASES: Case[] = [
    {
      name: "the sequence number of the calendar",
      table: "pilot_calendar",
      guard: "pilot_calendar_no_replace",
      // The calendar has a delete trigger of its own, which the replace's deletion also fires.
      alsoSees: ["pilot_calendar_no_delete"],
      setup: () => {
        w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: ACTORS.admin });
        return [ACTORS.admin];
      },
      sql: "INSERT OR REPLACE INTO pilot_calendar (seq, start_date, set_by, set_at) VALUES (1, '2026-01-01', ?, 't')",
      refusal: /append-only/,
    },
    {
      name: "the user of the roster",
      table: "pilot_participants",
      guard: "pilot_participants_no_replace",
      setup: () => {
        w.repo.setPilotParticipants([ACTORS.associate], { actorId: ACTORS.admin });
        return [ACTORS.associate, ACTORS.legalEngineer];
      },
      sql: "INSERT OR REPLACE INTO pilot_participants (user_id, recorded_by, recorded_at) VALUES (?, ?, 'later')",
      refusal: /roster entry is never replaced/,
    },
    {
      name: "the id of a timer",
      table: "time_entries",
      guard: "time_entries_no_replace",
      setup: () => {
        const m = matterWithReviewer();
        const entry = w.repo.startTimer(m.id, { userId: ACTORS.associate });
        w.repo.stopTimer(m.id, { userId: ACTORS.associate });
        return [entry.id, m.id, ACTORS.associate];
      },
      sql: "INSERT OR REPLACE INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', 'x')",
      refusal: /time entries are never replaced/,
    },
    {
      name: "the one open timer of a person, under a new id",
      table: "time_entries",
      guard: "time_entries_no_replace",
      setup: () => {
        const m = matterWithReviewer();
        w.repo.startTimer(m.id, { userId: ACTORS.associate });
        return ["tim_new", m.id, ACTORS.associate];
      },
      sql: "INSERT OR REPLACE INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', 'x')",
      refusal: /time entries are never replaced/,
    },
    {
      name: "the one open timer of a person, on another matter",
      table: "time_entries",
      guard: "time_entries_no_replace",
      setup: () => {
        const one = matterWithReviewer();
        const two = matterWithReviewer();
        w.repo.startTimer(one.id, { userId: ACTORS.associate });
        return ["tim_new", two.id, ACTORS.associate];
      },
      sql: "INSERT OR REPLACE INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', 'x')",
      refusal: /time entries are never replaced/,
    },
    {
      name: "the id of a reference issue",
      table: "reference_issues",
      guard: "reference_issues_no_replace",
      setup: () => {
        const m = savedList();
        const id = (q("SELECT id FROM reference_issues WHERE ordinal = 0") as { id: string }).id;
        return [id, m.id, 7, ACTORS.reviewer];
      },
      sql: "INSERT OR REPLACE INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at) VALUES (?, ?, 'gov-1', 'low', ?, ?, 't')",
      refusal: /reference issues are never replaced/,
    },
    {
      name: "the place of an issue in the list of a matter, under a new id",
      table: "reference_issues",
      guard: "reference_issues_no_replace",
      setup: () => {
        const m = savedList();
        return ["ref_new", m.id, 0, ACTORS.reviewer];
      },
      sql: "INSERT OR REPLACE INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at) VALUES (?, ?, 'gov-1', 'low', ?, ?, 't')",
      refusal: /reference issues are never replaced/,
    },
    {
      name: "the rule of a matter, under a new id and another place",
      table: "reference_issues",
      guard: "reference_issues_no_replace",
      setup: () => {
        const m = savedList();
        return ["ref_new", m.id, 7, ACTORS.reviewer];
      },
      sql: "INSERT OR REPLACE INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at) VALUES (?, ?, 'dur-1', 'low', ?, ?, 't')",
      refusal: /reference issues are never replaced/,
    },
  ];

  /** A matter whose list holds dur-1 (high, place 0) and one high issue no rule covers (place 1). */
  function savedList(): MatterFixture {
    const m = matterWithReviewer();
    w.repo.saveReferenceList(
      m.id,
      {
        rules: [{ ruleKey: "dur-1", severity: "high" }],
        outsideHigh: 1,
        outsideMedium: 0,
        outsideLow: 0,
      },
      { userId: ACTORS.reviewer },
    );
    return m;
  }

  for (const c of CASES) {
    it(`refuses a replace on ${c.name}, and without the guard the replace deletes the row`, () => {
      const params = c.setup();
      const before = rows(`SELECT * FROM ${c.table} ORDER BY rowid`);
      expect(before.length, c.name).toBeGreaterThan(0);

      expect(raw(c.sql, ...params), c.name).toThrow(c.refusal);
      expect(rows(`SELECT * FROM ${c.table} ORDER BY rowid`), c.name).toEqual(before);

      // Without the guard the same statement is accepted: it is the guard that refused it.
      for (const name of [c.guard, ...(c.alsoSees ?? [])]) w.db.exec(`DROP TRIGGER ${name}`);
      raw(c.sql, ...params)();
      expect(rows(`SELECT * FROM ${c.table} ORDER BY rowid`), c.name).not.toEqual(before);
    });
  }

  it("leaves a write that collides on no key alone, so the guards are not a blanket refusal", () => {
    // A timer for another person, and a new one for the same person once the first is stopped.
    const m = matterWithReviewer();
    const first = w.repo.startTimer(m.id, { userId: ACTORS.associate });
    const insertTimer = (id: string, userId: string, role: string) =>
      raw(
        "INSERT OR REPLACE INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, ?, 't')",
        id,
        m.id,
        userId,
        role,
      );
    insertTimer("tim_reviewer", ACTORS.reviewer, "reviewer")();
    w.repo.stopTimer(m.id, { userId: ACTORS.associate });
    insertTimer("tim_second", ACTORS.associate, "associate")();
    expect(rows("SELECT id FROM time_entries ORDER BY rowid").map((r) => r.id)).toEqual([
      first.id,
      "tim_reviewer",
      "tim_second",
    ]);
    // A new place and a new rule in a list, and a roster entry for another person.
    const list = savedList();
    raw(
      "INSERT OR REPLACE INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at) VALUES ('ref_ok', ?, 'gov-1', 'low', 7, ?, 't')",
      list.id,
      ACTORS.reviewer,
    )();
    w.repo.setPilotParticipants([ACTORS.associate], { actorId: ACTORS.admin });
    raw(
      "INSERT OR REPLACE INTO pilot_participants (user_id, recorded_by, recorded_at) VALUES (?, ?, 't')",
      ACTORS.reviewer,
      ACTORS.admin,
    )();
    expect(q("SELECT COUNT(*) AS n FROM reference_issues WHERE matter_id = ?", list.id)).toEqual({
      n: 3,
    });
    expect(q("SELECT COUNT(*) AS n FROM pilot_participants")).toEqual({ n: 2 });
  });

  it("still replaces the roster and the list through the application, which deletes before it writes", () => {
    w.repo.setPilotParticipants([ACTORS.associate, ACTORS.reviewer], { actorId: ACTORS.admin });
    w.repo.setPilotParticipants([ACTORS.reviewer, ACTORS.legalEngineer], { actorId: ACTORS.admin });
    expect(
      w.repo
        .listPilotParticipants()
        .map((p) => p.userId)
        .sort(),
    ).toEqual([ACTORS.reviewer, ACTORS.legalEngineer].sort());
    const m = savedList();
    const again = w.repo.saveReferenceList(
      m.id,
      {
        rules: [{ ruleKey: "dur-1", severity: "low" }],
        outsideHigh: 0,
        outsideMedium: 0,
        outsideLow: 2,
      },
      { userId: ACTORS.reviewer },
    );
    expect(again.issues.map((i) => [i.ruleKey, i.severity, i.ordinal])).toEqual([
      ["dur-1", "low", 0],
      [null, "low", 1],
      [null, "low", 2],
    ]);
  });
});

describe("migration 008, from a database made at version 7", () => {
  const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-pilot-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the four tables empty, keeps every earlier row and checksum, and the new code works on the old matters", () => {
    const old = join(dir, "migrations-to-7");
    mkdirSync(old);
    for (const name of [
      "001_init.sql",
      "002_integrity.sql",
      "003_ingest_warnings.sql",
      "004_usage_settled.sql",
      "005_retention.sql",
      "006_feedback_capture.sql",
      "007_training_matter.sql",
    ])
      copyFileSync(join(MIGRATIONS, name), join(old, name));
    const location = join(dir, "old.sqlite");

    // A database as the code before this migration left it: a matter with a review, one without.
    const atSeven = openDatabase(location, { migrationsDir: old });
    expect(
      atSeven.prepare("SELECT name FROM sqlite_master WHERE name = 'time_entries'").all(),
    ).toEqual([]);
    const repo = createRepository(atSeven, { now: w.clock.now });
    repo.seedDemoUsers();
    const playbook = repo.approvePlaybookVersion(
      repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "1.0.0",
          yaml: PLAYBOOK_YAML,
          sha256: sha256Hex(PLAYBOOK_YAML),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    seedPrompts(repo);
    const workflow = repo.upsertWorkflowVersion({
      manifest: WORKFLOW_MANIFEST,
      sha256: hashOf(WORKFLOW_MANIFEST),
    });
    const world = { db: atSeven, repo, clock: w.clock, playbook, workflow } as unknown as World;
    const reviewed = addMatter(world, { name: "reviewed" });
    startRun(world, reviewed);
    const fresh = addMatter(world, { name: "fresh" });
    repo.addMember(fresh.id, ACTORS.reviewer, "reviewer", associate);
    const before = atSeven
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as { version: number; sha256: string }[];
    expect(before.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const matters = atSeven.prepare("SELECT * FROM matters ORDER BY id").all();
    atSeven.close();

    const upgraded = openDatabase(location);
    const after = upgraded
      .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
      .all() as { version: number; name: string; sha256: string }[];
    expect(after.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(after[7]?.name).toBe("pilot_measures");
    expect(after.slice(0, 7).map(({ version, sha256 }) => ({ version, sha256 }))).toEqual(before);
    expect(upgraded.prepare("SELECT * FROM matters ORDER BY id").all()).toEqual(matters);
    for (const table of TABLES)
      expect(upgraded.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });

    // The old matters take the new rows: a timer on one, a list on the one no review has started on,
    // and the list of the reviewed one is closed.
    const next = createRepository(upgraded, { now: w.clock.now });
    expect(next.startTimer(reviewed.id, { userId: ACTORS.associate }).role).toBe("associate");
    expect(next.getReferenceList(reviewed.id).locked).toBe(true);
    expect(
      next.saveReferenceList(
        fresh.id,
        {
          rules: [{ ruleKey: "dur-1", severity: "high" }],
          outsideHigh: 0,
          outsideMedium: 0,
          outsideLow: 0,
        },
        { userId: ACTORS.reviewer },
      ).issues,
    ).toHaveLength(1);
    // The loader reads the old rows: both matters are listed, the review's run is there, and no
    // decision carries a reason code (they were made before reason codes were).
    const records = next.loadPilotRecords();
    expect(records.matters.map((m) => m.matterId).sort()).toEqual([fresh.id, reviewed.id].sort());
    expect(records.runs).toHaveLength(1);
    expect(next.getPilotCalendar()).toBeNull();
    expect(upgraded.prepare("SELECT version FROM schema_migrations").all()).toHaveLength(8);
    upgraded.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe("the pilot calendar", () => {
  it("keeps every date that was set, and the newest is in force", () => {
    expect(w.repo.getPilotCalendar()).toBeNull();
    expect(w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: ACTORS.admin })).toEqual({
      startDate: "2026-11-09",
    });
    const first = w.clock.iso();
    expect(w.repo.getPilotCalendar()).toEqual({
      startDate: "2026-11-09",
      setBy: ACTORS.admin,
      setAt: first,
      timesSet: 1,
    });
    w.clock.tick(60_000);
    w.repo.setPilotCalendar({ startDate: "2026-11-16", actorId: ACTORS.legalEngineer });
    expect(w.repo.getPilotCalendar()).toEqual({
      startDate: "2026-11-16",
      setBy: ACTORS.legalEngineer,
      setAt: w.clock.iso(),
      timesSet: 2,
    });
    expect(rows("SELECT start_date FROM pilot_calendar ORDER BY seq")).toEqual([
      { start_date: "2026-11-09" },
      { start_date: "2026-11-16" },
    ]);
  });

  it("writes an event with the date and the one it replaced, and no matter", () => {
    w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: ACTORS.admin });
    w.repo.setPilotCalendar({ startDate: "2026-11-16", actorId: ACTORS.admin });
    const events = eventsOf("pilot.calendar");
    expect(events.map((e) => e.detail)).toEqual([
      { startDate: "2026-11-09", previousStartDate: null },
      { startDate: "2026-11-16", previousStartDate: "2026-11-09" },
    ]);
    expect(events[0]).toMatchObject({
      actorId: ACTORS.admin,
      matterId: null,
      targetType: "pilot_calendar",
      targetId: "2026-11-09",
    });
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("refuses a start date that is not a real date, with a fixed message, and writes nothing", () => {
    const bad = [
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "26-01-01",
      "2026-1-1",
      "",
      "ZQ-HOSTILE-DATE",
      "2026-11-09T00:00:00Z",
      20261109,
      null,
      undefined,
    ];
    for (const value of bad) {
      const error = refused(() =>
        w.repo.setPilotCalendar({ startDate: value as never, actorId: ACTORS.admin }),
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("bad_calendar_date");
      expect(error.message).not.toContain("ZQ-HOSTILE");
    }
    expect(q("SELECT COUNT(*) AS n FROM pilot_calendar")).toEqual({ n: 0 });
    expect(eventsOf("pilot.calendar")).toEqual([]);
  });

  it("refuses a start date the pilot module cannot count from, which only looks like a date", () => {
    // Years below 1000 (a date field posts a typed "26" as 0026), and a window that leaves 9999.
    const unusable = [
      "0000-01-01",
      "0026-01-05",
      "0099-12-31",
      "0999-12-30",
      "0999-12-31",
      "9999-11-27",
      "9999-12-27",
      "9999-12-30",
      "9999-12-31",
    ];
    for (const value of unusable) {
      const error = refused(() =>
        w.repo.setPilotCalendar({ startDate: value, actorId: ACTORS.admin }),
      );
      expect(error, value).toBeInstanceOf(ValidationError);
      expect(error.code, value).toBe("bad_calendar_date");
    }
    expect(q("SELECT COUNT(*) AS n FROM pilot_calendar")).toEqual({ n: 0 });
    expect(eventsOf("pilot.calendar")).toEqual([]);
  });

  it("accepts the first and the last usable start date and the last days of a December", () => {
    const usable = [
      "1000-01-01",
      "1000-12-31",
      "2026-12-30",
      "2026-12-31",
      "9998-12-31",
      "9999-11-26",
    ];
    for (const value of usable) {
      expect(w.repo.setPilotCalendar({ startDate: value, actorId: ACTORS.admin }).startDate).toBe(
        value,
      );
      expect(w.repo.getPilotCalendar()?.startDate).toBe(value);
    }
    expect(q("SELECT COUNT(*) AS n FROM pilot_calendar")).toEqual({ n: usable.length });
  });

  it("holds only start dates that the measures and the end of the pilot can be worked out from", () => {
    // Whatever the store lets in must survive the computation that reads it back: try every day
    // around the edges of the years and keep the ones that were accepted.
    const edges = [
      "0000-12-31",
      "0025-12-31",
      "0026-01-05",
      "0099-12-31",
      "0100-01-01",
      "0999-12-31",
      "1000-01-01",
      "1000-01-02",
      "9999-11-24",
      "9999-11-25",
      "9999-11-26",
      "9999-11-27",
      "9999-11-28",
      "9999-12-31",
    ];
    const accepted: string[] = [];
    for (const value of edges) {
      try {
        w.repo.setPilotCalendar({ startDate: value, actorId: ACTORS.admin });
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        continue;
      }
      accepted.push(value);
      const records = w.repo.loadPilotRecords();
      expect(records.calendar?.startDate).toBe(value);
      expect(
        () => computePilotMeasures(records, { scope: "pilot", asOf: "2026-02-10T12:00:00.000Z" }),
        value,
      ).not.toThrow();
      expect(() => calendarEnd(value), value).not.toThrow();
    }
    expect(accepted).toEqual([
      "1000-01-01",
      "1000-01-02",
      "9999-11-24",
      "9999-11-25",
      "9999-11-26",
    ]);
  });

  it("needs an actor who exists", () => {
    expect(() =>
      w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: "usr_nobody" }),
    ).toThrow(NotFoundError);
    expect(q("SELECT COUNT(*) AS n FROM pilot_calendar")).toEqual({ n: 0 });
  });

  it("is append-only: an update, a delete and a replace are refused by the database", () => {
    w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: ACTORS.admin });
    expect(raw("UPDATE pilot_calendar SET start_date = '2026-01-01'")).toThrow(/append-only/);
    expect(raw("DELETE FROM pilot_calendar")).toThrow(/append-only/);
    expect(
      raw(
        "INSERT OR REPLACE INTO pilot_calendar (seq, start_date, set_by, set_at) VALUES (1, '2026-01-01', ?, 't')",
        ACTORS.admin,
      ),
    ).toThrow(/append-only/);
    expect(w.repo.getPilotCalendar()?.startDate).toBe("2026-11-09");
    // The shape of the date is held too, for a writer that skips the application.
    expect(
      raw(
        "INSERT INTO pilot_calendar (start_date, set_by, set_at) VALUES ('soon', ?, 't')",
        ACTORS.admin,
      ),
    ).toThrow(/CHECK constraint/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the roster of trained people", () => {
  it("replaces the roster, and who stays keeps their recorder and their time", () => {
    const first = w.repo.setPilotParticipants([ACTORS.reviewer, ACTORS.associate], {
      actorId: ACTORS.admin,
    });
    expect(first).toEqual({
      added: [ACTORS.reviewer, ACTORS.associate].sort(),
      removed: [],
      total: 2,
    });
    const at = w.clock.iso();
    w.clock.tick(3_600_000);
    const second = w.repo.setPilotParticipants([ACTORS.reviewer, ACTORS.legalEngineer], {
      actorId: ACTORS.legalEngineer,
    });
    expect(second).toEqual({
      added: [ACTORS.legalEngineer],
      removed: [ACTORS.associate],
      total: 2,
    });
    expect(w.repo.listPilotParticipants()).toEqual([
      { userId: ACTORS.legalEngineer, recordedBy: ACTORS.legalEngineer, recordedAt: w.clock.iso() },
      { userId: ACTORS.reviewer, recordedBy: ACTORS.admin, recordedAt: at },
    ]);
    expect(w.repo.getPilotAdmin().participants).toHaveLength(2);
    expect(w.repo.setPilotParticipants([], { actorId: ACTORS.admin })).toEqual({
      added: [],
      removed: [ACTORS.legalEngineer, ACTORS.reviewer].sort(),
      total: 0,
    });
    expect(w.repo.listPilotParticipants()).toEqual([]);
  });

  it("writes an event with the ids added and removed and the new total, and no matter", () => {
    w.repo.setPilotParticipants([ACTORS.associate], { actorId: ACTORS.admin });
    w.repo.setPilotParticipants([ACTORS.reviewer], { actorId: ACTORS.admin });
    const events = eventsOf("pilot.participants");
    expect(events.map((e) => e.detail)).toEqual([
      { added: [ACTORS.associate], removed: [], total: 1 },
      { added: [ACTORS.reviewer], removed: [ACTORS.associate], total: 1 },
    ]);
    expect(events[0]).toMatchObject({
      actorId: ACTORS.admin,
      matterId: null,
      targetType: "pilot_participants",
      targetId: "roster",
    });
  });

  it("refuses a person who is not a user, a person twice and more than 64, and changes nothing", () => {
    w.repo.setPilotParticipants([ACTORS.associate], { actorId: ACTORS.admin });
    const before = rows("SELECT * FROM pilot_participants");
    const events = eventsOf("pilot.participants").length;

    const unknown = refused(() =>
      w.repo.setPilotParticipants([ACTORS.reviewer, "usr_ZQ-HOSTILE"], { actorId: ACTORS.admin }),
    );
    expect(unknown).toBeInstanceOf(ValidationError);
    expect(unknown.code).toBe("unknown_user");
    expect(unknown.message).not.toContain("ZQ-HOSTILE");
    expect(
      refused(() =>
        w.repo.setPilotParticipants([ACTORS.reviewer, ACTORS.reviewer], { actorId: ACTORS.admin }),
      ).code,
    ).toBe("duplicate_user");
    expect(
      refused(() =>
        w.repo.setPilotParticipants(
          Array.from({ length: MAX_PARTICIPANTS + 1 }, (_, i) => `usr_${i}`),
          { actorId: ACTORS.admin },
        ),
      ).code,
    ).toBe("too_many_participants");
    expect(
      refused(() => w.repo.setPilotParticipants("everyone" as never, { actorId: ACTORS.admin }))
        .code,
    ).toBe("unknown_user");

    // Nothing was deleted or added by any of them, and none wrote an event.
    expect(rows("SELECT * FROM pilot_participants")).toEqual(before);
    expect(eventsOf("pilot.participants")).toHaveLength(events);
  });

  it("takes exactly 64 people, which is what the audit event can list", () => {
    expect(MAX_PARTICIPANTS).toBe(64);
    const ids = Array.from({ length: MAX_PARTICIPANTS }, (_, i) => `usr_trainee_${i}`);
    for (const id of ids)
      w.db
        .prepare(
          "INSERT INTO users (id, display_name, global_role, demo) VALUES (?, ?, 'member', 1)",
        )
        .run(id, "Synthetic trainee");
    const result = w.repo.setPilotParticipants(ids, { actorId: ACTORS.admin });
    expect(result.total).toBe(64);
    expect(eventsOf("pilot.participants")[0]?.detail["added"]).toHaveLength(64);
    expect(w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("needs an actor who exists", () => {
    expect(() =>
      w.repo.setPilotParticipants([ACTORS.associate], { actorId: "usr_nobody" }),
    ).toThrow(NotFoundError);
    expect(q("SELECT COUNT(*) AS n FROM pilot_participants")).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("timers", () => {
  it("starts in the role held and stops on the server's clock, in whole seconds", () => {
    const m = matterWithReviewer();
    const started = w.repo.startTimer(m.id, { userId: ACTORS.associate });
    expect(started).toMatchObject({
      matterId: m.id,
      userId: ACTORS.associate,
      role: "associate",
      startedAt: w.clock.iso(),
      stoppedAt: null,
    });
    w.clock.tick(90_500);
    const stopped = w.repo.stopTimer(m.id, { userId: ACTORS.associate });
    expect(stopped).toMatchObject({ id: started.id, stoppedAt: w.clock.iso(), seconds: 90 });

    const reviewer = w.repo.startTimer(m.id, { userId: ACTORS.reviewer });
    expect(reviewer.role).toBe("reviewer");
  });

  it("allows one running timer for a person, here or on another matter, and the index is the backstop", () => {
    const one = matterWithReviewer();
    const two = matterWithReviewer();
    w.repo.startTimer(one.id, { userId: ACTORS.associate });
    const here = refused(() => w.repo.startTimer(one.id, { userId: ACTORS.associate }));
    expect(here).toBeInstanceOf(ConflictError);
    expect(here.code).toBe("timer_open");
    expect(refused(() => w.repo.startTimer(two.id, { userId: ACTORS.associate })).code).toBe(
      "timer_open",
    );
    // Another person times the same matter at once.
    expect(w.repo.startTimer(one.id, { userId: ACTORS.reviewer }).role).toBe("reviewer");

    // The database refuses a second open timer for a person when the code is bypassed ...
    const insert = (id: string) =>
      raw(
        "INSERT INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', 't')",
        id,
        two.id,
        ACTORS.associate,
      );
    // The insert guard names the one-open-timer key too, and runs first ...
    expect(insert("tim_raw")).toThrow(/time entries are never replaced/);
    // ... the index is the second line, when the guard is gone ...
    w.db.exec("DROP TRIGGER time_entries_no_replace");
    expect(insert("tim_raw")).toThrow(/UNIQUE constraint failed: time_entries\.user_id/);
    // ... and the code refuses it when the index is gone as well.
    w.db.exec("DROP INDEX time_entries_one_open_per_user");
    expect(refused(() => w.repo.startTimer(two.id, { userId: ACTORS.associate })).code).toBe(
      "timer_open",
    );
    expect(q("SELECT COUNT(*) AS n FROM time_entries WHERE matter_id = ?", two.id)).toEqual({
      n: 0,
    });
  });

  it("stops only a timer that runs on that matter, and a stopped one is not stopped twice", () => {
    const one = matterWithReviewer();
    const two = matterWithReviewer();
    expect(refused(() => w.repo.stopTimer(one.id, { userId: ACTORS.associate })).code).toBe(
      "no_open_timer",
    );
    w.repo.startTimer(one.id, { userId: ACTORS.associate });
    // A stop on the other matter does not find it, and leaves it running.
    expect(refused(() => w.repo.stopTimer(two.id, { userId: ACTORS.associate })).code).toBe(
      "no_open_timer",
    );
    expect(w.repo.listTimerState(one.id, ACTORS.associate).running).not.toBeNull();
    w.repo.stopTimer(one.id, { userId: ACTORS.associate });
    expect(refused(() => w.repo.stopTimer(one.id, { userId: ACTORS.associate })).code).toBe(
      "no_open_timer",
    );
  });

  it("is for an associate or a reviewer of the matter; a viewer and a stranger are refused, and the database holds the rule", () => {
    const m = matterWithReviewer();
    w.repo.addMember(m.id, ACTORS.legalEngineer, "viewer", associate);
    for (const userId of [ACTORS.legalEngineer, ACTORS.admin]) {
      const error = refused(() => w.repo.startTimer(m.id, { userId }));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("timer_role");
    }
    const insert = (userId: string, role: string, stoppedAt: string | null = null) =>
      raw(
        "INSERT INTO time_entries (id, matter_id, user_id, role, started_at, stopped_at) VALUES ('tim_raw', ?, ?, ?, 't', ?)",
        m.id,
        userId,
        role,
        stoppedAt,
      );
    // A viewer, a stranger, and a reviewer entered as an associate: each breaks one rule and no other.
    expect(insert(ACTORS.legalEngineer, "associate")).toThrow(
      /member of the matter in the role held/,
    );
    expect(insert(ACTORS.admin, "associate")).toThrow(/member of the matter in the role held/);
    expect(insert(ACTORS.reviewer, "associate")).toThrow(/member of the matter in the role held/);
    // A timer starts open.
    expect(insert(ACTORS.associate, "associate", "u")).toThrow(/a timer starts open/);
    expect(q("SELECT COUNT(*) AS n FROM time_entries")).toEqual({ n: 0 });
    // A matter that does not exist is not found.
    expect(() => w.repo.startTimer("mat_ffffffffffffffff", { userId: ACTORS.associate })).toThrow(
      NotFoundError,
    );
  });

  it("is final once stopped: only the stop can change a row, and it can be made once", () => {
    const m = matterWithReviewer();
    const entry = w.repo.startTimer(m.id, { userId: ACTORS.associate });
    // On a running entry anything but the stop is refused.
    for (const set of [
      "started_at = 'x'",
      "role = 'reviewer'",
      "user_id = 'usr_demo_reviewer'",
      "matter_id = 'mat_other'",
      "id = 'tim_other'",
    ])
      expect(raw(`UPDATE time_entries SET ${set} WHERE id = ?`, entry.id), set).toThrow(
        /can only be stopped, once/,
      );
    // Not stopping at all is no stop.
    expect(raw("UPDATE time_entries SET stopped_at = NULL WHERE id = ?", entry.id)).toThrow(
      /can only be stopped, once/,
    );
    // A stop earlier than the start breaks the check.
    expect(raw("UPDATE time_entries SET stopped_at = '' WHERE id = ?", entry.id)).toThrow(
      /CHECK constraint/,
    );
    w.clock.tick(1000);
    w.repo.stopTimer(m.id, { userId: ACTORS.associate });
    const stopped = q("SELECT * FROM time_entries WHERE id = ?", entry.id);
    // A stopped entry is final.
    expect(raw("UPDATE time_entries SET stopped_at = '9999' WHERE id = ?", entry.id)).toThrow(
      /can only be stopped, once/,
    );
    expect(raw("UPDATE time_entries SET stopped_at = NULL WHERE id = ?", entry.id)).toThrow(
      /can only be stopped, once/,
    );
    expect(q("SELECT * FROM time_entries WHERE id = ?", entry.id)).toEqual(stopped);
    // Nor is an entry replaced.
    expect(
      raw(
        "INSERT OR REPLACE INTO time_entries (id, matter_id, user_id, role, started_at) VALUES (?, ?, ?, 'associate', 't')",
        entry.id,
        m.id,
        ACTORS.associate,
      ),
    ).toThrow(/never replaced/);
  });

  it("writes the start time as the stop when the clock has stepped back, never a negative time", () => {
    const m = matterWithReviewer();
    const entry = w.repo.startTimer(m.id, { userId: ACTORS.associate });
    w.clock.set("2026-10-31T09:00:00.000Z");
    const stopped = w.repo.stopTimer(m.id, { userId: ACTORS.associate });
    expect(stopped.stoppedAt).toBe(entry.startedAt);
    expect(stopped.seconds).toBe(0);
  });

  it("reports one person's state on one matter: running, closed time and sessions, and a timer elsewhere", () => {
    const one = matterWithReviewer();
    const two = matterWithReviewer();
    expect(w.repo.listTimerState(one.id, ACTORS.associate)).toEqual({
      running: null,
      elsewhere: false,
      closedSeconds: 0,
      sessions: 0,
    });
    w.repo.startTimer(one.id, { userId: ACTORS.associate });
    w.clock.tick(60_000);
    w.repo.stopTimer(one.id, { userId: ACTORS.associate });
    w.repo.startTimer(one.id, { userId: ACTORS.associate });
    w.clock.tick(30_999);
    w.repo.stopTimer(one.id, { userId: ACTORS.associate });
    const third = w.repo.startTimer(one.id, { userId: ACTORS.associate });
    expect(w.repo.listTimerState(one.id, ACTORS.associate)).toEqual({
      running: third,
      elsewhere: false,
      closedSeconds: 90,
      sessions: 2,
    });
    // On the other matter the person has no time, and a timer runs elsewhere. Nobody else's counts.
    expect(w.repo.listTimerState(two.id, ACTORS.associate)).toEqual({
      running: null,
      elsewhere: true,
      closedSeconds: 0,
      sessions: 0,
    });
    expect(w.repo.listTimerState(one.id, ACTORS.reviewer).sessions).toBe(0);
  });

  it("writes events with ids, the role and the seconds, and nothing else", () => {
    const m = matterWithReviewer();
    const entry = w.repo.startTimer(m.id, { userId: ACTORS.reviewer });
    w.clock.tick(125_000);
    w.repo.stopTimer(m.id, { userId: ACTORS.reviewer });
    const [start] = eventsOf("time.start");
    const [stop] = eventsOf("time.stop");
    expect(start).toMatchObject({
      actorId: ACTORS.reviewer,
      matterId: m.id,
      targetType: "time_entry",
      targetId: entry.id,
      detail: { entryId: entry.id, role: "reviewer" },
    });
    expect(Object.keys(start!.detail).sort()).toEqual(["entryId", "role"]);
    expect(stop).toMatchObject({
      targetId: entry.id,
      detail: { entryId: entry.id, role: "reviewer", seconds: 125 },
    });
    expect(Object.keys(stop!.detail).sort()).toEqual(["entryId", "role", "seconds"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the reference list", () => {
  const save = (
    m: MatterFixture,
    input: Parameters<World["repo"]["saveReferenceList"]>[1],
    userId: string = ACTORS.reviewer,
  ) => w.repo.saveReferenceList(m.id, input, { userId });

  it("lists rule slots in the playbook's order, then the issues no rule covers by severity, and the next save replaces it", () => {
    const m = matterWithReviewer();
    const first = save(m, {
      // Given in the wrong order on purpose.
      rules: [
        { ruleKey: "gov-1", severity: "low" },
        { ruleKey: "dur-1", severity: "high" },
      ],
      outsideHigh: 1,
      outsideMedium: 2,
      outsideLow: 0,
    });
    expect(first.locked).toBe(false);
    expect(first.issues.map((i) => [i.ordinal, i.ruleKey, i.severity])).toEqual([
      [0, "dur-1", "high"],
      [1, "gov-1", "low"],
      [2, null, "high"],
      [3, null, "medium"],
      [4, null, "medium"],
    ]);
    expect(first.issues.every((i) => i.recordedBy === ACTORS.reviewer && i.matterId === m.id)).toBe(
      true,
    );

    w.clock.tick(1000);
    const second = save(m, {
      rules: [{ ruleKey: "pty-1", severity: "medium" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    expect(second.issues.map((i) => [i.ruleKey, i.severity])).toEqual([["pty-1", "medium"]]);
    expect(q("SELECT COUNT(*) AS n FROM reference_issues")).toEqual({ n: 1 });
    // An empty list is a list: the reviewer found nothing.
    expect(save(m, noList).issues).toEqual([]);
  });

  it("writes an event with the number of issues, the rule keys and the counts, and nothing else", () => {
    const m = matterWithReviewer();
    save(m, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 1,
      outsideMedium: 0,
      outsideLow: 2,
    });
    const [event] = eventsOf("reference.save");
    expect(event).toMatchObject({
      actorId: ACTORS.reviewer,
      matterId: m.id,
      targetType: "matter",
      targetId: m.id,
      detail: {
        issues: 4,
        ruleKeys: ["dur-1"],
        outsideHigh: 1,
        outsideMedium: 0,
        outsideLow: 2,
      },
    });
    expect(Object.keys(event!.detail).sort()).toEqual([
      "issues",
      "outsideHigh",
      "outsideLow",
      "outsideMedium",
      "ruleKeys",
    ]);
  });

  it("is recorded by a reviewer of the matter only, and the database holds the rule", () => {
    const m = matterWithReviewer();
    w.repo.addMember(m.id, ACTORS.legalEngineer, "viewer", associate);
    for (const userId of [ACTORS.associate, ACTORS.legalEngineer, ACTORS.admin]) {
      const error = refused(() => save(m, noList, userId));
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.code).toBe("reference_role");
    }
    for (const userId of [ACTORS.associate, ACTORS.legalEngineer])
      expect(
        raw(
          `INSERT INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at)
           VALUES ('ref_raw', ?, NULL, 'high', 0, ?, 't')`,
          m.id,
          userId,
        ),
      ).toThrow(/recorded by a reviewer of the matter/);
    expect(q("SELECT COUNT(*) AS n FROM reference_issues")).toEqual({ n: 0 });
  });

  it("closes when a review starts, whatever became of it: refused by the code and by three triggers", () => {
    const m = matterWithReviewer();
    save(m, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    expect(w.repo.getReferenceList(m.id).locked).toBe(true);

    const error = refused(() => save(m, noList));
    expect(error).toBeInstanceOf(ConflictError);
    expect(error.code).toBe("reference_locked");
    expect(w.repo.getReferenceList(m.id).issues).toHaveLength(1);

    // The triggers refuse a writer that skips the code: an insert, a delete, and any edit.
    expect(
      raw(
        `INSERT INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at)
         VALUES ('ref_raw', ?, NULL, 'low', 9, ?, 't')`,
        m.id,
        ACTORS.reviewer,
      ),
    ).toThrow(/closed once a review has started/);
    expect(raw("DELETE FROM reference_issues WHERE matter_id = ?", m.id)).toThrow(
      /closed once a review has started/,
    );
    expect(raw("UPDATE reference_issues SET severity = 'low' WHERE matter_id = ?", m.id)).toThrow(
      /replaced, never edited/,
    );
    expect(w.repo.getReferenceList(m.id).issues).toHaveLength(1);

    // With both triggers gone the code still refuses.
    w.db.exec("DROP TRIGGER reference_issues_closed_insert");
    w.db.exec("DROP TRIGGER reference_issues_closed_delete");
    expect(refused(() => save(m, noList)).code).toBe("reference_locked");
    expect(w.repo.getReferenceList(m.id).issues).toHaveLength(1);
  });

  it("is not closed by an evaluation run, which is no review of the matter", () => {
    const m = matterWithReviewer();
    const manifest = w.repo.buildRunManifest(m.id, {
      workflowVersionId: w.workflow.id,
      modelProvider: "scripted",
      model: "scripted-1",
    });
    w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate, purpose: "eval" });
    expect(w.repo.getReferenceList(m.id).locked).toBe(false);
    expect(save(m, noList).locked).toBe(false);
  });

  it("names only rules of the playbook pinned to the matter, and with none pinned only issues no rule covers", () => {
    const m = matterWithReviewer();
    const unknown = refused(() =>
      save(m, {
        rules: [{ ruleKey: "ZQ-NO-RULE", severity: "high" }],
        outsideHigh: 0,
        outsideMedium: 0,
        outsideLow: 0,
      }),
    );
    expect(unknown).toBeInstanceOf(ValidationError);
    expect(unknown.code).toBe("unknown_rule");
    expect(unknown.message).not.toContain("ZQ-NO-RULE");
    expect(
      refused(() =>
        save(m, {
          rules: [{ ruleKey: 7 as never, severity: "high" }],
          outsideHigh: 0,
          outsideMedium: 0,
          outsideLow: 0,
        }),
      ).code,
    ).toBe("unknown_rule");

    const bare = addMatter(w, { pinPlaybook: false });
    w.repo.addMember(bare.id, ACTORS.reviewer, "reviewer", associate);
    expect(
      refused(() =>
        save(bare, {
          rules: [{ ruleKey: "dur-1", severity: "high" }],
          outsideHigh: 0,
          outsideMedium: 0,
          outsideLow: 0,
        }),
      ).code,
    ).toBe("unknown_rule");
    expect(
      save(bare, { rules: [], outsideHigh: 1, outsideMedium: 0, outsideLow: 0 }).issues,
    ).toHaveLength(1);
  });

  it("takes a rule once, in the code and in the index, and several issues no rule covers", () => {
    const m = matterWithReviewer();
    const twice = refused(() =>
      save(m, {
        rules: [
          { ruleKey: "dur-1", severity: "high" },
          { ruleKey: "dur-1", severity: "low" },
        ],
        outsideHigh: 0,
        outsideMedium: 0,
        outsideLow: 0,
      }),
    );
    expect(twice.code).toBe("duplicate_rule");
    expect(
      save(m, { rules: [], outsideHigh: 3, outsideMedium: 3, outsideLow: 3 }).issues,
    ).toHaveLength(9);

    // The index refuses a second issue for one rule when the code is bypassed ...
    const insert = (id: string, ordinal: number) =>
      raw(
        `INSERT INTO reference_issues (id, matter_id, rule_key, severity, ordinal, recorded_by, recorded_at)
         VALUES (?, ?, 'dur-1', 'high', ?, ?, 't')`,
        id,
        m.id,
        ordinal,
        ACTORS.reviewer,
      );
    insert("ref_a", 20)();
    // The insert guard names the rule key too, and runs first ...
    expect(insert("ref_b", 21)).toThrow(/reference issues are never replaced/);
    // ... the index is the second line, when the guard is gone ...
    w.db.exec("DROP TRIGGER reference_issues_no_replace");
    expect(insert("ref_b", 21)).toThrow(/UNIQUE constraint failed: reference_issues\.matter_id/);
    // ... and the code refuses it when the index is gone as well.
    w.db.exec("DROP INDEX reference_issues_one_per_rule");
    expect(
      refused(() =>
        save(m, {
          rules: [
            { ruleKey: "pty-1", severity: "high" },
            { ruleKey: "pty-1", severity: "high" },
          ],
          outsideHigh: 0,
          outsideMedium: 0,
          outsideLow: 0,
        }),
      ).code,
    ).toBe("duplicate_rule");
  });

  it("takes a severity of the closed set and counts from 0 to 9, and a refusal changes nothing", () => {
    const m = matterWithReviewer();
    const kept = save(m, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    const events = eventsOf("reference.save").length;
    for (const severity of ["urgent", "", "HIGH", null, 2])
      expect(
        refused(() =>
          save(m, {
            rules: [{ ruleKey: "dur-1", severity: severity as never }],
            outsideHigh: 0,
            outsideMedium: 0,
            outsideLow: 0,
          }),
        ).code,
      ).toBe("bad_severity");
    for (const count of [-1, 10, 1.5, "3", Number.NaN, undefined, null])
      for (const field of ["outsideHigh", "outsideMedium", "outsideLow"] as const)
        expect(
          refused(() =>
            save(m, {
              rules: [],
              outsideHigh: 0,
              outsideMedium: 0,
              outsideLow: 0,
              [field]: count as never,
            }),
          ).code,
          `${field} ${String(count)}`,
        ).toBe("bad_count");
    expect(
      refused(() =>
        save(m, { rules: "all" as never, outsideHigh: 0, outsideMedium: 0, outsideLow: 0 }),
      ).code,
    ).toBe("bad_severity");
    // Nothing was changed by any of them.
    expect(w.repo.getReferenceList(m.id).issues).toEqual(kept.issues);
    expect(eventsOf("reference.save")).toHaveLength(events);
    // The edges are taken.
    expect(
      save(m, { rules: [], outsideHigh: 9, outsideMedium: 0, outsideLow: 9 }).issues,
    ).toHaveLength(18);
  });

  it("replaces the list whole: a failure part way leaves the earlier list as it was", () => {
    const m = matterWithReviewer();
    const kept = save(m, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    w.db.exec(`CREATE TEMP TRIGGER zz_fail_second BEFORE INSERT ON reference_issues
      WHEN NEW.ordinal = 1 BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() =>
      save(m, {
        rules: [{ ruleKey: "pty-1", severity: "low" }],
        outsideHigh: 2,
        outsideMedium: 0,
        outsideLow: 0,
      }),
    ).toThrow("injected failure");
    expect(w.repo.getReferenceList(m.id).issues).toEqual(kept.issues);
    w.db.exec("DROP TRIGGER zz_fail_second");
    expect(eventsOf("reference.save")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("deleting a matter", () => {
  it("deletes its timers, a running one among them, and its reference list, by statements of their own", () => {
    const doomed = matterWithReviewer();
    const kept = matterWithReviewer();
    for (const m of [doomed, kept]) {
      w.repo.saveReferenceList(
        m.id,
        {
          rules: [{ ruleKey: "dur-1", severity: "high" }],
          outsideHigh: 1,
          outsideMedium: 0,
          outsideLow: 0,
        },
        { userId: ACTORS.reviewer },
      );
      w.repo.startTimer(m.id, { userId: ACTORS.reviewer });
      w.clock.tick(10_000);
      w.repo.stopTimer(m.id, { userId: ACTORS.reviewer });
    }
    // The associate's timer on the doomed matter is still running when the matter goes.
    w.repo.startTimer(doomed.id, { userId: ACTORS.associate });
    const count = (table: string, id: string) =>
      q<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE matter_id = ?`, id).n;
    expect(tablesHoldingMatter(w.db, doomed.id)).toEqual(
      expect.arrayContaining(["time_entries", "reference_issues"]),
    );

    // With the connection's foreign keys off no key cascades: a deletion that relied on the cascade
    // would leave the rows behind, and the residue guard would roll it back.
    w.db.exec("PRAGMA foreign_keys = OFF");
    w.repo.deleteMatter(doomed.id, { actorId: ACTORS.associate });
    w.db.exec("PRAGMA foreign_keys = ON");

    expect(count("time_entries", doomed.id)).toBe(0);
    expect(count("reference_issues", doomed.id)).toBe(0);
    expect(tablesHoldingMatter(w.db, doomed.id)).toEqual([]);
    // The other matter is whole, and the person is free to time again.
    expect(count("time_entries", kept.id)).toBe(1);
    expect(count("reference_issues", kept.id)).toBe(2);
    expect(w.repo.startTimer(kept.id, { userId: ACTORS.associate }).matterId).toBe(kept.id);
    expect(
      w.repo.listAuditEvents({ matterId: doomed.id, action: "matter.delete" })[0]!.detail,
    ).toMatchObject({ timeEntries: 2, referenceIssues: 2 });
  });

  it("leaves the calendar and the roster alone: they name no matter", () => {
    w.repo.setPilotCalendar({ startDate: "2026-11-09", actorId: ACTORS.admin });
    w.repo.setPilotParticipants([ACTORS.associate], { actorId: ACTORS.admin });
    const m = matterWithReviewer();
    w.repo.deleteMatter(m.id, { actorId: ACTORS.associate });
    expect(w.repo.getPilotCalendar()?.startDate).toBe("2026-11-09");
    expect(w.repo.listPilotParticipants().map((p) => p.userId)).toEqual([ACTORS.associate]);
  });

  it("deletes the reference list of a matter that was reviewed, whose triggers close it", () => {
    const m = matterWithReviewer();
    w.repo.saveReferenceList(
      m.id,
      {
        rules: [{ ruleKey: "dur-1", severity: "high" }],
        outsideHigh: 0,
        outsideMedium: 0,
        outsideLow: 0,
      },
      { userId: ACTORS.reviewer },
    );
    const run = startRun(w, m);
    w.repo.updateRunStatus(m.id, run.id, "cancelled");
    // The list is closed against a delete of its own, and not against the matter's deletion.
    expect(raw("DELETE FROM reference_issues WHERE matter_id = ?", m.id)).toThrow(/closed/);
    w.repo.deleteMatter(m.id, { actorId: ACTORS.associate });
    expect(q("SELECT COUNT(*) AS n FROM reference_issues")).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
describe("the codes this module refuses with", () => {
  it("are exactly the ones in PILOT_REFUSAL_CODES, so the layer above can give each a phrase", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../src/store/repo-pilot.ts", import.meta.url)),
      "utf8",
    );
    const thrown = new Set(
      [...source.matchAll(/(?:ValidationError|ConflictError)\(\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect([...thrown].sort()).toEqual([...PILOT_REFUSAL_CODES].sort());
  });

  it("were each raised by the tests above, so none is a code that nothing can reach", () => {
    expect(PILOT_REFUSAL_CODES.filter((code) => !seen.has(code))).toEqual([]);
  });
});
