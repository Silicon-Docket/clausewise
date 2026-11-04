import { beforeEach, describe, expect, it } from "vitest";
import { findingContentSha256, sha256Hex } from "../../src/canonical.js";
import type { VerifiedFinding } from "../../src/contracts.js";
import {
  ConflictError,
  ContentMismatchError,
  ExportBlockedError,
  NotFoundError,
  StaleFindingError,
  StaleRunError,
  ValidationError,
  type ExportBlockerReason,
} from "../../src/store/index.js";
import {
  ACTORS,
  addMatter,
  allFindings,
  decideAll,
  exported,
  fakePath,
  findingFor,
  makeWorld,
  rehash,
  reviewable,
  saveAll,
  startRun,
  succeed,
  type World,
} from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const span = (m: ReturnType<typeof addMatter>, i: number) => ({ id: m.nda.spanIds[i] as string, text: m.nda.texts[i] as string });
const reasons = (matterId: string, runId: string): ExportBlockerReason[] =>
  w.repo.getExportReadiness(matterId, runId).blockers.map((b) => b.reason);

describe("saveFindings", () => {
  it("writes findings, evidence and checks, and reads them back as the same content", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const input = allFindings(m);
    const saved = w.repo.saveFindings(m.id, run.id, input, { actorId: null });
    expect(saved.map((f) => f.ruleKey)).toEqual(["pty-1", "dur-1", "gov-1"]);

    const dur = w.repo.getFinding(m.id, saved[1]?.id as string);
    expect(dur).toMatchObject({
      runId: run.id,
      matterId: m.id,
      ruleKey: "dur-1",
      category: "duration",
      severity: "high",
      status: "compliant",
      validity: "current",
      staleReason: null,
      verificationState: "verified",
      reviews: [],
      currentReview: null,
    });
    expect(dur?.evidence).toHaveLength(1);
    expect(dur?.evidence[0]).toMatchObject({ spanId: m.nda.spanIds[2], role: "governing", quoteCheck: "verified", supportCheck: "supported", offsets: { start: 0, end: 24 } });
    expect(dur?.evidence[0]?.id).toMatch(/^evd_/);
    expect(dur?.checks).toEqual([{ id: "quote_exists", kind: "deterministic", outcome: "pass", detail: "1 of 1 found" }]);
    expect(dur?.rule).toMatchObject({ key: "dur-1", title: "Duration of obligations", ordinal: 1 });
    // The stored content hashes back to the stored hash: nothing was lost or reordered on the way through.
    for (const f of saved) expect(findingContentSha256(f)).toBe(f.contentSha256);
    expect(saved.map((f) => f.contentSha256)).toEqual(input.map((f) => f.contentSha256));
  });

  it("keeps evidence order, escalations, conflict and abstain text, which the hash depends on", () => {
    const m = addMatter(w, { amendment: true });
    const run = startRun(w, m);
    const amendment = m.amendment as NonNullable<typeof m.amendment>;
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      status: "undetermined",
      discrepancy: "Two passages disagree.",
      conflict: "Section 6.1 says two years; the amendment deletes it.",
      abstainReason: "The documents do not settle precedence.",
      evidence: [
        { spanId: amendment.spanIds[1] as string, quote: "Section 6.1", role: "conflicting", quoteCheck: "verified", offsets: { start: 3, end: 14 }, supportCheck: "insufficient" },
        { spanId: m.nda.spanIds[2] as string, quote: "two (2) years", role: "superseded", quoteCheck: "ambiguous", offsets: null, supportCheck: "not_run" },
        { spanId: m.nda.spanIds[3] as string, quote: "not in the text", role: "supporting", quoteCheck: "not_found", offsets: null, supportCheck: "not_run" },
      ],
      escalations: [
        { code: "model_abstained", detail: "no status" },
        { code: "conflicting_sources", detail: "6.1 vs amendment" },
      ],
      verificationState: "escalated_by_system",
    });
    const [saved] = w.repo.saveFindings(m.id, run.id, [f]);
    expect(saved?.evidence.map((e) => [e.spanId, e.quoteCheck])).toEqual([
      [amendment.spanIds[1], "verified"],
      [m.nda.spanIds[2], "ambiguous"],
      [m.nda.spanIds[3], "not_found"],
    ]);
    expect(saved?.escalations.map((e) => e.code)).toEqual(["model_abstained", "conflicting_sources"]);
    expect(saved).toMatchObject({ conflict: f.conflict, abstainReason: f.abstainReason });
    expect(saved?.contentSha256).toBe(f.contentSha256);
    expect(findingContentSha256(saved as VerifiedFinding)).toBe(f.contentSha256);
  });

  it("lists findings in playbook order whatever order they were saved in", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.saveFindings(m.id, run.id, [...allFindings(m)].reverse());
    expect(w.repo.listFindings(m.id, run.id).map((f) => f.ruleKey)).toEqual(["pty-1", "dur-1", "gov-1"]);
  });

  it("audits the save with rule keys and counts only", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    saveAll(w, m, run);
    const event = w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })[0];
    expect(event?.detail).toEqual({ saved: 3, skipped: 0, ruleKeys: ["pty-1", "dur-1", "gov-1"] });
  });

  it("is a no-op for a rule already saved with the same content, so a resumed run can save again", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const first = saveAll(w, m, run);
    const again = saveAll(w, m, run);
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(w.repo.listFindings(m.id, run.id)).toHaveLength(3);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })).toHaveLength(1);
    const different = rehash({ ...findingFor("dur-1", span(m, 2)), explanation: "Changed my mind." });
    expect(() => w.repo.saveFindings(m.id, run.id, [different])).toThrow(/different finding/);
  });

  it("refuses a run whose inputs changed, and one that was superseded", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => saveAll(w, m, run)).toThrow(StaleRunError);
    expect(w.repo.listFindings(m.id, run.id)).toEqual([]);
  });

  it("refuses a run whose digest no longer matches even if nothing marked it superseded", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    // A change made around the repository, so that no invalidation ran.
    w.db.prepare("UPDATE matters SET client_legal_name = 'Changed Behind The Back, Inc.' WHERE id = ?").run(m.id);
    expect(w.repo.getRun(m.id, run.id)?.status).toBe("analyzing");
    expect(() => saveAll(w, m, run)).toThrow(StaleRunError);
  });

  it("accepts findings only while the run is analyzing or verifying", () => {
    const m = addMatter(w);
    const queued = startRun(w, m, "queued");
    expect(() => saveAll(w, m, queued)).toThrow(/is queued/);
    for (const status of ["ingesting", "extracting", "retrieving", "analyzing", "verifying", "succeeded"] as const) {
      if (status !== "succeeded") w.repo.updateRunStatus(m.id, queued.id, status);
      if (status === "analyzing" || status === "verifying") continue;
      if (status === "succeeded") w.repo.updateRunStatus(m.id, queued.id, "succeeded");
      expect(() => saveAll(w, m, queued), status).toThrow(ConflictError);
    }
  });

  it("accepts findings while the run is verifying as well", () => {
    const m = addMatter(w);
    const run = startRun(w, m, "verifying");
    expect(saveAll(w, m, run)).toHaveLength(3);
  });

  describe("checks the stages' work again", () => {
    const refuse = (mutate: (f: VerifiedFinding) => VerifiedFinding, pattern: RegExp, rehashAfter = true) => {
      const m = addMatter(w, { amendment: true });
      const run = startRun(w, m);
      const bad = mutate(findingFor("dur-1", span(m, 2)));
      expect(() => w.repo.saveFindings(m.id, run.id, [rehashAfter ? rehash(bad) : bad])).toThrow(pattern);
      expect(w.repo.listFindings(m.id, run.id)).toEqual([]);
    };

    it("a content hash that is not the hash of the content", () => {
      refuse((f) => ({ ...f, explanation: "Edited after hashing." }), /not the hash of its content/, false);
    });
    it("a rule that is not in the run's playbook version", () => {
      refuse((f) => ({ ...f, ruleKey: "zzz-9" }), /zzz-9/);
    });
    it("a category or severity that disagrees with the rule", () => {
      refuse((f) => ({ ...f, severity: "low" }), /disagrees with its rule/);
      refuse((f) => ({ ...f, category: "parties" }), /disagrees with its rule/);
    });
    it("evidence that cites a span outside the run's documents", () => {
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), spanId: "ver_unknown:p0" }] as never }), /not in the run's documents/);
    });
    it("evidence that cites a span of another matter", () => {
      const other = addMatter(w, { name: "other" });
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), spanId: other.nda.spanIds[2] as string }] as never }), /not in the run's documents/);
    });
    it("verified evidence without offsets, or with offsets past the span", () => {
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), offsets: null }] as never }), /needs offsets/);
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), offsets: { start: 0, end: 9999 } }] as never }), /needs offsets/);
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), offsets: { start: 5, end: 5 } }] as never }), /needs offsets/);
    });
    it("offsets on a quote that was not verified", () => {
      refuse((f) => ({ ...f, evidence: [{ ...(f.evidence[0] as object), quoteCheck: "not_found" }] as never }), /not verified/);
    });
    it("an escalation that forces undetermined on a finding with another status", () => {
      for (const code of ["conflicting_sources", "model_abstained", "output_invalid", "context_over_budget"] as const)
        refuse((f) => ({ ...f, escalations: [{ code, detail: "x" }], verificationState: "escalated_by_system" }), /forces undetermined/);
    });
    it("an undetermined finding with no escalation", () => {
      refuse((f) => ({ ...f, status: "undetermined" }), /carries no escalation/);
    });
    it("a repeated check id", () => {
      refuse((f) => ({ ...f, checks: [...f.checks, ...f.checks] }), /repeats a check id/);
    });
    it("values outside the vocabulary", () => {
      refuse((f) => ({ ...f, status: "great" as never }), ValidationErrorPattern);
      refuse((f) => ({ ...f, fallbackBasis: "invented" as never }), ValidationErrorPattern);
      refuse((f) => ({ ...f, escalations: [{ code: "mystery" as never, detail: "" }] }), ValidationErrorPattern);
    });
    it("two findings for one rule", () => {
      const m = addMatter(w);
      const run = startRun(w, m);
      const f = findingFor("dur-1", span(m, 2));
      expect(() => w.repo.saveFindings(m.id, run.id, [f, f])).toThrow(/one finding per rule/);
    });
  });

  it("accepts an undetermined finding that carries its escalation", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const f = rehash({
      ...findingFor("dur-1", span(m, 2)),
      status: "undetermined",
      evidence: [],
      escalations: [{ code: "output_invalid", detail: "no valid answer" }],
      verificationState: "escalated_by_system",
    });
    expect(w.repo.saveFindings(m.id, run.id, [f])[0]).toMatchObject({ status: "undetermined", evidence: [] });
  });

  it("is all or nothing: a failure part way leaves no finding, evidence or check behind", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    // The third finding's checks cannot be written, after the first two findings are already in.
    w.db.exec(`CREATE TEMP TRIGGER fail_on_gov BEFORE INSERT ON verification_results
      WHEN NEW.finding_id IN (SELECT id FROM findings WHERE rule_key = 'gov-1')
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    expect(() => saveAll(w, m, run)).toThrow("injected failure");
    for (const table of ["findings", "finding_evidence", "verification_results"])
      expect((w.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })).toEqual([]);
    w.db.exec("DROP TRIGGER fail_on_gov");
    expect(saveAll(w, m, run)).toHaveLength(3);
  });
});

const ValidationErrorPattern = /invalid|finding/;

describe("recordReview", () => {
  const setup = () => reviewable(w);
  const decide = (matterId: string, f: { id: string; contentSha256: string }, over: object = {}) =>
    w.repo.recordReview(matterId, f.id, { reviewerId: ACTORS.reviewer, decision: "accept", findingContentSha256: f.contentSha256, ...over });

  it("records an acceptance bound to the content hash, and audits it without the reason", () => {
    const { m, findings } = setup();
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    const review = decide(m.id, f);
    expect(review).toMatchObject({
      findingId: f.id,
      matterId: m.id,
      reviewerId: ACTORS.reviewer,
      reviewerName: "Dana Whitfield (reviewing attorney)",
      decision: "accept",
      edits: null,
      reason: null,
      findingContentSha256: f.contentSha256,
      supersedesReviewId: null,
      validity: "current",
    });
    const event = w.repo.listAuditEvents({ matterId: m.id, action: "review.decide" })[0];
    expect(event).toMatchObject({ actorId: ACTORS.reviewer, targetId: f.id });
    expect(event?.detail).toMatchObject({ reviewId: review.id, ruleKey: "pty-1", decision: "accept", findingContentSha256: f.contentSha256 });
    expect(w.repo.getFinding(m.id, f.id)?.currentReview?.id).toBe(review.id);
  });

  it("requires a reason for edit, reject and escalate, and not for accept", () => {
    const { m, findings } = setup();
    const f = findings[1] as NonNullable<(typeof findings)[0]>;
    for (const decision of ["reject", "escalate"] as const) {
      expect(() => decide(m.id, f, { decision })).toThrow(/needs a reason/);
      expect(() => decide(m.id, f, { decision, reason: "   " })).toThrow(/needs a reason/);
      expect(() => decide(m.id, f, { decision, reason: null })).toThrow(/needs a reason/);
    }
    expect(() => decide(m.id, f, { decision: "edit", edits: { discrepancy: "x" } })).toThrow(/needs a reason/);
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
    expect(decide(m.id, f, { decision: "reject", reason: "The clause is not what the finding says." }).reason).toBe("The clause is not what the finding says.");
    expect(decide(m.id, f, { decision: "accept", reason: "Agreed." }).reason).toBe("Agreed.");
  });

  it("requires edits for an edit and forbids them otherwise", () => {
    const { m, findings } = setup();
    const f = findings[1] as NonNullable<(typeof findings)[0]>;
    expect(() => decide(m.id, f, { decision: "edit", reason: "r" })).toThrow(/needs the edits/);
    expect(() => decide(m.id, f, { decision: "edit", reason: "r", edits: null })).toThrow(/needs the edits/);
    expect(() => decide(m.id, f, { decision: "accept", edits: { status: "deviation" } })).toThrow(/only an edit/);
    expect(() => decide(m.id, f, { decision: "bogus" })).toThrow(ValidationError);
  });

  it("stores changed fields only, and refuses an edit that changes nothing", () => {
    const { m, findings } = setup();
    const f = findings[1] as NonNullable<(typeof findings)[0]>;
    expect(() => decide(m.id, f, { decision: "edit", reason: "r", edits: { status: "compliant", discrepancy: "" } })).toThrow(/change something/);
    const evidence = f.evidence[0] as NonNullable<(typeof f.evidence)[0]>;
    const review = decide(m.id, f, {
      decision: "edit",
      reason: "The amendment changes it.",
      edits: {
        status: "deviation",
        discrepancy: "No end is stated.",
        fallbackLanguage: "",
        evidenceRoles: [{ evidenceId: evidence.id, role: "governing" }],
      },
    });
    expect(review.edits).toEqual({ status: "deviation", discrepancy: "No end is stated." });
    const roleEdit = decide(m.id, f, { decision: "edit", reason: "r", edits: { evidenceRoles: [{ evidenceId: evidence.id, role: "supporting" }] } });
    expect(roleEdit.edits).toEqual({ evidenceRoles: [{ evidenceId: evidence.id, role: "supporting" }] });
  });

  it("refuses edits that name evidence of another finding, or unknown fields", () => {
    const { m, findings } = setup();
    const [a, b] = findings as [NonNullable<(typeof findings)[0]>, NonNullable<(typeof findings)[0]>];
    const foreign = b.evidence[0] as NonNullable<(typeof b.evidence)[0]>;
    expect(() => decide(m.id, a, { decision: "edit", reason: "r", edits: { evidenceRoles: [{ evidenceId: foreign.id, role: "supporting" }] } })).toThrow(NotFoundError);
    expect(() => decide(m.id, a, { decision: "edit", reason: "r", edits: { status: "bogus" } })).toThrow(ValidationError);
    expect(() => decide(m.id, a, { decision: "edit", reason: "r", edits: { severity: "low" } })).toThrow(ValidationError);
    expect(w.repo.listReviews(m.id, a.id)).toEqual([]);
  });

  it("makes the previous decision stale and links the new one to it", () => {
    const { m, findings } = setup();
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    const first = decide(m.id, f);
    w.clock.tick();
    const second = decide(m.id, f, { decision: "reject", reason: "On reflection, no." });
    expect(second.supersedesReviewId).toBe(first.id);
    const all = w.repo.listReviews(m.id, f.id);
    expect(all.map((r) => [r.id, r.validity])).toEqual([[first.id, "stale"], [second.id, "current"]]);
    expect(w.repo.getFinding(m.id, f.id)?.currentReview?.id).toBe(second.id);
    expect(w.db.prepare("SELECT count(*) AS n FROM reviews WHERE finding_id = ? AND validity = 'current'").get(f.id)).toEqual({ n: 1 });
  });

  it("refuses a decision made on content that is not the finding's, and changes nothing", () => {
    const { m, findings } = setup();
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    expect(() => decide(m.id, f, { findingContentSha256: sha256Hex("older content") })).toThrow(ContentMismatchError);
    expect(() => decide(m.id, f, { findingContentSha256: "short" })).toThrow(ValidationError);
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
    expect(w.repo.getMatter(m.id)?.status).toBe("in_review");
  });

  it("refuses a decision on a finding that went stale, naming it as stale and not as a mismatch", () => {
    const { m, findings } = setup();
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => decide(m.id, f)).toThrow(StaleFindingError);
    expect(() => decide(m.id, f, { findingContentSha256: sha256Hex("older content") })).toThrow(StaleFindingError);
    expect(w.repo.listReviews(m.id, f.id)).toEqual([]);
  });

  it("refuses a finding whose run is no longer current even if its flag still says current", () => {
    const { m, run, findings } = setup();
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    w.db.prepare("UPDATE matters SET client_legal_name = 'Changed Behind The Back, Inc.' WHERE id = ?").run(m.id);
    expect(w.repo.getFinding(m.id, f.id)?.validity).toBe("current");
    expect(w.repo.getRun(m.id, run.id)?.status).toBe("succeeded");
    expect(() => decide(m.id, f)).toThrow(StaleFindingError);
  });

  it("refuses a decision before the run has succeeded, and after the memo is exported", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const findings = saveAll(w, m, run);
    expect(() => decide(m.id, findings[0] as never)).toThrow(/not open for review|running/);
    const done = exported(w);
    const f = done.findings[0] as NonNullable<(typeof done.findings)[0]>;
    expect(() => decide(done.m.id, f, { decision: "reject", reason: "Too late." })).toThrow(/exported/);
  });

  it("moves the matter to review_complete when the last finding is decided, and back when it is reopened", () => {
    const { m, findings } = setup();
    const status = () => w.repo.getMatter(m.id)?.status;
    expect(status()).toBe("in_review");
    decideAll(w, m.id, findings.slice(0, 2));
    expect(status()).toBe("in_review");
    decide(m.id, findings[2] as never);
    expect(status()).toBe("review_complete");

    // A reviewer who reopens the review is putting the matter back in review...
    w.repo.setMatterStatus(m.id, "in_review", { actorId: ACTORS.reviewer });
    expect(status()).toBe("in_review");
    // ...and deciding again, on the same content, completes it again.
    decide(m.id, findings[0] as never, { decision: "reject", reason: "Reopened." });
    expect(status()).toBe("review_complete");
    // A decision that is refused changes nothing.
    expect(() => decide(m.id, findings[0] as never, { findingContentSha256: sha256Hex("x") })).toThrow();
    expect(status()).toBe("review_complete");
  });

  it("lists earlier decisions for the same rule across runs, newest first, for re-confirmation", () => {
    const { m, findings } = setup();
    const f = findings[1] as NonNullable<(typeof findings)[0]>;
    const review = decide(m.id, f);
    w.repo.applyInputChange(m.id, { reason: "rerun_requested", actorId: ACTORS.associate });
    const run2 = startRun(w, m);
    const second = saveAll(w, m, run2);
    succeed(w, m, run2);
    const prior = w.repo.listReviewsForRule(m.id, "dur-1");
    expect(prior.map((r) => [r.id, r.runId, r.validity])).toEqual([[review.id, f.runId, "stale"]]);
    // Same content, so a one-click re-confirmation is possible: the hashes are equal.
    expect(prior[0]?.findingContentSha256).toBe(second[1]?.contentSha256);
    expect(w.repo.listReviewsForRule(m.id, "gov-1")).toEqual([]);
  });
});

describe("export readiness", () => {
  it("is ready only when every finding is current with a current decision on its exact content", () => {
    const { m, run, findings } = reviewable(w);
    expect(w.repo.getExportReadiness(m.id, run.id).ready).toBe(false);
    decideAll(w, m.id, findings);
    expect(w.repo.getExportReadiness(m.id, run.id)).toEqual({ ready: true, blockers: [] });
  });

  it("names the finding, the rule and the reason for each blocker", () => {
    const { m, run, findings } = reviewable(w);
    decideAll(w, m.id, [findings[0] as never]);
    const { ready, blockers } = w.repo.getExportReadiness(m.id, run.id);
    expect(ready).toBe(false);
    expect(blockers).toEqual([
      { findingId: findings[1]?.id, ruleKey: "dur-1", reason: "no_review" },
      { findingId: findings[2]?.id, ruleKey: "gov-1", reason: "no_review" },
    ]);
  });

  it("reports finding_stale and run_not_current after an input change", () => {
    const { m, run, findings } = reviewable(w);
    decideAll(w, m.id, findings);
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    const { blockers } = w.repo.getExportReadiness(m.id, run.id);
    expect(blockers[0]).toEqual({ findingId: null, ruleKey: null, reason: "run_not_current" });
    expect(blockers.slice(1).map((b) => b.reason)).toEqual(["finding_stale", "finding_stale", "finding_stale"]);
    expect(blockers.slice(1).map((b) => b.ruleKey)).toEqual(["pty-1", "dur-1", "gov-1"]);
  });

  it("reports a run that has not succeeded", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    saveAll(w, m, run);
    expect(reasons(m.id, run.id)).toContain("run_not_current");
  });

  it("reports a decision made on other content as content_changed", () => {
    const { m, run, findings } = reviewable(w);
    decideAll(w, m.id, findings.slice(1));
    // A decision row that was written around the repository, for content the finding does not have.
    w.db
      .prepare(
        `INSERT INTO reviews (id, finding_id, matter_id, reviewer_id, decision, edited_json, reason, finding_content_sha256, supersedes_review_id, validity, created_at)
         VALUES ('rev_forged', ?, ?, ?, 'accept', NULL, NULL, ?, NULL, 'current', 't')`,
      )
      .run(findings[0]?.id as string, m.id, ACTORS.reviewer, sha256Hex("something else"));
    expect(w.repo.getExportReadiness(m.id, run.id).blockers).toEqual([
      { findingId: findings[0]?.id, ruleKey: "pty-1", reason: "content_changed" },
    ]);
  });

  it("reports only stale decisions as stale_review", () => {
    const { m, run, findings } = reviewable(w);
    const reviews = decideAll(w, m.id, findings);
    w.db.prepare("UPDATE reviews SET validity = 'stale' WHERE id = ?").run(reviews[1]?.id as string);
    expect(w.repo.getExportReadiness(m.id, run.id).blockers).toEqual([
      { findingId: findings[1]?.id, ruleKey: "dur-1", reason: "stale_review" },
    ]);
  });

  it("recomputes the content hash instead of trusting the stored one", () => {
    const { m, run, findings } = reviewable(w);
    decideAll(w, m.id, findings);
    // Editing content around the repository (the update trigger would normally refuse this).
    w.db.exec("DROP TRIGGER findings_content_immutable");
    w.db.prepare("UPDATE findings SET explanation = 'Quietly changed.' WHERE id = ?").run(findings[0]?.id as string);
    expect(w.repo.getExportReadiness(m.id, run.id).blockers).toEqual([
      { findingId: findings[0]?.id, ruleKey: "pty-1", reason: "content_changed" },
    ]);
  });

  it("is not ready when a rule has no finding, which an empty run would otherwise pass vacuously", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.saveFindings(m.id, run.id, [findingFor("pty-1", span(m, 1)), findingFor("gov-1", span(m, 3))]);
    succeed(w, m, run);
    const first = w.repo.listFindings(m.id, run.id);
    decideAll(w, m.id, first);
    expect(w.repo.getExportReadiness(m.id, run.id).blockers).toEqual([{ findingId: null, ruleKey: "dur-1", reason: "missing_finding" }]);

    const empty = addMatter(w, { name: "empty" });
    const emptyRun = startRun(w, empty);
    succeed(w, empty, emptyRun);
    const result = w.repo.getExportReadiness(empty.id, emptyRun.id);
    expect(result.ready).toBe(false);
    expect(result.blockers.map((b) => b.reason)).toEqual(["missing_finding", "missing_finding", "missing_finding"]);
  });

  it("returns not found for a run that is not this matter's", () => {
    const { m } = reviewable(w);
    const other = reviewable(w);
    expect(() => w.repo.getExportReadiness(m.id, other.run.id)).toThrow(NotFoundError);
    expect(() => w.repo.getExportReadiness(m.id, "run_nope")).toThrow(NotFoundError);
  });
});

describe("recordMemo", () => {
  it("records a memo for a fully decided run, supersedes the last one, and exports the matter", () => {
    const e = exported(w);
    expect(e.memo).toMatchObject({ status: "current", runId: e.run.id, exportedBy: ACTORS.reviewer });
    expect(e.memo.reviewIds).toEqual(e.reviews.map((r) => r.id));
    expect(w.repo.getMatter(e.m.id)?.status).toBe("exported");
    expect(w.repo.getCurrentMemo(e.m.id)?.id).toBe(e.memo.id);

    // A second export of the same decisions replaces the first as the current memo.
    w.clock.tick();
    const second = w.repo.recordMemo(e.m.id, {
      runId: e.run.id,
      reviewIds: e.reviews.map((r) => r.id),
      fileSha256: sha256Hex("second memo"),
      storagePath: fakePath(e.m.id),
      exportedBy: ACTORS.reviewer,
    });
    expect(w.repo.getMemo(e.m.id, e.memo.id)?.status).toBe("superseded");
    expect(w.repo.getCurrentMemo(e.m.id)?.id).toBe(second.id);
    expect(w.repo.listMemos(e.m.id).map((x) => x.id)).toEqual([second.id, e.memo.id]);
    expect(w.repo.getMatter(e.m.id)?.status).toBe("exported");
    const event = w.repo.listAuditEvents({ matterId: e.m.id, action: "memo.export" })[0];
    expect(event?.detail).toMatchObject({ runId: e.run.id, fileSha256: e.memo.fileSha256, reviews: 3 });
  });

  it("is blocked, with the blockers, while anything is undecided", () => {
    const { m, run, findings } = reviewable(w);
    const reviews = decideAll(w, m.id, findings.slice(0, 2));
    let caught: unknown;
    try {
      w.repo.recordMemo(m.id, { runId: run.id, reviewIds: reviews.map((r) => r.id), fileSha256: sha256Hex("m"), storagePath: fakePath(m.id), exportedBy: ACTORS.reviewer });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExportBlockedError);
    expect((caught as ExportBlockedError).blockers).toEqual([{ findingId: findings[2]?.id, ruleKey: "gov-1", reason: "no_review" }]);
    expect(w.repo.listMemos(m.id)).toEqual([]);
    expect(w.repo.getMatter(m.id)?.status).toBe("in_review");
  });

  it("is blocked after an input change", () => {
    const { m, run, findings } = reviewable(w);
    const reviews = decideAll(w, m.id, findings);
    w.repo.updateClientName(m.id, "Marlowe Analytics Holdings, Inc.", { actorId: ACTORS.associate });
    expect(() => w.repo.recordMemo(m.id, { runId: run.id, reviewIds: reviews.map((r) => r.id), fileSha256: sha256Hex("m"), storagePath: fakePath(m.id), exportedBy: ACTORS.reviewer })).toThrow(ExportBlockedError);
  });

  it("refuses a memo built from decisions that are not the current ones", () => {
    const { m, run, findings } = reviewable(w);
    const reviews = decideAll(w, m.id, findings);
    // The reviewer changes their mind while the document is being built.
    w.repo.recordReview(m.id, findings[0]?.id as string, { reviewerId: ACTORS.reviewer, decision: "reject", reason: "Changed.", findingContentSha256: findings[0]?.contentSha256 as string });
    const attempt = (reviewIds: string[]) =>
      w.repo.recordMemo(m.id, { runId: run.id, reviewIds, fileSha256: sha256Hex("m"), storagePath: fakePath(m.id), exportedBy: ACTORS.reviewer });
    expect(() => attempt(reviews.map((r) => r.id))).toThrow(/changed while the memo was being built/);
    expect(() => attempt([])).toThrow(ConflictError);
    expect(w.repo.listMemos(m.id)).toEqual([]);
    const current = w.repo.listFindings(m.id, run.id).map((f) => (f.currentReview as { id: string }).id);
    expect(attempt(current).status).toBe("current");
  });

  it("validates the file hash and keeps the file in the matter's own folder", () => {
    const { m, run, findings } = reviewable(w);
    const reviews = decideAll(w, m.id, findings);
    const go = (over: object) =>
      w.repo.recordMemo(m.id, { runId: run.id, reviewIds: reviews.map((r) => r.id), fileSha256: sha256Hex("m"), storagePath: fakePath(m.id), exportedBy: ACTORS.reviewer, ...over });
    expect(() => go({ fileSha256: "nope" })).toThrow(ValidationError);
    expect(() => go({ storagePath: fakePath("mat_ffffffffffffffff") })).toThrow(/own folder/);
    expect(() => go({ exportedBy: "usr_nobody" })).toThrow(NotFoundError);
    expect(() => go({ runId: "run_nope" })).toThrow(NotFoundError);
    expect(w.repo.listMemos(m.id)).toEqual([]);
  });
});

describe("feedback", () => {
  it("records ratings, reasons, missed issues and comments, with ids only in the audit log", () => {
    const { m, run, findings } = reviewable(w);
    const f = findings[0] as NonNullable<(typeof findings)[0]>;
    const rating = w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "rating", rating: 4 });
    const reason = w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "finding_reason", findingId: f.id, runId: run.id, reasonCode: "wrong_evidence" });
    const missed = w.repo.addFeedback(m.id, { userId: ACTORS.associate, kind: "missed_issue", text: "FEEDBACK-SECRET about a clause" });
    w.repo.addFeedback(m.id, { userId: ACTORS.associate, kind: "comment", text: "Looks right." });
    expect(rating).toMatchObject({ kind: "rating", rating: 4, text: null });
    expect(reason).toMatchObject({ findingId: f.id, runId: run.id, reasonCode: "wrong_evidence" });
    expect(missed.text).toBe("FEEDBACK-SECRET about a clause");
    expect(w.repo.listFeedback(m.id)).toHaveLength(4);
    const audit = JSON.stringify(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" }));
    expect(audit).not.toContain("FEEDBACK-SECRET");
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "feedback.add" })).toHaveLength(4);
  });

  it("validates", () => {
    const { m, findings } = reviewable(w);
    const go = (input: object) => w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "t", ...input } as never);
    expect(() => go({ kind: "rating" })).toThrow(/needs a rating/);
    expect(() => go({ kind: "rating", rating: 6 })).toThrow(ValidationError);
    expect(() => go({ kind: "rating", rating: 2.5 })).toThrow(ValidationError);
    expect(() => go({ kind: "comment", text: "   " })).toThrow(/needs text/);
    expect(() => go({ kind: "missed_issue", text: undefined })).toThrow(/needs text/);
    expect(() => go({ kind: "finding_reason" })).toThrow(/names a finding/);
    expect(() => go({ kind: "bogus" })).toThrow(ValidationError);
    expect(() => go({ reasonCode: "Has Spaces" })).toThrow(ValidationError);
    expect(() => go({ text: "x".repeat(4001) })).toThrow(ValidationError);
    expect(() => go({ userId: "usr_nobody" })).toThrow(NotFoundError);
    expect(() => go({ findingId: "fnd_nope" })).toThrow(NotFoundError);
    expect(() => go({ runId: "run_nope" })).toThrow(NotFoundError);
    expect(findings).toHaveLength(3);
    expect(w.repo.listFeedback(m.id)).toEqual([]);
  });
});
