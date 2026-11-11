import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runRetention } from "../../src/retention/job.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible } from "../a11y/rules.js";
import { factsOf } from "../pages/audit-support.js";
import { all, byTag, hasClass, readable, section } from "../pages/html.js";
import { dropAuditTriggers } from "../store/audit-tamper.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  checkPage,
  cleanup,
  fingerprint,
  makeSite,
  newMatter,
  routeFor,
  type Browser,
  type Site,
} from "./support.js";

/**
 * `GET /audit`: the audit log page (package W2.7, slice C). It names no matter and is for an
 * administrator. These tests send real requests to the real application: who is let in and who is
 * not, what the page says about a log that holds and one that has been tampered with, that opening
 * it changes nothing, and that nothing a tampered row holds reaches the page.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MARK = "QZMARK-audit-route-5ae2";

describe("who may open the audit log page", () => {
  let site: Site;
  beforeAll(() => {
    site = makeSite();
    newMatter(site.w);
  });

  it("is a route of the application that checks the global action audit.read", () => {
    expect(routeFor(site.app, "GET", urls.audit())).toBe("GET /audit");
  });

  it("sends a visitor with no session to sign in", async () => {
    const response = await site.anonymous().get(urls.audit());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(urls.home());
  });

  it("answers 403 to everyone who is not an administrator, with nothing of the page in the answer", async () => {
    for (const userId of [
      IDS.associate,
      IDS.reviewer,
      VIEWER,
      OUTSIDER,
      OTHER_ASSOCIATE,
      IDS.legalEngineer,
    ]) {
      const before = fingerprint(site);
      const response = await (await site.as(userId)).get(urls.audit());
      const body = await response.text();
      expect(response.status, userId).toBe(403);
      expect(response.headers.get("content-type"), userId).toMatch(/^text\/html/);
      expect(body, userId).not.toContain("Audit log check");
      expect(body, userId).not.toContain("Events checked");
      expect(body, userId).not.toContain("audit.read");
      expect(body, userId).not.toMatch(/[0-9a-f]{64}/);
      expect(body, userId).not.toMatch(/mat_[0-9a-f]{16}/);
      expect(fingerprint(site)).toEqual(before);
    }
  });

  it("lets in the administrator, with a page that passes the rules every page has", async () => {
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.audit());
    expect(page.response.headers.get("content-type")).toMatch(/^text\/html/);
    checkPage(site, page);
    expectAccessible(page.html);
    expect(readable(byTag(page.root, "h1")[0]!)).toBe("Audit log check");
  });

  it("answers no other method at the address: the page has no form and no write", async () => {
    const admin = await site.as(IDS.admin);
    const before = fingerprint(site);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await admin.send(method, urls.audit())).status, method).toBe(404);
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("the navigation", () => {
  it("shows the Audit log link to an administrator and to nobody else", async () => {
    const site = makeSite();
    const links = async (userId: string): Promise<string[]> => {
      const page = await (await site.as(userId)).page(urls.matters());
      return all(page.root, (el) => el.name === "a" && hasClass(el, "brand") === false)
        .filter((el) => el.attrs.some((a) => a.name === "href" && a.value === urls.audit()))
        .map((el) => readable(el));
    };
    expect(await links(IDS.admin)).toEqual(["Audit log"]);
    for (const userId of [IDS.associate, IDS.reviewer, IDS.legalEngineer, VIEWER, OUTSIDER])
      expect(await links(userId), userId).toEqual([]);
  });

  it("leads the administrator to a page that opens", async () => {
    const site = makeSite();
    const admin = await site.as(IDS.admin);
    const start = await admin.page(urls.matters());
    const link = all(
      start.root,
      (el) =>
        el.name === "a" && el.attrs.some((a) => a.name === "href" && a.value === urls.audit()),
    )[0]!;
    expect(readable(link)).toBe("Audit log");
    expect((await admin.get(urls.audit())).status).toBe(200);
  });
});

describe("what the page says about a log that holds", () => {
  it("states the events, the head, the matters and the retention date, each against its whole", async () => {
    const site = makeSite();
    newMatter(site.w, "First");
    newMatter(site.w, "Second");
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.audit());
    const total = site.w.repo.countAuditEvents();
    const head = site.w.repo.auditHead()!;
    const chain = readable(section(page.root, "audit-chain"));
    expect(chain).toContain("Intact");
    expect(chain).toContain(`Events checked: ${total} of ${total} in the log.`);
    expect(chain).toContain(`Event ${head.seq}`);
    expect(chain).toContain(head.hash);
    const matters = readable(section(page.root, "audit-matters"));
    expect(matters).toContain("2 matters");
    expect(matters).toContain("No matter is missing a creation or a deletion event.");
    expect(readable(section(page.root, "audit-retention"))).toContain(
      "0 of 2 matters are past their retention date.",
    );
  });

  it("reads the log when the page is opened, not before: a new event is in the next page", async () => {
    const site = makeSite();
    const admin = await site.as(IDS.admin);
    const first = readable(section((await admin.page(urls.audit())).root, "audit-chain"));
    newMatter(site.w);
    const second = readable(section((await admin.page(urls.audit())).root, "audit-chain"));
    expect(second).not.toBe(first);
    const total = site.w.repo.countAuditEvents();
    expect(second).toContain(`Events checked: ${total} of ${total} in the log.`);
  });

  it("changes nothing: opening the page writes no audit event and no row", async () => {
    const site = makeSite();
    newMatter(site.w);
    const admin = await site.as(IDS.admin);
    const before = fingerprint(site);
    const events = site.w.repo.countAuditEvents();
    for (let i = 0; i < 3; i++) await admin.page(urls.audit());
    expect(fingerprint(site)).toEqual(before);
    expect(site.w.repo.countAuditEvents()).toBe(events);
  });

  it("ignores the query and never echoes it", async () => {
    const site = makeSite();
    const admin = await site.as(IDS.admin);
    const plain = await admin.page(urls.audit());
    const asked = await admin.page(`${urls.audit()}?q=${MARK}&matter=mat_0123456789abcdef&seq=1`);
    expect(asked.html).not.toContain(MARK);
    expect(asked.html).not.toContain("mat_0123456789abcdef");
    expect(readable(byTag(asked.root, "main")[0]!)).toBe(readable(byTag(plain.root, "main")[0]!));
  });
});

describe("what the page says about a log that has been tampered with", () => {
  it("says Broken, where, and why, and shows nothing of the altered row", async () => {
    const site = makeSite();
    newMatter(site.w);
    newMatter(site.w);
    const db = site.w.repo.db;
    dropAuditTriggers(db);
    db.prepare("UPDATE audit_events SET actor_id = ?, target_id = ? WHERE seq = 3").run(
      `usr_${MARK}`,
      `${MARK}-target`,
    );
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.audit());
    const chain = readable(section(page.root, "audit-chain"));
    const total = site.w.repo.countAuditEvents();
    expect(chain).toContain("Broken");
    expect(chain).not.toContain("Intact");
    expect(chain).toContain(
      "The chain breaks at event 3: this event's content does not match its hash (hash_mismatch).",
    );
    expect(chain).toContain(`Events that check out before it: 2 of ${total} in the log.`);
    expect(chain).toContain("Nothing from event 3 on can be trusted.");
    expect(page.html).not.toContain(MARK);
    checkPage(site, page);
    expectAccessible(page.html);
  });

  it("is still a 200 page, because a broken log is a result and not an error", async () => {
    const site = makeSite();
    newMatter(site.w);
    dropAuditTriggers(site.w.repo.db);
    site.w.repo.db.prepare("UPDATE audit_events SET action = 'matter.update' WHERE seq = 1").run();
    const response = await (await site.as(IDS.admin)).get(urls.audit());
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Broken");
  });

  it("lists a matter that vanished without a deletion event, by its id, and says nothing else of it", async () => {
    const site = makeSite();
    const keep = newMatter(site.w, `Kept ${MARK}`);
    const gone = newMatter(site.w, `Gone ${MARK}`);
    site.w.repo.db.prepare("DELETE FROM matters WHERE id = ?").run(gone.matterId);
    const admin = await site.as(IDS.admin);
    const page = await admin.page(urls.audit());
    const matters = section(page.root, "audit-matters");
    expect(readable(matters)).toContain("Not accounted for");
    expect(factsOf(page.root, "audit-matters")).toMatchObject({
      Created: "2 matters with a creation event",
      "Gone, no deletion event": "1 of 2 created",
      "In the database": "1 matter",
    });
    const ids = all(matters, (el) => el.name === "code").map((el) => readable(el));
    expect(ids).toEqual([gone.matterId]);
    expect(page.html).not.toContain(keep.matterId);
    expect(page.html).not.toContain(MARK);
    // The chain itself holds: only the matters do not add up.
    expect(readable(section(page.root, "audit-chain"))).toContain("Intact");
    expectAccessible(page.html);
  });

  it("does not list an id that a row holds if it is not the id of a matter", async () => {
    const site = makeSite();
    const made = newMatter(site.w);
    dropAuditTriggers(site.w.repo.db);
    site.w.repo.db
      .prepare(
        "UPDATE audit_events SET matter_id = ? WHERE action = 'matter.create' AND matter_id = ?",
      )
      .run(`<i>${MARK}</i>`, made.matterId);
    const page = await (await site.as(IDS.admin)).page(urls.audit());
    expect(page.html).not.toContain(MARK);
    // The matter is still counted as present with no creation event, by its true id.
    const ids = all(section(page.root, "audit-matters"), (el) => el.name === "code").map((el) =>
      readable(el),
    );
    expect(ids).toEqual([made.matterId]);
  });
});

describe("what the page says about retention", () => {
  let site: Site;
  let admin: Browser;
  beforeAll(async () => {
    site = makeSite();
    admin = await site.as(IDS.admin);
  });

  it("says no run is recorded until the job has run with --apply", async () => {
    newMatter(site.w);
    const page = await admin.page(urls.audit());
    expect(readable(section(page.root, "audit-retention"))).toContain(
      "No retention run is recorded. The operator runs pnpm parol:retain.",
    );
  });

  it("says what the last run did, against the matters it found, once the job has run", async () => {
    const late = new Date("2027-01-15T09:00:00.000Z");
    const dry = runRetention(
      { repo: site.w.repo, files: site.w.files, now: () => late },
      { apply: false, maxMatters: 25 },
    );
    expect(dry.expired).toBeGreaterThan(0);
    // The page judges at the clock of the site; the job at the moment it is given.
    expect(readable(section((await admin.page(urls.audit())).root, "audit-retention"))).toContain(
      "No retention run is recorded",
    );
    const report = runRetention(
      { repo: site.w.repo, files: site.w.files, now: () => late },
      { apply: true, maxMatters: 25 },
    );
    const page = await admin.page(urls.audit());
    const text = readable(section(page.root, "audit-retention"));
    expect(text).toContain("Last retention run: event ");
    expect(text).toContain(
      `Of ${report.expired} ${report.expired === 1 ? "matter" : "matters"} past their date, ${report.deleted} deleted, ${report.skipped} skipped, ${report.failed} failed.`,
    );
    expect(text).toContain("Compaction of the database: done.");
    expect(text).not.toContain("No retention run is recorded");
    // The matters are gone with their deletion events, so the log accounts for them.
    expect(readable(section(page.root, "audit-matters"))).toContain(
      "No matter is missing a creation or a deletion event.",
    );
    expectAccessible(page.html);
  });
});
