import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoGateError } from "../../src/export/errors.js";
import { buildMemo } from "../../src/export/memo.js";
import { REFUSAL_JUMP, REFUSAL_PHRASES, REFUSAL_TODO } from "../../src/server/routes/notices.js";
import { urls } from "../../src/server/urls.js";
import { expectAccessible } from "../a11y/rules.js";
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
import { decideAll } from "../services/support.js";
import {
  IDS,
  checkPage,
  cleanup,
  fingerprint,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "./support.js";

/**
 * The refusals of the memo are answered on the memos page, in words: a memo asked for too early,
 * one whose quoted passage no longer matches, one whose decisions changed while it was built, and
 * a download of a file that is gone or has changed. They used to end on the shell's page for a
 * conflict, which says only to reload the page. What these tests can show: the status, the words and
 * the part that says what to do, that the page is the memos page, that nothing is changed by a
 * refusal and that the JSON API still answers in JSON. What they cannot show: that a person who
 * reads the words does what they say.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** What the memo builder of the site does next: build, refuse at a gate, or change a decision first. */
let behaviour: "build" | "unverified_quote" | "decision_changes" = "build";
let site: Site;
let reviewer: Browser;
let associate: Browser;

beforeAll(async () => {
  site = makeSite({
    buildMemo: async (input) => {
      if (behaviour === "unverified_quote")
        throw new MemoGateError("unverified_quote", "text that must not matter");
      const bytes = await buildMemo(input);
      if (behaviour === "decision_changes") {
        // While the document is being built, the reviewer changes a decision: the record would not
        // match the file, so the store refuses it.
        const am = site.w.grant(site.w.reviewer, input.matter.id);
        const findingId = site.w.services.runs.issues(am, input.run.id)[0]!.findingId;
        const view = site.w.services.runs.finding(am, findingId);
        site.w.services.reviews.decide(am, findingId, {
          decision: "reject",
          reasonCode: "other",
          findingContentSha256: view.contentSha256,
          edits: null,
          reason: "changed my mind",
        });
      }
      return bytes;
    },
  });
  reviewer = await site.as(IDS.reviewer);
  associate = await site.as(IDS.associate);
});

/** A matter whose findings are all decided, so that the reviewer may export. */
async function decided(name: string): Promise<Prepared> {
  const ids = await prepareMatter(site, { name, exported: false });
  const am = site.w.grant(site.w.associate, ids.matterId);
  decideAll(
    site.w,
    site.w.grant(site.w.reviewer, ids.matterId),
    site.w.services.runs.issues(am, ids.runId),
  );
  return ids;
}

const postExport = async (who: Browser, matterId: string): Promise<Response> =>
  who.send("POST", urls.memos(matterId), {
    headers: FORM,
    body: new URLSearchParams({ _csrf: await who.apiToken() }).toString(),
  });

/** The page a refused memo request was answered with: the memos page, one alert, its todo. */
async function memosPageOf(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^text\/html/);
  // A page and not a file: nothing is offered for download.
  expect(response.headers.get("content-disposition")).toBeNull();
  const html = await response.text();
  const page = { response, html, root: parseHtml(html) };
  checkPage(site, page);
  const root = expectAccessible(html);
  expect(readable(all(root, (el) => el.name === "h1")[0] as El)).toBe("Memos");
  const alerts = all(root, (el) => attr(el, "role") === "alert");
  expect(alerts).toHaveLength(1);
  const alert = alerts[0] as El;
  expect(hasClass(alert, "notice-error")).toBe(true);
  return { html, root, alert, todos: withClass(alert, "todo").map(readable) };
}

describe("a memo asked for before it can be made", () => {
  it("is refused on the memos page when a finding has no decision, with the words and what to do", async () => {
    const ids = await prepareMatter(site, { name: "Export too early", exported: false });
    const before = fingerprint(site, ids.matterId);
    const page = await memosPageOf(await postExport(reviewer, ids.matterId), 409);
    expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["export_blocked"]}`);
    expect(page.todos).toEqual([REFUSAL_TODO["export_blocked"]]);
    expect(REFUSAL_JUMP["export_blocked"]).toBeUndefined();
    // The page is the memos page with its export form, so the person can try again.
    expect(byId(page.root, "export")).toBeDefined();
    expect(fingerprint(site, ids.matterId)).toEqual(before);
    // And the JSON API says the same thing as it always did.
    const api = await reviewer.api("POST", `/api/matters/${ids.matterId}/memos`);
    expect(api.status).toBe(409);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe("export_blocked");
  });

  it("is refused for a review that went out of date after it was decided", async () => {
    const ids = await decided("Export after a change");
    site.w.repo.applyInputChange(ids.matterId, {
      reason: "rerun_requested",
      actorId: IDS.associate,
    });
    const before = fingerprint(site, ids.matterId);
    const page = await memosPageOf(await postExport(reviewer, ids.matterId), 409);
    expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["export_blocked"]}`);
    expect(fingerprint(site, ids.matterId)).toEqual(before);
  });

  it("is refused when a passage a finding quotes no longer matches the stored text", async () => {
    const ids = await decided("Export with a moved quote");
    behaviour = "unverified_quote";
    try {
      const before = fingerprint(site, ids.matterId);
      const page = await memosPageOf(await postExport(reviewer, ids.matterId), 409);
      expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["memo_quote_unverified"]}`);
      expect(page.todos).toEqual([REFUSAL_TODO["memo_quote_unverified"]]);
      expect(page.html).not.toContain("text that must not matter");
      expect(fingerprint(site, ids.matterId)).toEqual(before);
      const api = await reviewer.api("POST", `/api/matters/${ids.matterId}/memos`);
      expect(api.status).toBe(409);
      expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
        "memo_quote_unverified",
      );
    } finally {
      behaviour = "build";
    }
  });

  it("is refused when a decision changed while the memo was being built, and exporting again works", async () => {
    const ids = await decided("Export in a race");
    behaviour = "decision_changes";
    try {
      const before = site.w.repo.listMemos(ids.matterId).length;
      const response = await postExport(reviewer, ids.matterId);
      const page = await memosPageOf(response, 409);
      expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["reviews_changed"]}`);
      expect(page.todos).toEqual([REFUSAL_TODO["reviews_changed"]]);
      // No memo was made, and the file that was saved for it was taken back.
      expect(site.w.repo.listMemos(ids.matterId)).toHaveLength(before);
    } finally {
      behaviour = "build";
    }
    // "Export the memo again" is advice that works.
    const again = await postExport(reviewer, ids.matterId);
    expect(again.status).toBe(303);
    expect(site.w.repo.listMemos(ids.matterId)).toHaveLength(1);
  });

  it("is still the shell's 403 for a person whose role may not export, and the memos page is not shown", async () => {
    const ids = await prepareMatter(site, { name: "Export by the associate", exported: false });
    const response = await postExport(associate, ids.matterId);
    expect(response.status).toBe(403);
    const root = parseHtml(await response.text());
    expect(withClass(root, "notice-error")).toHaveLength(0);
    expect(readable(all(root, (el) => el.name === "h1")[0] as El)).toBe("You may not do that");
  });
});

describe("a download of a memo file that cannot be sent", () => {
  it("answers a file that is gone with the memos page, the words, and nothing about the path", async () => {
    const ids = await prepareMatter(site, { name: "Memo file gone" });
    const record = site.w.repo.getMemo(ids.matterId, ids.memoId!)!;
    rmSync(join(site.w.files.root, record.storagePath));
    const before = fingerprint(site, ids.matterId);
    const page = await memosPageOf(
      await associate.get(urls.memoFile(ids.matterId, ids.memoId!)),
      409,
    );
    expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["memo_file_missing"]}`);
    expect(page.todos).toEqual([REFUSAL_TODO["memo_file_missing"]]);
    expect(page.html).not.toContain(record.storagePath);
    expect(page.html).not.toContain(site.w.files.root);
    // The record is still listed, so the person can see which memo it is.
    expect(byId(page.root, "memo-list")).toBeDefined();
    expect(
      all(byId(page.root, "memo-list") as El, (el) => el.name === "a").map((a) => attr(a, "href")),
    ).toContain(urls.memoFile(ids.matterId, ids.memoId!));
    expect(fingerprint(site, ids.matterId)).toEqual(before);
    // The JSON API answers as before.
    const api = await associate.get(`/api/matters/${ids.matterId}/memos/${ids.memoId!}/file`);
    expect(api.status).toBe(409);
    expect(api.headers.get("content-type")).toMatch(/json/);
    expect(((await api.json()) as { error: { code: string } }).error.code).toBe(
      "memo_file_missing",
    );
  });

  it("answers a file that has changed since it was recorded the same way, with its own words", async () => {
    const ids = await prepareMatter(site, { name: "Memo file changed" });
    const record = site.w.repo.getMemo(ids.matterId, ids.memoId!)!;
    const path = join(site.w.files.root, record.storagePath);
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    writeFileSync(path, bytes);
    const response = await reviewer.get(urls.memoFile(ids.matterId, ids.memoId!));
    expect(response.headers.get("content-type")).not.toBe(DOCX);
    const page = await memosPageOf(response, 409);
    expect(readable(page.alert)).toBe(`Problem ${REFUSAL_PHRASES["memo_file_changed"]}`);
    expect(page.todos).toEqual([REFUSAL_TODO["memo_file_changed"]]);
    expect(page.html).not.toContain(record.storagePath);
    // The two download codes read differently from each other and from the export's.
    expect(REFUSAL_PHRASES["memo_file_changed"]).not.toBe(REFUSAL_PHRASES["memo_file_missing"]);
  });

  it("sends a file that is whole as a file, and a memo that is not there as the shell's 404", async () => {
    const ids = await prepareMatter(site, { name: "Memo file whole" });
    const whole = await reviewer.get(urls.memoFile(ids.matterId, ids.memoId!));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe(DOCX);
    const missing = await reviewer.get(urls.memoFile(ids.matterId, "memo_00000000deadbeef"));
    expect(missing.status).toBe(404);
    const root = parseHtml(await missing.text());
    expect(withClass(root, "notice-error")).toHaveLength(0);
    expect(readable(all(root, (el) => el.name === "h1")[0] as El)).toBe("Page not found");
  });
});
