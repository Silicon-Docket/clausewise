import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS, MATTER_ACTIONS } from "../../src/auth/actions.js";
import { createApp } from "../../src/server/app.js";
import { describeRoutes } from "../../src/server/matter-route.js";
import { renderErrorPage } from "../../src/server/pages/index.js";
import { trainedField } from "../../src/server/pages/pilotfields.js";
import { registerRoutes } from "../../src/server/routes/index.js";
import { csvDownloadHeaders } from "../../src/server/routes/shared.js";
import { urls } from "../../src/server/urls.js";
import { createPilotService } from "../../src/services/pilot.js";
import { DEMO_USER_IDS } from "../../src/store/index.js";
import { expectAccessible, tabStops } from "../a11y/rules.js";
import { AS_OF, f1Records } from "../pilot/f1.js";
import { all, attr, byId, byTag, hasClass, readable, type El } from "../pages/html.js";
import {
  Browser,
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  addMember,
  checkPage,
  cleanup,
  fingerprint,
  makeSite,
  newMatter,
  routeFor,
  uploadCase,
  type Site,
} from "./support.js";
import { computePilotMeasures } from "../../src/pilot/compute.js";

/**
 * The routes of the pilot measures, the timer and the reference list (package W2.6b), sent through
 * the real shell and the real services. Who is let in and who is not, what the page and the file
 * say, what a form that is refused is answered with, that every write is audited and needs the
 * token, and that nothing a request carried is logged or written where it should not be.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MARK = "QZMARK-pilot-route-77d1";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

/** What the pilot routes can change, counted: the fingerprint of the matter routes does not hold these. */
function counts(site: Site): Record<string, number> {
  const count = (table: string): number =>
    (site.w.repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    calendar: count("pilot_calendar"),
    roster: count("pilot_participants"),
    timers: count("time_entries"),
    reference: count("reference_issues"),
    audit: count("audit_events"),
  };
}

/** A form post made by hand: the token of this session unless told otherwise. */
async function post(
  browser: Browser,
  path: string,
  fields: Record<string, string>,
  token?: string | null,
): Promise<Response> {
  const csrf = token === undefined ? await browser.apiToken() : token;
  const body = new URLSearchParams(csrf === null ? fields : { _csrf: csrf, ...fields });
  return browser.send("POST", path, { headers: FORM, body: body.toString() });
}

/** The rules every page has, for the matter page a refused form is answered with. */
const accessibleMatterPage = (html: string): El => expectAccessible(html);

const noticeOf = (page: { root: El }): string | null => {
  const box = all(page.root, (el) => hasClass(el, "notice"))[0];
  return box === undefined ? null : readable(box);
};

/** A reader of the file as a spreadsheet would read it: RFC 4180, CRLF between records. */
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" && text.charAt(i + 1) === "\n") {
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
      i += 1;
    } else cell += ch;
  }
  return out;
}

describe("the routes as the application holds them", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
  });
  const recordOf = (method: string, path: string) =>
    describeRoutes(site.app).find((r) => r.method === method && r.path === path);

  it("registers the four pages and forms that name no matter with the global action they need", () => {
    expect(recordOf("GET", "/pilot")).toMatchObject({
      kind: "principal",
      globalAction: "pilot.read",
      action: null,
    });
    expect(recordOf("GET", "/pilot/measures.csv")).toMatchObject({
      kind: "principal",
      globalAction: "pilot.read",
    });
    expect(recordOf("POST", "/pilot/calendar")).toMatchObject({
      kind: "principal",
      globalAction: "pilot.manage",
    });
    expect(recordOf("POST", "/pilot/participants")).toMatchObject({
      kind: "principal",
      globalAction: "pilot.manage",
    });
  });

  it("registers the two forms of a matter with the actions the role table gives them", () => {
    expect(recordOf("POST", "/matters/:matterId/timer")).toMatchObject({
      kind: "matter",
      action: "time.record",
    });
    expect(recordOf("POST", "/matters/:matterId/reference-list")).toMatchObject({
      kind: "matter",
      action: "reference.write",
    });
    expect(MATTER_ACTIONS["time.record"]).toEqual(["associate", "reviewer"]);
    expect(MATTER_ACTIONS["reference.write"]).toEqual(["reviewer"]);
    expect(GLOBAL_ACTIONS["pilot.read"]).toEqual(["legal_engineer", "admin"]);
  });

  it("answers no other method at these addresses, and takes no id from a path or a body", async () => {
    const admin = await site.as(IDS.admin);
    const before = counts(site);
    for (const path of ["/pilot", "/pilot/measures.csv"])
      for (const method of ["POST", "PUT", "PATCH", "DELETE"])
        expect((await admin.send(method, path)).status, `${method} ${path}`).toBe(404);
    for (const path of ["/pilot/calendar", "/pilot/participants"])
      for (const method of ["GET", "PUT", "PATCH", "DELETE"])
        expect((await admin.send(method, path)).status, `${method} ${path}`).toBe(404);
    expect(counts(site)).toEqual(before);
    // The two matter forms name only the matter, so there is no id to forge: nothing in the path but
    // `:matterId`, and the person is the signed-in one.
    const routes = describeRoutes(site.app)
      .filter((r) => r.kind === "matter" && /\/(timer|reference-list)$/.test(r.path))
      .map((r) => r.path);
    expect(routes.sort()).toEqual([
      "/matters/:matterId/reference-list",
      "/matters/:matterId/timer",
    ]);
    for (const path of routes) expect(path.match(/:[A-Za-z]+/g)).toEqual([":matterId"]);
  });
});

describe("who may open the pilot page and the file", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
  });

  for (const path of [urls.pilot(), urls.pilotCsv()]) {
    it(`sends a visitor with no session to sign in: ${path}`, async () => {
      const response = await site.anonymous().get(path);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(urls.home());
    });

    it(`answers 403 to everyone who is not the legal engineer or an administrator, with nothing of the page: ${path}`, async () => {
      for (const userId of [IDS.associate, IDS.reviewer, VIEWER, OUTSIDER, OTHER_ASSOCIATE]) {
        const before = counts(site);
        const response = await (await site.as(userId)).get(path);
        const body = await response.text();
        expect(response.status, userId).toBe(403);
        expect(response.headers.get("content-type"), userId).toMatch(/^text\/html/);
        expect(response.headers.get("content-disposition"), userId).toBeNull();
        expect(body, userId).not.toContain("Pilot measures");
        expect(body, userId).not.toContain("scope,calendar_start");
        expect(body, userId).not.toContain("No pilot data");
        expect(counts(site)).toEqual(before);
      }
    });

    it(`gives every member the same body, whoever they are: ${path}`, async () => {
      const bodies = new Set<string>();
      for (const userId of [IDS.associate, IDS.reviewer, VIEWER, OUTSIDER])
        bodies.add(await (await (await site.as(userId)).get(path)).text());
      expect(bodies.size).toBe(1);
    });

    it(`lets in the legal engineer and the administrator: ${path}`, async () => {
      for (const userId of [IDS.legalEngineer, IDS.admin]) {
        const response = await (await site.as(userId)).get(path);
        expect(response.status, userId).toBe(200);
      }
    });
  }

  it("checks the global role as the database has it for this request, not as a session says", async () => {
    const browser = await site.as(IDS.associate);
    expect((await browser.get(urls.pilot())).status).toBe(403);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'legal_engineer' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.pilot())).status).toBe(200);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'member' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.pilot())).status).toBe(403);
  });

  it("reads and writes nothing when it is opened", async () => {
    const before = counts(site);
    const fp = fingerprint(site);
    for (const userId of [IDS.admin, IDS.legalEngineer, IDS.associate]) {
      const browser = await site.as(userId);
      await browser.get(urls.pilot());
      await browser.get(urls.pilot("synthetic"));
      await browser.get(urls.pilotCsv());
    }
    expect(counts(site)).toEqual(before);
    expect(fingerprint(site)).toEqual(fp);
  });
});

describe("the page and its scope", () => {
  let site: Site;
  beforeAll(async () => {
    site = makeSite();
    newMatter(site.w);
  });

  it("opens on the pilot scope, which is empty here, and says so first", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.pilot());
    expect(readable(byTag(page.root, "h1")[0]!)).toBe("Pilot measures");
    expect(readable(byTag(page.root, "title")[0]!)).toBe("Pilot measures | Parol");
    const text = readable(byTag(page.root, "main")[0]!);
    expect(text).toContain(
      "No pilot data. This database holds 1 matter and it is synthetic or was made by a demonstration identity",
    );
    expect(text).not.toContain("SYNTHETIC SCOPE");
    const links = all(
      page.root,
      (el) => el.name === "a" && attr(el, "href")?.startsWith("/pilot") === true,
    );
    const scope = links.filter((el) => attr(el, "aria-current") !== undefined);
    expect(scope.map((el) => attr(el, "href"))).toEqual([urls.pilot()]);
    // The CSV link carries the scope of the page.
    expect(
      links.some(
        (el) => attr(el, "href") === urls.pilotCsv("pilot") && readable(el).includes("CSV"),
      ),
    ).toBe(true);
  });

  it("shows the synthetic scope only when asked, under a banner, in the title and in every caption", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.pilot("synthetic"));
    expect(readable(byTag(page.root, "title")[0]!)).toBe(
      "Pilot measures (synthetic scope) | Parol",
    );
    const banner = all(page.root, (el) => hasClass(el, "banner-synthetic"))[0]!;
    expect(readable(banner)).toContain("SYNTHETIC SCOPE");
    expect(readable(banner)).toContain(
      "not pilot data, not adoption, not accuracy and not time saved",
    );
    const captions = byTag(page.root, "caption").map((el) => readable(el));
    expect(captions.length).toBeGreaterThan(5);
    for (const caption of captions) expect(caption, caption).toMatch(/synthetic scope$/);
    expect(
      all(page.root, (el) => el.name === "a" && attr(el, "href") === urls.pilotCsv("synthetic"))
        .length,
    ).toBe(1);
  });

  it("reads anything but synthetic as the pilot scope, however the query is written", async () => {
    const admin = await site.as(IDS.admin);
    for (const query of [
      "?scope=bogus",
      "?scope=",
      "?scope=SYNTHETIC",
      "?scope=pilot&scope=synthetic",
      "?x=synthetic",
    ]) {
      const page = await admin.page(`${urls.pilot()}${query}`);
      expect(readable(byTag(page.root, "title")[0]!), query).toBe("Pilot measures | Parol");
      expect(
        all(page.root, (el) => hasClass(el, "banner-synthetic")),
        query,
      ).toHaveLength(0);
    }
    // And never echoes it.
    const page = await admin.page(`${urls.pilot()}?scope=${MARK}`);
    expect(page.html).not.toContain(MARK);
  });

  it("states every measure with its numerator, its denominator and what the denominator counts", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.pilot("synthetic"));
    const table = all(page.root, (el) => el.name === "table").find((t) =>
      readable(byTag(t, "caption")[0]!).startsWith("Pilot measures,"),
    )!;
    const header = byTag(table, "th")
      .filter((th) => attr(th, "scope") === "col")
      .map((th) => readable(th));
    expect(header).toEqual([
      "Measure",
      "Result",
      "Numerator",
      "Denominator",
      "What the denominator counts",
      "Note",
    ]);
    const rows = byTag(table, "tbody")[0]!;
    const body = all(rows, (el) => el.name === "tr");
    expect(body.length).toBeGreaterThanOrEqual(11);
    for (const row of body) {
      const cells = byTag(row, "td").map((td) => readable(td));
      // What the denominator counts is always a sentence.
      expect(cells[3], readable(byTag(row, "th")[0]!)).not.toBe("");
    }
  });

  it("passes the rules every page has, and every control is reached by Tab in reading order", async () => {
    const admin = await site.as(IDS.admin);
    for (const scope of ["pilot", "synthetic"] as const) {
      const page = await admin.page(urls.pilot(scope));
      checkPage(site, page);
      const root = expectAccessible(page.html);
      const names = tabStops(root).map((el) => attr(el, "name") ?? attr(el, "href") ?? el.name);
      // The date, its button, the boxes of the roster, its button, the scroll regions and the link
      // to the file, in the order they are written.
      expect(names.indexOf("startDate")).toBeGreaterThan(-1);
      expect(names.indexOf("startDate")).toBeLessThan(names.indexOf(trainedField(IDS.associate)));
      expect(names.indexOf(trainedField(IDS.associate))).toBeLessThan(
        names.indexOf(urls.pilotCsv(scope)),
      );
    }
  });

  it("has a form for the date and for the roster, each with the session's token", async () => {
    const admin = await site.as(IDS.legalEngineer);
    const page = await admin.page(urls.pilot());
    for (const action of [urls.pilotCalendar(), urls.pilotParticipants()]) {
      expect(admin.hasForm(page, action), action).toBe(true);
      const form = admin.formOf(page, action);
      expect(
        all(
          form,
          (el) =>
            el.name === "input" && attr(el, "name") === "_csrf" && attr(el, "type") === "hidden",
        ),
        action,
      ).toHaveLength(1);
    }
    // One box for each person, and a label for each.
    const boxes = all(page.root, (el) => el.name === "input" && attr(el, "type") === "checkbox");
    expect(boxes.map((el) => attr(el, "name")).sort()).toEqual(
      [IDS.associate, IDS.reviewer, IDS.legalEngineer, IDS.admin, VIEWER, OUTSIDER, OTHER_ASSOCIATE]
        .map(trainedField)
        .sort(),
    );
  });
});

describe("the file", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
    newMatter(site.w);
  });

  it("is a download, not a page: the type, the disposition with a plain name, and no sniffing or caching", async () => {
    const admin = await site.as(IDS.admin);
    const pilot = await admin.get(urls.pilotCsv());
    expect(pilot.status).toBe(200);
    expect(pilot.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const disposition = pilot.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9][A-Za-z0-9._-]*\.csv"$/);
    expect(disposition).toBe('attachment; filename="parol-pilot-measures-pilot-2026-11-04.csv"');
    expect(pilot.headers.get("x-content-type-options")).toBe("nosniff");
    expect(pilot.headers.get("cache-control")).toBe("no-store");
    const text = await pilot.text();
    expect(pilot.headers.get("content-length")).toBe(String(new TextEncoder().encode(text).length));
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("carries SYNTHETIC in capitals in the name of the synthetic scope, and the scope on every row", async () => {
    const admin = await site.as(IDS.legalEngineer);
    const response = await admin.get(urls.pilotCsv("synthetic"));
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="parol-pilot-measures-SYNTHETIC-2026-11-04.csv"',
    );
    const rows = parseCsv(await response.text());
    expect(rows[0]!.slice(0, 4)).toEqual(["scope", "calendar_start", "as_of", "measure"]);
    for (const row of rows.slice(1, -1)) expect(row[0]).toBe("synthetic");
    const pilot = parseCsv(await (await admin.get(urls.pilotCsv("pilot"))).text());
    for (const row of pilot.slice(1, -1)) expect(row[0]).toBe("pilot");
  });

  it("holds the same rows as the page: every measure of the page is in the file", async () => {
    const admin = await site.as(IDS.admin);
    const file = parseCsv(await (await admin.get(urls.pilotCsv("synthetic"))).text());
    const measures = new Set(file.slice(1, -1).map((row) => row[3]));
    for (const id of [
      "completion",
      "repeat_usage",
      "correction_rate",
      "missed_issue_rate",
      "escalation_system",
      "escalation_reviewer",
      "satisfaction_rating",
      "active_time",
      "shadow_agreement",
      "population",
    ])
      expect(measures.has(id), id).toBe(true);
  });

  it("neutralises a rule key that a spreadsheet would read as a formula, on the way out of the route", async () => {
    // The route and the service are the real ones; the store is made to hold rule keys that no
    // import would allow, by wrapping the one read that produces them.
    const hostile = [
      "=1+1",
      "+1",
      "-1",
      "@SUM(1)",
      "\t=1",
      "\r=1",
      " =1",
      '=HYPERLINK("http://example.invalid","x")',
    ];
    const records = f1Records();
    records.playbooks = [{ versionId: "pb-1", ruleKeys: ["pty-1", ...hostile] }];
    for (const ruleKey of hostile)
      records.missedIssues.push({ matterId: "M1", userDemo: false, ruleKey });
    const repo = { ...site.w.repo, loadPilotRecords: () => records };
    const pilot = createPilotService({ ...site.w.deps, repo, now: () => new Date(AS_OF) });
    const deps = { ...site.deps, services: { ...site.deps.services, pilot } };
    const app = createApp(deps, { log: () => {}, renderError: renderErrorPage });
    registerRoutes(app, deps);
    const browser = new Browser(app);
    await browser.signIn(IDS.admin);
    // The records are F1's, whose people are not demonstration identities: the pilot scope has them.
    const response = await browser.get(urls.pilotCsv("pilot"));
    expect(response.status).toBe(200);
    const text = await response.text();
    const rows = parseCsv(text).slice(1, -1);
    expect(rows.length).toBeGreaterThan(50);
    const ruleKeys = rows.filter((r) => r[4] === "rule").map((r) => r[5]!);
    expect(ruleKeys.filter((key) => key.startsWith("'")).length).toBe(hostile.length);
    const FORMULA = /^[\u0000-  ]*[=+\-@\t\r]/u;
    for (const row of rows)
      for (const cell of row) expect(FORMULA.test(cell), JSON.stringify(cell)).toBe(false);
    // The same records are the page's too: the page shows them as text, escaped.
    const page = await browser.page(urls.pilot("pilot"));
    expect(page.html).not.toContain('=HYPERLINK("http');
    // And nothing was changed by reading.
    expect(
      computePilotMeasures(records, { scope: "pilot", asOf: AS_OF }).rows.length,
    ).toBeGreaterThan(50);
  });
});

describe("the headers of a download", () => {
  it("name the file only with plain characters, and fall back to a plain name for any other", () => {
    for (const name of [
      'a"b.csv',
      "x\r\nSet-Cookie: y=1.csv",
      "../x.csv",
      "",
      " lead.csv",
      "a".repeat(101),
      "\u0000.csv",
      "caf\u00e9.csv",
    ]) {
      const headers = csvDownloadHeaders(name, 7);
      expect(headers["content-disposition"], JSON.stringify(name)).toBe(
        'attachment; filename="parol-pilot-measures.csv"',
      );
    }
    expect(csvDownloadHeaders("parol-pilot-measures-SYNTHETIC-2026-11-04.csv", 7)).toEqual({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="parol-pilot-measures-SYNTHETIC-2026-11-04.csv"',
      "content-length": "7",
    });
  });
});

describe("the calendar form", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
  });

  it("saves the date as the person who asked, tells them so, and shows the five weeks from it", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.pilot());
    const before = counts(site);
    const response = await admin.submit(page, urls.pilotCalendar(), {
      set: { startDate: "2026-11-09" },
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${urls.pilot()}?notice=calendar-saved&nt=`)).toBe(true);
    const after = counts(site);
    expect(after.calendar).toBe(before.calendar! + 1);
    expect(after.audit).toBe(before.audit! + 1);
    const event = site.w.repo.listAuditEvents({ action: "pilot.calendar" }).at(-1)!;
    expect(event.actorId).toBe(IDS.admin);
    expect(event.matterId).toBeNull();
    expect(event.detail).toEqual({ startDate: "2026-11-09", previousStartDate: null });

    const next = await admin.page(location);
    expect(noticeOf(next)).toContain("The start date of the pilot was saved.");
    expect(readable(byTag(next.root, "main")[0]!)).toContain(
      "The pilot starts on 2026-11-09 and week 5 ends on 2026-12-13, counted in UTC.",
    );
    const input = byId(next.root, "start-date")!;
    expect(attr(input, "value")).toBe("2026-11-09");
    // Another date replaces it, and the first is kept in the history.
    const again = await admin.submit(next, urls.pilotCalendar(), {
      set: { startDate: "2026-11-16" },
    });
    expect(again.status).toBe(303);
    expect(site.w.repo.getPilotCalendar()).toMatchObject({ startDate: "2026-11-16", timesSet: 2 });
  });

  it("lets the legal engineer do the same", async () => {
    const engineer = await site.as(IDS.legalEngineer);
    const page = await engineer.page(urls.pilot());
    const response = await engineer.submit(page, urls.pilotCalendar(), {
      set: { startDate: "2026-11-23" },
    });
    expect(response.status).toBe(303);
    expect(site.w.repo.listAuditEvents({ action: "pilot.calendar" }).at(-1)!.actorId).toBe(
      IDS.legalEngineer,
    );
  });

  for (const bad of ["2026-02-30", "09/11/2026", "", "2026-13-01"]) {
    it(`answers a date that is not a real one with a page: ${JSON.stringify(bad)}`, async () => {
      const admin = await site.as(IDS.admin);
      const page = await admin.page(urls.pilot());
      const before = counts(site);
      const response = await admin.submit(page, urls.pilotCalendar(), { set: { startDate: bad } });
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      const refused = { html: await response.text() };
      const root = expectAccessible(refused.html);
      const alert = all(root, (el) => attr(el, "role") === "alert")[0]!;
      expect(readable(alert)).toContain("The start date is not a real date.");
      expect(readable(alert)).toContain(
        "Enter the first day of the pilot as year-month-day, for example 2026-11-09.",
      );
      // The jump leads to the control that is wrong, and the control is there.
      const jump = all(alert, (el) => el.name === "a")[0]!;
      expect(attr(jump, "href")).toBe("#start-date");
      expect(byId(root, "start-date")).toBeDefined();
      // What was typed is shown again, and nothing was written.
      expect(attr(byId(root, "start-date")!, "value") ?? "").toBe(bad);
      expect(counts(site)).toEqual(before);
    });
  }

  it("refuses a field the form does not offer, and writes nothing", async () => {
    const admin = await site.as(IDS.admin);
    const before = counts(site);
    for (const extra of [
      { startDate: "2026-11-09", role: "admin" },
      { startDate: "2026-11-09", setBy: MARK },
    ]) {
      const response = await post(admin, urls.pilotCalendar(), extra);
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(MARK);
    }
    expect(counts(site)).toEqual(before);
  });

  it("needs the token: none, a wrong one and another session's token are each a 403 that writes nothing", async () => {
    const admin = await site.as(IDS.admin);
    const other = await site.as(IDS.legalEngineer);
    const before = counts(site);
    for (const token of [null, "wrong", await other.apiToken()]) {
      const response = await post(admin, urls.pilotCalendar(), { startDate: "2026-12-01" }, token);
      expect(response.status, String(token)).toBe(403);
    }
    expect(counts(site)).toEqual(before);
  });

  it("is refused to a member with the token, and to a visitor, and writes nothing", async () => {
    const before = counts(site);
    const fp = fingerprint(site);
    for (const userId of [IDS.associate, IDS.reviewer, VIEWER, OUTSIDER]) {
      const browser = await site.as(userId);
      const response = await post(browser, urls.pilotCalendar(), { startDate: "2026-12-01" });
      expect(response.status, userId).toBe(403);
    }
    const visitor = await post(
      site.anonymous(),
      urls.pilotCalendar(),
      { startDate: "2026-12-01" },
      "x",
    );
    expect([303, 403]).toContain(visitor.status);
    expect(counts(site)).toEqual(before);
    expect(fingerprint(site)).toEqual(fp);
  });

  it("writes the event in the same transaction as the date, and logs and shows nothing it was given", async () => {
    const admin = await site.as(IDS.admin);
    const response = await post(admin, urls.pilotCalendar(), { startDate: `${MARK}<b>` });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).not.toContain(`<b>`);
    expect(site.logs.join("\n")).not.toContain(MARK);
    expect(JSON.stringify(site.w.repo.listAuditEvents({ limit: 10_000 }))).not.toContain(MARK);
    // A refusal left no calendar and no event of its own.
    const calendarEvents = site.w.repo.listAuditEvents({ action: "pilot.calendar" });
    expect(calendarEvents.length).toBe(site.w.repo.getPilotCalendar()?.timesSet);
  });
});

describe("the roster form", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
  });

  it("records the people who were ticked, replacing the list, and audits who was added and removed", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.pilot());
    const response = await admin.submit(page, urls.pilotParticipants(), {
      set: {
        [trainedField(IDS.associate)]: "yes",
        [trainedField(IDS.reviewer)]: "yes",
      },
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${urls.pilot()}?notice=participants-saved&nt=`)).toBe(true);
    expect(
      site.w.repo
        .listPilotParticipants()
        .map((p) => p.userId)
        .sort(),
    ).toEqual([IDS.associate, IDS.reviewer].sort());
    const next = await admin.page(location);
    expect(noticeOf(next)).toContain("The list of trained people was saved.");
    const ticked = all(
      next.root,
      (el) =>
        el.name === "input" &&
        attr(el, "type") === "checkbox" &&
        el.attrs.some((a) => a.name === "checked"),
    );
    expect(ticked.map((el) => attr(el, "name")).sort()).toEqual(
      [IDS.associate, IDS.reviewer].map(trainedField).sort(),
    );

    // A smaller list removes the person left out.
    const second = await admin.submit(next, urls.pilotParticipants(), {
      set: { [trainedField(IDS.reviewer)]: "yes" },
    });
    expect(second.status).toBe(303);
    // (the form carried the earlier ticks, so the associate is ticked still: untick through a post)
    const third = await post(admin, urls.pilotParticipants(), {
      [trainedField(IDS.reviewer)]: "yes",
    });
    expect(third.status).toBe(303);
    expect(site.w.repo.listPilotParticipants().map((p) => p.userId)).toEqual([IDS.reviewer]);
    const event = site.w.repo.listAuditEvents({ action: "pilot.participants" }).at(-1)!;
    expect(event.actorId).toBe(IDS.admin);
    expect(event.detail).toEqual({ added: [], removed: [IDS.associate], total: 1 });
    // And an empty list is a list: nobody was trained.
    const none = await post(admin, urls.pilotParticipants(), {});
    expect(none.status).toBe(303);
    expect(site.w.repo.listPilotParticipants()).toEqual([]);
  });

  it("answers a person who is not a user, a field the form does not offer and too many people with a page", async () => {
    const admin = await site.as(IDS.admin);
    const before = counts(site);
    const unknown = await post(admin, urls.pilotParticipants(), {
      [trainedField("usr_nobody")]: "yes",
      [trainedField(IDS.associate)]: "yes",
    });
    expect(unknown.status).toBe(400);
    const html = await unknown.text();
    const root = expectAccessible(html);
    const alert = all(root, (el) => attr(el, "role") === "alert")[0]!;
    expect(readable(alert)).toContain("The list names a person who is not a user of Parol.");
    expect(attr(all(alert, (el) => el.name === "a")[0]!, "href")).toBe("#participants");
    expect(byId(root, "participants")).toBeDefined();
    // What was ticked is shown again.
    const stillTicked = all(
      root,
      (el) =>
        el.name === "input" &&
        attr(el, "type") === "checkbox" &&
        el.attrs.some((a) => a.name === "checked"),
    );
    expect(stillTicked.map((el) => attr(el, "name"))).toEqual([trainedField(IDS.associate)]);

    const stray = await post(admin, urls.pilotParticipants(), {
      [trainedField(IDS.associate)]: "yes",
      globalRole: "admin",
    });
    expect(stray.status).toBe(400);
    const notYes = await post(admin, urls.pilotParticipants(), {
      [trainedField(IDS.associate)]: "no",
    });
    expect(notYes.status).toBe(400);
    const crowd = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [trainedField(`usr_${i}`), "yes"]),
    );
    const many = await post(admin, urls.pilotParticipants(), crowd);
    expect(many.status).toBe(400);
    expect(
      readable(all(expectAccessible(await many.text()), (el) => attr(el, "role") === "alert")[0]!),
    ).toContain("more than 64 people");
    expect(counts(site)).toEqual(before);
  });

  it("needs the token and a global role that holds pilot.manage, and writes nothing otherwise", async () => {
    const admin = await site.as(IDS.admin);
    const before = counts(site);
    for (const token of [null, "wrong"])
      expect(
        (
          await post(
            admin,
            urls.pilotParticipants(),
            { [trainedField(IDS.associate)]: "yes" },
            token,
          )
        ).status,
      ).toBe(403);
    for (const userId of [IDS.associate, IDS.reviewer, VIEWER, OUTSIDER]) {
      const browser = await site.as(userId);
      expect(
        (await post(browser, urls.pilotParticipants(), { [trainedField(IDS.associate)]: "yes" }))
          .status,
        userId,
      ).toBe(403);
    }
    expect(counts(site)).toEqual(before);
  });
});

describe("the timer", () => {
  let site: Site;
  let matterId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = newMatter(site.w).matterId;
    addMember(site, matterId, VIEWER, "viewer");
  });
  const timer = (
    browser: Browser,
    intent: string,
    id = matterId,
    extra: Record<string, string> = {},
  ) => post(browser, urls.matterTimer(id), { intent, ...extra });

  it("starts for an associate, refuses a second start in words, and stops, each audited by the person", async () => {
    const associate = await site.as(IDS.associate);
    const started = await timer(associate, "start");
    expect(started.status).toBe(303);
    const location = started.headers.get("location") ?? "";
    expect(location.startsWith(`${urls.matter(matterId)}?notice=timer-started&nt=`)).toBe(true);
    const page = await associate.page(location);
    expect(noticeOf(page)).toContain("The timer is running.");
    expect(
      site.w.services.pilot.timer(site.w.grant(site.w.associate, matterId)).running,
    ).not.toBeNull();

    const before = counts(site);
    const again = await timer(associate, "start");
    expect(again.status).toBe(409);
    const root = accessibleMatterPage(await again.text());
    const alert = all(root, (el) => attr(el, "role") === "alert")[0]!;
    expect(readable(alert)).toContain(
      "You already have a timer running. Stop it before starting another one.",
    );
    expect(counts(site)).toEqual(before);

    const stopped = await timer(associate, "stop");
    expect(stopped.status).toBe(303);
    expect(
      (stopped.headers.get("location") ?? "").startsWith(
        `${urls.matter(matterId)}?notice=timer-stopped&nt=`,
      ),
    ).toBe(true);
    const none = await timer(associate, "stop");
    expect(none.status).toBe(409);
    const noneAlert = all(
      accessibleMatterPage(await none.text()),
      (el) => attr(el, "role") === "alert",
    )[0]!;
    expect(readable(noneAlert)).toContain(
      "No timer is running on this matter. Press Start timer to begin one.",
    );
    expect(attr(all(noneAlert, (el) => el.name === "a")[0]!, "href")).toBe("#time");

    const events = site.w.repo.listAuditEvents({ matterId });
    const start = events.filter((e) => e.action === "time.start");
    const stop = events.filter((e) => e.action === "time.stop");
    expect(start).toHaveLength(1);
    expect(stop).toHaveLength(1);
    expect(start[0]!.actorId).toBe(IDS.associate);
    expect(stop[0]!.actorId).toBe(IDS.associate);
    expect(stop[0]!.detail).toMatchObject({ role: "associate" });
  });

  it("lets the reviewer time the matter as well, as the reviewer", async () => {
    const reviewer = await site.as(IDS.reviewer);
    expect((await timer(reviewer, "start")).status).toBe(303);
    expect((await timer(reviewer, "stop")).status).toBe(303);
    const entry = site.w.repo.db
      .prepare("SELECT role, user_id FROM time_entries WHERE matter_id = ? AND user_id = ?")
      .get(matterId, IDS.reviewer) as { role: string; user_id: string };
    expect(entry.role).toBe("reviewer");
  });

  it("refuses a viewer, an outsider and an administrator who is not a member, writing nothing", async () => {
    const before = counts(site);
    const viewer = await timer(await site.as(VIEWER), "start");
    expect(viewer.status).toBe(403);
    for (const userId of [OUTSIDER, IDS.admin, OTHER_ASSOCIATE])
      expect((await timer(await site.as(userId), "start")).status, userId).toBe(404);
    expect(
      (await timer(await site.as(IDS.associate), "start", "mat_0000000000000000")).status,
    ).toBe(404);
    expect(counts(site)).toEqual(before);
  });

  it("answers a person with no part in the matter as it answers for a matter that does not exist", async () => {
    const outsider = await site.as(OUTSIDER);
    const real = await timer(outsider, "start");
    const missing = await timer(outsider, "start", "mat_0000000000000000");
    expect(real.status).toBe(missing.status);
    expect(await real.text()).toBe(await missing.text());
  });

  it("refuses an intent that is not start or stop and a field the form does not offer, as a bad request", async () => {
    const associate = await site.as(IDS.associate);
    const before = counts(site);
    for (const fields of [
      { intent: "pause" },
      { intent: "" },
      { intent: "START" },
      { intent: "start", userId: IDS.reviewer },
      { intent: "start", matterId: "mat_0000000000000000" },
      {},
    ]) {
      const response = await post(associate, urls.matterTimer(matterId), fields);
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(await response.text()).toContain("That request was not valid.");
    }
    expect(counts(site)).toEqual(before);
  });

  it("needs the token: none, a wrong one and another session's are each a 403 that writes nothing", async () => {
    const associate = await site.as(IDS.associate);
    const other = await site.as(IDS.reviewer);
    const before = counts(site);
    for (const token of [null, "wrong", await other.apiToken()])
      expect(
        (await post(associate, urls.matterTimer(matterId), { intent: "start" }, token)).status,
        String(token),
      ).toBe(403);
    expect(
      (
        await site
          .anonymous()
          .send("POST", urls.matterTimer(matterId), { headers: FORM, body: "intent=start" })
      ).status,
    ).toBe(303);
    expect(counts(site)).toEqual(before);
  });

  it("is the signed-in person's own timer: a field naming another person changes nothing about whose it is", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const response = await post(reviewer, urls.matterTimer(matterId), {
      intent: "start",
      userId: IDS.associate,
    });
    expect(response.status).toBe(400);
    expect(
      site.w.repo.db
        .prepare("SELECT COUNT(*) AS n FROM time_entries WHERE stopped_at IS NULL")
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("the reference list", () => {
  let site: Site;
  let matterId: string;
  beforeAll(() => {
    site = makeSite();
    matterId = newMatter(site.w).matterId;
    addMember(site, matterId, VIEWER, "viewer");
  });
  const list = (browser: Browser, fields: Record<string, string>, id = matterId) =>
    post(browser, urls.matterReferenceList(id), fields);
  const rows = () =>
    site.w.repo.db
      .prepare(
        "SELECT rule_key, severity FROM reference_issues WHERE matter_id = ? ORDER BY ordinal",
      )
      .all(matterId) as { rule_key: string | null; severity: string }[];

  it("is saved by the reviewer, who is told so, as a severity for some rules and a count for the rest", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const response = await list(reviewer, {
      "severity:dur-1": "high",
      "severity:pds-1": "medium",
      "severity:pds-2": "",
      outsideHigh: "1",
      outsideMedium: "",
      outsideLow: "2",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location.startsWith(`${urls.matter(matterId)}?notice=reference-saved&nt=`)).toBe(true);
    expect(noticeOf(await reviewer.page(location))).toContain("The reference list was saved.");
    expect(rows()).toEqual([
      { rule_key: "pds-1", severity: "medium" },
      { rule_key: "dur-1", severity: "high" },
      { rule_key: null, severity: "high" },
      { rule_key: null, severity: "low" },
      { rule_key: null, severity: "low" },
    ]);
    const event = site.w.repo
      .listAuditEvents({ matterId })
      .find((e) => e.action === "reference.save")!;
    expect(event.actorId).toBe(IDS.reviewer);
    expect(event.detail).toMatchObject({
      issues: 5,
      outsideHigh: 1,
      outsideMedium: 0,
      outsideLow: 2,
    });
    // The set replaces the list.
    expect((await list(reviewer, { outsideHigh: "0" })).status).toBe(303);
    expect(rows()).toEqual([]);
  });

  it("is refused to an associate and a viewer, and not found by an outsider, writing nothing", async () => {
    const before = counts(site);
    expect((await list(await site.as(IDS.associate), { "severity:dur-1": "high" })).status).toBe(
      403,
    );
    expect((await list(await site.as(VIEWER), { "severity:dur-1": "high" })).status).toBe(403);
    for (const userId of [OUTSIDER, IDS.admin])
      expect((await list(await site.as(userId), { "severity:dur-1": "high" })).status, userId).toBe(
        404,
      );
    expect(counts(site)).toEqual(before);
  });

  it("answers a rule that is not the playbook's, a severity that is not one and a count out of range, in words", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const before = counts(site);
    const cases: [Record<string, string>, string, string | null][] = [
      [{ "severity:not-a-rule": "high" }, "That rule is not in the playbook of this matter.", null],
      [
        { "severity:dur-1": "urgent" },
        "That severity is not one of the choices.",
        "#reference-list",
      ],
      [{ outsideHigh: "x" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideMedium: "10" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideLow: "-1" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideLow: "1.5" }, "That is not a count the list can hold.", "#reference-outside"],
      // Forms of a number that a script would read and a person would not write.
      [{ outsideHigh: "0x5" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideMedium: "1e0" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideLow: "+3" }, "That is not a count the list can hold.", "#reference-outside"],
      [{ outsideLow: "5 5" }, "That is not a count the list can hold.", "#reference-outside"],
    ];
    for (const [fields, phrase, jump] of cases) {
      const response = await list(reviewer, fields);
      expect(response.status, JSON.stringify(fields)).toBe(400);
      const root = accessibleMatterPage(await response.text());
      const alert = all(root, (el) => attr(el, "role") === "alert")[0]!;
      expect(readable(alert), JSON.stringify(fields)).toContain(phrase);
      const link = all(alert, (el) => el.name === "a")[0];
      expect(link === undefined ? null : attr(link, "href")).toBe(jump);
    }
    const stray = await list(reviewer, { "severity:dur-1": "high", role: "reviewer" });
    expect(stray.status).toBe(400);
    expect(counts(site)).toEqual(before);
  });

  it("needs the token: none, a wrong one and another session's are each a 403 that writes nothing", async () => {
    const reviewer = await site.as(IDS.reviewer);
    const other = await site.as(IDS.associate);
    const before = counts(site);
    for (const token of [null, "wrong", await other.apiToken()])
      expect(
        (
          await post(
            reviewer,
            urls.matterReferenceList(matterId),
            { "severity:dur-1": "high" },
            token,
          )
        ).status,
        String(token),
      ).toBe(403);
    expect(counts(site)).toEqual(before);
  });

  it("is closed once a review has started: 409 with the words, and the list as it was left", async () => {
    const reviewer = await site.as(IDS.reviewer);
    expect((await list(reviewer, { "severity:dur-1": "high" })).status).toBe(303);
    const am = site.w.grant(site.w.associate, matterId);
    await uploadCase(site.w, matterId);
    site.w.services.runs.start(am, { workflowLabel: "v2" });
    await site.w.services.runs.idle();
    const before = counts(site);
    const response = await list(reviewer, { "severity:pds-1": "low" });
    expect(response.status).toBe(409);
    const alert = all(
      accessibleMatterPage(await response.text()),
      (el) => attr(el, "role") === "alert",
    )[0]!;
    expect(readable(alert)).toContain(
      "A review has started on this matter, so its reference list is closed.",
    );
    expect(readable(alert)).toContain("Report anything the review missed on the review page.");
    expect(counts(site)).toEqual(before);
    expect(rows()).toEqual([{ rule_key: "dur-1", severity: "high" }]);
  });
});

describe("a write and its event", () => {
  /** Makes the audit log refuse the event of one action, so that a change which wrote it separately would be left behind. */
  const refuseEvent = (site: Site, action: string): void => {
    site.w.repo.db.exec(`CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = '${action}'
      BEGIN SELECT RAISE(ABORT, 'parol-test: audit event refused'); END`);
  };
  const allowEvents = (site: Site): void => {
    site.w.repo.db.exec("DROP TRIGGER zz_refuse_audit");
  };

  it("commit together or not at all: when the event is refused the route does not say it was done and nothing is left", async () => {
    const site = makeSite();
    const { matterId } = newMatter(site.w);
    const admin = await site.as(IDS.admin);
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);
    const cases: [string, () => Promise<Response>][] = [
      ["pilot.calendar", () => post(admin, urls.pilotCalendar(), { startDate: "2026-11-09" })],
      [
        "pilot.participants",
        () => post(admin, urls.pilotParticipants(), { [trainedField(IDS.associate)]: "yes" }),
      ],
      ["time.start", () => post(associate, urls.matterTimer(matterId), { intent: "start" })],
      [
        "reference.save",
        () => post(reviewer, urls.matterReferenceList(matterId), { "severity:dur-1": "high" }),
      ],
    ];
    for (const [action, send] of cases) {
      const before = counts(site);
      refuseEvent(site, action);
      const response = await send();
      allowEvents(site);
      expect(response.status, action).toBe(500);
      expect(counts(site), action).toEqual(before);
    }
    // The stop is refused the same way: the timer is still running afterwards.
    expect((await post(associate, urls.matterTimer(matterId), { intent: "start" })).status).toBe(
      303,
    );
    const running = counts(site);
    refuseEvent(site, "time.stop");
    const stop = await post(associate, urls.matterTimer(matterId), { intent: "stop" });
    allowEvents(site);
    expect(stop.status).toBe(500);
    expect(counts(site)).toEqual(running);
    expect(
      site.w.services.pilot.timer(site.w.grant(site.w.associate, matterId)).running,
    ).not.toBeNull();
  });

  it("is written once, by the person who did it, for every route that writes", async () => {
    const site = makeSite();
    const { matterId } = newMatter(site.w);
    const admin = await site.as(IDS.admin);
    const associate = await site.as(IDS.associate);
    const reviewer = await site.as(IDS.reviewer);
    const before = counts(site).audit!;
    await post(admin, urls.pilotCalendar(), { startDate: "2026-11-09" });
    await post(admin, urls.pilotParticipants(), { [trainedField(IDS.associate)]: "yes" });
    await post(associate, urls.matterTimer(matterId), { intent: "start" });
    await post(associate, urls.matterTimer(matterId), { intent: "stop" });
    await post(reviewer, urls.matterReferenceList(matterId), { "severity:dur-1": "high" });
    const events = site.w.repo.listAuditEvents({ afterSeq: 0, limit: 10_000 }).slice(before);
    expect(events.map((e) => [e.action, e.actorId, e.matterId])).toEqual([
      ["pilot.calendar", IDS.admin, null],
      ["pilot.participants", IDS.admin, null],
      ["time.start", IDS.associate, matterId],
      ["time.stop", IDS.associate, matterId],
      ["reference.save", IDS.reviewer, matterId],
    ]);
    // Reads, refusals and a repeated start write none.
    await admin.get(urls.pilot());
    await post(associate, urls.matterTimer(matterId), { intent: "stop" });
    await post(associate, urls.matterTimer(matterId), { intent: "pause" });
    expect(counts(site).audit).toBe(before + 5);
  });
});

describe("what is logged", () => {
  it("names the route's template and no text from a request, a matter or a person", async () => {
    const site = makeSite();
    const { matterId } = newMatter(site.w, `Matter ${MARK}`);
    const admin = await site.as(IDS.admin);
    const reviewer = await site.as(IDS.reviewer);
    await post(admin, urls.pilotCalendar(), { startDate: `${MARK}-date` });
    await post(admin, urls.pilotParticipants(), { [trainedField(`${MARK}-user`)]: "yes" });
    await post(reviewer, urls.matterTimer(matterId), { intent: MARK });
    await post(reviewer, urls.matterReferenceList(matterId), { [`severity:${MARK}`]: "high" });
    await admin.get(`${urls.pilot()}?scope=${MARK}`);
    const text = site.logs.join("\n");
    expect(text).toContain("/matters/:matterId/timer");
    expect(text).toContain("/pilot/calendar");
    expect(text).not.toContain(MARK);
    expect(JSON.stringify(site.w.repo.listAuditEvents({ limit: 10_000 }))).not.toContain(MARK);
  });
});
