import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import { GLOBAL_ROLES, type GlobalRole } from "../../src/contracts.js";
import { FIELDS, Layout, render } from "../../src/server/pages/index.js";
import { NAV_ITEMS, navItemsFor } from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import {
  DEMO_USER_IDS,
  createRepository,
  loadMigrationFiles,
  openDatabase,
  runMigrations,
} from "../../src/store/index.js";
import { all, first, parseHtml, readable } from "../pages/html.js";
import { allowedActions } from "../pages/invariants.js";
import { IDS, buildChrome } from "../pages/support.js";

/**
 * The contract commit before phase 3 (CC3). It adds no behaviour: the migration number, the
 * addresses, the form fields, the navigation item and the stylesheet rules that the pilot measures
 * package (W2.6b) needs, so that it and the error pages package (W2.9-err) can work on disjoint
 * files. These tests prove the seams are in place and that the tree builds with them.
 */

const MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url));

const scratch: string[] = [];
const scratchDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migration 008", () => {
  const files = loadMigrationFiles();

  it("exists, follows 007 without a gap, and is named for its owner", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.slice(5, 8).map((file) => [file.version, file.name])).toEqual([
      [6, "feedback_capture"],
      [7, "training_matter"],
      [8, "pilot_measures"],
    ]);
    expect(existsSync(join(MIGRATIONS, "008_pilot_measures.sql"))).toBe(true);
  });

  it("is a placeholder that names its owner and holds no statement, until the owner replaces the body", () => {
    const text = readFileSync(join(MIGRATIONS, "008_pilot_measures.sql"), "utf8");
    if (!text.includes("PLACEHOLDER (contract commit CC3)")) return;
    expect(text).toContain("Owner: W2.6b.");
    const statements = text
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("--"));
    expect(statements).toEqual([]);
  });

  it("is reached by a fresh database, which records every file in order", () => {
    const db = openDatabase(":memory:");
    const rows = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; name: string }[];
    expect(rows.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(rows[7]?.name).toBe("pilot_measures");
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.current).toBe(files.length);
    db.close();
  });

  it("upgrades a database that was created at version 7, keeping its rows and the checksums of 001 to 007", () => {
    const old = join(scratchDir("parol-cc3-"), "migrations-to-7");
    mkdirSync(old);
    for (const file of files.slice(0, 7)) {
      const name = `${String(file.version).padStart(3, "0")}_${file.name}.sql`;
      copyFileSync(join(MIGRATIONS, name), join(old, name));
    }
    const location = join(scratchDir("parol-cc3-"), "old.sqlite");

    // A database as the code before this commit left it: seven migrations and some data.
    const atSeven = openDatabase(location, { migrationsDir: old });
    const oldRepo = createRepository(atSeven);
    oldRepo.seedDemoUsers();
    const matter = oldRepo.createMatter({
      name: "Lanternfish / Corvane NDA",
      clientLegalName: "Corvane Holdings Ltd",
      createdBy: DEMO_USER_IDS.admin,
    });
    const before = atSeven
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(before.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    atSeven.close();

    // Opened by the current code: the rest are applied, the first seven are not touched.
    const upgraded = openDatabase(location);
    const after = upgraded
      .prepare("SELECT version, sha256 FROM schema_migrations ORDER BY version")
      .all() as unknown as { version: number; sha256: string }[];
    expect(after.map((row) => row.version)).toEqual(files.map((file) => file.version));
    expect(after.slice(0, 7)).toEqual(before);
    const repo = createRepository(upgraded);
    expect(repo.getMatter(matter.id)?.name).toBe("Lanternfish / Corvane NDA");
    expect(runMigrations(upgraded).applied).toEqual([]);
    upgraded.close();
  });
});

describe("the primary navigation", () => {
  it("ends with Pilot measures, after the items of the earlier commits, which keep their places", () => {
    const labels = NAV_ITEMS.map((item) => item.label);
    expect(labels).toEqual([
      "Matters",
      "Quickstart",
      "Help",
      "Evaluations",
      "Audit log",
      "Pilot measures",
    ]);
    expect(NAV_ITEMS.find((item) => item.label === "Pilot measures")).toEqual({
      label: "Pilot measures",
      href: "/pilot",
      global: "pilot.read",
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

  it("shows Pilot measures to the roles that hold the action pilot.read, and to nobody else", () => {
    for (const role of GLOBAL_ROLES)
      expect(shownTo(role).includes("Pilot measures"), role).toBe(
        (GLOBAL_ACTIONS["pilot.read"] as readonly string[]).includes(role),
      );
    expect(shownTo(undefined).includes("Pilot measures")).toBe(false);
    expect(shownTo("member").includes("Pilot measures")).toBe(false);
    expect(navItemsFor("legal_engineer").map((item) => item.label)).toContain("Pilot measures");
    expect(navItemsFor("admin").map((item) => item.label)).toContain("Pilot measures");
  });
});

describe("urls and form fields", () => {
  it("builds the pilot addresses: the pilot scope has no query, the demonstration scope has one", () => {
    expect(urls.pilot()).toBe("/pilot");
    expect(urls.pilot("pilot")).toBe("/pilot");
    expect(urls.pilot("synthetic")).toBe("/pilot?scope=synthetic");
    expect(urls.pilotCsv()).toBe("/pilot/measures.csv");
    expect(urls.pilotCsv("pilot")).toBe("/pilot/measures.csv");
    expect(urls.pilotCsv("synthetic")).toBe("/pilot/measures.csv?scope=synthetic");
    expect(urls.pilotCalendar()).toBe("/pilot/calendar");
    expect(urls.pilotParticipants()).toBe("/pilot/participants");
  });

  it("builds the matter addresses of the timer and the reference list, escaping the id", () => {
    expect(urls.matterTimer("mat_1")).toBe("/matters/mat_1/timer");
    expect(urls.matterReferenceList("mat_1")).toBe("/matters/mat_1/reference-list");
    expect(urls.matterTimer("m 1/../x")).toBe("/matters/m%201%2F..%2Fx/timer");
    expect(urls.matterReferenceList("m 1/../x")).toBe("/matters/m%201%2F..%2Fx/reference-list");
  });

  it("names the four form fields, and gives no two fields one name beyond the one shared by design", () => {
    expect(FIELDS.startDate).toBe("startDate");
    expect(FIELDS.outsideHigh).toBe("outsideHigh");
    expect(FIELDS.outsideMedium).toBe("outsideMedium");
    expect(FIELDS.outsideLow).toBe("outsideLow");
    const byValue = new Map<string, string[]>();
    for (const [key, value] of Object.entries(FIELDS))
      byValue.set(value, [...(byValue.get(value) ?? []), key]);
    const shared = [...byValue.values()].filter((keys) => keys.length > 1);
    expect(shared).toEqual([["userId", "memberUserId"]]);
  });

  it("lets the page invariants accept forms that post to the new addresses", () => {
    const actions = allowedActions();
    expect(actions.has(urls.matterTimer(IDS.matter))).toBe(true);
    expect(actions.has(urls.matterReferenceList(IDS.matter))).toBe(true);
    expect(actions.has(urls.pilotCalendar())).toBe(true);
    expect(actions.has(urls.pilotParticipants())).toBe(true);
  });
});

describe("the stylesheet", () => {
  const css = readFileSync(
    fileURLToPath(new URL("../../public/parol.css", import.meta.url)),
    "utf8",
  );
  const rule = (selector: string): string =>
    new RegExp(`(^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[2] ?? "";

  it("has the three rules W2.6b needs: a marked banner, a plain list of scope links and muted text", () => {
    expect(rule(".banner-synthetic")).toContain("border-width");
    expect(rule(".scope-switch")).toContain("list-style: none");
    expect(rule(".scope-switch")).toContain("display: flex");
    expect(rule(".measure-no-data")).toContain("var(--muted)");
  });

  it("uses colour only through the stylesheet's own tokens", () => {
    for (const selector of [".banner-synthetic", ".scope-switch", ".measure-no-data"]) {
      const body = rule(selector);
      expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(body, selector).not.toMatch(/\brgb|\bhsl/i);
    }
  });
});
