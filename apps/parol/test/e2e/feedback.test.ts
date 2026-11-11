import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REASON_CODES } from "../../src/contracts.js";
import { FIELDS, MINOR_EDIT_VALUE } from "../../src/server/pages/forms.js";
import { urls } from "../../src/server/urls.js";
import { REASON_CODE_LABEL } from "../../src/server/views/feedback.js";
import type { FindingView, IssueRow } from "../../src/services/views.js";
import { all, first, hasClass, readable } from "../pages/html.js";
import {
  IDS,
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
