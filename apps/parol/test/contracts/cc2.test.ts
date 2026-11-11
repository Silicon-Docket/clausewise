import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsx } from "hono/jsx";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import type { AuthorizedMatter, Principal } from "../../src/auth/types.js";
import {
  GLOBAL_ROLES,
  REASON_CODES,
  type GlobalRole,
  type ReasonCode,
} from "../../src/contracts.js";
import { createSimulatedModel } from "../../src/demo/simulated-model.js";
import { FindingPane, FIELDS, Layout, RunPage, render } from "../../src/server/pages/index.js";
import { MINOR_EDIT_VALUE, NOT_COVERED_VALUE } from "../../src/server/pages/forms.js";
import { ContextHelp, WordsHelp } from "../../src/server/pages/help.js";
import { NAV_ITEMS } from "../../src/server/pages/layout.js";
import { TrainingBanner, TrainingSection } from "../../src/server/pages/training.js";
import { urls } from "../../src/server/urls.js";
import type { ServiceDeps } from "../../src/services/deps.js";
import { createServices } from "../../src/services/index.js";
import type { FeedbackService } from "../../src/services/feedback.js";
import type { MatterService, Services } from "../../src/services/types.js";
import type {
  DecisionRequest,
  FindingView,
  IssueRow,
  MatterFeedbackView,
  MatterSummary,
  MatterView,
  MissedIssueView,
  NoteView,
  RatingView,
  ReviewHistoryItem,
  RuleChoice,
  TrainingProgressView,
  TrainingStepProgress,
} from "../../src/services/views.js";
import {
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  loadMigrationFiles,
  openDatabase,
  runMigrations,
} from "../../src/store/index.js";
import type { MatterRow, TrainingKey } from "../../src/store/types.js";
import { all, first, parseHtml, readable } from "../pages/html.js";
import { allowedActions } from "../pages/invariants.js";
import {
  IDS,
  buildChrome,
  buildFindingView,
  buildIssueRows,
  buildMatterSummary,
  buildRunSummary,
} from "../pages/support.js";
import { stubServices } from "../server/support-app.js";

/**
 * The contract commit before phase 2 (CC2). It adds no behaviour: shared types, constants,
 * registrations and slots, so that two packages (W2.6a feedback capture; W2.8 training matter,
 * quickstart page and in-app help) can work on disjoint files. These tests prove the seams are in
 * place, that every stub says whose it is, and that the tree builds with the stubs in it.
 *
 * The stub rows are written so that the package that fills a stub does not have to edit this file.
 * A stub is a function that throws "stub: <package id>" (or a component that renders nothing), and
 * the line of the stub carries the comment marker with that package id. While the marker is on the
 * stub the function must behave as a stub; once the owner has taken the marker off (and written the
 * function) it must not throw the stub error. The marker is looked for on the stub itself, not in
 * the file, so a package may fill some methods of a file and leave others (a cut slice) as stubs.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf8");
/** The comment marker of a stub. Built here so that a scan for the marker finds stubs and not this file. */
const marker = (id: string): string => `${"STUB"}(${id})`;

type PackageId = "W2.6a" | "W2.8";

const scratch: string[] = [];
const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Whether `name` is still a stub in `file` (relative to `src`): a line that declares it, or one of
 * the next two, carries the package's marker. A doc comment or an interface that mentions the name
 * is not followed by a marker, so it never counts. A name that is nowhere declared with a marker
 * has been filled in, moved or renamed by its owner, which is the owner's right.
 */
function stillStub(file: string, id: PackageId, name: string): boolean {
  const lines = read(file).split("\n");
  const declares = new RegExp(`(^|[\\s.])${name}\\s*\\(`);
  return lines.some((line, at) => {
    const text = line.trimStart();
    if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) return false;
    return declares.test(line) && lines.slice(at, at + 3).some((l) => l.includes(marker(id)));
  });
}

// ---------------------------------------------------------------------------------------------
// A small world: a repository, a file store, a model that calls nothing
// ---------------------------------------------------------------------------------------------

function makeDeps(extra: Partial<ServiceDeps> = {}): ServiceDeps {
  const repo = createRepository(openDatabase(":memory:"));
  repo.seedDemoUsers();
  return {
    repo,
    files: new FileStore(join(scratchDir("parol-cc2-"), "files")),
    generator: createSimulatedModel(),
    config: { relaxedSegregation: false },
    now: () => new Date("2026-11-04T09:00:00.000Z"),
    log: () => {},
    ...extra,
  };
}

const admin: Principal = {
  userId: DEMO_USER_IDS.admin,
  displayName: "Test admin",
  globalRole: "admin",
};

/** The authorization layer makes the real one; a stub never looks at it. */
const matterAccess = {
  matterId: "mat_cc2",
  principal: admin,
  role: "associate",
} as unknown as AuthorizedMatter;

const ordinaryMatter: Parameters<MatterService["create"]>[1] = {
  name: "Lanternfish / Corvane NDA",
  clientLegalName: "Corvane Holdings Ltd",
  playbookVersionId: null,
  reviewerUserId: null,
};

// ---------------------------------------------------------------------------------------------
// createServices
// ---------------------------------------------------------------------------------------------

describe("createServices", () => {
  it("builds with a feedback service whose six functions exist, and calls none of them while building", () => {
    const services = createServices(makeDeps());
    expect(Object.keys(services)).toEqual(
      expect.arrayContaining(["matters", "runs", "reviews", "evaluations", "audit", "feedback"]),
    );
    for (const name of [
      "reportMissedIssue",
      "addNote",
      "rate",
      "list",
      "ruleChoices",
      "myRating",
    ] as const)
      expect(typeof services.feedback[name], name).toBe("function");
    // Each service type is a member of `Services` as the interface of its module.
    const feedback: FeedbackService = services.feedback;
    expect(feedback).toBe(services.feedback);
  });

  it("accepts the training key when a matter is created, as the quickstart will send it", () => {
    const services = createServices(makeDeps());
    const input: Parameters<MatterService["create"]>[1] = { ...ordinaryMatter, training: "T01" };
    // W2.8 reads the key. Until it does the matter is made as an ordinary one and says so.
    const created = services.matters.create(admin, input);
    expect(created.name).toBe("Lanternfish / Corvane NDA");
  });

  it("gives an ordinary matter a summary whose training is null, in the create result and in the list", () => {
    const services = createServices(makeDeps());
    const created = services.matters.create(admin, ordinaryMatter);
    expect(created.training).toBeNull();
    const listed = services.matters.list(admin);
    expect(listed.length).toBeGreaterThan(0);
    for (const entry of listed) expect(entry.training ?? null).toBeNull();
  });

  it("gives the test stand-in a feedback group that refuses a call, like the other groups", () => {
    const stub = stubServices();
    expect(() => stub.feedback.list(matterAccess)).toThrow("a stub service was called");
    expect(Object.keys(stub)).toEqual(expect.arrayContaining(["feedback"]));
  });
});

// ---------------------------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------------------------

interface StubRow {
  id: PackageId;
  /** The file under `src` that holds the stub and its marker. */
  file: string;
  /** The name that is declared with the marker. */
  name: string;
  what: string;
  call(deps: ServiceDeps, services: ReturnType<typeof createServices>): unknown;
}

const feedbackRow = (name: keyof FeedbackService, call: StubRow["call"]): StubRow => ({
  id: "W2.6a",
  file: "services/feedback.ts",
  name,
  what: `FeedbackService.${name}`,
  call,
});

const STUB_ROWS: StubRow[] = [
  feedbackRow("reportMissedIssue", (_deps, services) =>
    services.feedback.reportMissedIssue(matterAccess, "run_x", {
      ruleKey: null,
      location: null,
      note: "A note.",
    }),
  ),
  feedbackRow("addNote", (_deps, services) =>
    services.feedback.addNote(matterAccess, "fnd_x", { note: "A note." }),
  ),
  feedbackRow("rate", (_deps, services) =>
    services.feedback.rate(matterAccess, { rating: 4, comment: null }),
  ),
  feedbackRow("list", (_deps, services) => services.feedback.list(matterAccess)),
  feedbackRow("ruleChoices", (_deps, services) =>
    services.feedback.ruleChoices(matterAccess, "run_x"),
  ),
  feedbackRow("myRating", (_deps, services) => services.feedback.myRating(matterAccess)),
];

/** The message of what `run` throws, or null when it returns. */
function thrownMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : `not an Error: ${String(error)}`;
  }
}

describe("the stubs", () => {
  let deps: ServiceDeps;
  let services: ReturnType<typeof createServices>;
  beforeAll(() => {
    deps = makeDeps();
    services = createServices(deps);
  });

  for (const row of STUB_ROWS) {
    it(`${row.what} throws "stub: ${row.id}" while its stub carries the marker, and not after`, () => {
      const marked = stillStub(row.file, row.id, row.name);
      const message = thrownMessage(() => row.call(deps, services));
      if (marked) {
        expect(message).toBe(`stub: ${row.id}`);
        expect(message?.startsWith("stub: ")).toBe(true);
      } else {
        // The owner has filled it in and taken the marker out: it may do anything but still be a stub.
        expect(message?.startsWith("stub: ") ?? false).toBe(false);
      }
    });
  }

  it("covers every method of FeedbackService, so a method added to the interface needs a row", () => {
    const rows = STUB_ROWS.filter((row) => row.file === "services/feedback.ts").map(
      (row) => row.name,
    );
    expect(new Set(rows)).toEqual(new Set(Object.keys(services.feedback)));
  });

  it("puts the marker on the line of every stub throw, naming the same package as the message", () => {
    for (const file of new Set(STUB_ROWS.map((row) => row.file))) {
      const text = read(file);
      const throws = text.split("\n").filter((line) => line.includes('throw new Error("stub:'));
      // A file whose owner has filled in every stub has neither a marker nor a stub throw left.
      const stillOne = STUB_ROWS.some(
        (row) => row.file === file && stillStub(row.file, row.id, row.name),
      );
      if (!stillOne) {
        expect(throws, file).toEqual([]);
        continue;
      }
      expect(throws.length, file).toBeGreaterThan(0);
      for (const line of throws) {
        const named = /throw new Error\("stub: ([^"]+)"\)/.exec(line)?.[1];
        const marked = /STUB\(([^)]+)\)/.exec(line)?.[1];
        expect(named, line).toBeDefined();
        expect(marked, line).toBe(named);
      }
    }
  });

  it("returns an object from the factory and throws only when a method is called", () => {
    expect(() => createServices(makeDeps())).not.toThrow();
    const again = createServices(makeDeps());
    expect(again.feedback).toBeTypeOf("object");
  });

  it("leaves a marker only in the files this commit named, so the stub scan has nothing unlisted", () => {
    const named = new Set([
      "services/feedback.ts",
      "server/pages/help.tsx",
      "server/pages/training.tsx",
      "store/repo-matters.ts",
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const found = walk(SRC)
      .filter((file) =>
        (["W2.6a", "W2.8"] as const).some((id) => readFileSync(file, "utf8").includes(marker(id))),
      )
      .map((file) => file.slice(SRC.length));
    expect(found.filter((file) => !named.has(file))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The training key on a matter
// ---------------------------------------------------------------------------------------------

describe("MatterRow.trainingKey", () => {
  it("is null on an ordinary matter, whether it was just made or read back", () => {
    const repo = createRepository(openDatabase(":memory:"));
    repo.seedDemoUsers();
    const made = repo.createMatter({
      name: "Lanternfish / Corvane NDA",
      clientLegalName: "Corvane Holdings Ltd",
      createdBy: DEMO_USER_IDS.admin,
    });
    expect(made.trainingKey).toBeNull();
    expect(repo.getMatter(made.id)?.trainingKey).toBeNull();
    for (const entry of repo.listMattersForUser(DEMO_USER_IDS.admin))
      expect(entry.trainingKey).toBeNull();
  });

  it("is a key of its own type, with the one value T01, and reads null while its marker is on the line", () => {
    const key: TrainingKey = "T01";
    const row: Pick<MatterRow, "trainingKey"> = { trainingKey: key };
    const none: Pick<MatterRow, "trainingKey"> = { trainingKey: null };
    expect([row.trainingKey, none.trainingKey]).toEqual(["T01", null]);
    // The stub is a value, not a throw: it must stay inert for every ordinary matter.
    const stub = read("store/repo-matters.ts")
      .split("\n")
      .find((line) => line.includes("trainingKey") && line.includes(marker("W2.8")));
    if (stub !== undefined) expect(stub).toContain("trainingKey: null");
  });
});

// ---------------------------------------------------------------------------------------------
// The components that render nothing
// ---------------------------------------------------------------------------------------------

describe("the help and training components", () => {
  const rows: IssueRow[] = buildIssueRows();
  const finding: FindingView = buildFindingView();
  const progress: TrainingProgressView = {
    key: "T01",
    steps: [{ n: 1, title: "Documents are in place", state: "seeded", note: "Set up for you." }],
    checkable: 5,
    checkableDone: 0,
  };

  const COMPONENTS: {
    id: PackageId;
    file: string;
    name: string;
    html: () => string;
  }[] = [
    {
      id: "W2.8",
      file: "server/pages/help.tsx",
      name: "WordsHelp",
      html: () => render(jsx(WordsHelp, { rows })),
    },
    {
      id: "W2.8",
      file: "server/pages/help.tsx",
      name: "ContextHelp",
      html: () => render(jsx(ContextHelp, { finding })),
    },
    {
      id: "W2.8",
      file: "server/pages/training.tsx",
      name: "TrainingBanner",
      html: () =>
        render(jsx(TrainingBanner, { compact: true, training: "T01", provider: "scripted" })),
    },
    {
      id: "W2.8",
      file: "server/pages/training.tsx",
      name: "TrainingSection",
      html: () => render(jsx(TrainingSection, { progress })),
    },
  ];

  for (const component of COMPONENTS)
    it(`${component.name} renders nothing while its stub carries the marker`, () => {
      const html = component.html();
      expect(typeof html).toBe("string");
      if (stillStub(component.file, component.id, component.name)) expect(html).toBe("");
    });

  it("lets the banner be called for any matter: with no training key, and with none of its other props", () => {
    expect(render(jsx(TrainingBanner, {}))).toBeTypeOf("string");
    expect(render(jsx(TrainingBanner, { training: null }))).toBeTypeOf("string");
    expect(render(jsx(TrainingSection, {}))).toBeTypeOf("string");
    expect(render(jsx(TrainingSection, { progress: null }))).toBeTypeOf("string");
    if (stillStub("server/pages/training.tsx", "W2.8", "TrainingBanner"))
      expect(render(jsx(TrainingBanner, { training: null }))).toBe("");
  });

  it("leaves the run page as it was while the training banner and the words help are stubs", () => {
    const stubbed =
      stillStub("server/pages/training.tsx", "W2.8", "TrainingBanner") &&
      stillStub("server/pages/help.tsx", "W2.8", "WordsHelp");
    const page = (training: string | null | undefined): string =>
      render(
        RunPage({
          chrome: buildChrome(),
          matter: buildMatterSummary(training === undefined ? {} : { training }),
          run: buildRunSummary(),
          issues: buildIssueRows(),
          selected: buildFindingView(),
        }),
      );
    if (stubbed) {
      // The key changes nothing on the page, and the page still holds its keyboard list.
      expect(page("T01")).toBe(page(null));
      expect(page(undefined)).toBe(page(null));
      expect(page(null)).toContain('id="keys-help"');
      expect(page(null)).not.toContain('id="words-help"');
      expect(page(null)).not.toContain("banner-training");
    }
    expect(page(null)).toContain('id="keys-help"');
  });

  it("leaves the finding pane as it was while the context help is a stub", () => {
    const pane = render(
      FindingPane({ chrome: buildChrome(), matterId: IDS.matter, finding: buildFindingView() }),
    );
    expect(pane).toContain("data-finding=");
    if (stillStub("server/pages/help.tsx", "W2.8", "ContextHelp"))
      expect(pane).not.toContain("context-help");
  });
});

describe("the slots in the host pages", () => {
  const run = read("server/pages/run.tsx");
  const finding = read("server/pages/finding.tsx");

  it("puts the words help in the run page after the keyboard list, handed the run's issue rows", () => {
    const keys = run.indexOf("<KeysHelp />");
    const words = run.indexOf("<WordsHelp");
    expect(keys).toBeGreaterThan(0);
    expect(words).toBeGreaterThan(keys);
    expect(run.slice(words, run.indexOf("/>", words))).toContain("rows={issues}");
  });

  it("puts the compact training banner in the run page's header region, before the other banners", () => {
    const header = run.indexOf("</header>");
    const banner = run.indexOf("<TrainingBanner");
    const standIn = run.indexOf('class="banner banner-standin"');
    expect(header).toBeGreaterThan(0);
    expect(banner).toBeGreaterThan(header);
    expect(banner).toBeLessThan(standIn);
    const call = run.slice(banner, run.indexOf("/>", banner));
    expect(call).toContain("compact");
    // It is given the matter's key and the run's provider, and no id or text.
    expect(call).toContain("training={matter.training}");
    expect(call).toContain("provider={run.model.provider}");
  });

  it("puts the context help in the finding pane before the evidence section, handed the finding", () => {
    const help = finding.indexOf("<ContextHelp");
    const evidence = finding.indexOf("<EvidenceSection finding={finding}");
    expect(help).toBeGreaterThan(0);
    expect(evidence).toBeGreaterThan(help);
    expect(finding.slice(help, finding.indexOf("/>", help))).toContain("finding={finding}");
  });
});

// ---------------------------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------------------------

describe("REASON_CODES", () => {
  it("are the six codes of the design, in the order the form lists them", () => {
    expect([...REASON_CODES]).toEqual([
      "wrong_status",
      "wrong_evidence",
      "missed_context",
      "bad_fallback",
      "unclear",
      "other",
    ]);
  });

  it("have no repeat, and each is lower-case words joined by underscores", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
    for (const code of REASON_CODES) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it("make the ReasonCode type, so a table over it must name every code", () => {
    const covered: Record<ReasonCode, true> = {
      wrong_status: true,
      wrong_evidence: true,
      missed_context: true,
      bad_fallback: true,
      unclear: true,
      other: true,
    };
    expect(Object.keys(covered)).toEqual([...REASON_CODES]);
  });
});

// ---------------------------------------------------------------------------------------------
// The view types
// ---------------------------------------------------------------------------------------------

describe("the view types", () => {
  it("let a page fixture built before the new fields still compile, and carry them when given", () => {
    const row = buildIssueRows()[0] as IssueRow;
    const withCount: IssueRow = { ...row, noteCount: 2 };
    expect(withCount.noteCount).toBe(2);
    expect(row.noteCount).toBeUndefined();

    const history: ReviewHistoryItem = {
      decision: "edit",
      reviewerName: "D. Okafor",
      at: "2026-11-04T09:30:00.000Z",
      reason: "The status is wrong.",
      validity: "current",
      reasonCode: "wrong_status",
      minorEdit: false,
      edits: null,
    };
    expect([history.reasonCode, history.minorEdit]).toEqual(["wrong_status", false]);

    const request: DecisionRequest = {
      decision: "reject",
      findingContentSha256: "0".repeat(64),
      edits: null,
      reason: "The passage does not say this.",
      reasonCode: "wrong_evidence",
      minorEdit: null,
    };
    expect(request.reasonCode).toBe("wrong_evidence");
  });

  it("describe a finding with notes and the right to add one", () => {
    const note: NoteView = {
      feedbackId: "fb_1",
      findingId: IDS.run,
      note: "I disagree.",
      authorName: "A. Ruiz",
      at: "2026-11-04T09:31:00.000Z",
    };
    const finding: FindingView = {
      ...buildFindingView(),
      notes: [note],
      canAddNote: { allowed: true, reason: null },
    };
    expect(finding.notes?.map((n) => n.note)).toEqual(["I disagree."]);
    expect(finding.canAddNote).toEqual({ allowed: true, reason: null });
  });

  it("describe a feedback list: reports, notes and only the caller's rating", () => {
    const choice: RuleChoice = {
      ruleKey: "dur-1",
      title: "Duration of confidentiality obligations",
    };
    const missed: MissedIssueView = {
      feedbackId: "fb_2",
      runId: IDS.run,
      ruleKey: null,
      ruleTitle: null,
      location: null,
      note: "Nothing covers the audit right.",
      reporterName: "A. Ruiz",
      at: "2026-11-04T09:32:00.000Z",
    };
    const rating: RatingView = {
      feedbackId: "fb_3",
      rating: 4,
      comment: null,
      at: "2026-11-04T09:40:00.000Z",
    };
    const list: MatterFeedbackView = { missedIssues: [missed], notes: [], myRating: rating };
    expect(choice.ruleKey).toBe("dur-1");
    expect(list.myRating?.rating).toBe(4);
    expect(list.missedIssues[0]?.ruleKey).toBeNull();
  });

  it("describe the progress through the training matter, with the denominator in the view", () => {
    const step: TrainingStepProgress = {
      n: 3,
      title: "Run the review",
      state: "not_yet",
      note: "Start a review with workflow version v2.",
    };
    const progress: TrainingProgressView = {
      key: "T01",
      steps: [step],
      checkable: 5,
      checkableDone: 0,
    };
    const view = { training: progress } satisfies Pick<MatterView, "training">;
    const summary: MatterSummary = { ...buildMatterSummary(), training: "T01" };
    expect(view.training.checkable).toBe(5);
    expect(summary.training).toBe("T01");
    expect(buildMatterSummary().training).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Migrations 006 and 007
// ---------------------------------------------------------------------------------------------

describe("migrations 006 and 007", () => {
  const files = loadMigrationFiles();

  it("exist, follow 005 without a gap, and are named for their owners", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
    expect(files.slice(0, 7).map((file) => [file.version, file.name])).toEqual([
      [1, "init"],
      [2, "integrity"],
      [3, "ingest_warnings"],
      [4, "usage_settled"],
      [5, "retention"],
      [6, "feedback_capture"],
      [7, "training_matter"],
    ]);
    expect(existsSync(join(MIGRATIONS, "006_feedback_capture.sql"))).toBe(true);
    expect(existsSync(join(MIGRATIONS, "007_training_matter.sql"))).toBe(true);
  });

  it("are placeholders that name their owner and hold no statement, until the owner replaces the body", () => {
    for (const [name, owner] of [
      ["006_feedback_capture.sql", "W2.6a"],
      ["007_training_matter.sql", "W2.8"],
    ] as const) {
      const text = readFileSync(join(MIGRATIONS, name), "utf8");
      if (!text.includes("PLACEHOLDER (contract commit CC2)")) continue;
      expect(text, name).toContain(`Owner: ${owner}.`);
      const statements = text
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
      expect(statements, name).toEqual([]);
    }
  });

  it("are reached by a fresh database, which records every file in order", () => {
    const db = openDatabase(":memory:");
    const rows = db
      .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; name: string; sha256: string }[];
    expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows.slice(5, 7).map((row) => row.name)).toEqual([
      "feedback_capture",
      "training_matter",
    ]);
    // Nothing is left to apply, and the current version is the number of the last file.
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.current).toBe(files.length);
    expect(again.current).toBeGreaterThanOrEqual(7);
    db.close();
  });

  it("upgrade a database that was created at version 5, keeping its rows and the checksums of 001 to 005", () => {
    const old = join(scratchDir("parol-cc2-"), "migrations-to-5");
    mkdirSync(old);
    for (const file of files.slice(0, 5)) {
      const name = `${String(file.version).padStart(3, "0")}_${file.name}.sql`;
      copyFileSync(join(MIGRATIONS, name), join(old, name));
    }
    const location = join(scratchDir("parol-cc2-"), "old.sqlite");

    // A database as the code before this commit left it: five migrations and some data.
    const atFive = openDatabase(location, { migrationsDir: old });
    const oldRepo = createRepository(atFive);
    oldRepo.seedDemoUsers();
    const matter = oldRepo.createMatter({
      name: "Lanternfish / Corvane NDA",
      clientLegalName: "Corvane Holdings Ltd",
      createdBy: DEMO_USER_IDS.admin,
    });
    const before = atFive
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(before.map((row) => row.version)).toEqual([1, 2, 3, 4, 5]);
    atFive.close();

    // Opened by the current code: the rest are applied, the first five are not touched.
    const upgraded = openDatabase(location);
    const after = upgraded
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(after.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(after.slice(0, 5)).toEqual(before);
    expect(after.length).toBeGreaterThanOrEqual(7);
    const repo = createRepository(upgraded);
    expect(repo.listUsers().length).toBeGreaterThan(0);
    // The matter made before the upgrade is still there, and is an ordinary one.
    expect(repo.getMatter(matter.id)?.name).toBe("Lanternfish / Corvane NDA");
    expect(repo.getMatter(matter.id)?.trainingKey).toBeNull();
    // And the runner has nothing more to do.
    expect(runMigrations(upgraded).applied).toEqual([]);
    upgraded.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

describe("the primary navigation", () => {
  it("holds Matters, Quickstart and Help, then Evaluations and Audit log, in that order", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(labels.slice(0, 5)).toEqual([
      "Matters",
      "Quickstart",
      "Help",
      "Evaluations",
      "Audit log",
    ]);
    expect(NAV_ITEMS.find((item) => item.label === "Quickstart")).toEqual({
      label: "Quickstart",
      href: "/quickstart",
    });
    expect(NAV_ITEMS.find((item) => item.label === "Help")).toEqual({
      label: "Help",
      href: "/help",
    });
    // The gated items of the earlier commit are as they were.
    expect(NAV_ITEMS.find((item) => item.label === "Evaluations")?.global).toBe("evaluation.read");
    expect(NAV_ITEMS.find((item) => item.label === "Audit log")?.global).toBe("audit.read");
  });

  /** The links a page of this chrome shows in its primary navigation, in order. */
  const shownTo = (globalRole: GlobalRole | undefined): string[] => {
    const chrome =
      globalRole === undefined ? buildChrome({ userName: null }) : buildChrome({ globalRole });
    const root = parseHtml(render(Layout({ title: "Page", chrome })));
    return all(
      first(root, (el) => el.name === "nav"),
      (el) => el.name === "a",
    ).map((a) => readable(a));
  };

  it("shows Quickstart and Help to everyone, a visitor with no role included, after Matters", () => {
    for (const role of [...GLOBAL_ROLES, undefined]) {
      const shown = shownTo(role);
      expect(shown, String(role)).toContain("Quickstart");
      expect(shown, String(role)).toContain("Help");
      expect(shown.indexOf("Matters"), String(role)).toBeLessThan(shown.indexOf("Quickstart"));
      expect(shown.indexOf("Quickstart"), String(role)).toBeLessThan(shown.indexOf("Help"));
    }
  });

  it("keeps the earlier gated items working: Evaluations for a legal engineer and an administrator, Audit log for an administrator", () => {
    const gated = ["Evaluations", "Audit log"];
    const ofGated = (role: GlobalRole | undefined) =>
      shownTo(role).filter((label) => gated.includes(label));
    expect(ofGated("member")).toEqual([]);
    expect(ofGated("legal_engineer")).toEqual(["Evaluations"]);
    expect(ofGated("admin")).toEqual(["Evaluations", "Audit log"]);
    expect(ofGated(undefined)).toEqual([]);
    for (const role of GLOBAL_ROLES)
      for (const [label, action] of [
        ["Evaluations", "evaluation.read"],
        ["Audit log", "audit.read"],
      ] as const)
        expect(shownTo(role).includes(label), `${role} ${label}`).toBe(
          (GLOBAL_ACTIONS[action] as readonly string[]).includes(role),
        );
  });
});

// ---------------------------------------------------------------------------------------------
// Addresses and form fields
// ---------------------------------------------------------------------------------------------

describe("urls and form fields", () => {
  it("builds the feedback addresses, escaping every id", () => {
    expect(urls.missedIssues("mat_1", "run_2")).toBe("/matters/mat_1/runs/run_2/missed-issues");
    expect(urls.notes("mat_1", "fnd_3")).toBe("/matters/mat_1/findings/fnd_3/notes");
    expect(urls.rating("mat_1")).toBe("/matters/mat_1/rating");
    expect(urls.missedIssues("m 1/../x", "r&2")).toBe(
      "/matters/m%201%2F..%2Fx/runs/r%262/missed-issues",
    );
    expect(urls.notes("m 1", "f/2")).toBe("/matters/m%201/findings/f%2F2/notes");
    expect(urls.rating("m 1/../x")).toBe("/matters/m%201%2F..%2Fx/rating");
  });

  it("builds the quickstart, help and training addresses, with an anchor on help only when one is given", () => {
    expect(urls.quickstart()).toBe("/quickstart");
    expect(urls.help()).toBe("/help");
    expect(urls.help("status-deviation")).toBe("/help#status-deviation");
    expect(urls.help("a b#c")).toBe("/help#a%20b%23c");
    expect(urls.help("")).toBe("/help");
    expect(urls.training()).toBe("/training");
    expect(urls.trainerKey()).toBe("/training/key");
  });

  it("names the form fields of the two packages, and gives no two fields one name", () => {
    expect(FIELDS.reasonCode).toBe("reasonCode");
    expect(FIELDS.minorEdit).toBe("minorEdit");
    expect(FIELDS.ruleKey).toBe("ruleKey");
    expect(FIELDS.location).toBe("location");
    expect(FIELDS.note).toBe("note");
    expect(FIELDS.rating).toBe("rating");
    expect(FIELDS.comment).toBe("comment");
    expect(FIELDS.trainerUserId).toBe("trainerUserId");
    // The reviewer and the trainer are two people on one form.
    expect(FIELDS.trainerUserId).not.toBe(FIELDS.reviewerUserId);
    // One name was already shared by design (the member list uses the sign-in field); no other.
    const byValue = new Map<string, string[]>();
    for (const [key, value] of Object.entries(FIELDS))
      byValue.set(value, [...(byValue.get(value) ?? []), key]);
    const shared = [...byValue.values()].filter((keys) => keys.length > 1);
    expect(shared).toEqual([["userId", "memberUserId"]]);
  });

  it("fixes what the rule choice and the minor-edit box post", () => {
    expect(NOT_COVERED_VALUE).toBe("(none)");
    expect(MINOR_EDIT_VALUE).toBe("yes");
    // Not a possible rule key, so "not covered" can never be mistaken for a rule.
    expect(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(NOT_COVERED_VALUE)).toBe(false);
  });

  it("lets the page invariants accept forms that post to the new addresses", () => {
    const actions = allowedActions();
    expect(actions.has(urls.rating(IDS.matter))).toBe(true);
    expect(actions.has(urls.training())).toBe(true);
    expect(actions.has(urls.missedIssues(IDS.matter, IDS.run))).toBe(true);
    for (const row of buildIssueRows())
      expect(actions.has(urls.notes(IDS.matter, row.findingId))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The stylesheet
// ---------------------------------------------------------------------------------------------

describe("the stylesheet", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../public/parol.css", import.meta.url)),
    "utf8",
  );
  const rule = (selector: string): string =>
    new RegExp(`(^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";

  it("has the two rules W2.6a needs: a list without bullets and an inline scale", () => {
    expect(rule(".feedback-list")).toContain("list-style: none");
    expect(rule(".rating-scale")).toContain("display: flex");
    expect(rule(".rating-scale")).toContain("flex-wrap: wrap");
  });

  it("uses colour only through the stylesheet's own tokens", () => {
    for (const selector of [".feedback-list li", ".rating-scale"]) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(body, selector).not.toMatch(/\brgb|\bhsl/i);
    }
    expect(rule(".feedback-list li")).toContain("var(--rule)");
  });
});
