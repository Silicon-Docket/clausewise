import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import type { AuthorizedMatter, Principal } from "../../src/auth/types.js";
import { GLOBAL_ROLES, type GlobalRole } from "../../src/contracts.js";
import { createSimulatedModel } from "../../src/demo/simulated-model.js";
import { EMPTY_SOURCE, createComparisonSource } from "../../src/evaluations/index.js";
import type { ComparisonSource } from "../../src/evaluations/index.js";
import { reportRetentionNotices } from "../../src/retention/notices.js";
import { FIELDS, Layout, render } from "../../src/server/pages/index.js";
import { NAV_ITEMS } from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import type { ServiceDeps } from "../../src/services/deps.js";
import { createServices } from "../../src/services/index.js";
import type { MatterService } from "../../src/services/types.js";
import {
  DEMO_USER_IDS,
  FileStore,
  createRepository,
  loadMigrationFiles,
  openDatabase,
  runMigrations,
} from "../../src/store/index.js";
import { all, first, parseHtml, readable } from "../pages/html.js";
import { allowedActions } from "../pages/invariants.js";
import { matterPage } from "../pages/render.js";
import { IDS, buildChrome, buildMatterView } from "../pages/support.js";

/**
 * The contract commit before phase 1 (CC1). It adds no behaviour: shared types, registrations and
 * slots, so that three packages can work on disjoint files. These tests prove the seams are in
 * place, that every stub says whose it is, and that the tree builds with the stubs in it.
 *
 * The stub rows are written so that the package that fills a stub does not have to edit this file:
 * a stub is a function that throws "stub: <package id>" and whose file carries the comment marker
 * with that package id. While the marker is in the file the function must throw exactly that
 * error; once the owner has removed the marker (and written the function) it must not.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const read = (relative: string): string => readFileSync(join(SRC, relative), "utf8");
/** The comment marker of a stub. Built here so that a scan for the marker finds stubs and not this file. */
const marker = (id: string): string => `${"STUB"}(${id})`;

const scratch: string[] = [];
const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// A small world: a repository, a file store, a model that calls nothing
// ---------------------------------------------------------------------------------------------

function makeDeps(extra: Partial<ServiceDeps> = {}): ServiceDeps {
  const repo = createRepository(openDatabase(":memory:"));
  repo.seedDemoUsers();
  return {
    repo,
    files: new FileStore(join(scratchDir("parol-cc1-"), "files")),
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

/** The authorization layer makes the real one; the stub never looks at it. */
const matterAccess = {
  matterId: "mat_cc1",
  principal: admin,
  role: "associate",
} as unknown as AuthorizedMatter;

// ---------------------------------------------------------------------------------------------
// createServices
// ---------------------------------------------------------------------------------------------

describe("createServices", () => {
  it("builds with no evaluations source, with the empty one and with another, and never reads a source while building", () => {
    const other: ComparisonSource = {
      list: vi.fn(() => ({ entries: [], truncated: false })),
      get: vi.fn(() => null),
    };
    for (const evaluations of [undefined, EMPTY_SOURCE, other]) {
      const services = createServices(makeDeps(evaluations === undefined ? {} : { evaluations }));
      expect(Object.keys(services)).toEqual(
        expect.arrayContaining(["matters", "runs", "reviews", "evaluations", "audit"]),
      );
      expect(typeof services.evaluations.list).toBe("function");
      expect(typeof services.evaluations.comparison).toBe("function");
      expect(typeof services.audit.check).toBe("function");
      expect(typeof services.matters.setRetention).toBe("function");
    }
    expect(other.list).not.toHaveBeenCalled();
    expect(other.get).not.toHaveBeenCalled();
  });

  it("accepts retainDays when a matter is created, as the new-matter form and the API will send it", () => {
    const deps = makeDeps();
    const services = createServices(deps);
    const input: Parameters<MatterService["create"]>[1] = {
      name: "Lanternfish / Corvane NDA",
      clientLegalName: "Corvane Holdings Ltd",
      playbookVersionId: null,
      reviewerUserId: null,
      retainDays: 45,
    };
    const created = services.matters.create(admin, input);
    expect(created.name).toBe("Lanternfish / Corvane NDA");
  });
});

// ---------------------------------------------------------------------------------------------
// The stubs
// ---------------------------------------------------------------------------------------------

type PackageId = "W2.x" | "W2.5" | "W2.7";

interface StubRow {
  id: PackageId;
  /** The file under `src` that holds the stub and its marker. */
  file: string;
  what: string;
  call(deps: ServiceDeps, services: ReturnType<typeof createServices>): unknown;
}

const NO_USAGE = {
  responses: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedResponses: 0,
};

const STUB_ROWS: StubRow[] = [
  {
    id: "W2.5",
    file: "services/evaluations.ts",
    what: "EvaluationService.list",
    call: (_deps, services) => services.evaluations.list(admin),
  },
  {
    id: "W2.5",
    file: "services/evaluations.ts",
    what: "EvaluationService.comparison",
    call: (_deps, services) =>
      services.evaluations.comparison(admin, { id: "cmp_0123456789abcdef" }),
  },
  {
    id: "W2.7",
    file: "services/audit.ts",
    what: "AuditService.check",
    call: (_deps, services) => services.audit.check(admin),
  },
  {
    id: "W2.7",
    file: "services/matters.ts",
    what: "MatterService.setRetention",
    call: (_deps, services) => services.matters.setRetention(matterAccess, 30),
  },
  {
    id: "W2.x",
    file: "store/repo-spend.ts",
    what: "Repository.addSpend",
    call: (deps) => deps.repo.addSpend(NO_USAGE),
  },
  {
    id: "W2.x",
    file: "store/repo-spend.ts",
    what: "Repository.spendToday",
    call: (deps) => deps.repo.spendToday(),
  },
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
    it(`${row.what} throws "stub: ${row.id}" while ${row.file} carries its marker, and not after`, () => {
      const marked = read(row.file).includes(marker(row.id));
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

  it("puts the marker on the line of every stub throw, naming the same package as the message", () => {
    for (const file of new Set(STUB_ROWS.map((row) => row.file))) {
      const throws = read(file)
        .split("\n")
        .filter((line) => line.includes('throw new Error("stub:'));
      // A file whose owner has filled the stub in carries no marker and no stub throw: that is the
      // goal, and this file does not have to be edited for it. A stub throw without a marker is not.
      if (!read(file).includes(`${"STUB"}(`)) {
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

  it("returns an object from the factories and throws only when a method is called", () => {
    expect(() => createServices(makeDeps())).not.toThrow();
    const again = createServices(makeDeps());
    expect(again.evaluations).toBeTypeOf("object");
    expect(again.audit).toBeTypeOf("object");
  });

  it("makes the retention notices a call that returns without doing anything, until W2.7 fills it", () => {
    const notice = vi.fn();
    const marked = read("retention/notices.ts").includes(marker("W2.7"));
    const result = reportRetentionNotices({ repo: makeDeps().repo, now: () => new Date(), notice });
    expect(result).toBeUndefined();
    if (marked) expect(notice).not.toHaveBeenCalled();
  });

  it("makes the retention section of the matter page render nothing, until W2.7 fills it", () => {
    const marked = read("server/pages/retention.tsx").includes(marker("W2.7"));
    const without = matterPage(buildMatterView());
    const retention = {
      retainUntil: "2026-12-04T09:00:00.000Z",
      daysLeft: 30,
      pastDate: false,
      defaultDays: 30,
      maxDays: 90,
    };
    const withView = matterPage(buildMatterView({ retention }));
    if (marked) {
      expect(withView).toBe(without);
      expect(without).not.toContain('id="retention"');
    }
  });

  it("calls the retention section on the matter page between the people and the delete sections", () => {
    const page = read("server/pages/matter.tsx");
    const people = page.indexOf("<PeopleSection");
    const retention = page.indexOf("<RetentionSection");
    const remove = page.indexOf('id="delete"');
    expect(people).toBeGreaterThan(0);
    expect(retention).toBeGreaterThan(people);
    expect(remove).toBeGreaterThan(retention);
    // It is handed the view's retention, the role's right to change it, and no id but the matter's.
    const call = page.slice(retention, page.indexOf("/>", retention));
    expect(call).toContain("retention={view.retention}");
    expect(call).toContain("matterId={matter.id}");
    expect(call).toContain("canUpdate={canUpdate}");
  });
});

// ---------------------------------------------------------------------------------------------
// The evaluation source
// ---------------------------------------------------------------------------------------------

describe("EMPTY_SOURCE", () => {
  it("lists nothing and finds nothing", () => {
    expect(EMPTY_SOURCE.list()).toEqual({ entries: [], truncated: false });
    expect(EMPTY_SOURCE.get("cmp_0123456789abcdef")).toBeNull();
    expect(EMPTY_SOURCE.get("not an id")).toBeNull();
  });

  it("is what a folder that does not exist reads as", () => {
    const missing = join(scratchDir("parol-cc1-"), "evaluations", "not-made");
    const source = createComparisonSource(missing);
    expect(source.list()).toEqual({ entries: [], truncated: false });
    expect(source.get("cmp_0123456789abcdef")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Migrations 004 and 005
// ---------------------------------------------------------------------------------------------

describe("migrations 004 and 005", () => {
  const files = loadMigrationFiles();

  it("exist, follow 003 without a gap, and are named for their owners", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files.slice(0, 5).map((file) => [file.version, file.name])).toEqual([
      [1, "init"],
      [2, "integrity"],
      [3, "ingest_warnings"],
      [4, "usage_settled"],
      [5, "retention"],
    ]);
  });

  it("are reached by a fresh database, which records every file in order", () => {
    const db = openDatabase(":memory:");
    const rows = db
      .prepare("SELECT version, name, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; name: string; sha256: string }[];
    expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows.slice(3, 5).map((row) => row.name)).toEqual(["usage_settled", "retention"]);
    // Nothing is left to apply, and the current version is the number of the last file.
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.current).toBe(files.length);
    expect(again.current).toBeGreaterThanOrEqual(5);
    db.close();
  });

  it("upgrade a database that was created at version 3, keeping its rows and the checksums of 001 to 003", () => {
    const old = join(scratchDir("parol-cc1-"), "migrations-to-3");
    mkdirSync(old);
    for (const file of files.slice(0, 3)) {
      const name = `${String(file.version).padStart(3, "0")}_${file.name}.sql`;
      copyFileSync(
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        join(old, name),
      );
    }
    const location = join(scratchDir("parol-cc1-"), "old.sqlite");

    // A database as the code before this commit left it: three migrations and some data.
    const atThree = openDatabase(location, { migrationsDir: old });
    createRepository(atThree).seedDemoUsers();
    const before = atThree
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(before.map((row) => row.version)).toEqual([1, 2, 3]);
    atThree.close();

    // Opened by the current code: the rest are applied, the first three are not touched.
    const upgraded = openDatabase(location);
    const after = upgraded
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(after.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(after.slice(0, 3)).toEqual(before);
    expect(after.length).toBeGreaterThanOrEqual(5);
    expect(createRepository(upgraded).listUsers().length).toBeGreaterThan(0);
    // And the runner has nothing more to do.
    expect(runMigrations(upgraded).applied).toEqual([]);
    upgraded.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------

describe("the primary navigation", () => {
  it("holds Matters, then Evaluations (evaluation.read) and Audit log (audit.read)", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(labels).toEqual(expect.arrayContaining(["Matters", "Evaluations", "Audit log"]));
    expect(labels.indexOf("Matters")).toBeLessThan(labels.indexOf("Evaluations"));
    expect(labels.indexOf("Evaluations")).toBeLessThan(labels.indexOf("Audit log"));
    expect(NAV_ITEMS.find((item) => item.label === "Matters")).toEqual({
      label: "Matters",
      href: "/matters",
    });
    expect(NAV_ITEMS.find((item) => item.label === "Evaluations")).toEqual({
      label: "Evaluations",
      href: "/evaluations",
      global: "evaluation.read",
    });
    expect(NAV_ITEMS.find((item) => item.label === "Audit log")).toEqual({
      label: "Audit log",
      href: "/audit",
      global: "audit.read",
    });
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

  it("shows Evaluations to a legal engineer and an administrator, and Audit log to an administrator only", () => {
    const gated = ["Evaluations", "Audit log"];
    const ofGated = (role: GlobalRole | undefined) =>
      shownTo(role).filter((label) => gated.includes(label));
    expect(shownTo("member")).toContain("Matters");
    expect(ofGated("member")).toEqual([]);
    expect(ofGated("legal_engineer")).toEqual(["Evaluations"]);
    expect(ofGated("admin")).toEqual(["Evaluations", "Audit log"]);
    // A page with no signed-in person has no role, and shows neither.
    expect(shownTo(undefined)).toContain("Matters");
    expect(ofGated(undefined)).toEqual([]);
  });

  it("agrees with the table of global actions for every role it knows", () => {
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
  it("builds the evaluations address, with the trail anchor only when a slot is chosen", () => {
    expect(urls.evaluations()).toBe("/evaluations");
    expect(urls.evaluations({ comparison: "cmp_0123456789abcdef" })).toBe(
      "/evaluations?comparison=cmp_0123456789abcdef",
    );
    expect(
      urls.evaluations({
        comparison: "cmp_0123456789abcdef",
        split: "dev",
        caseKey: "PAROL-D05",
        ruleKey: "term",
      }),
    ).toBe("/evaluations?comparison=cmp_0123456789abcdef&split=dev&case=PAROL-D05&rule=term#trail");
    // One half of a slot is not a slot.
    expect(urls.evaluations({ comparison: "cmp_0123456789abcdef", caseKey: "PAROL-D05" })).toBe(
      "/evaluations?comparison=cmp_0123456789abcdef&case=PAROL-D05",
    );
  });

  it("escapes every value it is given", () => {
    const href = urls.evaluations({ comparison: "a&b=c", caseKey: "x y", ruleKey: "#z" });
    expect(href).toBe("/evaluations?comparison=a%26b%3Dc&case=x%20y&rule=%23z#trail");
    expect(urls.matterRetention("m 1/../x")).toBe("/matters/m%201%2F..%2Fx/retention");
  });

  it("builds the retention and audit addresses and names the retention field", () => {
    expect(urls.matterRetention("mat_1")).toBe("/matters/mat_1/retention");
    expect(urls.audit()).toBe("/audit");
    expect(FIELDS.retainDays).toBe("retainDays");
  });

  it("lets the page invariants accept a form that posts to the retention address", () => {
    expect(allowedActions().has(urls.matterRetention(IDS.matter))).toBe(true);
  });
});
