import type {
  BulkDecisionResponse,
  ConfigResponse,
  DocumentListResponse,
  Finding,
  PlaybookListResponse,
  ReviewDetail,
  ReviewListResponse,
} from "@clausewise/api";
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, fixture, fixtureBytes, oracleFor, type Harness } from "./support.js";

describe("the whole path through the API", () => {
  let t: Harness;
  let balanced: Harness;
  beforeAll(async () => {
    t = await createHarness({ generator: await oracleFor("nda-aggressive.docx"), scope: "file" });
    balanced = await createHarness({
      generator: await oracleFor("nda-balanced.docx"),
      scope: "file",
    });
  });

  it("uploads a contract, reviews it with a built-in playbook, and shows consistent findings", async () => {
    const fix = await fixture("nda-aggressive.docx");

    const { document, review } = await t.reviewedFixture("nda-aggressive.docx");
    expect(document).toMatchObject({ fileName: "nda-aggressive.docx", reviewCount: 0 });
    expect(review.status).toBe("done");
    expect(review.error).toBeNull();
    expect(review.progress).toEqual({ done: 10, total: 10 });
    expect(review.model).toMatchObject({ provider: "oracle", model: "oracle" });

    // Every rule the fixture expects as a deviation or missing is a finding, and nothing else is.
    const expectedFindings = Object.entries(fix.expected)
      .filter(([, status]) => status === "deviation" || status === "missing")
      .map(([ruleId]) => ruleId)
      .sort();
    expect(review.findings.map((f) => f.ruleId).sort()).toEqual(expectedFindings);
    expect(review.counts).toMatchObject({ deviation: 9, missing: 1, error: 0 });
    expect(review.open).toEqual({
      high: expect.any(Number),
      medium: expect.any(Number),
      low: expect.any(Number),
    });
    expect(
      review.findings.every((f) => f.decision === "pending" && f.editedReplacement === null),
    ).toBe(true);

    // The worst findings come first.
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const ranks = review.findings.map((f) => rank[f.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // An applied edit is consistent: the span of the paragraph is the words that were removed.
    const term = t.finding(review, "term");
    expect(term.edit.kind).toBe("applied");
    if (term.edit.kind !== "applied") throw new Error("unreachable");
    expect(term.edit.paragraphText.slice(term.edit.start, term.edit.end)).toBe(term.edit.original);
    expect(term.edit.original).toBe("are perpetual and shall continue indefinitely");
    expect(term.clauses.length).toBeGreaterThan(0);
    expect(term.clauses[0]?.number).toBe("3.1");
    expect(term.clauses[0]?.text).toContain(term.edit.original);
    expect(term.clauses[0]?.text).toContain(term.edit.paragraphText);

    for (const finding of review.findings) {
      if (finding.edit.kind === "applied") {
        const { paragraphText, start, end, original } = finding.edit;
        expect(paragraphText.slice(start, end)).toBe(original);
      }
    }

    // A missing clause carries the suggested wording and no edit of the contract.
    const missing = review.findings.find((f) => f.status === "missing");
    expect(missing?.edit.kind).toBe("none");

    expect(review.findings.length + review.results.length).toBe(10);

    const documents = await t.json<DocumentListResponse>("/api/documents");
    expect(documents.body.documents).toEqual([
      expect.objectContaining({ id: document.id, reviewCount: 1 }),
    ]);
    const reviews = await t.json<ReviewListResponse>("/api/reviews");
    expect(reviews.body.reviews).toEqual([
      expect.objectContaining({
        id: review.id,
        status: "done",
        documentName: "nda-aggressive.docx",
        open: review.open,
      }),
    ]);
  });

  it("records decisions one at a time and in bulk, and edited wording only for an applied edit", async () => {
    const { review } = await t.reviewedFixture("nda-aggressive.docx");
    const path = (ruleId: string) => `/api/reviews/${review.id}/findings/${ruleId}`;

    const accepted = await t.send<Finding>("PATCH", path("term"), { decision: "accepted" });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      ruleId: "term",
      decision: "accepted",
      editedReplacement: null,
    });

    const edited = await t.send<Finding>("PATCH", path("term"), {
      editedReplacement: "end three (3) years after the date of disclosure",
    });
    expect(edited.body).toMatchObject({
      decision: "accepted",
      editedReplacement: "end three (3) years after the date of disclosure",
    });
    // The model's own wording is untouched beside it.
    expect(edited.body.edit.kind === "applied" && edited.body.edit.replacement).toBeTruthy();

    const empty = await t.send<Finding>("PATCH", path("term"), { editedReplacement: "" });
    expect(empty.body.editedReplacement).toBe("");
    const cleared = await t.send<Finding>("PATCH", path("term"), { editedReplacement: null });
    expect(cleared.body.editedReplacement).toBeNull();

    // A finding with no edit of the contract cannot take wording of its own.
    const noEdit = await t.send("PATCH", path("compelled-disclosure"), { editedReplacement: "x" });
    expect(noEdit.status).toBe(400);
    expect(noEdit.body).toMatchObject({ error: { code: "bad_request" } });
    // Clearing nothing is allowed, and a decision on it is.
    const rejected = await t.send<Finding>("PATCH", path("compelled-disclosure"), {
      decision: "rejected",
    });
    expect(rejected.body.decision).toBe("rejected");

    expect((await t.send("PATCH", path("term"), {})).status).toBe(400);
    expect((await t.send("PATCH", path("term"), { decision: "maybe" })).status).toBe(400);
    expect(
      (await t.send("PATCH", path("term"), { editedReplacement: "x".repeat(20_001) })).status,
    ).toBe(400);
    expect((await t.send("PATCH", path("term"), { editedReplacement: "a\u0000b" })).status).toBe(
      400,
    );
    expect((await t.send("PATCH", path("no-such-rule"), { decision: "accepted" })).status).toBe(
      404,
    );

    // Bulk: by severity, by rule ids, both, and neither.
    const high = review.findings.filter((f) => f.severity === "high").length;
    const byHigh = await t.send<BulkDecisionResponse>(
      "PATCH",
      `/api/reviews/${review.id}/findings`,
      {
        decision: "accepted",
        severities: ["high"],
      },
    );
    expect(byHigh.body).toEqual({ updated: high });
    const byIds = await t.send<BulkDecisionResponse>(
      "PATCH",
      `/api/reviews/${review.id}/findings`,
      {
        decision: "rejected",
        ruleIds: ["governing-law", "remedies", "not-a-rule"],
      },
    );
    expect(byIds.body).toEqual({ updated: 2 });
    const both = await t.send<BulkDecisionResponse>("PATCH", `/api/reviews/${review.id}/findings`, {
      decision: "pending",
      ruleIds: ["term", "governing-law"],
      severities: ["low"],
    });
    const lowOfThose = review.findings.filter(
      (f) => ["term", "governing-law"].includes(f.ruleId) && f.severity === "low",
    ).length;
    expect(both.body).toEqual({ updated: lowOfThose });
    const none = await t.send<BulkDecisionResponse>("PATCH", `/api/reviews/${review.id}/findings`, {
      decision: "rejected",
      ruleIds: [],
    });
    expect(none.body).toEqual({ updated: 0 });
    const all = await t.send<BulkDecisionResponse>("PATCH", `/api/reviews/${review.id}/findings`, {
      decision: "accepted",
    });
    expect(all.body).toEqual({ updated: review.findings.length });

    const after = await t.json<ReviewDetail>(`/api/reviews/${review.id}`);
    expect(after.body.findings.every((f) => f.decision === "accepted")).toBe(true);
    // The wording the lawyer cleared stays cleared through a bulk decision.
    expect(t.finding(after.body, "term").editedReplacement).toBeNull();
  });

  it("serves the report as JSON and as Markdown, and the original file", async () => {
    const { document, review } = await t.reviewedFixture("nda-aggressive.docx");

    const json = await t.request(`/api/reviews/${review.id}/report`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.headers.get("content-disposition")).toContain("attachment");
    const report = (await json.json()) as {
      document: string;
      results: unknown[];
      playbook: { name: string };
    };
    expect(report.document).toBe("nda-aggressive.docx");
    expect(report.results).toHaveLength(10);
    const same = await t.request(`/api/reviews/${review.id}/report?format=json`);
    expect(await same.json()).toEqual(report);

    const md = await t.request(`/api/reviews/${review.id}/report?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toContain("text/markdown");
    expect(md.headers.get("content-disposition")).toContain("nda-aggressive.summary.md");
    const text = await md.text();
    expect(text).toContain(report.playbook.name);
    expect(text).toContain("Deviations");

    expect((await t.request(`/api/reviews/${review.id}/report?format=pdf`)).status).toBe(400);

    const file = await t.request(`/api/documents/${document.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("wordprocessingml.document");
    expect(file.headers.get("content-disposition")).toBe(
      `attachment; filename="nda-aggressive.docx"; filename*=UTF-8''nda-aggressive.docx`,
    );
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("cache-control")).toBe("no-store");
    const downloaded = new Uint8Array(await file.arrayBuffer());
    const original = await fixtureBytes("nda-aggressive.docx");
    expect(Buffer.compare(downloaded, original)).toBe(0);
  });

  it("lists the rules that are not findings apart from the findings", async () => {
    const { review } = await balanced.reviewedFixture("nda-balanced.docx");
    expect(review.findings).toEqual([]);
    expect(review.open).toEqual({ high: 0, medium: 0, low: 0 });
    expect(review.results).toHaveLength(10);
    expect(review.results.map((r) => r.status).sort()).toEqual([
      ...Array<string>(9).fill("compliant"),
      "not_applicable",
    ]);
    const governing = review.results.find((r) => r.ruleId === "governing-law");
    expect(governing).toMatchObject({ status: "compliant", error: null });
    expect(governing?.clauseNumbers.length).toBeGreaterThan(0);

    // A rule that was met is not a finding, so there is nothing to decide on.
    const answer = await balanced.send(
      "PATCH",
      `/api/reviews/${review.id}/findings/governing-law`,
      {
        decision: "accepted",
      },
    );
    expect(answer.status).toBe(404);
  });

  it("answers config, health and the playbook list", async () => {
    const config = await t.json<ConfigResponse>("/api/config");
    expect(config.body).toEqual({
      version: "9.9.9-test",
      authRequired: false,
      maxUploadBytes: 5 * 1024 * 1024,
      model: {
        configured: true,
        provider: "oracle",
        model: "oracle",
        disclosure: "a scripted test oracle (nothing is sent anywhere)",
      },
    });
    expect((await t.json("/healthz")).body).toEqual({ ok: true });

    const list = await t.json<PlaybookListResponse>("/api/playbooks");
    expect(list.body.playbooks.map((p) => p.id)).toEqual([
      "builtin:nda-mutual",
      "builtin:saas-customer",
    ]);
    expect(list.body.playbooks[0]).toMatchObject({
      source: "builtin",
      ruleCount: 10,
      updatedAt: null,
    });
  });
});
