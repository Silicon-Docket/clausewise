import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FIELDS } from "../../src/server/pages/forms.js";
import {
  REFUSAL_JUMP,
  REFUSAL_PHRASES,
  REFUSAL_TODO,
  refusalOf,
} from "../../src/server/routes/notices.js";
import { REFUSALS_RETENTION } from "../../src/server/routes/refusals-retention.js";
import { urls } from "../../src/server/urls.js";
import { ConflictError } from "../../src/store/index.js";
import { all, attr, hasClass, parseHtml, readable } from "../pages/html.js";
import {
  IDS,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The store refuses to delete a matter while a table still holds a row of it (`matter_residue`).
 * The person who asked for the deletion cannot fix that: a table was added that deletion was not
 * taught about. They are told so in words that do not name a table, that nothing was deleted, and
 * who to ask; the matter is as it was; and the JSON API answers 409 with the code and no table.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("the phrase", () => {
  it("is defined once, with a todo that occurs inside it and no jump, and says what happened", () => {
    expect(Object.keys(REFUSALS_RETENTION.phrases)).toContain("matter_residue");
    const phrase = REFUSAL_PHRASES["matter_residue"]!;
    const todo = REFUSAL_TODO["matter_residue"]!;
    expect(phrase).toMatch(/^[A-Z][^<>&"]*\.$/);
    expect(todo.length).toBeGreaterThan(0);
    expect(phrase).toContain(todo);
    expect(phrase).toContain("Nothing was deleted");
    expect(todo).toContain("operator");
    // Nothing on the page fixes it, so there is nothing to jump to.
    expect(REFUSAL_JUMP["matter_residue"]).toBeUndefined();
    // No dash, and no name of a table in it.
    expect(phrase).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
    expect(phrase).not.toMatch(/zz_|_id|table/i);
  });

  it("reaches the person as a 409 with the phrase and the todo", () => {
    const refusal = refusalOf(
      new ConflictError("matter_residue", "a table still holds rows of the matter: zz_extra"),
    );
    expect(refusal).toMatchObject({ status: 409, code: "matter_residue" });
    expect(refusal?.notice).toEqual({
      kind: "error",
      text: REFUSAL_PHRASES["matter_residue"],
      todo: REFUSAL_TODO["matter_residue"],
    });
    // Whatever the message said, the table is not on its way to the page.
    expect(JSON.stringify(refusal)).not.toContain("zz_extra");
  });
});

describe("a deletion the store refuses", () => {
  let site: Site;
  let ids: Prepared;
  let associate: Browser;
  let reviewer: Browser;

  beforeAll(async () => {
    site = makeSite();
    ids = await prepareMatter(site, { exported: false });
    associate = await site.as(IDS.associate);
    reviewer = await site.as(IDS.reviewer);
    site.w.repo.db.exec("CREATE TABLE zz_extra (matter_id TEXT)");
    site.w.repo.db.prepare("INSERT INTO zz_extra (matter_id) VALUES (?)").run(ids.matterId);
  });

  it("is answered on the matter's page, with the phrase and the todo, and leaves the matter as it was", async () => {
    const page = await associate.page(urls.matter(ids.matterId));
    const before = fingerprint(site);
    const folder = site.w.files.exists(site.w.repo.listVersions(ids.matterId)[0]!.storagePath);

    const response = await associate.submit(page, urls.matterDelete(ids.matterId), {
      set: { [FIELDS.confirm]: "yes" },
    });

    expect(response.status).toBe(409);
    const html = await response.text();
    const root = parseHtml(html);
    const alerts = all(root, (el) => attr(el, "role") === "alert");
    expect(alerts).toHaveLength(1);
    expect(hasClass(alerts[0]!, "notice-error")).toBe(true);
    expect(readable(alerts[0]!)).toBe(`Problem ${REFUSAL_PHRASES["matter_residue"]}`);
    // The todo is marked inside the phrase.
    const marked = all(alerts[0]!, (el) => hasClass(el, "todo"));
    expect(marked.map((el) => readable(el))).toEqual([REFUSAL_TODO["matter_residue"]]);
    expect(html).not.toContain("zz_extra");
    // The page is still a page of the matter, and nothing was taken from it.
    expect(fingerprint(site)).toEqual(before);
    expect(site.w.repo.getMatter(ids.matterId)).toBeDefined();
    expect(site.w.files.exists(site.w.repo.listVersions(ids.matterId)[0]!.storagePath)).toBe(
      folder,
    );
    expect(folder).toBe(true);
  });

  it("is a 409 with the code and no table in the JSON API", async () => {
    const before = fingerprint(site);
    const response = await associate.api("DELETE", `/api/matters/${ids.matterId}`);
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: { kind: "conflict", code: "matter_residue" } });
    expect(text).not.toContain("zz_extra");
    expect(fingerprint(site)).toEqual(before);
  });

  it("is not changed for a person who may not delete: they are refused as before", async () => {
    const response = await reviewer.api("DELETE", `/api/matters/${ids.matterId}`);
    expect(response.status).toBe(403);
  });

  it("goes through once nothing is left behind, and then the matter is gone", async () => {
    site.w.repo.db.exec("DELETE FROM zz_extra");
    const page = await associate.page(urls.matter(ids.matterId));
    const response = await associate.submit(page, urls.matterDelete(ids.matterId), {
      set: { [FIELDS.confirm]: "yes" },
    });
    expect(response.status).toBe(303);
    expect(site.w.repo.getMatter(ids.matterId)).toBeUndefined();
  });
});
