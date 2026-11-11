import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import { describeRoutes } from "../../src/server/matter-route.js";
import { urls } from "../../src/server/urls.js";
import { TRAINER_NOTES, TRAINING_STEPS } from "../../src/training/index.js";
import { expectAccessible } from "../a11y/rules.js";
import { attr, byTag, readable, type El } from "../pages/html.js";
import { simulatedModel } from "../training/support.js";
import {
  IDS,
  OTHER_ASSOCIATE,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  type Site,
} from "./support.js";

/**
 * `GET /training/key` through the real shell and the real route (package W2.8). The trainer's key
 * is for the legal engineer and the administrators (`training.key`): they get the page, a member
 * gets the shell's 403 with nothing of the page, and a visitor is sent to sign in. The page
 * reads and changes nothing, so no other method is registered on the URL.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let site: Site;
beforeAll(() => {
  site = makeSite({ model2: simulatedModel() });
});

/** The seven answers, so that a body can be searched for each, and the first words of the notes. */
const ANSWERS = TRAINING_STEPS.map((step) => step.key);
const NOTE_HEADINGS = TRAINER_NOTES.map((note) => note.heading);

const MEMBERS = [
  ["the associate", IDS.associate],
  ["the reviewer", IDS.reviewer],
  ["a viewer", VIEWER],
  ["an outsider", OUTSIDER],
  ["another associate", OTHER_ASSOCIATE],
] as const;

describe("who may open the trainer's key", () => {
  for (const [who, userId] of [
    ["the legal engineer", IDS.legalEngineer],
    ["the administrator", IDS.admin],
  ] as const)
    it(`lets in ${who}, with every answer and every note, as a whole page`, async () => {
      const browser = await site.as(userId);
      const page = await browser.page(urls.trainerKey());
      expect(page.response.status).toBe(200);
      expect(page.response.headers.get("content-type")).toMatch(/^text\/html/);
      const text = readable(byTag(page.root, "main")[0] as El);
      for (const answer of ANSWERS) expect(text).toContain(answer);
      for (const heading of NOTE_HEADINGS) expect(text).toContain(heading);
      expect(readable(byTag(page.root, "h1")[0] as El)).toBe("Trainer's key");
      expect(attr(byTag(page.root, "main")[0] as El, "id")).toBe("main");
      expectAccessible(page.html);
    });

  for (const [who, userId] of MEMBERS)
    it(`refuses ${who}, a member, with the shell's 403 and not one answer`, async () => {
      const browser = await site.as(userId);
      const response = await browser.get(urls.trainerKey());
      expect(response.status).toBe(403);
      const body = await response.text();
      expect(body).toContain("<h1>");
      for (const answer of ANSWERS) expect(body).not.toContain(answer);
      for (const heading of NOTE_HEADINGS) expect(body).not.toContain(heading);
      expect(body.toLowerCase()).not.toContain("pds-1");
      expect(body).not.toContain("Answer key");
    });

  it("gives every member the same body, whoever they are", async () => {
    const bodies = new Set<string>();
    for (const [, userId] of MEMBERS) {
      const browser = await site.as(userId);
      bodies.add(await (await browser.get(urls.trainerKey())).text());
    }
    expect(bodies.size).toBe(1);
  });

  it("sends a visitor to sign in", async () => {
    const response = await site.anonymous().get(urls.trainerKey());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(await response.text()).not.toContain(ANSWERS[0]);
  });

  it("checks the global role as the database has it for this request, not as a cookie says", async () => {
    const browser = await site.as(IDS.associate);
    expect((await browser.get(urls.trainerKey())).status).toBe(403);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'legal_engineer' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.trainerKey())).status).toBe(200);
    site.w.repo.db
      .prepare("UPDATE users SET global_role = 'member' WHERE id = ?")
      .run(IDS.associate);
    expect((await browser.get(urls.trainerKey())).status).toBe(403);
  });
});

describe("the route's own guard", () => {
  it("is recorded as a principal route that checks the global action training.key, a read", () => {
    const record = describeRoutes(site.app).find(
      (route) => route.method === "GET" && route.path === urls.trainerKey(),
    );
    expect(record).toBeDefined();
    expect(record).toMatchObject({ kind: "principal", globalAction: "training.key", action: null });
    expect(GLOBAL_ACTIONS["training.key"]).toEqual(["legal_engineer", "admin"]);
  });

  it("has no other method on the URL: a write there is not a route", async () => {
    const lee = await site.as(IDS.legalEngineer);
    const token = await lee.apiToken();
    const before = fingerprint(site);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await lee.send(method, urls.trainerKey(), {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ _csrf: token }).toString(),
      });
      expect(response.status, method).toBe(404);
    }
    expect(fingerprint(site)).toEqual(before);
    expect(
      describeRoutes(site.app).filter((route) => route.path === urls.trainerKey()),
    ).toHaveLength(1);
  });

  it("changes nothing when it is read, and leaves nothing in the audit log", async () => {
    const before = fingerprint(site);
    const events = site.w.repo.countAuditEvents();
    for (const userId of [IDS.legalEngineer, IDS.admin, IDS.associate]) {
      const browser = await site.as(userId);
      await browser.get(urls.trainerKey());
    }
    expect(fingerprint(site)).toEqual(before);
    expect(site.w.repo.countAuditEvents()).toBe(events);
  });

  it("holds no matter: not a title, not an id, whoever reads it", async () => {
    // Give the legal engineer a matter of their own so that there is something to leak.
    const lee = await site.as(IDS.legalEngineer);
    const made = site.w.services.matters.create(
      { userId: IDS.legalEngineer, displayName: "Lee", globalRole: "legal_engineer" },
      {
        name: "A matter that must not appear on the key page",
        clientLegalName: "Lanternfish Software, Inc.",
        playbookVersionId: null,
        reviewerUserId: null,
      },
    );
    const body = await (await lee.get(urls.trainerKey())).text();
    expect(body).not.toContain(made.id);
    expect(body).not.toContain("must not appear");
    expect(body).not.toContain("Lanternfish");
  });
});
