import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import {
  NOTICES,
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
} from "../../src/server/routes/notices.js";
import {
  CreateMatterInput,
  PatchMatterBody,
  RetentionInput,
  requiredRetainDaysFromForm,
  retainDaysFromForm,
} from "../../src/server/routes/schemas.js";
import { urls } from "../../src/server/urls.js";
import { formatDate } from "../../src/server/views/format.js";
import { MAX_RETAIN_DAYS, ValidationError } from "../../src/store/index.js";
import {
  all,
  attr,
  byId,
  hasClass,
  parseHtml,
  readable,
  withClass,
  type El,
} from "../pages/html.js";
import {
  IDS,
  OUTSIDER,
  VIEWER,
  cleanup,
  fingerprint,
  makeSite,
  matterIdFrom,
  prepareMatter,
  type Browser,
  type Page,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * How long a matter is kept, through the pages and the JSON API (package W2.7, slice B): the field
 * of the new-matter form, the form on the matter page that changes the date, and the same two
 * operations in JSON. Who may change the date, that a token is needed, that a number that is not a
 * whole number of days from 1 to 90 is refused in words and changes nothing, and that changing the
 * date touches nothing else. The store's rules for the date are in test/store/retention.test.ts,
 * the page in test/pages/retention-page.test.ts.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let site: Site;
let ids: Prepared;
let associate: Browser;
let reviewer: Browser;
let viewer: Browser;
let outsider: Browser;
let admin: Browser;
let visitor: Browser;

beforeAll(async () => {
  site = makeSite();
  // Exported, so that a change that reached the review would show: the memo is current, every
  // finding is decided, and the matter is in its last state.
  ids = await prepareMatter(site, { exported: true });
  associate = await site.as(IDS.associate);
  reviewer = await site.as(IDS.reviewer);
  viewer = await site.as(VIEWER);
  outsider = await site.as(OUTSIDER);
  admin = await site.as(IDS.admin);
  visitor = site.anonymous();
});

const dateOf = (matterId: string = ids.matterId): string =>
  site.w.repo.getMatter(matterId)!.retainUntil;

const eventsOf = (matterId: string = ids.matterId) =>
  site.w.repo.listAuditEvents({ matterId, action: "matter.retention" });

/** What a refused request must leave as it was: the rows of the matter, its date and its events. */
const state = (matterId: string = ids.matterId) => ({
  rows: fingerprint(site, matterId),
  retainUntil: dateOf(matterId),
  events: eventsOf(matterId).length,
});

/** The form post the page would make, with the token and the field given. */
function postRetention(
  who: Browser,
  matterId: string,
  field: string | null,
  token: string | null,
): Promise<Response> {
  const pairs: [string, string][] = [];
  if (token !== null) pairs.push(["_csrf", token]);
  if (field !== null) pairs.push([FIELDS.retainDays, field]);
  return who.send("POST", urls.matterRetention(matterId), {
    headers: FORM,
    body: new URLSearchParams(pairs).toString(),
  });
}

const sendForm = async (who: Browser, field: string | null, matterId = ids.matterId) =>
  postRetention(who, matterId, field, await who.apiToken());

const patch = (
  who: Browser,
  body: unknown,
  matterId = ids.matterId,
  csrf: boolean | string = true,
) => who.api("PATCH", `/api/matters/${matterId}`, body, csrf);

const notices = (page: Page): string[] =>
  all(page.root, (el) => hasClass(el, "notice")).map((el) => readable(el));

/** The days a response put between the creation of a matter and its retention date. */
const keptDays = (matterId: string): number => {
  const matter = site.w.repo.getMatter(matterId)!;
  return (Date.parse(matter.retainUntil) - Date.parse(matter.createdAt)) / DAY;
};

describe("the form on the matter page, for an associate", () => {
  it("changes the date to the number of days from now, says so, and records one event", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const form = associate.formOf(page, urls.matterRetention(ids.matterId));
    expect(all(form, (el) => attr(el, "name") === FIELDS.retainDays)).toHaveLength(1);
    const before = state();
    const memoBefore = site.w.repo.getCurrentMemo(ids.matterId);

    const response = await associate.submit(page, urls.matterRetention(ids.matterId), {
      set: { [FIELDS.retainDays]: "60" },
    });

    expect(response.status).toBe(303);
    const location = response.headers.get("location")!;
    expect(location).toMatch(
      new RegExp(
        `^${urls.matter(ids.matterId)}\\?notice=retention-saved&nt=\\d+\\.[A-Za-z0-9_-]{43}$`,
      ),
    );
    const landed = await associate.page(location);
    expect(notices(landed)).toEqual(["Done The retention date was changed."]);
    // The page now says the new date, and what the store holds is that date.
    const section = readable(byId(landed.root, "retention") as El);
    expect(section).toContain(`kept until ${formatDate(dateOf())}`);

    expect(dateOf()).not.toBe(before.retainUntil);
    const events = eventsOf();
    expect(events).toHaveLength(before.events + 1);
    const event = events.at(-1)!;
    expect(event).toMatchObject({
      actorId: IDS.associate,
      targetType: "matter",
      targetId: ids.matterId,
      detail: { from: before.retainUntil, to: dateOf(), days: 60 },
    });
    // 60 days from the moment of the change: after the creation of the matter, within minutes of it.
    const sinceCreation = Date.parse(dateOf()) - 60 * DAY - Date.parse(event.at);
    expect(Math.abs(sinceCreation)).toBeLessThan(60_000);
    // Everything else the review rests on is as it was: the same rows, and the same current memo.
    expect({ ...fingerprint(site, ids.matterId), audit: 0 }).toEqual({ ...before.rows, audit: 0 });
    expect(fingerprint(site, ids.matterId).audit).toBe(before.rows.audit! + 1);
    expect(site.w.repo.getCurrentMemo(ids.matterId)).toEqual(memoBefore);
    expect(site.w.repo.getMatter(ids.matterId)?.status).toBe("exported");
    expect(site.w.repo.verifyAuditChain().ok).toBe(true);
  });

  it("takes a date earlier than the one it had, as well as a later one, the boundaries 1 and 90, and a field with spaces or a leading zero", async () => {
    const dates: string[] = [];
    for (const field of ["90", "1", " 30 ", "030"]) {
      const response = await sendForm(associate, field);
      expect(response.status, field).toBe(303);
      dates.push(dateOf());
    }
    // Four changes, four events, each with its own number of days; 90 then 1 moved the date back.
    expect(
      eventsOf()
        .slice(-4)
        .map((e) => e.detail["days"]),
    ).toEqual([90, 1, 30, 30]);
    expect(Date.parse(dates[1]!)).toBeLessThan(Date.parse(dates[0]!));
    expect(Date.parse(dates[2]!)).toBeGreaterThan(Date.parse(dates[1]!));
  });

  it("ignores an id in the body: the matter is the one in the path", async () => {
    const other = site.w.services.matters.create(site.w.associate, {
      name: "Another matter",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: null,
    });
    const otherBefore = state(other.id);
    const token = await associate.apiToken();
    const response = await associate.send("POST", urls.matterRetention(ids.matterId), {
      headers: FORM,
      body: new URLSearchParams([
        ["_csrf", token],
        [FIELDS.retainDays, "20"],
        ["matterId", other.id],
        ["id", other.id],
      ]).toString(),
    });
    expect(response.status).toBe(303);
    expect(state(other.id)).toEqual(otherBefore);
    expect(eventsOf().at(-1)?.matterId).toBe(ids.matterId);
  });
});

describe("a number of days that is not a whole number from 1 to 90", () => {
  const REFUSED = [
    ["a blank field", ""],
    ["no field at all", null],
    ["zero", "0"],
    ["one over the ceiling", String(MAX_RETAIN_DAYS + 1)],
    ["a fraction", "1.5"],
    ["a negative number", "-5"],
    ["a plus sign", "+30"],
    ["letters", "abc"],
    ["a number and a word", "30 days"],
    ["an exponent", "1e1"],
    ["four digits", "0030"],
    ["a number too big for the shape", "99999999999999999999"],
    ["digits of another script", "٣٠"],
  ] as const;

  for (const [name, field] of REFUSED) {
    it(`${name} is answered on the matter's page in words, with a way to the field, and changes nothing`, async () => {
      const asked = await associate.page(urls.matter(ids.matterId));
      const before = state();

      const response = await sendForm(associate, field);

      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/^text\/html/);
      const html = await response.text();
      const root = parseHtml(html);
      const alerts = all(root, (el) => attr(el, "role") === "alert");
      expect(alerts).toHaveLength(1);
      expect(hasClass(alerts[0]!, "notice-error")).toBe(true);
      const jump = REFUSAL_JUMP["retention_days"]!;
      expect(readable(alerts[0]!)).toBe(
        `Problem ${REFUSAL_PHRASES["retention_days"]} ${jump.label}`,
      );
      // The todo is marked inside the phrase, and the link leads to a place the page has.
      expect(withClass(alerts[0]!, "todo").map((el) => readable(el))).toEqual([
        REFUSAL_TODO["retention_days"],
      ]);
      const link = all(alerts[0]!, (el) => el.name === "a");
      expect(link.map((a) => attr(a, "href"))).toEqual(["#retention"]);
      expect(byId(root, "retention")).toBeDefined();
      // The page is the one that was asked from, and nothing of the request is in it.
      expect(html.replace(/<div class="notice notice-error"[^>]*>.*?<\/div>/s, "")).toBe(
        asked.html,
      );
      expect(state()).toEqual(before);
    });
  }

  it("leaves the date alone for every one of them, and records no event", async () => {
    const before = state();
    for (const [, field] of REFUSED) await sendForm(associate, field);
    expect(state()).toEqual(before);
  });
});

describe("the form on the matter page, for the others", () => {
  it("needs the token: none, an empty one, a wrong one and another session's are each a 403 and change nothing", async () => {
    const before = state();
    const other = await reviewer.apiToken();
    for (const token of [null, "", "not-a-token-0123456789abcdefghijklmnopqrstuv", other]) {
      const response = await postRetention(associate, ids.matterId, "45", token);
      expect(response.status, String(token)).toBe(403);
    }
    expect(state()).toEqual(before);
  });

  it("is refused to a reviewer and a viewer with 403, and nothing changes", async () => {
    const before = state();
    for (const who of [reviewer, viewer]) {
      const response = await sendForm(who, "45");
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("retention date was changed");
    }
    expect(state()).toEqual(before);
  });

  it("is a 404 for a person who is not on the matter, the same as for a matter that does not exist, an administrator included", async () => {
    const before = state();
    const missing = await sendForm(outsider, "45", "mat_ffffffffffffffff");
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    for (const who of [outsider, admin]) {
      const response = await sendForm(who, "45");
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(missingBody);
    }
    expect(state()).toEqual(before);
  });

  it("sends a visitor to sign in, and changes nothing", async () => {
    const before = state();
    const response = await postRetention(visitor, ids.matterId, "45", await visitor.apiToken());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(state()).toEqual(before);
  });

  it("shows a reviewer and a viewer the date and no form, and says who can change it", async () => {
    for (const who of [reviewer, viewer]) {
      const page = await who.page(urls.matter(ids.matterId));
      expect(who.hasForm(page, urls.matterRetention(ids.matterId))).toBe(false);
      const text = readable(byId(page.root, "retention") as El);
      expect(text).toContain("Only an associate on the matter can change this date.");
      expect(text).toContain(`kept until ${formatDate(dateOf())}`);
    }
  });
});

describe("the JSON API: PATCH /api/matters/:matterId with a retention body", () => {
  it("changes the date for an associate, returns the matter with the new date, and records the event", async () => {
    const before = state();
    const response = await patch(associate, { retention: { days: 70 } });
    expect(response.status).toBe(200);
    const view = (await response.json()) as {
      retention: { retainUntil: string; pastDate: boolean; maxDays: number };
      matter: { retainUntil: string; pastRetention: boolean };
    };
    expect(view.retention.retainUntil).toBe(dateOf());
    expect(view.matter.retainUntil).toBe(dateOf());
    expect(view.retention).toMatchObject({ pastDate: false, maxDays: MAX_RETAIN_DAYS });
    expect(view.matter.pastRetention).toBe(false);
    expect(eventsOf()).toHaveLength(before.events + 1);
    expect(eventsOf().at(-1)).toMatchObject({
      actorId: IDS.associate,
      detail: { to: dateOf(), days: 70 },
    });
    expect({ ...fingerprint(site, ids.matterId), audit: 0 }).toEqual({ ...before.rows, audit: 0 });
  });

  const BAD: [string, unknown][] = [
    ["an extra key in the retention body", { retention: { days: 60, extra: 1 } }],
    ["zero days", { retention: { days: 0 } }],
    ["one over the ceiling", { retention: { days: MAX_RETAIN_DAYS + 1 } }],
    ["a fraction", { retention: { days: 1.5 } }],
    ["the number as text", { retention: { days: "60" } }],
    ["null", { retention: { days: null } }],
    ["no days", { retention: {} }],
    ["a number in place of the body", { retention: 60 }],
    ["a date in place of days", { retention: { retainUntil: "2099-01-01T00:00:00.000Z" } }],
    ["a date beside the days", { retention: { days: 60 }, retainUntil: "2099-01-01" }],
    ["two kinds of change in one request", { retention: { days: 60 }, clientLegalName: "Other" }],
  ];

  for (const [name, body] of BAD) {
    it(`refuses ${name} with 400 and changes nothing`, async () => {
      const before = state();
      const response = await patch(associate, body);
      expect(response.status).toBe(400);
      expect(state()).toEqual(before);
    });
  }

  it("is refused to every caller who may not change the date, as the form is, and changes nothing", async () => {
    const before = state();
    expect((await patch(reviewer, { retention: { days: 45 } })).status).toBe(403);
    expect((await patch(viewer, { retention: { days: 45 } })).status).toBe(403);
    const missing = await patch(outsider, { retention: { days: 45 } }, "mat_ffffffffffffffff");
    expect(missing.status).toBe(404);
    const missingBody = await missing.text();
    for (const who of [outsider, admin]) {
      const response = await patch(who, { retention: { days: 45 } });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe(missingBody);
    }
    expect((await patch(visitor, { retention: { days: 45 } })).status).toBe(401);
    expect(state()).toEqual(before);
  });

  it("needs the token in the header: none, a wrong one and another session's are each a 403", async () => {
    const before = state();
    for (const csrf of [
      false,
      "not-a-token-0123456789abcdefghijklmnopqrstuv",
      await reviewer.apiToken(),
    ])
      expect((await patch(associate, { retention: { days: 45 } }, ids.matterId, csrf)).status).toBe(
        403,
      );
    expect(state()).toEqual(before);
  });
});

describe("the number of days when a matter is made", () => {
  const form = async (fields: Record<string, string>): Promise<Response> => {
    const page = await associate.page(urls.matters());
    return associate.submit(page, urls.matters(), {
      set: { name: "Kept", clientLegalName: "Lanternfish Software, Inc.", ...fields },
    });
  };

  it("keeps a matter made with the form for the days typed in it", async () => {
    const response = await form({ [FIELDS.retainDays]: "7" });
    expect(response.status).toBe(303);
    expect(keptDays(matterIdFrom(response))).toBe(7);
    // The list of matters shows the date that many days on.
    const created = site.w.repo.getMatter(matterIdFrom(response))!;
    const list = await associate.page(urls.matters());
    const row = all(list.root, (el) => el.name === "tr").find((tr) =>
      readable(tr).includes(formatDate(created.retainUntil)),
    );
    expect(row).toBeDefined();
  });

  it("takes the default of 30 days when the field is blank, and offers 30 in the form", async () => {
    const page = await associate.page(urls.matters());
    const field = all(page.root, (el) => attr(el, "name") === FIELDS.retainDays)[0]!;
    expect(attr(field, "value")).toBe("30");
    const response = await form({ [FIELDS.retainDays]: "  " });
    expect(response.status).toBe(303);
    expect(keptDays(matterIdFrom(response))).toBe(30);
  });

  it("takes 1 and 90 and refuses 0, 91 and text on the list of matters, in words, making nothing", async () => {
    expect(keptDays(matterIdFrom(await form({ [FIELDS.retainDays]: "1" })))).toBe(1);
    expect(keptDays(matterIdFrom(await form({ [FIELDS.retainDays]: "90" })))).toBe(90);
    const before = fingerprint(site);
    for (const value of ["0", "91", "abc", "7.5", "7 days"]) {
      const response = await form({ [FIELDS.retainDays]: value });
      expect(response.status, value).toBe(400);
      const alerts = all(parseHtml(await response.text()), (el) => attr(el, "role") === "alert");
      expect(alerts, value).toHaveLength(1);
      expect(readable(alerts[0]!), value).toBe(
        `Problem ${REFUSAL_PHRASES["retention_days"]} ${REFUSAL_JUMP["retention_days"]!.label}`,
      );
    }
    expect(fingerprint(site)).toEqual(before);
  });

  it("takes the days in JSON, within the range, and nothing else about the date", async () => {
    const make = (extra: Record<string, unknown>) =>
      associate.api("POST", "/api/matters", {
        name: "Kept",
        clientLegalName: "Lanternfish Software, Inc.",
        ...extra,
      });
    const ok = await make({ retainDays: 12 });
    expect(ok.status).toBe(201);
    const made = (await ok.json()) as { id: string };
    expect(keptDays(made.id)).toBe(12);
    const defaulted = (await (await make({})).json()) as { id: string };
    expect(keptDays(defaulted.id)).toBe(30);

    const before = fingerprint(site);
    for (const extra of [
      { retainDays: 0 },
      { retainDays: MAX_RETAIN_DAYS + 1 },
      { retainDays: 1.5 },
      { retainDays: "12" },
      { retainDays: null },
      // A date is never taken from a request, only a number of days.
      { retainUntil: "2099-01-01T00:00:00.000Z" },
      { retainDays: 12, retainUntil: "2099-01-01T00:00:00.000Z" },
    ])
      expect((await make(extra)).status, JSON.stringify(extra)).toBe(400);
    expect(fingerprint(site)).toEqual(before);
  });
});

describe("a matter that is past its date", () => {
  it("is marked in the list and on its page until the date is moved, and one change clears both", async () => {
    const made = site.w.services.matters.create(site.w.associate, {
      name: "Old matter",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: IDS.reviewer,
    });
    // Made past its date by the database, as time would: a date after the creation and before the
    // clock of the services (4 November 2026).
    site.w.repo.db
      .prepare("UPDATE matters SET retain_until = ? WHERE id = ?")
      .run("2026-11-03T12:00:00.000Z", made.id);

    const chipsOf = async (): Promise<string[]> => {
      const list = await associate.page(urls.matters());
      const row = all(list.root, (el) => el.name === "tr").find((tr) =>
        readable(tr).includes("Old matter"),
      )!;
      return withClass(row, "chip")
        .map((chip) => readable(chip))
        .filter((text) => text === "Past");
    };
    expect(await chipsOf()).toEqual(["Past"]);
    const page = await associate.page(urls.matter(made.id));
    const text = readable(byId(page.root, "retention") as El);
    expect(text).toContain("Past its date");
    expect(text).toContain("past its retention date (3 November 2026)");
    expect(text).toContain("nothing deletes a matter by itself");
    expect(text).toContain("Change the date below");

    // A matter that is not past is not marked.
    const fresh = await associate.page(urls.matters());
    const other = all(fresh.root, (el) => el.name === "tr").filter(
      (tr) => !readable(tr).includes("Old matter"),
    );
    for (const row of other)
      expect(withClass(row, "chip").map((chip) => readable(chip))).not.toContain("Past");

    const done = await sendForm(associate, "45", made.id);
    expect(done.status).toBe(303);
    expect(await chipsOf()).toEqual([]);
    const after = readable(
      byId((await associate.page(urls.matter(made.id))).root, "retention") as El,
    );
    expect(after).not.toContain("Past its date");
    expect(after).toContain("kept until");
  });

  it("is shown a reviewer as past, with the way to have it changed, and no form", async () => {
    const made = site.w.services.matters.create(site.w.associate, {
      name: "Old matter two",
      clientLegalName: "Lanternfish Software, Inc.",
      playbookVersionId: null,
      reviewerUserId: IDS.reviewer,
    });
    site.w.repo.db
      .prepare("UPDATE matters SET retain_until = ? WHERE id = ?")
      .run("2026-11-03T12:00:00.000Z", made.id);
    const page = await reviewer.page(urls.matter(made.id));
    expect(reviewer.hasForm(page, urls.matterRetention(made.id))).toBe(false);
    const text = readable(byId(page.root, "retention") as El);
    expect(text).toContain("Past its date");
    expect(text).toContain("Ask an associate on the matter to change the date");
  });
});

describe("the request schemas", () => {
  const NAMED = { name: "Kept", clientLegalName: "Lanternfish Software, Inc." };

  it("hold the range themselves, so the store is not the only place that refuses 0 and 91", () => {
    for (const days of [1, 30, MAX_RETAIN_DAYS]) {
      expect(RetentionInput.safeParse({ days }).success, String(days)).toBe(true);
      expect(PatchMatterBody.safeParse({ retention: { days } }).success, String(days)).toBe(true);
      expect(CreateMatterInput.safeParse({ ...NAMED, retainDays: days }).success).toBe(true);
    }
    for (const days of [0, -1, MAX_RETAIN_DAYS + 1, 1.5, "30", null, Number.NaN]) {
      expect(RetentionInput.safeParse({ days }).success, String(days)).toBe(false);
      expect(PatchMatterBody.safeParse({ retention: { days } }).success, String(days)).toBe(false);
      expect(CreateMatterInput.safeParse({ ...NAMED, retainDays: days }).success).toBe(false);
    }
    expect(CreateMatterInput.safeParse(NAMED).success).toBe(true);
  });

  it("read the days of a form as digits only, trimmed, in the range, with the retention code", () => {
    expect(retainDaysFromForm(undefined)).toBeUndefined();
    expect(retainDaysFromForm("   ")).toBeUndefined();
    expect(retainDaysFromForm(" 45 ")).toBe(45);
    expect(retainDaysFromForm(String(MAX_RETAIN_DAYS))).toBe(MAX_RETAIN_DAYS);
    expect(() => requiredRetainDaysFromForm("")).toThrow(ValidationError);
    expect(() => requiredRetainDaysFromForm(undefined)).toThrow(ValidationError);
    for (const text of ["0", String(MAX_RETAIN_DAYS + 1), "1.5", "-1", "x", "1 2"]) {
      let error: unknown;
      try {
        retainDaysFromForm(text);
      } catch (e) {
        error = e;
      }
      expect((error as ValidationError).code, text).toBe("retention_days");
      // The words are the same for every input, so they quote nothing the form said.
      expect((error as Error).message).toBe(
        `retention must be a whole number of days from 1 to ${MAX_RETAIN_DAYS}`,
      );
    }
  });
});

describe("the words of the refusal and of the notice", () => {
  it("has one phrase for the code, a todo that occurs in it, and a jump to the field; the notice is registered", () => {
    const phrase = REFUSAL_PHRASES["retention_days"]!;
    const todo = REFUSAL_TODO["retention_days"]!;
    expect(phrase).toContain(todo);
    expect(todo).toBe(`Enter a whole number of days from 1 to ${MAX_RETAIN_DAYS}.`);
    expect(phrase).toMatch(/^[A-Z][^<>&"]*\.$/);
    expect(REFUSAL_JUMP["retention_days"]).toEqual({
      href: "#retention",
      label: "Go to the retention field",
    });
    expect(NOTICES["retention-saved"]).toEqual({
      kind: "success",
      text: "The retention date was changed.",
    });
    for (const text of [phrase, todo, REFUSAL_JUMP["retention_days"]!.label])
      expect(text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });

  it("reaches the person from the store's own refusal, and quotes nothing the request said", () => {
    const refusal = refusalOf(
      new ValidationError(
        "retention_days",
        "retention must be a whole number of days from 1 to 90",
      ),
    );
    expect(refusal).toMatchObject({ status: 400, code: "retention_days" });
    expect(refusal?.notice).toEqual({
      kind: "error",
      text: REFUSAL_PHRASES["retention_days"],
      todo: REFUSAL_TODO["retention_days"],
      jump: { href: "#retention", label: "Go to the retention field" },
    });
  });
});
