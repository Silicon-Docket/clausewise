import { afterAll, describe, expect, it } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import type { Principal } from "../../src/auth/types.js";
import { ForbiddenError } from "../../src/services/errors.js";
import { ConflictError, DEMO_USER_IDS, ValidationError } from "../../src/store/index.js";
import { addUser } from "../server/support-app.js";
import { cleanup, decideAll, makeWorld, newMatter, uploadCase, type World } from "./support.js";

afterAll(cleanup);

/**
 * The pilot service (package W2.6b): the check of the global role on every function that names no
 * matter, the check of the matter role on the timer and the reference list, and the whole way from
 * stored events to the measures and the CSV, through the real services and the real store.
 *
 * Every person here is a demonstration identity and every matter is synthetic, as on every database
 * this build can make, so the pilot scope is empty and the synthetic scope holds what the scenario
 * stored. The scenario states no result of a model: it counts what it did.
 */

const VIEWER = "usr_test_viewer";
const OUTSIDER = "usr_test_outsider";
const MARK = "QZMARK-pilot-service-91c4";

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error");
};

/** A world with a viewer and an outsider added as people. */
function world(): World {
  const w = makeWorld();
  addUser(w.repo, VIEWER);
  addUser(w.repo, OUTSIDER);
  return w;
}

describe("the functions that name no matter check the global role first", () => {
  const w = world();
  const { pilot } = w.services;
  const member = w.associate;
  const calls: Record<string, (p: Principal) => unknown> = {
    measures: (p) => pilot.measures(p, "pilot"),
    csv: (p) => pilot.csv(p, "pilot"),
    admin: (p) => pilot.admin(p),
    setCalendar: (p) => pilot.setCalendar(p, { startDate: "2026-11-09" }),
    setParticipants: (p) => pilot.setParticipants(p, { userIds: [DEMO_USER_IDS.associate] }),
  };

  for (const [name, call] of Object.entries(calls)) {
    it(`${name} refuses a member, for the legal engineer and the administrator only`, () => {
      expect(
        errorOf(() => call(member)),
        name,
      ).toBeInstanceOf(ForbiddenError);
      expect(
        errorOf(() => call(w.reviewer)),
        name,
      ).toBeInstanceOf(ForbiddenError);
      expect(() => call(w.engineer), name).not.toThrow();
      expect(() => call(w.admin), name).not.toThrow();
    });
  }

  it("changes nothing when it refuses", () => {
    const before = w.repo.countAuditEvents();
    const calendar = w.repo.getPilotCalendar();
    errorOf(() => pilot.setCalendar(member, { startDate: "2026-01-05" }));
    errorOf(() => pilot.setParticipants(member, { userIds: [DEMO_USER_IDS.reviewer] }));
    expect(w.repo.countAuditEvents()).toBe(before);
    expect(w.repo.getPilotCalendar()).toEqual(calendar);
  });

  it("uses the table the route guard uses: the read action for the page, the manage action for the forms", () => {
    expect(GLOBAL_ACTIONS["pilot.read"]).toEqual(["legal_engineer", "admin"]);
    expect(GLOBAL_ACTIONS["pilot.manage"]).toEqual(["legal_engineer", "admin"]);
  });

  it("reads and writes nothing when it measures", () => {
    const before = w.repo.countAuditEvents();
    pilot.measures(w.admin, "pilot");
    pilot.measures(w.admin, "synthetic");
    pilot.csv(w.engineer, "synthetic");
    pilot.admin(w.engineer);
    expect(w.repo.countAuditEvents()).toBe(before);
  });
});

describe("the calendar and the roster, through the service", () => {
  it("sets the calendar as the person who asked, with the end of week 5 and how often it was set", () => {
    const w = world();
    const { pilot } = w.services;
    expect(pilot.admin(w.admin).calendar).toBeNull();
    pilot.setCalendar(w.engineer, { startDate: "2026-11-09" });
    pilot.setCalendar(w.admin, { startDate: "2026-11-16" });
    const calendar = pilot.admin(w.admin).calendar;
    expect(calendar).toMatchObject({
      startDate: "2026-11-16",
      // 5 weeks from Monday 16 November end on Sunday 20 December.
      endDate: "2026-12-20",
      timesSet: 2,
    });
    const events = w.repo.listAuditEvents({ action: "pilot.calendar" });
    expect(events.map((event) => event.actorId)).toEqual([
      DEMO_USER_IDS.legalEngineer,
      DEMO_USER_IDS.admin,
    ]);
    expect(events.map((event) => event.matterId)).toEqual([null, null]);
  });

  it("refuses a date that is not a real one, with the calendar's own code", () => {
    const w = world();
    for (const bad of ["", "2026-02-30", "09/11/2026", "2026-11-9", "tomorrow"]) {
      const error = errorOf(() => w.services.pilot.setCalendar(w.admin, { startDate: bad }));
      expect(error, bad).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).code, bad).toBe("bad_calendar_date");
    }
    expect(w.services.pilot.admin(w.admin).calendar).toBeNull();
  });

  it("lists every person with a box, and the hint that someone completed the training matter is not a measure", async () => {
    const w = world();
    const { pilot } = w.services;
    const before = pilot.admin(w.admin).participants;
    expect(before.map((p) => p.userId).sort()).toEqual(
      [
        DEMO_USER_IDS.associate,
        DEMO_USER_IDS.reviewer,
        DEMO_USER_IDS.legalEngineer,
        DEMO_USER_IDS.admin,
        VIEWER,
        OUTSIDER,
      ].sort(),
    );
    expect(before.every((p) => !p.trained && p.completedTraining === false)).toBe(true);
    pilot.setParticipants(w.admin, { userIds: [DEMO_USER_IDS.associate, DEMO_USER_IDS.reviewer] });
    const after = pilot.admin(w.admin).participants;
    expect(
      after
        .filter((p) => p.trained)
        .map((p) => p.userId)
        .sort(),
    ).toEqual([DEMO_USER_IDS.associate, DEMO_USER_IDS.reviewer].sort());
    // Replace-all: a smaller list removes the person left out.
    pilot.setParticipants(w.admin, { userIds: [DEMO_USER_IDS.reviewer] });
    expect(
      pilot
        .admin(w.admin)
        .participants.filter((p) => p.trained)
        .map((p) => p.userId),
    ).toEqual([DEMO_USER_IDS.reviewer]);
    // The roster is what the trainer recorded: the hint is separate and moves no measure.
    const measures = pilot.measures(w.admin, "synthetic").measures;
    expect(measures.population.find((line) => line.code === "participants_trained")?.count).toBe(1);
  });

  it("refuses a person who is not a user and a roster that is too long, writing nothing", () => {
    const w = world();
    const { pilot } = w.services;
    pilot.setParticipants(w.admin, { userIds: [DEMO_USER_IDS.associate] });
    const events = w.repo.countAuditEvents();
    const unknown = errorOf(() => pilot.setParticipants(w.admin, { userIds: ["usr_nobody"] }));
    expect((unknown as ValidationError).code).toBe("unknown_user");
    const many = Array.from({ length: 65 }, (_, i) => `usr_${i}`);
    const tooMany = errorOf(() => pilot.setParticipants(w.admin, { userIds: many }));
    expect((tooMany as ValidationError).code).toBe("too_many_participants");
    expect(w.repo.countAuditEvents()).toBe(events);
    expect(pilot.admin(w.admin).participants.filter((p) => p.trained)).toHaveLength(1);
  });
});

describe("the timer", () => {
  it("is the signed-in person's own: start, a second start refused, stop, and what was timed", () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId, am } = newMatter(w);
    const reviewerAm = w.grant(w.reviewer, matterId);

    expect(pilot.timer(am)).toEqual({
      allowed: true,
      running: null,
      elsewhere: false,
      closedSeconds: 0,
      sessions: 0,
    });
    const started = pilot.startTimer(am);
    expect(started.running).not.toBeNull();
    expect(started.sessions).toBe(0);
    // The other person on the matter is not timing: a timer belongs to a person.
    expect(pilot.timer(reviewerAm).running).toBeNull();

    const twice = errorOf(() => pilot.startTimer(am));
    expect(twice).toBeInstanceOf(ConflictError);
    expect((twice as ConflictError).code).toBe("timer_open");

    const stopped = pilot.stopTimer(am);
    expect(stopped.running).toBeNull();
    expect(stopped.sessions).toBe(1);
    expect(stopped.closedSeconds).toBeGreaterThanOrEqual(0);

    const none = errorOf(() => pilot.stopTimer(am));
    expect((none as ConflictError).code).toBe("no_open_timer");

    // A second session adds to the total.
    pilot.startTimer(am);
    expect(pilot.stopTimer(am).sessions).toBe(2);
    const actions = w.repo.listAuditEvents({ matterId }).map((event) => event.action);
    expect(actions.filter((a) => a === "time.start")).toHaveLength(2);
    expect(actions.filter((a) => a === "time.stop")).toHaveLength(2);
  });

  it("says, on another matter, that a timer runs elsewhere, and names no matter", () => {
    const w = world();
    const { pilot } = w.services;
    const first = newMatter(w, "First matter");
    const second = newMatter(w, "Second matter");
    pilot.startTimer(first.am);
    const view = pilot.timer(second.am);
    expect(view).toMatchObject({ allowed: true, running: null, elsewhere: true });
    expect(JSON.stringify(view)).not.toContain(first.matterId);
    const refused = errorOf(() => pilot.startTimer(second.am));
    expect((refused as ConflictError).code).toBe("timer_open");
    // Stopped here is not running there: there is nothing to stop on this matter.
    expect((errorOf(() => pilot.stopTimer(second.am)) as ConflictError).code).toBe("no_open_timer");
  });

  it("is refused to a viewer by the service itself, and a viewer's view says so and holds nothing", () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId, am } = newMatter(w);
    w.repo.addMember(matterId, VIEWER, "viewer", { actorId: DEMO_USER_IDS.associate });
    const viewerAm = w.grant(w.principal(VIEWER), matterId);
    expect(errorOf(() => pilot.startTimer(viewerAm))).toBeInstanceOf(ForbiddenError);
    expect(errorOf(() => pilot.stopTimer(viewerAm))).toBeInstanceOf(ForbiddenError);
    expect(pilot.timer(viewerAm)).toEqual({
      allowed: false,
      running: null,
      elsewhere: false,
      closedSeconds: 0,
      sessions: 0,
    });
    // The associate times on; nothing the viewer did reached the table.
    pilot.startTimer(am);
    expect(pilot.timer(viewerAm).running).toBeNull();
  });
});

describe("the reference list", () => {
  it("is for the reviewer: an associate and a viewer are refused, and see no list", () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId, am } = newMatter(w);
    w.repo.addMember(matterId, VIEWER, "viewer", { actorId: DEMO_USER_IDS.associate });
    const viewerAm = w.grant(w.principal(VIEWER), matterId);
    const input = { rules: [], outsideHigh: 0, outsideMedium: 0, outsideLow: 1 };
    expect(pilot.referenceList(am)).toBeNull();
    expect(pilot.referenceList(viewerAm)).toBeNull();
    expect(errorOf(() => pilot.saveReferenceList(am, input))).toBeInstanceOf(ForbiddenError);
    expect(errorOf(() => pilot.saveReferenceList(viewerAm, input))).toBeInstanceOf(ForbiddenError);
    expect(w.repo.getReferenceList(matterId).issues).toEqual([]);
  });

  it("shows the rules of the pinned playbook, saves a severity for some and counts for the rest", () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId } = newMatter(w);
    const reviewerAm = w.grant(w.reviewer, matterId);
    const open = pilot.referenceList(reviewerAm);
    expect(open?.state).toBe("open");
    expect(open?.rules.length).toBeGreaterThan(3);
    expect(open?.rules.every((rule) => rule.severity === null)).toBe(true);
    expect(open?.rules.map((rule) => rule.ruleKey)).toContain("dur-1");
    expect(open?.issues).toBe(0);

    const saved = pilot.saveReferenceList(reviewerAm, {
      rules: [
        { ruleKey: "dur-1", severity: "high" },
        { ruleKey: "pds-1", severity: "medium" },
      ],
      outsideHigh: 1,
      outsideMedium: 0,
      outsideLow: 2,
    });
    expect(saved.state).toBe("open");
    expect(saved.rules.find((rule) => rule.ruleKey === "dur-1")?.severity).toBe("high");
    expect(saved.rules.find((rule) => rule.ruleKey === "pds-1")?.severity).toBe("medium");
    expect(saved.rules.filter((rule) => rule.severity !== null)).toHaveLength(2);
    expect(saved.outside).toEqual({ high: 1, medium: 0, low: 2 });
    // The count is of what the page can show: two rules and three issues no rule covers.
    expect(saved.issues).toBe(5);
    const event = w.repo.listAuditEvents({ matterId }).find((e) => e.action === "reference.save");
    expect(event?.actorId).toBe(DEMO_USER_IDS.reviewer);

    // The set replaces the list.
    const again = pilot.saveReferenceList(reviewerAm, {
      rules: [],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    expect(again.issues).toBe(0);
    expect(again.rules.every((rule) => rule.severity === null)).toBe(true);
  });

  it("refuses a rule that is not the playbook's, a severity that is not one and a count out of range", () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId } = newMatter(w);
    const reviewerAm = w.grant(w.reviewer, matterId);
    const base = { rules: [], outsideHigh: 0, outsideMedium: 0, outsideLow: 0 };
    const code = (input: Parameters<typeof pilot.saveReferenceList>[1]): string =>
      (errorOf(() => pilot.saveReferenceList(reviewerAm, input)) as ValidationError).code;
    expect(code({ ...base, rules: [{ ruleKey: "not-a-rule", severity: "high" }] })).toBe(
      "unknown_rule",
    );
    expect(
      code({
        ...base,
        rules: [
          { ruleKey: "dur-1", severity: "high" },
          { ruleKey: "dur-1", severity: "low" },
        ],
      }),
    ).toBe("duplicate_rule");
    expect(
      code({
        ...base,
        rules: [{ ruleKey: "dur-1", severity: "urgent" as unknown as "high" }],
      }),
    ).toBe("bad_severity");
    expect(code({ ...base, outsideHigh: 10 })).toBe("bad_count");
    expect(code({ ...base, outsideLow: -1 })).toBe("bad_count");
    expect(code({ ...base, outsideMedium: 1.5 })).toBe("bad_count");
    expect(w.repo.getReferenceList(matterId).issues).toEqual([]);
  });

  it("can still record issues no rule covers on a matter with no playbook, and says so", () => {
    const w = world();
    const { pilot } = w.services;
    const made = w.services.matters.create(w.associate, {
      name: "No playbook yet",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: w.reviewer.userId,
    });
    const reviewerAm = w.grant(w.reviewer, made.id);
    const view = pilot.referenceList(reviewerAm);
    expect(view).toMatchObject({ state: "no_playbook", rules: [], issues: 0 });
    const saved = pilot.saveReferenceList(reviewerAm, {
      rules: [],
      outsideHigh: 0,
      outsideMedium: 2,
      outsideLow: 0,
    });
    expect(saved).toMatchObject({
      state: "no_playbook",
      outside: { high: 0, medium: 2, low: 0 },
      issues: 2,
    });
  });

  it("closes when a review starts: the list is shown as it was left and a save is refused", async () => {
    const w = world();
    const { pilot } = w.services;
    const { matterId, am } = newMatter(w);
    const reviewerAm = w.grant(w.reviewer, matterId);
    pilot.saveReferenceList(reviewerAm, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 0,
    });
    await uploadCase(w, matterId);
    w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const locked = pilot.referenceList(reviewerAm);
    expect(locked?.state).toBe("locked");
    expect(locked?.rules.find((rule) => rule.ruleKey === "dur-1")?.severity).toBe("high");
    const refused = errorOf(() =>
      pilot.saveReferenceList(reviewerAm, {
        rules: [],
        outsideHigh: 0,
        outsideMedium: 0,
        outsideLow: 0,
      }),
    );
    expect(refused).toBeInstanceOf(ConflictError);
    expect((refused as ConflictError).code).toBe("reference_locked");
    expect(pilot.referenceList(reviewerAm)?.issues).toBe(1);
  });
});

describe("from stored events to the measures and the file", () => {
  /**
   * One matter taken the whole way, as a person would: the reference list before the review, a
   * timer for each person, the documents, a review, a decision on every finding, the memo, a
   * report of a missed issue and a rating. Its numbers are counted from what the services return,
   * not from the measures.
   */
  async function scenario() {
    const w = world();
    const { pilot } = w.services;
    // The review is made on 3 November 2026; the pilot is set to have started on 20 October, so the
    // review falls in week 3, an assisted week.
    pilot.setCalendar(w.admin, { startDate: "2026-10-20" });
    pilot.setParticipants(w.admin, { userIds: [DEMO_USER_IDS.associate, DEMO_USER_IDS.reviewer] });
    const { matterId, am } = newMatter(w, `Matter ${MARK}`);
    const reviewerAm = w.grant(w.reviewer, matterId);
    pilot.saveReferenceList(reviewerAm, {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 1,
      outsideLow: 0,
    });
    pilot.startTimer(am);
    pilot.stopTimer(am);
    pilot.startTimer(reviewerAm);
    pilot.stopTimer(reviewerAm);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, { workflowLabel: "v2" });
    await w.services.runs.idle();
    const issues = w.services.runs.issues(am, run.id);
    const decided = decideAll(w, reviewerAm, issues);
    await w.services.reviews.exportMemo(reviewerAm);
    w.services.feedback.reportMissedIssue(am, run.id, {
      ruleKey: "dur-1",
      location: `Section ${MARK}`,
      note: `A note ${MARK}`,
    });
    w.services.feedback.rate(am, { rating: 4, comment: `A comment ${MARK}` });
    return { w, matterId, am, reviewerAm, issues, decided, runId: run.id };
  }

  it("leaves the pilot scope empty, and says why, whatever was stored", async () => {
    const { w, matterId } = await scenario();
    const view = w.services.pilot.measures(w.admin, "pilot");
    expect(view.scope).toBe("pilot");
    expect(view.title).toBe("Pilot measures");
    expect(view.banner).toBeNull();
    expect(view.emptyNote).toContain("No pilot data");
    expect(view.emptyNote).toContain("This database holds 1 matter");
    const rows = view.measures.rows;
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.every((row) => row.status === "no_data" && row.reason === "all_excluded")).toBe(
      true,
    );
    const count = (code: string): number =>
      view.measures.population.find((line) => line.code === code)?.count ?? -1;
    expect(count("matters_total")).toBe(1);
    expect(count("matters_synthetic")).toBe(1);
    expect(count("matters_in_scope")).toBe(0);
    // The records are there: they are in the other scope, not lost.
    expect(w.repo.getMatter(matterId)?.synthetic).toBe(true);
  });

  it("counts the stored events in the synthetic scope, with the denominator of each", async () => {
    const { w, issues, decided } = await scenario();
    const view = w.services.pilot.measures(w.admin, "synthetic");
    expect(view.banner).toContain("SYNTHETIC SCOPE");
    expect(view.title).toBe("Pilot measures (synthetic scope)");
    const { measures } = view;
    const row = (measure: string, breakdown: string, key = "") =>
      measures.rows.find(
        (r) => r.measure === measure && r.breakdown === breakdown && r.key === key,
      );
    const count = (code: string): number =>
      measures.population.find((line) => line.code === code)?.count ?? -1;

    // One matter, reviewed in week 3 and exported.
    expect(count("matters_in_scope")).toBe(1);
    expect(count("matters_run_in_window")).toBe(1);
    expect(count("matters_exported")).toBe(1);
    expect(row("completion", "overall")).toMatchObject({ numerator: 1, denominator: 1, value: 1 });
    expect(row("completion", "phase", "assisted")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(row("completion", "phase", "baseline")?.status).toBe("no_data");

    // Findings and decisions, counted from what the services returned.
    expect(count("findings")).toBe(issues.length);
    expect(count("findings_decided")).toBe(decided.length);
    const corrections = decided.filter((f) => {
      const decision = f.reviews.find((h) => h.validity === "current")?.decision;
      return decision === "edit" || decision === "reject";
    }).length;
    expect(row("correction_rate", "overall")).toMatchObject({
      numerator: corrections,
      denominator: decided.length,
    });

    // One report for one exported matter, one rating, two people able to rate.
    expect(row("missed_issue_rate", "overall")).toMatchObject({ numerator: 1, denominator: 1 });
    expect(row("missed_issue_rate", "rule", "dur-1")).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(row("satisfaction_rating", "overall")).toMatchObject({
      status: "value",
      denominator: 1,
    });
    expect(row("satisfaction_rating", "overall")?.value).toBe(4);
    expect(row("satisfaction_response", "overall")).toMatchObject({ numerator: 1, denominator: 2 });

    // Timers: one session each, so one NDA behind each median, in the assisted phase.
    for (const series of ["associate", "reviewer", "combined"])
      expect(row("active_time", "series", `assisted:${series}`), series).toMatchObject({
        status: "value",
        denominator: 1,
      });
    expect(count("time_entries_counted")).toBe(2);
    expect(count("time_entries_open")).toBe(0);
    expect(count("participants_trained")).toBe(2);

    // The reference list was recorded before the review and is compared with it.
    expect(count("reference_issues_compared")).toBeGreaterThan(0);
    expect(row("shadow_agreement", "overall")?.denominator).toBeGreaterThan(0);

    // Every value that is given is finite, and every row that has no data says why.
    for (const r of measures.rows) {
      if (r.status === "value")
        expect(Number.isFinite(r.value), `${r.measure} ${r.key}`).toBe(true);
      else expect(r.reason, `${r.measure} ${r.key}`).not.toBeNull();
    }
  });

  it("gives the CSV of each scope as the same rows as the measures, with the scope on every one", async () => {
    const { w } = await scenario();
    const { pilot } = w.services;
    for (const scope of ["pilot", "synthetic"] as const) {
      const view = pilot.measures(w.engineer, scope);
      const file = pilot.csv(w.engineer, scope);
      const lines = file.body.split("\r\n");
      // One header, one line per measure row and per population line, and the final line ending.
      expect(lines).toHaveLength(
        1 + view.measures.rows.length + view.measures.population.length + 1,
      );
      expect(lines.at(-1)).toBe("");
      for (const line of lines.slice(1, -1)) expect(line.startsWith(`${scope},`), line).toBe(true);
      expect(file.fileName).toBe(
        scope === "synthetic"
          ? "parol-pilot-measures-SYNTHETIC-2026-11-04.csv"
          : "parol-pilot-measures-pilot-2026-11-04.csv",
      );
    }
  });

  it("holds no text from a matter, a person or a note: not in the measures, the file or the admin view", async () => {
    const { w, matterId, runId, issues } = await scenario();
    const { pilot } = w.services;
    const dump = [
      JSON.stringify(pilot.measures(w.admin, "pilot")),
      JSON.stringify(pilot.measures(w.admin, "synthetic")),
      pilot.csv(w.admin, "pilot").body,
      pilot.csv(w.admin, "synthetic").body,
    ].join("\n");
    expect(dump).not.toContain(MARK);
    expect(dump).not.toContain("Lanternfish");
    expect(dump).not.toContain("Corvane");
    // No id of a matter, a run, a finding or a person, and no person's name.
    const ids = [
      matterId,
      runId,
      ...issues.map((issue) => issue.findingId),
      DEMO_USER_IDS.associate,
      DEMO_USER_IDS.reviewer,
      DEMO_USER_IDS.admin,
    ];
    for (const id of ids) expect(dump, id).not.toContain(id);
    expect(dump).not.toContain("Alex Ruiz");
    expect(dump).not.toContain("Dana Whitfield");
    // The administration view names people, because the roster form needs them, and nothing else.
    const admin = JSON.stringify(pilot.admin(w.admin));
    expect(admin).not.toContain(MARK);
    expect(admin).not.toContain(matterId);
  });
});
