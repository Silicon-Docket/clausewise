import type { MatterAction } from "../auth/actions.js";
import { authorizeMatter } from "../auth/authorize.js";
import type { AuthorizedMatter, Principal } from "../auth/types.js";
import { registerAll } from "../boot/register.js";
import { REASON_CODES, type ReasonCode } from "../contracts.js";
import type { Services } from "../services/types.js";
import type {
  DecisionRequest,
  FindingView,
  ReferenceListInput,
  RunSummary,
} from "../services/views.js";
import { ConflictError, DEMO_USER_IDS, ValidationError, type Repository } from "../store/index.js";
import { DEMO_MATTERS, type DemoDocument } from "./matters.js";

/**
 * The demonstration scenario of the pilot measures: `pnpm parol:seed --pilot-demo` (package W2.6b).
 *
 * What it is. A backdated run of the pilot of docs/parol/08, made THROUGH THE SERVICES by the demo
 * identities on synthetic matters, so that every measure of the pilot page has something to count
 * in the synthetic scope. The calendar is set to a start date 29 days before the day it is run (the
 * last day of the scenario is the day before it, so no stored time is later than the run), the
 * clock steps through the weeks, and each step is a call a person would have made on a screen:
 * set the calendar, record who was trained, make a matter, write the reference list, start a timer,
 * upload the worked example's documents, start a review, decide each finding, export the memo,
 * report a missed issue, rate the matter. The reader is the scripted simulation.
 *
 * What it is not. It is not a result, and nothing in it is described as one. No number that a
 * measure shows is typed here: the figures come from the rows these calls leave behind, computed by
 * the page's own code at the time someone opens the page. The only numbers in this file are the
 * scenario's inputs (which day a step happens on, how long a sitting is shown to last, what a
 * rating is, which reason code a rejection carries). They are chosen to exercise every row and are
 * not measurements of anyone. The page computes no difference between phases, so no trend between
 * them is intended and none is in the inputs. The pilot scope stays empty on a database made this
 * way, because every person here is a demonstration identity and every matter is synthetic.
 *
 * The matters are made with the retention of any other matter. The first of them reaches its
 * retention date a day or two after the run, and the pilot page counts the matters that will go
 * before the end of the pilot; that is the page working as designed and not a fault of the seed.
 *
 * It refuses a database that has a pilot calendar and none of its matters, and one that holds only
 * some of its matters, because neither can be finished without guessing. It is idempotent by matter
 * name and owner, as the other seed steps are: a second call finds all of its matters and adds
 * nothing. Use a fresh data folder: the audit log is in the order the rows were written and not in
 * the order of their (backdated) times.
 */

/** The scenario cannot go on. The message is for the person running the seed and names no input. */
export class PilotDemoError extends Error {
  override name = "PilotDemoError";
}

/** The words the seed prints, and the test pins. They say what the data is and is not. */
export const PILOT_DEMO_NOTICE =
  "Demonstration data. Every figure on the pilot page's synthetic scope comes from a scripted reader and demonstration identities. It is not a pilot result.";

// ---------------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------------

/**
 * A clock the scenario moves. `now()` returns the current instant and then moves on by one step,
 * so that no two readings are equal and the rows a call writes follow each other; `set` jumps to an
 * instant. Hand `clock.now` to `createRepository` and `createServices` so that the repository, the
 * services and the audit log all follow the scenario.
 */
export interface SteppingClock {
  now(): Date;
  set(at: Date): void;
}

export function createSteppingClock(start: Date, stepMs = 1000): SteppingClock {
  let at = start.getTime();
  return {
    now: () => {
      const reading = new Date(at);
      at += stepMs;
      return reading;
    },
    set: (to) => {
      at = to.getTime();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The script. Inputs of the scenario, not results.
// ---------------------------------------------------------------------------------------------

/** The days run from the start date (day 0). Week n is days 7(n-1) to 7n-1. */
const DAYS_BACK = 29;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * How long each sitting is shown to last, in minutes, taken in the order the sittings happen. One
 * list for every phase, so that no phase is given shorter or longer sittings than another.
 */
const SITTING_MINUTES: readonly number[] = [38, 45, 41, 36, 44, 39, 42, 37];
/** What the people who rate give, taken in the order they rate. */
const RATINGS: readonly number[] = [4, 3, 5, 4, 2];

type Who = "associate" | "reviewer";

interface BaselineScript {
  name: string;
  /** The day the matter is made, timed and given its reference list: week 1. */
  madeOn: number;
  /** The day the documents go in and the review is started: week 2. */
  reviewedOn: number;
  workflow: "v1" | "v2";
  /** What the reviewing attorney found by hand, written before any review. */
  reference: ReferenceListInput;
}

interface AssistedScript {
  name: string;
  /** The day the matter is made, reviewed and decided: weeks 3 to 5. */
  day: number;
  exported: boolean;
  /** Who rates the matter after the memo, in order. */
  ratedBy: readonly Who[];
  /** The missed-issue reports, in order; a null rule says no rule of the playbook covers it. */
  reports: readonly { by: Who; ruleKey: string | null }[];
}

const BASELINE: readonly BaselineScript[] = [
  {
    name: "Demonstration baseline 1",
    madeOn: 1,
    reviewedOn: 8,
    workflow: "v2",
    reference: {
      rules: [
        { ruleKey: "dur-1", severity: "high" },
        { ruleKey: "pds-1", severity: "medium" },
      ],
      outsideHigh: 0,
      outsideMedium: 0,
      outsideLow: 1,
    },
  },
  {
    name: "Demonstration baseline 2",
    madeOn: 2,
    reviewedOn: 9,
    workflow: "v1",
    reference: {
      rules: [{ ruleKey: "dur-1", severity: "high" }],
      outsideHigh: 0,
      outsideMedium: 1,
      outsideLow: 0,
    },
  },
];

const ASSISTED: readonly AssistedScript[] = [
  {
    name: "Demonstration assisted 1",
    day: 15,
    exported: true,
    ratedBy: ["associate", "reviewer"],
    reports: [{ by: "associate", ruleKey: "pds-1" }],
  },
  {
    name: "Demonstration assisted 2",
    day: 22,
    exported: true,
    ratedBy: ["associate", "reviewer"],
    reports: [{ by: "reviewer", ruleKey: null }],
  },
  {
    name: "Demonstration assisted 3",
    day: 24,
    exported: true,
    ratedBy: ["associate"],
    reports: [],
  },
  {
    // Decided and not exported: its report is counted as outside the exported matters, and it is
    // not rated, because a matter is rated once it has a memo.
    name: "Demonstration assisted 4",
    day: 28,
    exported: false,
    ratedBy: [],
    reports: [{ by: "associate", ruleKey: "dur-1" }],
  },
];

/** What the reviewing attorney does with the findings of an assisted matter, round and round. */
const DECISION_PLAN = [
  "accept",
  "minor_edit",
  "accept",
  "reject",
  "accept",
  "escalate",
  "edit",
  "accept",
] as const;
type Choice = (typeof DECISION_PLAN)[number];

const DECISION_REASON = "Scripted demonstration decision.";
const EDITED_TEXT = "Scripted demonstration edit.";
const REPORT_NOTE = "Scripted demonstration report, not a finding about any document.";

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export interface PilotDemoMatter {
  name: string;
  matterId: string;
  kind: "baseline" | "assisted";
}

/** What was done through the services, counted as it was done. All zero when the scenario was already there. */
export interface PilotDemoDone {
  matters: number;
  sittings: number;
  referenceLists: number;
  reviews: number;
  decisions: number;
  memos: number;
  reports: number;
  ratings: number;
}

export interface PilotDemoReport {
  /** False when the scenario was already there and nothing was added. */
  created: boolean;
  /** The first day of the pilot calendar, `YYYY-MM-DD`, in UTC. */
  startDate: string | null;
  matters: PilotDemoMatter[];
  done: PilotDemoDone;
  /** Who can open the pilot page: the demo identities whose global role may. */
  readers: string[];
}

/**
 * A document of the worked example with its bytes. The seed reads the dataset files and hands them
 * over (this folder stays away from the file system, `test/demo/readme.test.ts`), so the scenario
 * uploads exactly what `pnpm parol:seed` uploads to its first matter.
 */
export interface PilotDemoDocument {
  document: DemoDocument;
  bytes: Uint8Array;
}

export interface PilotDemoOptions {
  repo: Repository;
  /** Services made with `now: clock.now`, over a repository made with the same. */
  services: Services;
  clock: SteppingClock;
  /** The worked example's documents, uploaded to every matter of the scenario. */
  documents: readonly PilotDemoDocument[];
  /** The instant the days run back from. Default: the clock's reading when the scenario starts. */
  anchor?: Date;
}

function principalOf(repo: Repository, userId: string): Principal {
  const user = repo.getUser(userId);
  // registerAll seeds the demo users first, so this is a store that was changed under the seed.
  if (user === undefined) throw new PilotDemoError("a demo user is missing from the data folder");
  return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
}

/** Makes the scenario's stored rows. See the top of the file for what it is and is not. */
export async function seedPilotDemo(options: PilotDemoOptions): Promise<PilotDemoReport> {
  const { repo, services, clock, documents } = options;
  if (documents.length === 0)
    throw new PilotDemoError("the scenario has no documents to upload, so no review could run");
  const registered = registerAll(repo, { seedDemoUsers: true });
  const alex = principalOf(repo, DEMO_USER_IDS.associate);
  const dana = principalOf(repo, DEMO_USER_IDS.reviewer);
  const sam = principalOf(repo, DEMO_USER_IDS.admin);
  const readers = [DEMO_USER_IDS.legalEngineer, DEMO_USER_IDS.admin].map(
    (userId) => principalOf(repo, userId).displayName,
  );

  const worked = DEMO_MATTERS.find((m) => m.key === "lanternfish");
  if (worked === undefined) throw new PilotDemoError("the worked example is not in the seed");

  // Which matters of the scenario are there already. A matter is the scenario's own when it has
  // its name and its owner is the associate.
  const scripted: { name: string; kind: PilotDemoMatter["kind"] }[] = [
    ...BASELINE.map((s) => ({ name: s.name, kind: "baseline" as const })),
    ...ASSISTED.map((s) => ({ name: s.name, kind: "assisted" as const })),
  ];
  const owned = services.matters.list(alex).filter((matter) => matter.role === "associate");
  const found: PilotDemoMatter[] = [];
  for (const script of scripted) {
    const matter = owned.find((m) => m.name === script.name);
    if (matter !== undefined)
      found.push({ name: script.name, matterId: matter.id, kind: script.kind });
  }
  const calendar = repo.getPilotAdmin().calendar;
  const none: PilotDemoDone = {
    matters: 0,
    sittings: 0,
    referenceLists: 0,
    reviews: 0,
    decisions: 0,
    memos: 0,
    reports: 0,
    ratings: 0,
  };
  if (found.length === scripted.length)
    return {
      created: false,
      startDate: calendar?.startDate ?? null,
      matters: found,
      done: none,
      readers,
    };
  if (found.length > 0)
    throw new PilotDemoError(
      "an earlier pilot demonstration stopped half way, and the rest cannot be added without guessing. Use a fresh data folder",
    );
  if (calendar !== null)
    throw new PilotDemoError(
      "a pilot calendar is already set, and the demonstration never replaces one. Use a fresh data folder",
    );

  // ---- the days -----------------------------------------------------------------------------
  const anchor = options.anchor ?? clock.now();
  const startMs =
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) -
    DAYS_BACK * DAY_MS;
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const dayAt = (day: number, hour: number): Date =>
    new Date(startMs + day * DAY_MS + hour * HOUR_MS);
  /** Moves the clock forward to an instant. It never moves it back: a step that ran long carries on. */
  const reach = (at: Date): void => {
    if (clock.now().getTime() < at.getTime()) clock.set(at);
  };

  const done = { ...none };
  const made: PilotDemoMatter[] = [];
  let sittings = 0;
  let ratings = 0;
  const nextSitting = (): number => SITTING_MINUTES[sittings++ % SITTING_MINUTES.length]!;
  const nextRating = (): number => RATINGS[ratings++ % RATINGS.length]!;

  const open = (principal: Principal, matterId: string, action: MatterAction): AuthorizedMatter =>
    authorizeMatter(repo, principal, matterId, action);

  /**
   * A sitting: the person presses Start, does `work`, and presses Stop when the sitting's scripted
   * length has passed. The length is the scenario's input; the times written are the clock's.
   */
  async function sit<T>(am: AuthorizedMatter, work: () => Promise<T> | T): Promise<T> {
    try {
      services.pilot.startTimer(am);
    } catch (error) {
      if (error instanceof ConflictError && error.code === "timer_open")
        throw new PilotDemoError(
          "a person of the demonstration already has a timer running. Stop it, or use a fresh data folder",
        );
      throw error;
    }
    const since = services.pilot.timer(am).running?.since;
    if (since === undefined)
      throw new PilotDemoError("a timer that was just started is not running");
    const result = await work();
    reach(new Date(Date.parse(since) + nextSitting() * MINUTE_MS));
    services.pilot.stopTimer(am);
    done.sittings += 1;
    return result;
  }

  const makeMatter = (name: string): string => {
    const summary = services.matters.create(alex, {
      name,
      clientLegalName: worked.clientLegalName,
      playbookVersionId: registered.playbook.id,
      reviewerUserId: dana.userId,
    });
    done.matters += 1;
    return summary.id;
  };

  const upload = async (matterId: string): Promise<void> => {
    const am = open(alex, matterId, "document.write");
    for (const { document, bytes } of documents)
      await services.matters.addDocument(am, {
        title: document.title,
        kind: document.kind,
        fileName: document.fileName,
        bytes,
        statedDate: document.statedDate,
      });
  };

  const review = async (matterId: string, workflowLabel: string): Promise<RunSummary> => {
    const am = open(alex, matterId, "run.start");
    const started = services.runs.start(am, { workflowLabel });
    await services.runs.idle();
    const run = services.runs.get(am, started.id);
    if (run.status !== "succeeded")
      throw new PilotDemoError(
        `a review of the demonstration did not finish (${run.status}${run.errorKind === null ? "" : `, ${run.errorKind}`})`,
      );
    done.reviews += 1;
    return run;
  };

  /** The attorney's decision on a finding, for a choice of the plan. */
  const requestFor = (choice: Choice, view: FindingView, code: ReasonCode): DecisionRequest => {
    const base = { findingContentSha256: view.contentSha256 };
    switch (choice) {
      case "accept":
        return { ...base, decision: "accept", edits: null, reason: null };
      case "minor_edit":
        // A change of wording, which the attorney marks as minor.
        return {
          ...base,
          decision: "edit",
          edits: { discrepancy: EDITED_TEXT },
          reason: DECISION_REASON,
          reasonCode: "unclear",
          minorEdit: true,
        };
      case "edit":
        // A change of status, which can never be minor.
        return {
          ...base,
          decision: "edit",
          edits: { status: view.issue.status === "compliant" ? "deviation" : "compliant" },
          reason: DECISION_REASON,
          reasonCode: "wrong_status",
        };
      case "reject":
        return {
          ...base,
          decision: "reject",
          edits: null,
          reason: DECISION_REASON,
          reasonCode: code,
        };
      case "escalate":
        return { ...base, decision: "escalate", edits: null, reason: DECISION_REASON };
    }
  };

  const decideAll = (matterId: string, runId: string, round: number): void => {
    const am = open(dana, matterId, "review.decide");
    const issues = services.runs.issues(am, runId);
    issues.forEach((issue, position) => {
      const view = services.runs.finding(am, issue.findingId);
      const choice = DECISION_PLAN[(position + round) % DECISION_PLAN.length]!;
      const code = REASON_CODES[(position + round) % REASON_CODES.length]!;
      services.reviews.decide(am, issue.findingId, requestFor(choice, view, code));
      done.decisions += 1;
    });
  };

  // ---- week 1: the calendar, who was trained, the manual baseline ---------------------------
  // The first step goes back in time, which `reach` never does.
  clock.set(dayAt(0, 9));
  services.pilot.setCalendar(sam, { startDate });
  services.pilot.setParticipants(sam, { userIds: [alex.userId, dana.userId] });

  const baselineIds = new Map<string, string>();
  for (const script of BASELINE) {
    reach(dayAt(script.madeOn, 9));
    const matterId = makeMatter(script.name);
    baselineIds.set(script.name, matterId);
    made.push({ name: script.name, matterId, kind: "baseline" });
    await sit(open(alex, matterId, "time.record"), () => undefined);
    reach(dayAt(script.madeOn, 14));
    // The attorney writes down what the manual review found, before any review has run.
    await sit(open(dana, matterId, "time.record"), () => {
      try {
        services.pilot.saveReferenceList(open(dana, matterId, "reference.write"), script.reference);
      } catch (error) {
        if (error instanceof ValidationError && error.code === "unknown_rule")
          throw new PilotDemoError("the demonstration playbook lacks a rule the script names");
        throw error;
      }
      done.referenceLists += 1;
    });
  }

  // ---- week 2: the same matters, now read by the scripted reader ----------------------------
  for (const script of BASELINE) {
    const matterId = baselineIds.get(script.name)!;
    reach(dayAt(script.reviewedOn, 9));
    await sit(open(alex, matterId, "time.record"), async () => {
      await upload(matterId);
      await review(matterId, script.workflow);
    });
    // The attorney reads the review next to the list written in week 1.
    reach(dayAt(script.reviewedOn, 14));
    await sit(open(dana, matterId, "time.record"), () => undefined);
  }

  // ---- weeks 3 to 5: assisted use ------------------------------------------------------------
  for (const [round, script] of ASSISTED.entries()) {
    reach(dayAt(script.day, 9));
    const matterId = makeMatter(script.name);
    made.push({ name: script.name, matterId, kind: "assisted" });
    const run = await sit(open(alex, matterId, "time.record"), async () => {
      await upload(matterId);
      return review(matterId, "v2");
    });
    reach(dayAt(script.day, 14));
    await sit(open(dana, matterId, "time.record"), async () => {
      decideAll(matterId, run.id, round);
      if (script.exported) {
        await services.reviews.exportMemo(open(dana, matterId, "memo.export"));
        done.memos += 1;
      }
    });

    // What the people say about it afterwards, through the feedback service.
    reach(dayAt(script.day, 16));
    for (const report of script.reports) {
      const who = report.by === "associate" ? alex : dana;
      services.feedback.reportMissedIssue(open(who, matterId, "feedback.add"), run.id, {
        ruleKey: report.ruleKey,
        location: null,
        note: REPORT_NOTE,
      });
      done.reports += 1;
    }
    for (const by of script.ratedBy) {
      const who = by === "associate" ? alex : dana;
      services.feedback.rate(open(who, matterId, "feedback.add"), {
        rating: nextRating(),
        comment: null,
      });
      done.ratings += 1;
    }
  }

  return { created: true, startDate, matters: made, done, readers };
}
