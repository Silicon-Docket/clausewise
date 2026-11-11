import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/canonical.js";
import { REASON_CODES, type Status } from "../../src/contracts.js";
import { toCsv } from "../../src/pilot/csv.js";
import { computePilotMeasures } from "../../src/pilot/compute.js";
import type {
  MeasureRow,
  PilotMeasures,
  PilotRecordSource,
  PilotRecords,
  PilotScope,
} from "../../src/pilot/types.js";
import type { RunRow } from "../../src/store/index.js";
import {
  ACTORS,
  NDA_PARAGRAPHS,
  addMatter,
  buildSpans,
  exported,
  fakePath,
  findingFor,
  makeWorld,
  startRun,
  succeed,
  type MatterFixture,
  type World,
} from "./fixtures.js";

/**
 * The loader and the pure module together, over rows the real store wrote.
 *
 * `loadPilotRecords` is the first read across matters. These tests show three things: what it
 * returns is the records of the scenario below and nothing it must not (no training matter's data,
 * no text, no deleted matter, no demonstration identity passed off as a person); the pure module
 * over those records gives the numbers a hand count gives; and the loader cannot be made to read a
 * column that holds text.
 *
 * The scenario is built through the repository with a clock that is set to each moment, and with
 * people who are not demonstration identities, which the database allows only with its `demo` check
 * switched off for the insert (this build has demonstration identities only; the code is written
 * for the day it does not). Every figure is invented, and the expected values below were counted by
 * hand from the table in the comment of `buildScenario`, never taken from the code under test.
 */

const START = "2026-11-02"; // a Monday
const AS_OF = "2026-12-20T12:00:00.000Z";
const DAY = 86_400_000;

/** The instant of day `day` (0 is the start date) at `time`. Weeks: 1 = days 0 to 6 ... 5 = days 28 to 34. */
const at = (day: number, time: string): string =>
  new Date(Date.parse(`${START}T${time}.000Z`) + day * DAY).toISOString();

const P = {
  alex: "usr_pilot_alex",
  ben: "usr_pilot_ben",
  dana: "usr_pilot_dana",
  vera: "usr_pilot_vera",
} as const;
const DEMO_ASSOCIATE = ACTORS.associate;

/** Text a person typed, planted where a column can hold it. None of it may reach the records. */
const MARKERS = {
  name: "ZQ-NAME-MARKER",
  client: "ZQ-CLIENT-MARKER",
  title: "ZQ-TITLE-MARKER",
  person: "ZQ-PERSON-MARKER",
  reason: "ZQ-REASON-MARKER",
  edit: "ZQ-EDIT-MARKER",
  report: "ZQ-REPORT-MARKER",
  place: "ZQ-PLACE-MARKER",
  words: "ZQ-WORDS-MARKER",
  explanation: "ZQ-EXPLANATION-MARKER",
  discrepancy: "ZQ-DISCREPANCY-MARKER",
};

type Rule = "pty-1" | "dur-1" | "gov-1";
/** One of: compliant; deviation; escalated (undetermined, escalated by the system). */
type Outcome = "compliant" | "deviation" | "escalated";

interface Scenario {
  w: World;
  ids: Record<string, string>;
  runs: Record<string, string>;
}

/**
 * The scenario. Day 0 is 2026-11-02; weeks of 7 days; week 1 is the baseline, week 2 shadow mode,
 * weeks 3 to 5 assisted use. People: associates alex and ben, reviewer dana, viewer vera, none of
 * them a demonstration identity; `usr_demo_associate` is one. The roster: alex, ben and the demo
 * associate. The playbook has three rules, pty-1, dur-1 and gov-1.
 *
 *   M1  real, alex, dana reviews, vera views. Run day 15 by alex: pty-1 compliant, dur-1 deviation,
 *       gov-1 escalated by the system. Dana decides: accept, reject (wrong_evidence), escalate; then
 *       changes dur-1 to an edit (bad_fallback, minor), so one decision is stale and three current.
 *       Memo. Ratings alex 4, dana 5, vera 3. Two reports by dana: dur-1, and one no rule covers.
 *   M2  real, alex, dana. Run day 22 by alex: all compliant, all accepted. No memo. One report (pty-1).
 *   M3  real, ben, dana. Reference list by dana on day 1: dur-1 high, pty-1 medium, one high issue
 *       no rule covers. Run day 8 by ben: dur-1 deviation, the others compliant. Nothing decided.
 *   M4  real, ben. Run day 40 (after the window): all compliant.
 *   M5  real, ben, dana. No run. Reference list by dana: gov-1 low.
 *   M6  synthetic, alex, dana. Run day 15: pty-1, dur-1 compliant, gov-1 escalated; all accepted;
 *       memo; rating alex 5.
 *   M7  not synthetic, made by the demo associate, who runs it on day 16: all compliant.
 *   M8  a TRAINING matter made by alex (synthetic, as the database insists), with a reference
 *       list, a run on day 15, decisions, a memo, a rating, a report and a timer. It is in neither
 *       scope and none of its rows may leave the store.
 *   D1, D2  a real and a synthetic matter, deleted.
 *
 * Timers (seconds): M5 ben day 2 1800 and 900, dana day 3 1200, ben day -1 600 (before the
 * window); M3 ben day 8 2400; M1 alex day 15 1500, dana day 16 2100; M2 alex day 22 2700, dana day
 * 23 900, alex day 24 still running; M6 alex day 15 600; M8 alex day 15 3000 (training).
 */
async function buildScenario(): Promise<Scenario> {
  const w = makeWorld();
  const { repo } = w;
  const ids: Record<string, string> = {};
  const runs: Record<string, string> = {};

  // People who are not demonstration identities: only with the check switched off, for the insert.
  w.db.exec("PRAGMA ignore_check_constraints = ON");
  try {
    for (const id of Object.values(P))
      w.db
        .prepare(
          "INSERT INTO users (id, display_name, global_role, demo) VALUES (?, ?, 'member', 0)",
        )
        .run(id, `${MARKERS.person} ${id}`);
  } finally {
    w.db.exec("PRAGMA ignore_check_constraints = OFF");
  }

  const at0 = (day: number, time = "08:00:00") => w.clock.set(at(day, time));

  // ---- the matters, made at the moments they were made ----
  function matter(
    key: string,
    day: number,
    time: string,
    o: {
      createdBy: string;
      synthetic?: boolean;
      training?: boolean;
      reviewer?: string;
      viewer?: string;
    },
  ): MatterFixture {
    at0(day, time);
    const created = repo.createMatter({
      name: `${MARKERS.name} ${key}`,
      clientLegalName: `${MARKERS.client} ${key}`,
      createdBy: o.createdBy,
      // A training matter is synthetic, which the database insists on (migration 7).
      synthetic: o.synthetic ?? o.training === true,
      ...(o.training ? { trainingKey: "T01" as const } : {}),
    });
    const body = NDA_PARAGRAPHS.join("\n");
    const { document, version } = repo.addDocument(
      created.id,
      {
        kind: "nda",
        title: `${MARKERS.title} ${key}`,
        version: {
          mediaType: "txt",
          fileSha256: sha256Hex(`file:${created.id}`),
          textSha256: sha256Hex(body),
          byteSize: body.length,
          statedDate: "2026-01-15",
          storagePath: fakePath(created.id),
          operative: true,
        },
      },
      { actorId: o.createdBy },
    );
    const spans = buildSpans(version.id, document.label, NDA_PARAGRAPHS);
    repo.insertSpans(created.id, spans, [
      { kind: "defines_term", spanId: spans[1]!.id, term: "Confidential Information" },
    ]);
    repo.setPlaybookVersion(created.id, w.playbook.id, { actorId: o.createdBy });
    if (o.reviewer) repo.addMember(created.id, o.reviewer, "reviewer", { actorId: o.createdBy });
    if (o.viewer) repo.addMember(created.id, o.viewer, "viewer", { actorId: o.createdBy });
    ids[key] = created.id;
    return {
      id: created.id,
      nda: {
        documentId: document.id,
        versionId: version.id,
        spanIds: spans.map((s) => s.id),
        texts: NDA_PARAGRAPHS,
      },
    };
  }

  const m: Record<string, MatterFixture> = {};
  m["M1"] = matter("M1", 14, "08:00:00", { createdBy: P.alex, reviewer: P.dana, viewer: P.vera });
  m["M6"] = matter("M6", 14, "08:30:00", { createdBy: P.alex, reviewer: P.dana, synthetic: true });
  m["M8"] = matter("M8", 14, "09:00:00", { createdBy: P.alex, reviewer: P.dana, training: true });
  m["M2"] = matter("M2", 21, "08:00:00", { createdBy: P.alex, reviewer: P.dana });
  m["M3"] = matter("M3", 1, "08:00:00", { createdBy: P.ben, reviewer: P.dana });
  m["M5"] = matter("M5", 1, "08:30:00", { createdBy: P.ben, reviewer: P.dana });
  m["M4"] = matter("M4", 39, "08:00:00", { createdBy: P.ben });
  m["M7"] = matter("M7", 15, "08:00:00", { createdBy: DEMO_ASSOCIATE });
  const d1 = matter("D1", 10, "08:00:00", { createdBy: P.alex });
  const d2 = matter("D2", 10, "08:30:00", { createdBy: P.alex, synthetic: true });
  repo.deleteMatter(d1.id, { actorId: P.alex });
  repo.deleteMatter(d2.id, { actorId: P.alex });

  // ---- the calendar and the roster ----
  at0(0, "07:00:00");
  repo.setPilotCalendar({ startDate: START, actorId: ACTORS.admin });
  repo.setPilotParticipants([P.alex, P.ben, DEMO_ASSOCIATE], { actorId: ACTORS.admin });

  // ---- reference lists, before any review ----
  const list = (
    key: string,
    day: number,
    time: string,
    rules: { ruleKey: string; severity: "high" | "medium" | "low" }[],
    outsideHigh = 0,
  ) => {
    at0(day, time);
    repo.saveReferenceList(
      m[key]!.id,
      { rules, outsideHigh, outsideMedium: 0, outsideLow: 0 },
      { userId: P.dana },
    );
  };
  list(
    "M3",
    1,
    "10:00:00",
    [
      { ruleKey: "dur-1", severity: "high" },
      { ruleKey: "pty-1", severity: "medium" },
    ],
    1,
  );
  list("M5", 1, "11:00:00", [{ ruleKey: "gov-1", severity: "low" }]);
  list("M8", 14, "10:00:00", [{ ruleKey: "dur-1", severity: "high" }]);

  // ---- runs ----
  const SPAN_OF: Record<Rule, number> = { "pty-1": 1, "dur-1": 2, "gov-1": 3 };
  const finish = (
    key: string,
    day: number,
    time: string,
    startedBy: string,
    outcomes: Record<Rule, Outcome>,
  ) => {
    at0(day, time);
    const fixture = m[key]!;
    const manifest = repo.buildRunManifest(fixture.id, {
      workflowVersionId: w.workflow.id,
      modelProvider: "scripted",
      model: "scripted-1",
    });
    const created = repo.createRun(fixture.id, { manifest, startedBy });
    for (const status of ["ingesting", "extracting", "retrieving", "analyzing"] as const)
      repo.updateRunStatus(fixture.id, created.id, status);
    const findings = (Object.keys(SPAN_OF) as Rule[]).map((rule) => {
      const span = {
        id: fixture.nda.spanIds[SPAN_OF[rule]]!,
        text: fixture.nda.texts[SPAN_OF[rule]]!,
      };
      const outcome = outcomes[rule];
      const overrides =
        outcome === "compliant"
          ? { explanation: MARKERS.explanation }
          : outcome === "deviation"
            ? {
                status: "deviation" as Status,
                discrepancy: MARKERS.discrepancy,
                explanation: MARKERS.explanation,
              }
            : {
                status: "undetermined" as Status,
                discrepancy: MARKERS.discrepancy,
                explanation: MARKERS.explanation,
                abstainReason: "The documents do not settle it.",
                escalations: [{ code: "model_abstained" as const, detail: "no status" }],
                verificationState: "escalated_by_system" as const,
              };
      return findingFor(rule, span, overrides);
    });
    const saved = repo.saveFindings(fixture.id, created.id, findings);
    const run = succeed(w, fixture, repo.getRun(fixture.id, created.id) as RunRow);
    runs[key] = run.id;
    return saved;
  };

  const compliant: Record<Rule, Outcome> = {
    "pty-1": "compliant",
    "dur-1": "compliant",
    "gov-1": "compliant",
  };
  finish("M3", 8, "09:00:00", P.ben, { ...compliant, "dur-1": "deviation" });
  const f1 = finish("M1", 15, "09:00:00", P.alex, {
    ...compliant,
    "dur-1": "deviation",
    "gov-1": "escalated",
  });
  const f6 = finish("M6", 15, "10:00:00", P.alex, { ...compliant, "gov-1": "escalated" });
  const f8 = finish("M8", 15, "12:00:00", P.alex, { ...compliant, "dur-1": "deviation" });
  finish("M7", 16, "09:00:00", DEMO_ASSOCIATE, compliant);
  const f2 = finish("M2", 22, "09:00:00", P.alex, compliant);
  finish("M4", 40, "09:00:00", P.ben, compliant);

  // ---- decisions and memos ----
  const byRule = (found: { id: string; ruleKey: string; contentSha256: string }[], rule: Rule) =>
    found.find((f) => f.ruleKey === rule)!;
  const current = new Map<string, string>();
  const decide = (
    key: string,
    day: number,
    time: string,
    found: { id: string; ruleKey: string; contentSha256: string }[],
    rule: Rule,
    decision: "accept" | "edit" | "reject" | "escalate",
    extra: {
      reasonCode?: (typeof REASON_CODES)[number];
      minorEdit?: boolean;
    } = {},
  ) => {
    at0(day, time);
    const finding = byRule(found, rule);
    const review = repo.recordReview(m[key]!.id, finding.id, {
      reviewerId: P.dana,
      decision,
      findingContentSha256: finding.contentSha256,
      ...(decision === "accept" ? {} : { reason: `${MARKERS.reason} ${decision}` }),
      ...(decision === "edit" ? { edits: { discrepancy: `${MARKERS.edit} changed` } } : {}),
      ...extra,
    });
    current.set(finding.id, review.id);
  };
  const memo = (key: string, day: number, time: string, found: { id: string }[]) => {
    at0(day, time);
    repo.recordMemo(m[key]!.id, {
      runId: runs[key]!,
      reviewIds: found.map((f) => current.get(f.id)!),
      fileSha256: sha256Hex(`memo:${key}`),
      storagePath: fakePath(m[key]!.id),
      exportedBy: P.dana,
    });
  };

  decide("M1", 16, "10:00:00", f1, "pty-1", "accept");
  decide("M1", 16, "10:01:00", f1, "dur-1", "reject", { reasonCode: "wrong_evidence" });
  decide("M1", 16, "10:02:00", f1, "gov-1", "escalate");
  // The reviewer changes her mind: the reject goes stale and the edit counts.
  decide("M1", 16, "10:05:00", f1, "dur-1", "edit", {
    reasonCode: "bad_fallback",
    minorEdit: true,
  });
  memo("M1", 16, "11:00:00", f1);

  for (const f of f2) decide("M2", 22, "11:00:00", f2, f.ruleKey as Rule, "accept");
  for (const f of f6) decide("M6", 15, "11:00:00", f6, f.ruleKey as Rule, "accept");
  memo("M6", 15, "12:00:00", f6);

  decide("M8", 15, "13:00:00", f8, "pty-1", "edit", { reasonCode: "other", minorEdit: false });
  decide("M8", 15, "13:01:00", f8, "dur-1", "reject", { reasonCode: "other" });
  decide("M8", 15, "13:02:00", f8, "gov-1", "accept");
  memo("M8", 15, "14:00:00", f8);

  // ---- ratings and reports ----
  const rate = (key: string, day: number, userId: string, rating: number) => {
    at0(day, "15:00:00");
    repo.addFeedback(m[key]!.id, {
      userId,
      kind: "rating",
      rating,
      text: `${MARKERS.words} ${rating}`,
    });
  };
  const report = (key: string, day: number, ruleKey: string | null) => {
    at0(day, "15:30:00");
    repo.addFeedback(m[key]!.id, {
      userId: P.dana,
      kind: "missed_issue",
      runId: runs[key]!,
      ruleKey,
      location: `${MARKERS.place} ${key}`,
      text: `${MARKERS.report} ${key}`,
    });
  };
  rate("M1", 17, P.alex, 4);
  rate("M1", 17, P.dana, 5);
  rate("M1", 17, P.vera, 3);
  rate("M6", 17, P.alex, 5);
  rate("M8", 17, P.alex, 1);
  report("M1", 17, "dur-1");
  report("M1", 17, null);
  report("M2", 23, "pty-1");
  report("M8", 17, "gov-1");

  // ---- timers (alex's running one last, since a person times one thing at a time) ----
  const timed = (
    key: string,
    userId: string,
    day: number,
    from: string,
    seconds: number | null,
  ) => {
    at0(day, from);
    repo.startTimer(m[key]!.id, { userId });
    if (seconds !== null) {
      w.clock.set(new Date(w.clock.now().getTime() + seconds * 1000).toISOString());
      repo.stopTimer(m[key]!.id, { userId });
    }
  };
  timed("M5", P.ben, 2, "09:00:00", 1800);
  timed("M5", P.ben, 2, "10:00:00", 900);
  timed("M5", P.dana, 3, "09:00:00", 1200);
  timed("M5", P.ben, -1, "09:00:00", 600);
  timed("M3", P.ben, 8, "09:00:00", 2400);
  timed("M1", P.alex, 15, "09:30:00", 1500);
  timed("M1", P.dana, 16, "09:00:00", 2100);
  timed("M2", P.alex, 22, "09:00:00", 2700);
  timed("M2", P.dana, 23, "09:00:00", 900);
  timed("M6", P.alex, 15, "11:00:00", 600);
  timed("M8", P.alex, 15, "12:00:00", 3000);
  timed("M2", P.alex, 24, "09:00:00", null);

  at0(40, "12:00:00");
  return { w, ids, runs };
}

const measure = (
  measures: PilotMeasures,
  id: MeasureRow["measure"],
  breakdown: MeasureRow["breakdown"],
  key = "",
): MeasureRow => {
  const row = measures.rows.find(
    (r) => r.measure === id && r.breakdown === breakdown && r.key === key,
  );
  if (row === undefined) throw new Error(`no row ${id} ${breakdown} ${key}`);
  return row;
};
const population = (measures: PilotMeasures): Record<string, number> =>
  Object.fromEntries(measures.population.map((p) => [p.code, p.count]));

let S: Scenario;
let records: PilotRecords;
const compute = (scope: PilotScope): PilotMeasures =>
  computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: REASON_CODES });

beforeAll(async () => {
  S = await buildScenario();
  // The interface slice A defined is the one the repository implements.
  const source: PilotRecordSource = S.w.repo;
  records = source.loadPilotRecords();
});

// ---------------------------------------------------------------------------------------------
describe("what the loader returns", () => {
  it("lists the matters that exist with their flags, the training matter flagged, the deleted ones gone", () => {
    const flags = Object.fromEntries(
      records.matters.map((r) => [
        r.matterId,
        [r.synthetic, r.creatorDemo, r.training, r.playbookVersionId === S.w.playbook.id],
      ]),
    );
    expect(Object.keys(flags).sort()).toEqual(
      ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"].map((k) => S.ids[k]).sort(),
    );
    //                       synthetic creatorDemo training  playbook
    expect(flags[S.ids["M1"]!]).toEqual([false, false, false, true]);
    expect(flags[S.ids["M6"]!]).toEqual([true, false, false, true]);
    expect(flags[S.ids["M7"]!]).toEqual([false, true, false, true]);
    expect(flags[S.ids["M8"]!]).toEqual([true, false, true, true]);
    for (const key of ["D1", "D2"]) expect(flags[S.ids[key]!]).toBeUndefined();
    // The retention date is the creation moment and thirty days.
    expect(records.matters.find((r) => r.matterId === S.ids["M3"])?.retainUntil).toBe(
      at(31, "08:00:00"),
    );
  });

  it("tells a person who is not a demonstration identity from one who is, on every kind of record", () => {
    const demo = (userId: string): boolean => userId === DEMO_ASSOCIATE;
    for (const r of records.members) expect(r.userDemo, r.userId).toBe(demo(r.userId));
    for (const r of records.runs) expect(r.startedByDemo, r.startedBy).toBe(demo(r.startedBy));
    expect(records.runs.filter((r) => r.startedByDemo).map((r) => r.matterId)).toEqual([
      S.ids["M7"],
    ]);
    expect(records.participants).toEqual([
      { userId: ACTORS.associate, demo: true },
      { userId: P.alex, demo: false },
      { userId: P.ben, demo: false },
    ]);
    expect(records.decisions.every((r) => !r.reviewerDemo)).toBe(true);
  });

  it("returns the runs of reviews, the findings with their flags, and the playbooks in order", () => {
    // Six matters were reviewed besides the training matter.
    expect(records.runs).toHaveLength(6);
    expect(records.runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(records.runs.find((r) => r.matterId === S.ids["M4"])?.startedAt).toBe(
      at(40, "09:00:00"),
    );
    expect(records.findings).toHaveLength(18);
    expect(records.findings.filter((f) => f.escalatedBySystem).map((f) => f.matterId)).toEqual(
      expect.arrayContaining([S.ids["M1"], S.ids["M6"]]),
    );
    expect(records.findings.filter((f) => f.escalatedBySystem)).toHaveLength(2);
    expect(
      records.findings.find((f) => f.matterId === S.ids["M3"] && f.ruleKey === "dur-1"),
    ).toMatchObject({
      status: "deviation",
      severity: "high",
      escalatedBySystem: false,
    });
    expect(records.playbooks).toEqual([
      { versionId: S.w.playbook.id, ruleKeys: ["pty-1", "dur-1", "gov-1"] },
    ]);
  });

  it("returns the current decisions with their codes and marks, and the stale ones apart", () => {
    // M1 three, M2 three, M6 three; the reject that was changed is stale, and M8's are not here.
    expect(records.decisions).toHaveLength(9);
    const m1 = records.decisions.filter((d) => d.matterId === S.ids["M1"]);
    expect(m1.map((d) => [d.decision, d.reasonCode, d.minorEdit]).sort()).toEqual(
      [
        ["accept", null, null],
        ["edit", "bad_fallback", true],
        ["escalate", null, null],
      ].sort(),
    );
    expect(records.staleDecisions).toEqual([{ matterId: S.ids["M1"], reviewerDemo: false }]);
  });

  it("returns memos, reports without their words, ratings oldest first, timers and reference issues", () => {
    expect(records.memos.map((r) => r.matterId).sort()).toEqual([S.ids["M1"], S.ids["M6"]].sort());
    // Grouped by matter (the order of the matters is the order of their ids, which are random).
    const keyed = (list: unknown[][]): string[] => list.map((r) => JSON.stringify(r)).sort();
    expect(keyed(records.missedIssues.map((r) => [r.matterId, r.ruleKey]))).toEqual(
      keyed([
        [S.ids["M1"], "dur-1"],
        [S.ids["M1"], null],
        [S.ids["M2"], "pty-1"],
      ]),
    );
    expect(records.ratings.map((r) => [r.matterId, r.userId, r.rating])).toEqual([
      [S.ids["M1"], P.alex, 4],
      [S.ids["M1"], P.dana, 5],
      [S.ids["M1"], P.vera, 3],
      [S.ids["M6"], P.alex, 5],
    ]);
    expect(records.timeEntries).toHaveLength(11);
    expect(records.timeEntries.filter((t) => t.stoppedAt === null)).toEqual([
      {
        matterId: S.ids["M2"],
        userId: P.alex,
        userDemo: false,
        role: "associate",
        startedAt: at(24, "09:00:00"),
        stoppedAt: null,
      },
    ]);
    expect(keyed(records.referenceIssues.map((r) => [r.matterId, r.ruleKey, r.severity]))).toEqual(
      keyed([
        [S.ids["M3"], "dur-1", "high"],
        [S.ids["M3"], "pty-1", "medium"],
        [S.ids["M3"], null, "high"],
        [S.ids["M5"], "gov-1", "low"],
      ]),
    );
    // Within a matter the list is in the playbook's order (pty-1 comes before dur-1), then the rest.
    expect(
      records.referenceIssues.filter((r) => r.matterId === S.ids["M3"]).map((r) => r.ruleKey),
    ).toEqual(["pty-1", "dur-1", null]);
    expect(records.calendar).toEqual({ startDate: START });
  });

  it("returns the matters the audit log saw made, with their flags, and which of them are gone", () => {
    const byId = Object.fromEntries(records.auditMatters.map((r) => [r.matterId, r]));
    expect(records.auditMatters).toHaveLength(10);
    expect(byId[S.ids["D1"]!]).toEqual({
      matterId: S.ids["D1"],
      synthetic: false,
      creatorDemo: false,
      training: false,
      deleted: true,
    });
    expect(byId[S.ids["D2"]!]).toMatchObject({ synthetic: true, deleted: true });
    expect(byId[S.ids["M7"]!]).toMatchObject({
      synthetic: false,
      creatorDemo: true,
      deleted: false,
    });
    expect(byId[S.ids["M8"]!]).toMatchObject({ training: true, deleted: false });
    expect(byId[S.ids["M1"]!]).toMatchObject({
      synthetic: false,
      creatorDemo: false,
      training: false,
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe("the training matter", () => {
  const training = () => S.ids["M8"]!;

  it("is listed with its flag and nothing else of it leaves the store", () => {
    const lists: [string, { matterId: string }[]][] = [
      ["members", records.members],
      ["runs", records.runs],
      ["findings", records.findings],
      ["decisions", records.decisions],
      ["staleDecisions", records.staleDecisions],
      ["memos", records.memos],
      ["missedIssues", records.missedIssues],
      ["ratings", records.ratings],
      ["timeEntries", records.timeEntries],
      ["referenceIssues", records.referenceIssues],
    ];
    for (const [name, list] of lists) {
      expect(list.length, name).toBeGreaterThan(0);
      expect(
        list.filter((r) => r.matterId === training()),
        name,
      ).toEqual([]);
    }
    expect(records.runs.some((r) => r.runId === S.runs["M8"])).toBe(false);
    // The rows exist in the database, so it is the loader that leaves them out.
    for (const table of [
      "matter_members",
      "runs",
      "findings",
      "reviews",
      "memos",
      "feedback",
      "time_entries",
      "reference_issues",
    ])
      expect(
        S.w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE matter_id = ?`).get(training()),
        table,
      ).not.toEqual({ n: 0 });
  });

  it("is counted once, in the population table of both scopes, and moves no measure", () => {
    for (const scope of ["pilot", "synthetic"] as const)
      expect(population(compute(scope))["matters_training"], scope).toBe(1);
    // M8 had a run in the window, three decisions and a memo, and a rating of 1: the synthetic
    // scope (where a synthetic matter would land) shows none of it.
    const synthetic = compute("synthetic");
    expect(measure(synthetic, "completion", "overall").denominator).toBe(2);
    expect(measure(synthetic, "satisfaction_rating", "overall").value).toBe(5);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the pure module over the stored rows gives the numbers a hand count gives", () => {
  const ratio = (row: MeasureRow, numerator: number, denominator: number, value: number) =>
    expect(
      { n: row.numerator, d: row.denominator, v: row.value, s: row.status },
      `${row.measure} ${row.breakdown} ${row.key}`,
    ).toEqual({ n: numerator, d: denominator, v: value, s: "value" });
  const noData = (row: MeasureRow, reason: string) =>
    expect(
      { v: row.value, s: row.status, r: row.reason },
      `${row.measure} ${row.breakdown} ${row.key}`,
    ).toEqual({ v: null, s: "no_data", r: reason });
  const median = (row: MeasureRow, n: number, value: number, min: number, max: number) =>
    expect(
      { n: row.denominator, v: row.value, lo: row.min, hi: row.max, s: row.status },
      `${row.measure} ${row.key}`,
    ).toEqual({ n, v: value, lo: min, hi: max, s: "value" });

  it("pilot scope: the population table", () => {
    const measures = compute("pilot");
    expect(measures.calendar).toEqual({ startDate: START, endDate: "2026-12-06" });
    expect(population(measures)).toEqual({
      matters_total: 8,
      matters_training: 1,
      matters_synthetic: 1,
      matters_by_demo_identity: 1,
      matters_real: 5,
      matters_in_scope: 5,
      matters_run_in_window: 3,
      matters_run_before_window: 0,
      matters_run_after_window: 1,
      matters_no_run: 1,
      matters_exported: 1,
      findings: 9,
      findings_decided: 6,
      decisions_no_longer_current: 1,
      missed_reports_counted: 2,
      missed_reports_outside: 1,
      ratings_counted: 2,
      ratings_by_viewers: 1,
      raters_eligible: 2,
      time_entries_counted: 8,
      time_entries_open: 1,
      time_entries_outside_window: 1,
      reference_issues_compared: 3,
      reference_issues_not_compared: 1,
      participants_trained: 2,
      starters_not_on_roster: 0,
      matters_expiring_before_pilot_end: 2,
      audit_matters_created: 6,
      audit_matters_deleted: 1,
    });
  });

  it("pilot scope: completion, repeat usage and the run-based measures, to the digit", () => {
    const m = compute("pilot");
    ratio(measure(m, "completion", "overall"), 1, 3, 0.3333);
    noData(measure(m, "completion", "phase", "baseline"), "no_denominator");
    ratio(measure(m, "completion", "phase", "shadow"), 0, 1, 0);
    ratio(measure(m, "completion", "phase", "assisted"), 1, 2, 0.5);

    // alex started matters in weeks 3 and 4; ben in week 2 only (his run on day 40 is outside the window).
    ratio(measure(m, "repeat_usage", "overall"), 1, 2, 0.5);

    ratio(measure(m, "correction_rate", "overall"), 1, 6, 0.1667);
    ratio(measure(m, "correction_rate", "phase", "assisted"), 1, 6, 0.1667);
    noData(measure(m, "correction_rate", "phase", "shadow"), "no_denominator");
    ratio(measure(m, "correction_rate", "reason_code", "bad_fallback"), 1, 6, 0.1667);
    // The reject that was changed to an edit does not count: the decision in force does.
    for (const code of ["wrong_status", "wrong_evidence", "missed_context", "unclear", "other"])
      ratio(measure(m, "correction_rate", "reason_code", code), 0, 6, 0);
    expect(m.rows.some((r) => r.key === "not_recorded")).toBe(false);

    ratio(measure(m, "accepted_or_minor", "overall"), 5, 6, 0.8333);

    ratio(measure(m, "missed_issue_rate", "overall"), 2, 1, 2);
    ratio(measure(m, "missed_issue_rate", "rule", "dur-1"), 1, 1, 1);
    ratio(measure(m, "missed_issue_rate", "rule", "not_covered"), 1, 1, 1);
    ratio(measure(m, "missed_issue_rate", "rule", "pty-1"), 0, 1, 0);
    ratio(measure(m, "missed_issue_rate", "rule", "gov-1"), 0, 1, 0);

    ratio(measure(m, "escalation_system", "overall"), 1, 9, 0.1111);
    ratio(measure(m, "escalation_system", "phase", "shadow"), 0, 3, 0);
    ratio(measure(m, "escalation_system", "phase", "assisted"), 1, 6, 0.1667);
    noData(measure(m, "escalation_system", "phase", "baseline"), "no_denominator");
    ratio(measure(m, "escalation_reviewer", "overall"), 1, 9, 0.1111);
    ratio(measure(m, "escalation_reviewer", "of_decided", "decided"), 1, 6, 0.1667);
  });

  it("pilot scope: ratings, the response rate and the times, to the digit", () => {
    const m = compute("pilot");
    median(measure(m, "satisfaction_rating", "overall"), 2, 4.5, 4, 5);
    ratio(measure(m, "satisfaction_rating", "distribution", "4"), 1, 2, 0.5);
    ratio(measure(m, "satisfaction_rating", "distribution", "5"), 1, 2, 0.5);
    ratio(measure(m, "satisfaction_rating", "distribution", "3"), 0, 2, 0);
    ratio(measure(m, "satisfaction_response", "overall"), 2, 2, 1);

    median(measure(m, "active_time", "series", "baseline:associate"), 1, 45, 45, 45);
    median(measure(m, "active_time", "series", "baseline:reviewer"), 1, 20, 20, 20);
    median(measure(m, "active_time", "series", "baseline:combined"), 1, 65, 65, 65);
    median(measure(m, "active_time", "series", "shadow:associate"), 1, 40, 40, 40);
    noData(measure(m, "active_time", "series", "shadow:reviewer"), "no_denominator");
    noData(measure(m, "active_time", "series", "shadow:combined"), "no_denominator");
    median(measure(m, "active_time", "series", "assisted:associate"), 2, 35, 25, 45);
    median(measure(m, "active_time", "series", "assisted:reviewer"), 2, 25, 15, 35);
    median(measure(m, "active_time", "series", "assisted:combined"), 2, 60, 60, 60);
  });

  it("pilot scope: shadow-mode agreement with the reference list, by severity", () => {
    const m = compute("pilot");
    // M3: dur-1 is a deviation (agreed), pty-1 is compliant (not), the high issue no rule covers (not).
    ratio(measure(m, "shadow_agreement", "overall"), 1, 3, 0.3333);
    ratio(measure(m, "shadow_agreement", "severity", "high"), 1, 2, 0.5);
    ratio(measure(m, "shadow_agreement", "severity", "medium"), 0, 1, 0);
    noData(measure(m, "shadow_agreement", "severity", "low"), "no_denominator");
  });

  it("synthetic scope: what the same rows give for the matters that are not the pilot's", () => {
    const m = compute("synthetic");
    expect(population(m)).toEqual({
      matters_total: 8,
      matters_training: 1,
      matters_synthetic: 1,
      matters_by_demo_identity: 1,
      matters_real: 5,
      matters_in_scope: 2,
      matters_run_in_window: 2,
      matters_run_before_window: 0,
      matters_run_after_window: 0,
      matters_no_run: 0,
      matters_exported: 1,
      findings: 6,
      findings_decided: 3,
      decisions_no_longer_current: 0,
      missed_reports_counted: 0,
      missed_reports_outside: 0,
      ratings_counted: 1,
      ratings_by_viewers: 0,
      raters_eligible: 2,
      time_entries_counted: 1,
      time_entries_open: 0,
      time_entries_outside_window: 0,
      reference_issues_compared: 0,
      reference_issues_not_compared: 0,
      participants_trained: 1,
      starters_not_on_roster: 1,
      matters_expiring_before_pilot_end: 0,
      audit_matters_created: 3,
      audit_matters_deleted: 1,
    });
    ratio(measure(m, "completion", "overall"), 1, 2, 0.5);
    ratio(measure(m, "repeat_usage", "overall"), 0, 1, 0);
    ratio(measure(m, "correction_rate", "overall"), 0, 3, 0);
    ratio(measure(m, "accepted_or_minor", "overall"), 3, 3, 1);
    ratio(measure(m, "escalation_system", "overall"), 1, 6, 0.1667);
    median(measure(m, "satisfaction_rating", "overall"), 1, 5, 5, 5);
    ratio(measure(m, "satisfaction_response", "overall"), 1, 2, 0.5);
    median(measure(m, "active_time", "series", "assisted:associate"), 1, 10, 10, 10);
  });

  it("the two scopes partition the matters: every real or synthetic matter is in exactly one", () => {
    const pilot = population(compute("pilot"));
    const synthetic = population(compute("synthetic"));
    expect(pilot["matters_in_scope"]! + synthetic["matters_in_scope"]!).toBe(
      pilot["matters_total"]! - pilot["matters_training"]!,
    );
  });

  it("carries every row of both scopes to the CSV, with the scope on each", () => {
    for (const scope of ["pilot", "synthetic"] as const) {
      const csv = toCsv(compute(scope));
      const lines = csv.trimEnd().split("\r\n");
      expect(lines.length).toBe(1 + compute(scope).rows.length + compute(scope).population.length);
      expect(lines.slice(1).every((line) => line.startsWith(`${scope},`))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe("on a database this build can make", () => {
  /** The measures of the two scopes over a database made only through the application's own ways. */
  function ordinary(calendar: boolean) {
    const w = makeWorld();
    // A reviewed and exported matter, synthetic as every matter the application makes is, and one
    // that is marked not synthetic but was made by a demonstration identity, which is no person.
    exported(w, { amendment: true, name: "reviewed" });
    startRun(w, addMatter(w, { name: "unmarked", synthetic: false }));
    if (calendar) w.repo.setPilotCalendar({ startDate: "2026-10-26", actorId: ACTORS.admin });
    const records = w.repo.loadPilotRecords();
    const at = (scope: PilotScope) =>
      computePilotMeasures(records, { scope, asOf: AS_OF, reasonCodes: REASON_CODES });
    return { pilot: at("pilot"), synthetic: at("synthetic") };
  }

  it("has no pilot scope: every row reads no data, because every identity here is a demonstration identity", () => {
    const { pilot, synthetic } = ordinary(true);
    expect(population(pilot)["matters_total"]).toBe(2);
    expect(population(pilot)["matters_in_scope"]).toBe(0);
    expect(pilot.rows.length).toBeGreaterThan(40);
    expect(pilot.rows.filter((r) => r.status !== "no_data")).toEqual([]);
    expect(new Set(pilot.rows.map((r) => r.reason))).toEqual(new Set(["all_excluded"]));
    expect(pilot.rows.every((r) => r.value === null)).toBe(true);
    // The same rows give the synthetic scope its figures: this is the scope that shows something.
    expect(population(synthetic)["matters_in_scope"]).toBe(2);
    ratioOf(measure(synthetic, "completion", "overall"), 1, 2);
  });

  it("reads no calendar before one is set, in both scopes, and still counts the matters", () => {
    const { pilot, synthetic } = ordinary(false);
    for (const measures of [pilot, synthetic]) {
      expect(measures.calendar).toBeNull();
      expect(measures.rows.filter((r) => r.status !== "no_data")).toEqual([]);
      expect(new Set(measures.rows.map((r) => r.reason))).toEqual(new Set(["no_calendar"]));
      expect(population(measures)["matters_total"]).toBe(2);
    }
  });
});

const ratioOf = (row: MeasureRow, numerator: number, denominator: number): void =>
  expect([row.numerator, row.denominator, row.status]).toEqual([numerator, denominator, "value"]);

// ---------------------------------------------------------------------------------------------
describe("no text and no identity reaches the records", () => {
  /** Every table and column that holds `needle`, found by reading the whole database. */
  function whereIs(needle: string): string[] {
    const found: string[] = [];
    const tables = S.w.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const columns = S.w.db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
      for (const column of columns) {
        const row = S.w.db
          .prepare(
            `SELECT count(*) AS n FROM "${name}" WHERE instr(CAST("${column.name}" AS TEXT), ?) > 0`,
          )
          .get(needle) as { n: number };
        if (row.n > 0) found.push(`${name}.${column.name}`);
      }
    }
    return found;
  }

  it("holds none of the words a person typed, in the records, the measures or the CSV", () => {
    const outputs = [
      JSON.stringify(records),
      JSON.stringify(compute("pilot")),
      JSON.stringify(compute("synthetic")),
      toCsv(compute("pilot")),
      toCsv(compute("synthetic")),
    ];
    for (const [kind, marker] of Object.entries(MARKERS)) {
      // The marker is in the database, in the column meant to hold it, so a clean result means something.
      expect(whereIs(marker), kind).not.toEqual([]);
      for (const output of outputs) expect(output, kind).not.toContain(marker);
    }
    // Nor the words of the document the findings were made on.
    for (const paragraph of NDA_PARAGRAPHS)
      expect(JSON.stringify(records)).not.toContain(paragraph.slice(0, 30));
    expect(JSON.stringify(records)).not.toContain("Marlowe");
  });

  it("puts the markers in the columns that hold text, which are the ones the loader does not read", () => {
    expect(whereIs(MARKERS.name)).toContain("matters.name");
    expect(whereIs(MARKERS.client)).toContain("matters.client_legal_name");
    expect(whereIs(MARKERS.title)).toContain("documents.title");
    expect(whereIs(MARKERS.person)).toContain("users.display_name");
    expect(whereIs(MARKERS.reason)).toContain("reviews.reason");
    expect(whereIs(MARKERS.edit)).toContain("reviews.edited_json");
    expect(whereIs(MARKERS.report)).toContain("feedback.text");
    expect(whereIs(MARKERS.place)).toContain("feedback.location");
    expect(whereIs(MARKERS.words)).toContain("feedback.text");
    expect(whereIs(MARKERS.explanation)).toContain("findings.explanation");
    expect(whereIs(MARKERS.discrepancy)).toContain("findings.discrepancy");
  });

  it("writes nothing: the database is the same after a load as before, and a load can run inside a transaction", () => {
    const dump = (): string =>
      (
        S.w.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      )
        .map(
          ({ name }) =>
            `${name}: ${JSON.stringify(S.w.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}`,
        )
        .join("\n");
    const before = dump();
    const first = S.w.repo.loadPilotRecords();
    expect(S.w.db.isTransaction).toBe(false);
    expect(dump()).toBe(before);
    const inside = S.w.repo.transaction(() => S.w.repo.loadPilotRecords());
    expect(inside).toEqual(first);
    expect(first).toEqual(records);
    expect(S.w.db.isTransaction).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the loader's source", () => {
  const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
  const source = (path: string): string => readFileSync(join(SRC, path), "utf8");

  /** The code of a file with its comments taken out: what a statement can name. */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /** Names of the columns that can hold text, and generic words for text. */
  const TEXT_COLUMNS =
    /\b(?:display_name|client_legal_name|edited_json|discrepancy|explanation|fallback_language|fallback_basis|abstain_reason|conflict|text|quote|title|location|name|reason|note|comment|body|content|prompt|response|output_json|rule_json|yaml)\b/;

  it("names no column that can hold text, in any statement", () => {
    const found = code(source("store/repo-pilot.ts")).match(TEXT_COLUMNS);
    expect(found).toBeNull();
  });

  it("would notice one: the scan finds a text column planted in a statement", () => {
    for (const planted of [
      "SELECT fb.text FROM feedback fb",
      "SELECT rv.reason FROM reviews rv",
      "SELECT matters.name FROM matters",
      "SELECT f.explanation FROM findings f",
      "SELECT fb.location FROM feedback fb",
      "SELECT rv.edited_json FROM reviews rv",
    ])
      expect(code(`const sql = "${planted}";`).match(TEXT_COLUMNS), planted).not.toBeNull();
    // The scan reads code and not comments.
    expect(
      code("// the text of a report is never read\nconst x = 1;").match(TEXT_COLUMNS),
    ).toBeNull();
  });

  it("is called from one place in the application: the pilot service", () => {
    const callers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.tsx?$/.test(name) &&
          /\bloadPilotRecords\b/.test(code(readFileSync(path, "utf8")))
        )
          callers.push(relative(SRC, path));
      }
    };
    walk(SRC);
    // The definition, the interface it implements, and the one service that calls it.
    expect(callers.sort()).toEqual(
      [
        "pilot/types.ts",
        "store/repo-pilot.ts",
        ...(callers.includes("services/pilot.ts") ? ["services/pilot.ts"] : []),
      ].sort(),
    );
  });

  it("adds the training condition to every statement that reads a matter's rows", () => {
    // A statement reads a matter's rows when it names a table with a matter column; each of them
    // (the matters list apart, which lists the training matter with its flag) carries the condition.
    const text = source("store/repo-pilot.ts");
    const loader = text.slice(text.indexOf("function loadPilotRecords"));
    const statements = [...loader.matchAll(/`(SELECT[\s\S]*?)`/g)].map((m) => m[1]!);
    const reads = statements.filter((s) =>
      /\b(?:matter_members|runs|findings|reviews|memos|feedback|time_entries|reference_issues)\b/.test(
        s,
      ),
    );
    expect(reads.length).toBeGreaterThanOrEqual(10);
    for (const statement of reads) expect(statement, statement).toContain("${NOT_TRAINING_SQL}");
  });
});
