import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE, NOT_COVERED_VALUE } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import { REASON_CODE_LABEL } from "../../src/server/views/feedback.js";
import type { FindingView, IssueRow } from "../../src/services/views.js";
import { all, attr, byId, first, hasClass, readable } from "../pages/html.js";
import {
  IDS,
  VIEWER,
  checkPage,
  cleanup,
  makeSite,
  prepareMatter,
  type Browser,
  type Prepared,
  type Site,
} from "../routes/support.js";

/**
 * The reason code and the minor-edit mark from the first click to the memo, through HTTP only: the
 * real shell, the real routes, the real services over an in-memory store, and a scripted stand-in
 * for the model (package W2.6a, slice A). The reviewer rejects one finding with a code and edits
 * another as a minor edit, both through the form, and accepts the rest. A marker is typed into every
 * free-text field; the codes are in the decisions and in the audit trail, and the marker is in the
 * decisions only. This is a script and not a measurement of any model; every name is synthetic.
 *
 * Slice B adds a second story below: the report of a missed issue, from the review page to the
 * deletion of the matter. The later slices add theirs.
 */

afterAll(cleanup);
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MARKER = "ZQ-E2E-FEEDBACK-4417";

describe("a reviewer's reasons, through HTTP only", () => {
  let site: Site;
  let reviewer: Browser;
  let ids: Prepared;
  let rows: IssueRow[] = [];
  const view = async (findingId: string): Promise<FindingView> =>
    (await (
      await reviewer.api("GET", `/api/matters/${ids.matterId}/findings/${findingId}`)
    ).json()) as FindingView;
  const rowOf = (ruleKey: string): IssueRow => rows.find((row) => row.ruleKey === ruleKey)!;

  beforeAll(async () => {
    site = makeSite();
    reviewer = await site.as(IDS.reviewer);
    ids = await prepareMatter(site, { exported: false });
    rows = (
      (await (
        await reviewer.api("GET", `/api/matters/${ids.matterId}/runs/${ids.runId}/findings`)
      ).json()) as { findings: IssueRow[] }
    ).findings;
  });

  it("rejects a finding with a code, through the form on the page of the finding", async () => {
    const pty = rowOf("pty-1");
    const page = await reviewer.page(urls.finding(ids.matterId, pty.findingId));
    const options = all(
      first(
        page.root,
        (el) => el.name === "select" && el.attrs.some((a) => a.value === FIELDS.reasonCode),
      ),
      (el) => el.name === "option",
    ).map((el) => readable(el));
    expect(options).toEqual([
      "Choose a reason code",
      ...REASON_CODES.map((c) => REASON_CODE_LABEL[c]),
    ]);

    // Without a code the form comes back, with the reason still in it.
    const refused = await reviewer.submit(page, urls.review(ids.matterId, pty.findingId), {
      set: { [FIELDS.decision]: "reject", [FIELDS.reason]: `Wrong party. ${MARKER}` },
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain(MARKER);

    const saved = await reviewer.submit(page, urls.review(ids.matterId, pty.findingId), {
      set: {
        [FIELDS.decision]: "reject",
        [FIELDS.reason]: `Wrong party. ${MARKER}`,
        [FIELDS.reasonCode]: "wrong_evidence",
      },
    });
    expect(saved.status).toBe(303);
    const landed = await reviewer.page(saved.headers.get("location")!);
    checkPage(site, landed);
    const decided = await view(pty.findingId);
    expect(decided.reviews).toHaveLength(1);
    expect(decided.reviews[0]).toMatchObject({
      decision: "reject",
      reasonCode: "wrong_evidence",
      minorEdit: null,
      validity: "current",
    });
    expect(
      readable(first(landed.root, (el) => el.name === "ol" && hasClass(el, "history"))),
    ).toContain("Reason code: Wrong evidence");
  });

  it("edits another as a minor edit, and says so in the history", async () => {
    const dur = rowOf("dur-1");
    const page = await reviewer.page(urls.finding(ids.matterId, dur.findingId));
    const saved = await reviewer.submit(page, urls.review(ids.matterId, dur.findingId), {
      set: {
        [FIELDS.decision]: "edit",
        [FIELDS.reason]: `Reworded for clarity. ${MARKER}`,
        [FIELDS.reasonCode]: "unclear",
        [FIELDS.discrepancy]: `Section 6.1 was deleted by the amendment, so no end is stated. ${MARKER}`,
        [FIELDS.minorEdit]: MINOR_EDIT_VALUE,
      },
    });
    expect(saved.status).toBe(303);
    const decided = await view(dur.findingId);
    expect(decided.reviews[0]).toMatchObject({
      decision: "edit",
      reasonCode: "unclear",
      minorEdit: true,
      validity: "current",
    });
    const landed = await reviewer.page(saved.headers.get("location")!);
    const history = readable(
      first(landed.root, (el) => el.name === "ol" && hasClass(el, "history")),
    );
    expect(history).toContain("Reason code: Unclear");
    expect(history).toContain("Marked as a minor edit.");
  });

  it("accepts the rest, which carry neither, and exports the memo", async () => {
    for (const row of rows.filter((r) => !["pty-1", "dur-1"].includes(r.ruleKey))) {
      const finding = await view(row.findingId);
      const verified =
        finding.issue.verificationState === "verified" && finding.issue.status !== "undetermined";
      const page = await reviewer.page(urls.finding(ids.matterId, row.findingId));
      const response = await reviewer.submit(page, urls.review(ids.matterId, row.findingId), {
        set: verified
          ? { [FIELDS.decision]: "accept" }
          : { [FIELDS.decision]: "escalate", [FIELDS.reason]: "The workflow could not settle it." },
      });
      expect(response.status, row.ruleKey).toBe(303);
      expect((await view(row.findingId)).reviews[0]).toMatchObject({
        reasonCode: null,
        minorEdit: null,
      });
    }
    const memos = await reviewer.page(urls.memos(ids.matterId));
    const exported = await reviewer.submit(memos, urls.memos(ids.matterId), { set: {} });
    expect(exported.status).toBe(303);
  });

  it("keeps the codes in the decisions and the audit trail, and the marker in the decisions only", () => {
    const db = site.w.repo.db;
    const coded = db
      .prepare(
        "SELECT decision, reason_code, minor_edit FROM reviews WHERE matter_id = ? AND reason_code IS NOT NULL ORDER BY decision",
      )
      .all(ids.matterId);
    expect(coded).toEqual([
      { decision: "edit", reason_code: "unclear", minor_edit: 1 },
      { decision: "reject", reason_code: "wrong_evidence", minor_edit: null },
    ]);
    const events = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "review.decide" });
    expect(
      events
        .filter((e) => e.detail["reasonCode"] !== null)
        .map((e) => [e.detail["decision"], e.detail["reasonCode"], e.detail["minorEdit"]]),
    ).toEqual([
      ["reject", "wrong_evidence", null],
      ["edit", "unclear", true],
    ]);

    // The marker is where a person put it, in the decisions, and nowhere that is logged or audited.
    const where = (table: string, column: string): number =>
      (
        db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE instr(CAST(${column} AS TEXT), ?) > 0`)
          .get(MARKER) as { n: number }
      ).n;
    expect(where("reviews", "reason")).toBe(2);
    expect(where("reviews", "edited_json")).toBe(1);
    expect(where("audit_events", "detail_json")).toBe(0);
    expect(site.logs.join("\n")).not.toContain(MARKER);
    expect(site.w.logs.join("\n")).not.toContain(MARKER);
    // The access log does not carry a code either: the route is named, the body is not.
    expect(site.logs.join("\n")).not.toContain("wrong_evidence");
  });

  it("leaves the codes out of the memo that was exported", async () => {
    const list = site.w.repo.listMemos(ids.matterId);
    expect(list).toHaveLength(1);
    const file = await reviewer.send(
      "GET",
      `/api/matters/${ids.matterId}/memos/${list[0]!.id}/file`,
    );
    expect(file.status).toBe(200);
    const bytes = Buffer.from(await file.arrayBuffer());
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(bytes);
    const xml = await zip.file("word/document.xml")!.async("string");
    // The reviewer's reason is in the memo; the code and the mark are not.
    expect(xml).toContain(MARKER);
    expect(xml).not.toContain("wrong_evidence");
    expect(xml).not.toContain("Wrong evidence");
    expect(xml.toLowerCase()).not.toContain("minor edit");
  });

  it("leaves a decision that went stale with its code, which no longer counts as current", async () => {
    const before = site.w.repo.db
      .prepare(
        "SELECT count(*) AS n FROM reviews WHERE matter_id = ? AND reason_code IS NOT NULL AND validity = 'current'",
      )
      .get(ids.matterId) as { n: number };
    expect(before.n).toBe(2);
    const associate = await site.as(IDS.associate);
    const fixed = await associate.apiUpload(
      `/api/matters/${ids.matterId}/documents/${ids.lastDocumentId}/versions`,
      {},
      {
        name: "amendment-corrected.txt",
        bytes: new TextEncoder().encode(
          "AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n2. A corrected paragraph of synthetic text.\n",
        ),
      },
    );
    expect(fixed.status).toBe(201);
    const after = site.w.repo.db
      .prepare(
        "SELECT validity, count(*) AS n FROM reviews WHERE matter_id = ? AND reason_code IS NOT NULL GROUP BY validity",
      )
      .all(ids.matterId);
    // Still on record with their codes, and out of date: a measure that counts current decisions
    // does not count them.
    expect(after).toEqual([{ validity: "stale", n: 2 }]);
  });
});

// ---------------------------------------------------------------------------------------------
// Slice B: a missed issue, from the review page to the deletion of the matter
// ---------------------------------------------------------------------------------------------

const NOTE_MARK = "ZQ-E2E-NOTE-6021";
const PLACE_MARK = "ZQ-E2E-PLACE-6022";

describe("a missed issue, through HTTP only", () => {
  let site: Site;
  let associate: Browser;
  let reviewer: Browser;
  let viewer: Browser;
  let ids: Prepared;
  const runUrl = (runId = ids.runId): string => urls.run(ids.matterId, runId);
  const listed = (root: ReturnType<typeof byId>): string[][] =>
    all(root!, (el) => el.name === "tr")
      .filter((tr) => all(tr, (el) => el.name === "td").length > 0)
      .map((tr) => all(tr, (el) => el.name === "td").map(readable));

  beforeAll(async () => {
    site = makeSite();
    associate = await site.as(IDS.associate);
    reviewer = await site.as(IDS.reviewer);
    viewer = await site.as(VIEWER);
    ids = await prepareMatter(site, { exported: false });
  });

  it("is reported by the reviewer through the form on the review page, and read back in the list", async () => {
    const page = await reviewer.page(runUrl());
    checkPage(site, page);
    // The link at the top leads to the section, which is on the page.
    const jump = first(page.root, (el) => el.name === "a" && attr(el, "href") === "#missed-issue");
    expect(readable(jump)).toBe("Report a missed issue");
    const saved = await reviewer.submit(page, urls.missedIssues(ids.matterId, ids.runId), {
      set: {
        [FIELDS.ruleKey]: "dur-1",
        [FIELDS.location]: `Amendment No. 1, paragraph 2 ${PLACE_MARK}`,
        [FIELDS.note]: `Section 6.1 is deleted and the review says it stands. ${NOTE_MARK}`,
      },
    });
    expect(saved.status).toBe(303);
    const landed = await reviewer.page(saved.headers.get("location")!);
    checkPage(site, landed);
    expect(readable(first(landed.root, (el) => attr(el, "role") === "status"))).toContain(
      "Your report was saved.",
    );
    const rows = listed(byId(landed.root, "missed-issue"));
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]).toContain("dur-1");
    expect(rows[0]![2]).toContain(NOTE_MARK);
  });

  it("is reported by the associate as not covered, and by the viewer in JSON, and all three read the same list", async () => {
    const page = await associate.page(runUrl());
    const saved = await associate.submit(page, urls.missedIssues(ids.matterId, ids.runId), {
      set: {
        [FIELDS.ruleKey]: NOT_COVERED_VALUE,
        [FIELDS.note]: `No rule covers a non-solicitation clause. ${NOTE_MARK}`,
      },
    });
    expect(saved.status).toBe(303);
    const viaJson = await viewer.api(
      "POST",
      `/api/matters/${ids.matterId}/runs/${ids.runId}/missed-issues`,
      {
        ruleKey: "gov-1",
        location: null,
        note: `The court named is outside the list. ${NOTE_MARK}`,
      },
    );
    expect(viaJson.status).toBe(201);
    for (const who of [associate, reviewer, viewer]) {
      const root = byId((await who.page(runUrl())).root, "missed-issue");
      expect(listed(root).map((row) => row[3])).toEqual([
        site.w.repo.getUser(IDS.reviewer)?.displayName,
        site.w.repo.getUser(IDS.associate)?.displayName,
        site.w.repo.getUser(VIEWER)?.displayName,
      ]);
    }
  });

  it("changes nothing the review is waiting on: the findings can be decided and the memo exported", async () => {
    const am = site.w.grant(site.w.reviewer, ids.matterId);
    for (const issue of site.w.services.runs.issues(am, ids.runId)) {
      const view = site.w.services.runs.finding(am, issue.findingId);
      const ok =
        view.issue.verificationState === "verified" && view.issue.status !== "undetermined";
      site.w.services.reviews.decide(am, issue.findingId, {
        decision: ok ? "accept" : "escalate",
        findingContentSha256: view.contentSha256,
        edits: null,
        reason: ok ? null : "The workflow could not settle this rule.",
      });
    }
    const memos = await reviewer.page(urls.memos(ids.matterId));
    const exported = await reviewer.submit(memos, urls.memos(ids.matterId), { set: {} });
    expect(exported.status).toBe(303);
    const memo = site.w.repo.listMemos(ids.matterId)[0]!;
    const file = await reviewer.send("GET", `/api/matters/${ids.matterId}/memos/${memo.id}/file`);
    const JSZip = (await import("jszip")).default;
    const xml = await (
      await JSZip.loadAsync(Buffer.from(await file.arrayBuffer()))
    )
      .file("word/document.xml")!
      .async("string");
    // The reports are for the people who run the pilot, and are not part of the memo.
    expect(xml).not.toContain(NOTE_MARK);
    expect(xml).not.toContain(PLACE_MARK);
  });

  it("keeps the words in the feedback table only, and the rule and the flags in the audit trail", () => {
    const db = site.w.repo.db;
    const where = (table: string, column: string, mark: string): number =>
      (
        db
          .prepare(`SELECT count(*) AS n FROM ${table} WHERE instr(CAST(${column} AS TEXT), ?) > 0`)
          .get(mark) as { n: number }
      ).n;
    expect(where("feedback", "text", NOTE_MARK)).toBe(3);
    expect(where("feedback", "location", PLACE_MARK)).toBe(1);
    expect(where("audit_events", "detail_json", NOTE_MARK)).toBe(0);
    expect(where("audit_events", "detail_json", PLACE_MARK)).toBe(0);
    expect(site.logs.join("\n")).not.toContain("ZQ-E2E");
    expect(site.w.logs.join("\n")).not.toContain("ZQ-E2E");
    const events = site.w.repo.listAuditEvents({ matterId: ids.matterId, action: "feedback.add" });
    expect(events.map((e) => [e.detail["ruleKey"], e.detail["hasLocation"], e.actorId])).toEqual([
      ["dur-1", true, IDS.reviewer],
      [null, false, IDS.associate],
      ["gov-1", false, VIEWER],
    ]);
  });

  it("stays with the review it was made about: a new review has none, and the old one still lists them", async () => {
    // A new version of the amendment makes the review out of date, and a new review is started.
    const fixed = await associate.apiUpload(
      `/api/matters/${ids.matterId}/documents/${ids.lastDocumentId}/versions`,
      {},
      {
        name: "amendment-corrected.txt",
        bytes: new TextEncoder().encode(
          "AMENDMENT NO. 1 TO MUTUAL NONDISCLOSURE AGREEMENT\n\n2. A corrected paragraph of synthetic text.\n",
        ),
      },
    );
    expect(fixed.status).toBe(201);
    const started = await associate.api("POST", `/api/matters/${ids.matterId}/runs`, {
      workflow: "v2",
    });
    expect(started.status).toBe(202);
    const next = ((await started.json()) as { id: string }).id;
    await site.w.services.runs.idle();
    expect(next).not.toBe(ids.runId);

    const fresh = await reviewer.page(runUrl(next));
    expect(listed(byId(fresh.root, "missed-issue"))).toEqual([]);
    const old = await reviewer.page(runUrl());
    expect(listed(byId(old.root, "missed-issue"))).toHaveLength(3);
    expect(readable(first(old.root, (el) => hasClass(el, "banner-stale")))).toContain(
      "out of date",
    );
  });

  it("goes with the matter when it is deleted, and the audit trail keeps the events without the words", async () => {
    const db = site.w.repo.db;
    const count = (sql: string): number => (db.prepare(sql).get(ids.matterId) as { n: number }).n;
    expect(count("SELECT count(*) AS n FROM feedback WHERE matter_id = ?")).toBe(3);
    const page = await associate.page(urls.matter(ids.matterId));
    const deleted = await associate.submit(page, urls.matterDelete(ids.matterId), {
      set: { [FIELDS.confirm]: "yes" },
    });
    expect(deleted.status).toBe(303);
    expect(count("SELECT count(*) AS n FROM feedback WHERE matter_id = ?")).toBe(0);
    expect(
      count(
        "SELECT count(*) AS n FROM audit_events WHERE matter_id = ? AND action = 'feedback.add'",
      ),
    ).toBe(3);
    expect(
      (
        db
          .prepare("SELECT count(*) AS n FROM audit_events WHERE instr(detail_json, ?) > 0")
          .get(NOTE_MARK) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    expect(site.w.repo.verifyAuditChain().ok).toBe(true);
  });
});
