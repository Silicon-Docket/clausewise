import {
  FORCES_UNDETERMINED,
  REASON_CODES,
  REVIEW_DECISIONS,
  type CheckResult,
  type DeterminedStatus,
  type Escalation,
  type EvidenceRole,
  type FallbackBasis,
  type ReasonCode,
  type ReviewDecision,
  type Status,
  type VerifiedFinding,
} from "../contracts.js";
import { canonicalJson, findingContentSha256, hashOf } from "../canonical.js";
import { newId } from "../ids.js";
import { verifyQuote } from "../quotes.js";
import { settleStatus } from "../settlement.js";
import {
  assertSha256,
  assertShortCode,
  assertStoragePath,
  assertStoragePathFree,
  cleanLabel,
  cleanProse,
  parseWith,
  type Ctx,
} from "./context.js";
import {
  ConflictError,
  ContentMismatchError,
  ExportBlockedError,
  NotFoundError,
  StaleFindingError,
  StaleRunError,
  ValidationError,
  type ExportBlocker,
} from "./errors.js";
import type { MattersApi } from "./repo-matters.js";
import { toStoredRule } from "./repo-playbooks.js";
import type { PlaybooksApi } from "./repo-playbooks.js";
import type { RunsApi } from "./repo-runs.js";
import { RULE_KEY_PATTERN, ReviewEditsSchema, VerifiedFindingSchema } from "./schemas.js";
import type {
  ExportReadiness,
  FeedbackRow,
  FindingRecord,
  MemoRow,
  ReviewEdits,
  ReviewRecord,
  StoredEvidence,
  StoredRule,
} from "./types.js";

interface RawFinding {
  id: string;
  run_id: string;
  matter_id: string;
  playbook_rule_id: string;
  rule_key: string;
  category: VerifiedFinding["category"];
  severity: VerifiedFinding["severity"];
  status: Status;
  discrepancy: string;
  explanation: string;
  fallback_language: string | null;
  fallback_basis: FallbackBasis;
  escalations_json: string;
  verification_state: VerifiedFinding["verificationState"];
  content_sha256: string;
  model_status: DeterminedStatus | null;
  validity: "current" | "stale";
  stale_reason: string | null;
  conflict: string | null;
  abstain_reason: string | null;
}
interface RawEvidence {
  id: string;
  finding_id: string;
  span_id: string;
  role: EvidenceRole;
  quote: string;
  start_offset: number | null;
  end_offset: number | null;
  quote_check: StoredEvidence["quoteCheck"];
  support_check: StoredEvidence["supportCheck"];
}
interface RawCheck {
  finding_id: string;
  check_id: string;
  kind: CheckResult["kind"];
  outcome: CheckResult["outcome"];
  detail: string;
}
interface RawReview {
  id: string;
  finding_id: string;
  matter_id: string;
  reviewer_id: string;
  reviewer_name: string;
  decision: ReviewDecision;
  edited_json: string | null;
  reason: string | null;
  reason_code: ReasonCode | null;
  minor_edit: 0 | 1 | null;
  finding_content_sha256: string;
  supersedes_review_id: string | null;
  validity: "current" | "stale";
  created_at: string;
}
interface RawMemo {
  id: string;
  matter_id: string;
  run_id: string;
  review_ids_json: string;
  file_sha256: string;
  storage_path: string;
  status: "current" | "superseded";
  exported_by: string;
  exported_at: string;
}
interface RawFeedback {
  id: string;
  matter_id: string;
  run_id: string | null;
  finding_id: string | null;
  user_id: string;
  kind: FeedbackRow["kind"];
  reason_code: string | null;
  rating: number | null;
  text: string | null;
  rule_key: string | null;
  location: string | null;
  created_at: string;
}

const toReview = (r: RawReview): ReviewRecord => ({
  id: r.id,
  findingId: r.finding_id,
  matterId: r.matter_id,
  reviewerId: r.reviewer_id,
  reviewerName: r.reviewer_name,
  decision: r.decision,
  edits: r.edited_json === null ? null : (JSON.parse(r.edited_json) as ReviewEdits),
  reason: r.reason,
  reasonCode: r.reason_code,
  minorEdit: r.minor_edit === null ? null : r.minor_edit === 1,
  findingContentSha256: r.finding_content_sha256,
  supersedesReviewId: r.supersedes_review_id,
  validity: r.validity,
  createdAt: r.created_at,
});
const toMemo = (r: RawMemo): MemoRow => ({
  id: r.id,
  matterId: r.matter_id,
  runId: r.run_id,
  reviewIds: JSON.parse(r.review_ids_json) as string[],
  fileSha256: r.file_sha256,
  storagePath: r.storage_path,
  status: r.status,
  exportedBy: r.exported_by,
  exportedAt: r.exported_at,
});
const toFeedback = (r: RawFeedback): FeedbackRow => ({
  id: r.id,
  matterId: r.matter_id,
  runId: r.run_id,
  findingId: r.finding_id,
  userId: r.user_id,
  kind: r.kind,
  reasonCode: r.reason_code,
  rating: r.rating,
  text: r.text,
  ruleKey: r.rule_key,
  location: r.location,
  createdAt: r.created_at,
});

const MAX_REASON = 4000;
const MAX_EDIT_TEXT = 8000;
const MAX_FEEDBACK_TEXT = 4000;

export function createFindingsApi(
  ctx: Ctx,
  matters: MattersApi,
  playbooks: PlaybooksApi,
  runs: RunsApi,
) {
  const { get, all, run, tx } = ctx;
  const { requireMatter, requireUser, transitionMatter } = matters.internal;
  const { requireRun } = runs.internal;

  // --- reading ------------------------------------------------------------------------------

  /**
   * Assembles findings with their evidence, checks, escalations, rule and decisions. One call per
   * kind of row for the whole set, so listing a run is five queries however many findings it has.
   * Every query is anchored on the matter.
   */
  function assemble(
    matterId: string,
    runId: string | null,
    findingId: string | null,
  ): FindingRecord[] {
    const findings = all<RawFinding>(
      "SELECT * FROM findings WHERE matter_id = ?1 AND (?2 IS NULL OR run_id = ?2) AND (?3 IS NULL OR id = ?3)",
      matterId,
      runId,
      findingId,
    );
    if (findings.length === 0) return [];

    const ruleIds = JSON.stringify([...new Set(findings.map((f) => f.playbook_rule_id))]);
    const rules = new Map<string, StoredRule>(
      all<Parameters<typeof toStoredRule>[0]>(
        "SELECT * FROM playbook_rules WHERE id IN (SELECT value FROM json_each(?))",
        ruleIds,
      ).map((r) => [r.id, toStoredRule(r)]),
    );

    const evidenceBy = new Map<string, StoredEvidence[]>();
    for (const e of all<RawEvidence>(
      `SELECT e.* FROM finding_evidence e JOIN findings f ON f.id = e.finding_id
       WHERE f.matter_id = ?1 AND (?2 IS NULL OR f.run_id = ?2) AND (?3 IS NULL OR f.id = ?3)
       ORDER BY e.finding_id, e.ordinal`,
      matterId,
      runId,
      findingId,
    )) {
      const list = evidenceBy.get(e.finding_id) ?? [];
      list.push({
        id: e.id,
        spanId: e.span_id,
        quote: e.quote,
        role: e.role,
        quoteCheck: e.quote_check,
        offsets:
          e.start_offset === null || e.end_offset === null
            ? null
            : { start: e.start_offset, end: e.end_offset },
        supportCheck: e.support_check,
      });
      evidenceBy.set(e.finding_id, list);
    }

    const checksBy = new Map<string, CheckResult[]>();
    for (const c of all<RawCheck>(
      `SELECT v.* FROM verification_results v JOIN findings f ON f.id = v.finding_id
       WHERE f.matter_id = ?1 AND (?2 IS NULL OR f.run_id = ?2) AND (?3 IS NULL OR f.id = ?3)
       ORDER BY v.finding_id, v.ordinal`,
      matterId,
      runId,
      findingId,
    )) {
      const list = checksBy.get(c.finding_id) ?? [];
      list.push({ id: c.check_id, kind: c.kind, outcome: c.outcome, detail: c.detail });
      checksBy.set(c.finding_id, list);
    }

    const reviewsBy = new Map<string, ReviewRecord[]>();
    for (const r of all<RawReview>(
      `SELECT rv.*, u.display_name AS reviewer_name
       FROM reviews rv
       JOIN users u ON u.id = rv.reviewer_id
       JOIN findings f ON f.id = rv.finding_id
       WHERE rv.matter_id = ?1 AND f.matter_id = ?1
         AND (?2 IS NULL OR f.run_id = ?2) AND (?3 IS NULL OR f.id = ?3)
       ORDER BY rv.created_at, rv.rowid`,
      matterId,
      runId,
      findingId,
    )) {
      const list = reviewsBy.get(r.finding_id) ?? [];
      list.push(toReview(r));
      reviewsBy.set(r.finding_id, list);
    }

    const records = findings.map((f): FindingRecord => {
      const reviews = reviewsBy.get(f.id) ?? [];
      return {
        id: f.id,
        runId: f.run_id,
        matterId: f.matter_id,
        playbookRuleId: f.playbook_rule_id,
        ruleKey: f.rule_key,
        category: f.category,
        severity: f.severity,
        status: f.status,
        evidence: evidenceBy.get(f.id) ?? [],
        discrepancy: f.discrepancy,
        explanation: f.explanation,
        fallbackLanguage: f.fallback_language,
        fallbackBasis: f.fallback_basis,
        conflict: f.conflict,
        abstainReason: f.abstain_reason,
        checks: checksBy.get(f.id) ?? [],
        escalations: JSON.parse(f.escalations_json) as Escalation[],
        verificationState: f.verification_state,
        contentSha256: f.content_sha256,
        modelStatus: f.model_status,
        validity: f.validity,
        staleReason: f.stale_reason,
        rule: rules.get(f.playbook_rule_id) as StoredRule,
        reviews,
        currentReview: reviews.find((r) => r.validity === "current") ?? null,
      };
    });
    return records.sort(
      (a, b) => a.rule.ordinal - b.rule.ordinal || (a.ruleKey < b.ruleKey ? -1 : 1),
    );
  }

  const getFinding = (matterId: string, findingId: string): FindingRecord | undefined =>
    assemble(matterId, null, findingId)[0];
  /** In playbook order. Empty for a run that is not this matter's. */
  const listFindings = (matterId: string, runId: string): FindingRecord[] =>
    assemble(matterId, runId, null);

  // --- writing findings ---------------------------------------------------------------------

  /**
   * Writes a run's findings, their evidence and their check results in one transaction.
   *
   * Refused with `StaleRunError` when the run is superseded or its inputs digest is no longer the
   * matter's, so a run that was overtaken by an edit cannot leave results behind. Everything the
   * stages computed is checked again here, because this is the last place before a reviewer sees
   * it: the content hash must be the hash of the content, evidence must cite spans of this
   * matter's documents named in the run manifest, offsets must fit their span, and the statuses
   * that must carry an escalation must carry one.
   *
   * A finding must also agree with itself. It is `verified` only when it has no escalation and no
   * failed check, and `escalated_by_system` otherwise (as `verifyFinding` decides it); a quote
   * that was not found carries `quote_not_verified`; and a quote marked `verified` or `ambiguous`
   * is looked up again in the stored span text with `verifyQuote`, so the badge and the highlight
   * a reviewer sees are the ones the text supports. A finding that keeps the status the workflow
   * stated (`modelStatus`) must be one that the rule's flags settle to the status it states (or
   * that a forcing escalation then made undetermined), and must carry the `status_settled` check;
   * a `status_settled` check without a model status is refused too. The `finding.save` event
   * counts how many of the saved findings were settled.
   *
   * Saving a rule that already has a finding with the same content is a no-op, so a resumed run
   * can save again.
   */
  function saveFindings(
    matterId: string,
    runId: string,
    findings: readonly VerifiedFinding[],
    opts: { actorId?: string | null } = {},
  ): FindingRecord[] {
    const parsed = findings.map((f) => parseWith(VerifiedFindingSchema, f, "finding"));
    if (new Set(parsed.map((f) => f.ruleKey)).size !== parsed.length)
      throw new ValidationError("duplicate_rule", "a run has one finding per rule");

    return tx(() => {
      const current = requireRun(matterId, runId);
      if (current.status === "superseded") throw new StaleRunError("superseded");
      const digest = matters.computeInputsDigest(matterId);
      if (digest === null || current.inputsSha256 !== digest)
        throw new StaleRunError("inputs_changed");
      if (current.status !== "analyzing" && current.status !== "verifying")
        throw new ConflictError(
          "run_not_writing",
          `the run is ${current.status}; findings are saved while it is analyzing or verifying`,
        );

      const rules = new Map(playbooks.listRules(current.playbookVersionId).map((r) => [r.key, r]));
      const inManifest = new Set(current.manifest.documents.map((d) => d.documentVersionId));
      const existing = new Map(
        all<{ rule_key: string; content_sha256: string }>(
          "SELECT rule_key, content_sha256 FROM findings WHERE run_id = ? AND matter_id = ?",
          runId,
          matterId,
        ).map((r) => [r.rule_key, r.content_sha256]),
      );

      const saved: string[] = [];
      let skipped = 0;
      let settledCount = 0;
      // A finding is named by its position in the batch. Its rule key came from the caller and may not
      // be a real one, so it is not echoed; a number helps whoever reads the error and is safe to print.
      for (const [index, f] of parsed.entries()) {
        const at = `finding ${index + 1}`;
        const rule = rules.get(f.ruleKey);
        if (!rule)
          throw new ValidationError(
            "unknown_rule",
            `${at} names a rule that is not in the run's playbook version`,
          );
        if (rule.category !== f.category || rule.severity !== f.severity)
          throw new ValidationError("rule_mismatch", `${at} disagrees with its rule`);

        const forced = f.escalations.some((e) => FORCES_UNDETERMINED.has(e.code));
        if (forced && f.status !== "undetermined")
          throw new ValidationError(
            "status_must_be_undetermined",
            `${at} carries an escalation that forces undetermined`,
          );
        if (f.status === "undetermined" && f.escalations.length === 0)
          throw new ValidationError(
            "undetermined_needs_escalation",
            `${at} is undetermined and carries no escalation`,
          );
        if (new Set(f.checks.map((c) => c.id)).size !== f.checks.length)
          throw new ValidationError("duplicate_check", `${at} repeats a check id`);

        // The status the workflow stated is kept only when code changed it, and the change must be
        // the one the rule's flags make (`settleStatus`): a settled finding is a statement that the
        // playbook, not the model, decided the status, so it is checked against the playbook here.
        const settledCheck = f.checks.some((c) => c.id === "status_settled");
        if (f.modelStatus !== undefined && f.modelStatus !== null) {
          if (f.modelStatus === f.status)
            throw new ValidationError(
              "model_status_same",
              `${at} keeps a model status that is the status it states`,
            );
          const settled = settleStatus(rule, f.modelStatus);
          if (settled === f.modelStatus)
            throw new ValidationError(
              "model_status_not_settled",
              `${at} keeps a model status that its rule does not change`,
            );
          if (f.status !== settled && f.status !== "undetermined")
            throw new ValidationError(
              "model_status_mismatch",
              `${at} has a status that is neither what its rule settles the model status to nor undetermined`,
            );
          if (!settledCheck)
            throw new ValidationError(
              "model_status_unexplained",
              `${at} keeps a model status and has no status_settled check`,
            );
        } else if (settledCheck) {
          throw new ValidationError(
            "model_status_mismatch",
            `${at} has a status_settled check and keeps no model status`,
          );
        }

        // The state a reviewer sees must be the one the checks and escalations give.
        const clean = f.escalations.length === 0 && f.checks.every((c) => c.outcome !== "fail");
        if ((f.verificationState === "verified") !== clean)
          throw new ValidationError(
            "verification_state_mismatch",
            `${at} has a verification state that disagrees with its checks and escalations`,
          );

        // Offsets are checked against the span text as stored, which is what the inspector highlights.
        let unfound = false;
        for (const e of f.evidence) {
          const span = matters.getSpan(matterId, e.spanId);
          if (!span || !inManifest.has(span.documentVersionId))
            throw new ValidationError(
              "evidence_outside_manifest",
              `${at} cites a span that is not in the run's documents`,
            );
          if (e.quoteCheck === "verified") {
            if (
              e.offsets === null ||
              e.offsets.start >= e.offsets.end ||
              e.offsets.end > span.text.length
            )
              throw new ValidationError(
                "bad_offsets",
                `${at} has verified evidence that needs offsets inside its span`,
              );
          } else if (e.offsets !== null) {
            throw new ValidationError(
              "bad_offsets",
              `${at} has evidence with offsets but its quote was not verified`,
            );
          }

          if (e.quoteCheck === "not_found") unfound = true;
          else {
            // A claim that the words are in the span is checked against the span, not believed.
            const found = verifyQuote(span.text, e.quote);
            if (
              found.check !== e.quoteCheck ||
              (e.quoteCheck === "verified" &&
                (found.offsets?.start !== e.offsets?.start ||
                  found.offsets?.end !== e.offsets?.end))
            )
              throw new ValidationError(
                "quote_mismatch",
                `${at} has a quote that is not in its span as the evidence states`,
              );
          }
        }
        if (unfound && !f.escalations.some((e) => e.code === "quote_not_verified"))
          throw new ValidationError(
            "unverified_quote_not_escalated",
            `${at} cites a quote that was not found and carries no quote_not_verified escalation`,
          );

        const recomputed = findingContentSha256({
          ruleKey: f.ruleKey,
          status: f.status,
          discrepancy: f.discrepancy,
          explanation: f.explanation,
          fallbackLanguage: f.fallbackLanguage,
          fallbackBasis: f.fallbackBasis,
          conflict: f.conflict,
          evidence: f.evidence,
          escalations: f.escalations,
          modelStatus: f.modelStatus ?? null,
        });
        if (recomputed !== f.contentSha256)
          throw new ValidationError(
            "content_hash_mismatch",
            `the content hash of ${at} is not the hash of its content`,
          );

        const already = existing.get(f.ruleKey);
        if (already !== undefined) {
          if (already !== f.contentSha256)
            throw new ConflictError(
              "finding_exists",
              `the run already has a different finding for the rule of ${at}`,
            );
          skipped += 1;
          continue;
        }

        const findingId = newId("fnd");
        run(
          `INSERT INTO findings
             (id, run_id, matter_id, playbook_rule_id, rule_key, category, severity, status, discrepancy,
              explanation, fallback_language, fallback_basis, escalations_json, verification_state,
              content_sha256, validity, stale_reason, conflict, abstain_reason, model_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', NULL, ?, ?, ?)`,
          findingId,
          runId,
          matterId,
          rule.id,
          f.ruleKey,
          f.category,
          f.severity,
          f.status,
          f.discrepancy,
          f.explanation,
          f.fallbackLanguage,
          f.fallbackBasis,
          canonicalJson(f.escalations),
          f.verificationState,
          f.contentSha256,
          f.conflict,
          f.abstainReason,
          f.modelStatus ?? null,
        );
        f.evidence.forEach((e, ordinal) =>
          run(
            `INSERT INTO finding_evidence
               (id, finding_id, span_id, role, quote, start_offset, end_offset, quote_check, support_check, ordinal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            newId("evd"),
            findingId,
            e.spanId,
            e.role,
            e.quote,
            e.offsets?.start ?? null,
            e.offsets?.end ?? null,
            e.quoteCheck,
            e.supportCheck,
            ordinal,
          ),
        );
        f.checks.forEach((c, ordinal) =>
          run(
            `INSERT INTO verification_results (finding_id, check_id, kind, outcome, detail, ordinal)
             VALUES (?, ?, ?, ?, ?, ?)`,
            findingId,
            c.id,
            c.kind,
            c.outcome,
            c.detail,
            ordinal,
          ),
        );
        saved.push(f.ruleKey);
        if (f.modelStatus !== undefined && f.modelStatus !== null) settledCount += 1;
      }

      if (saved.length > 0)
        ctx.audit({
          actorId: opts.actorId ?? null,
          matterId,
          action: "finding.save",
          targetType: "run",
          targetId: runId,
          detail: { saved: saved.length, skipped, settled: settledCount, ruleKeys: saved },
        });
      return listFindings(matterId, runId).filter((f) =>
        parsed.some((p) => p.ruleKey === f.ruleKey),
      );
    });
  }

  // --- reviews ------------------------------------------------------------------------------

  const getReview = (matterId: string, reviewId: string): ReviewRecord | undefined => {
    const row = get<RawReview>(
      `SELECT rv.*, u.display_name AS reviewer_name
       FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
       WHERE rv.id = ? AND rv.matter_id = ?`,
      reviewId,
      matterId,
    );
    return row ? toReview(row) : undefined;
  };

  /** Every decision on a finding, oldest first. */
  const listReviews = (matterId: string, findingId: string): ReviewRecord[] =>
    all<RawReview>(
      `SELECT rv.*, u.display_name AS reviewer_name
       FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
       WHERE rv.matter_id = ? AND rv.finding_id = ? ORDER BY rv.created_at, rv.rowid`,
      matterId,
      findingId,
    ).map(toReview);

  /**
   * Decisions made on earlier findings for the same rule, newest first, for "prior decision shown
   * for reference" after a re-run. Their `findingContentSha256` is what a one-click re-confirm
   * compares with the new finding's hash.
   */
  const listReviewsForRule = (
    matterId: string,
    ruleKey: string,
  ): (ReviewRecord & { runId: string })[] =>
    all<RawReview & { run_id: string }>(
      `SELECT rv.*, u.display_name AS reviewer_name, f.run_id AS run_id
       FROM reviews rv
       JOIN users u ON u.id = rv.reviewer_id
       JOIN findings f ON f.id = rv.finding_id
       WHERE rv.matter_id = ?1 AND f.matter_id = ?1 AND f.rule_key = ?2
       ORDER BY rv.created_at DESC, rv.rowid DESC`,
      matterId,
      ruleKey,
    ).map((row) => ({ ...toReview(row), runId: row.run_id }));

  function normaliseEdits(edits: unknown, finding: FindingRecord): ReviewEdits {
    const given = parseWith(ReviewEditsSchema, edits, "edits");
    const out: ReviewEdits = {};
    if (given.status !== undefined && given.status !== finding.status) out.status = given.status;
    if (given.discrepancy !== undefined && given.discrepancy !== finding.discrepancy) {
      cleanProse("edited discrepancy", given.discrepancy, MAX_EDIT_TEXT);
      out.discrepancy = given.discrepancy;
    }
    if (
      given.fallbackLanguage !== undefined &&
      given.fallbackLanguage !== (finding.fallbackLanguage ?? "")
    ) {
      cleanProse("edited fallback language", given.fallbackLanguage, MAX_EDIT_TEXT);
      out.fallbackLanguage = given.fallbackLanguage;
    }
    if (given.evidenceRoles !== undefined) {
      const roles: { evidenceId: string; role: EvidenceRole }[] = [];
      for (const change of given.evidenceRoles) {
        const evidence = finding.evidence.find((e) => e.id === change.evidenceId);
        // An evidence id from another finding is refused as if it did not exist.
        if (!evidence) throw new NotFoundError("evidence");
        if (evidence.role !== change.role) roles.push(change);
      }
      if (roles.length > 0) out.evidenceRoles = roles;
    }
    if (Object.keys(out).length === 0)
      throw new ValidationError("edit_changes_nothing", "an edit decision must change something");
    return out;
  }

  /**
   * Records a reviewer's decision, bound to the exact content they saw.
   *
   * It checks, in this order, that the finding exists in this matter, that it is current and its
   * run is the matter's current one (`StaleFindingError`), that the matter is open for review, that
   * `findingContentSha256` is the finding's hash (`ContentMismatchError`), and that a reason is
   * given where one is required, and that no other reviewer's decision is current on the finding
   * (`ConflictError` `decision_conflict`). The finding's previous current decision, the same
   * reviewer's, becomes stale and the new one records `supersedesReviewId`. The matter's `in_review` / `review_complete` status follows.
   *
   * An edit or a reject carries a reason code (`reason_code_required` when it has none), the other
   * decisions carry none (`reason_code_not_allowed`), and a code outside `REASON_CODES` is
   * `bad_reason_code`. Only an edit carries a minor-edit mark (`minor_edit_not_allowed`), stored as
   * false when an edit says nothing, and never true for an edit that changes the status
   * (`minor_edit_status`). The code and the mark are stored with the decision, bound like it to the
   * finding content it was made on, and the database refuses a decision that breaks these rules
   * (migration 006). The messages name the rule and never the value that was sent.
   */
  function recordReview(
    matterId: string,
    findingId: string,
    input: {
      reviewerId: string;
      decision: ReviewDecision;
      findingContentSha256: string;
      edits?: ReviewEdits | null;
      reason?: string | null;
      reasonCode?: ReasonCode | null;
      minorEdit?: boolean | null;
    },
  ): ReviewRecord {
    if (!(REVIEW_DECISIONS as readonly string[]).includes(input.decision))
      throw new ValidationError(
        "bad_decision",
        "decision must be accept, edit, reject or escalate",
      );
    assertSha256("findingContentSha256", input.findingContentSha256);
    const reason = input.reason === undefined || input.reason === null ? null : input.reason;
    if (reason !== null) cleanProse("reason", reason, MAX_REASON);
    const needsReason = input.decision !== "accept";
    if (needsReason && (reason === null || reason.trim().length === 0))
      throw new ValidationError(
        "reason_required",
        `a decision to ${input.decision} needs a reason`,
      );
    const hasEdits = input.edits !== undefined && input.edits !== null;
    if (input.decision === "edit" && !hasEdits)
      throw new ValidationError("edits_required", "an edit decision needs the edits");
    if (input.decision !== "edit" && hasEdits)
      throw new ValidationError("edits_not_allowed", "only an edit decision carries edits");

    // The reason code and the minor-edit mark. The value sent is never repeated in a message.
    const reasonCode = input.reasonCode === undefined ? null : input.reasonCode;
    if (reasonCode !== null && !(REASON_CODES as readonly unknown[]).includes(reasonCode))
      throw new ValidationError(
        "bad_reason_code",
        "the reason code is not one of the listed codes",
      );
    const needsReasonCode = input.decision === "edit" || input.decision === "reject";
    if (needsReasonCode && reasonCode === null)
      throw new ValidationError(
        "reason_code_required",
        `a decision to ${input.decision} needs a reason code`,
      );
    if (!needsReasonCode && reasonCode !== null)
      throw new ValidationError(
        "reason_code_not_allowed",
        "only an edit or a reject carries a reason code",
      );
    const markGiven = input.minorEdit !== undefined && input.minorEdit !== null;
    // A value that is not a plain true or false cannot be a mark, so it is refused as one that
    // is not allowed rather than stored as something else.
    if (markGiven && (input.decision !== "edit" || typeof input.minorEdit !== "boolean"))
      throw new ValidationError(
        "minor_edit_not_allowed",
        "only an edit carries a minor-edit mark, and the mark is true or false",
      );
    const minorEdit = input.decision === "edit" ? input.minorEdit === true : null;

    return tx(() => {
      const finding = getFinding(matterId, findingId);
      if (!finding) throw new NotFoundError("finding");
      const matter = requireMatter(matterId);
      const current = requireRun(matterId, finding.runId);

      // Currency is recomputed from the digest as well as read from the flag, because the flag is a
      // cache and the digest is the definition.
      const digest = matters.computeInputsDigest(matterId);
      if (
        finding.validity !== "current" ||
        current.status === "superseded" ||
        digest === null ||
        current.inputsSha256 !== digest
      )
        throw new StaleFindingError();
      if (matter.status === "exported")
        throw new ConflictError(
          "matter_exported",
          "the memo is exported; decisions can change only after a re-run",
        );
      if (matter.status !== "in_review" && matter.status !== "review_complete")
        throw new ConflictError(
          "matter_not_in_review",
          `the matter is ${matter.status}, not open for review`,
        );
      if (current.status !== "succeeded")
        throw new ConflictError("run_not_succeeded", "the run has not succeeded");
      if (input.findingContentSha256 !== finding.contentSha256) throw new ContentMismatchError();

      requireUser(input.reviewerId);
      const edits = hasEdits ? normaliseEdits(input.edits, finding) : null;
      // A change of status is a change of substance, so it is never a minor edit. `normaliseEdits`
      // has already dropped a status equal to the finding's own.
      if (minorEdit === true && edits !== null && edits.status !== undefined)
        throw new ValidationError(
          "minor_edit_status",
          "an edit that changes the status is not a minor edit",
        );

      // The content hash says the reviewer read this finding; it says nothing of whether they read
      // the decision on it. Replacing another reviewer's decision would leave them unaware, and the
      // memo is built from whichever decision is current. A reviewer changes their own.
      const previous = finding.currentReview;
      if (previous && previous.reviewerId !== input.reviewerId)
        throw new ConflictError(
          "decision_conflict",
          "another reviewer has already decided this finding",
        );
      if (previous) run("UPDATE reviews SET validity = 'stale' WHERE id = ?", previous.id);
      const id = newId("rev");
      run(
        `INSERT INTO reviews
           (id, finding_id, matter_id, reviewer_id, decision, edited_json, reason, reason_code,
            minor_edit, finding_content_sha256, supersedes_review_id, validity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)`,
        id,
        findingId,
        matterId,
        input.reviewerId,
        input.decision,
        edits === null ? null : canonicalJson(edits),
        reason,
        reasonCode,
        minorEdit === null ? null : minorEdit ? 1 : 0,
        finding.contentSha256,
        previous?.id ?? null,
        ctx.now(),
      );

      // Every current finding decided moves the matter to review_complete; reopening one moves it back.
      const after = getExportReadiness(matterId, finding.runId);
      const target = after.ready ? "review_complete" : "in_review";
      if (matter.status !== target) transitionMatter(matterId, target);

      ctx.audit({
        actorId: input.reviewerId,
        matterId,
        action: "review.decide",
        targetType: "finding",
        targetId: findingId,
        detail: {
          reviewId: id,
          ruleKey: finding.ruleKey,
          decision: input.decision,
          reasonCode,
          minorEdit,
          findingContentSha256: finding.contentSha256,
          supersedesReviewId: previous?.id ?? null,
          matterStatus: target,
        },
      });
      return getReview(matterId, id) as ReviewRecord;
    });
  }

  // --- export readiness ---------------------------------------------------------------------

  /**
   * Whether the run's findings can be exported now, and if not, what stands in the way. Nothing
   * stored is taken on trust: the inputs digest is recomputed, each finding's content hash is
   * recomputed from its content, and each decision's hash is compared with it.
   *
   * Ready means: the run succeeded on the matter's current inputs, the run has a finding for every
   * rule of its playbook version, and every one of them is current with a current decision made on
   * exactly its content.
   */
  function getExportReadiness(matterId: string, runId: string): ExportReadiness {
    const target = requireRun(matterId, runId);
    const matter = requireMatter(matterId);
    const blockers: ExportBlocker[] = [];

    const digest = matters.computeInputsDigest(matterId);
    const runCurrent =
      target.status === "succeeded" &&
      digest !== null &&
      target.inputsSha256 === digest &&
      matter.currentInputsSha256 === digest;
    if (!runCurrent) blockers.push({ findingId: null, ruleKey: null, reason: "run_not_current" });

    const found = listFindings(matterId, runId);
    const byRule = new Map(found.map((f) => [f.ruleKey, f]));
    for (const rule of playbooks.listRules(target.playbookVersionId))
      if (!byRule.has(rule.key))
        blockers.push({ findingId: null, ruleKey: rule.key, reason: "missing_finding" });

    for (const f of found) {
      const at = { findingId: f.id, ruleKey: f.ruleKey };
      if (f.validity !== "current") {
        blockers.push({ ...at, reason: "finding_stale" });
        continue;
      }
      if (findingContentSha256(f) !== f.contentSha256) {
        blockers.push({ ...at, reason: "content_changed" });
        continue;
      }
      const decision = f.currentReview;
      if (!decision) {
        blockers.push({
          ...at,
          reason: f.reviews.some((r) => r.validity === "stale") ? "stale_review" : "no_review",
        });
        continue;
      }
      if (decision.findingContentSha256 !== f.contentSha256)
        blockers.push({ ...at, reason: "content_changed" });
    }
    return { ready: blockers.length === 0, blockers };
  }

  // --- memos --------------------------------------------------------------------------------

  const getMemo = (matterId: string, memoId: string): MemoRow | undefined => {
    const row = get<RawMemo>(
      "SELECT * FROM memos WHERE id = ? AND matter_id = ?",
      memoId,
      matterId,
    );
    return row ? toMemo(row) : undefined;
  };
  const getCurrentMemo = (matterId: string): MemoRow | undefined => {
    const row = get<RawMemo>(
      "SELECT * FROM memos WHERE matter_id = ? AND status = 'current'",
      matterId,
    );
    return row ? toMemo(row) : undefined;
  };
  /** Newest first. */
  const listMemos = (matterId: string): MemoRow[] =>
    all<RawMemo>(
      "SELECT * FROM memos WHERE matter_id = ? ORDER BY exported_at DESC, rowid DESC",
      matterId,
    ).map(toMemo);

  /**
   * Records an exported memo. The caller builds and saves the file first and inserts the row only
   * when that worked (docs/parol/03, "Memo write failure"), so a row always has a file.
   *
   * Readiness is recomputed inside this transaction, and `reviewIds` must be exactly the current
   * decisions of the run's findings: a decision changed while the document was being built makes
   * the insert fail instead of recording a memo that does not match the record. The matter's
   * previous current memo is superseded and the matter becomes `exported`, unless that memo was
   * made from these very decisions of this run, in which case it is returned as it is and nothing
   * is written. The caller sees that by `storagePath`, and takes back the file it saved.
   */
  function recordMemo(
    matterId: string,
    input: {
      runId: string;
      reviewIds: readonly string[];
      fileSha256: string;
      storagePath: string;
      exportedBy: string;
    },
  ): MemoRow {
    assertSha256("fileSha256", input.fileSha256);
    assertStoragePath(matterId, input.storagePath);
    return tx(() => {
      const target = requireRun(matterId, input.runId);
      const matter = requireMatter(matterId);
      requireUser(input.exportedBy);
      const readiness = getExportReadiness(matterId, target.id);
      if (!readiness.ready) throw new ExportBlockedError(readiness.blockers);

      const ordered = listFindings(matterId, target.id).map(
        (f) => (f.currentReview as ReviewRecord).id,
      );
      const given = [...input.reviewIds].sort();
      const expected = [...ordered].sort();
      if (given.length !== expected.length || given.some((id, i) => id !== expected[i]))
        throw new ConflictError(
          "reviews_changed",
          "the decisions changed while the memo was being built",
        );

      // The memo on record was made from exactly these decisions of this run. A second copy would
      // supersede it, and a memo is shown as superseded only because the documents or the playbook
      // changed after it was made: nothing did. The caller is handed the memo that is there.
      const onRecord = getCurrentMemo(matterId);
      if (
        onRecord !== undefined &&
        onRecord.runId === target.id &&
        onRecord.reviewIds.length === ordered.length &&
        onRecord.reviewIds.every((id, i) => id === ordered[i])
      )
        return onRecord;

      assertStoragePathFree({ get }, input.storagePath);
      run(
        "UPDATE memos SET status = 'superseded' WHERE matter_id = ? AND status = 'current'",
        matterId,
      );
      const id = newId("memo");
      run(
        `INSERT INTO memos (id, matter_id, run_id, review_ids_json, file_sha256, storage_path, status, exported_by, exported_at)
         VALUES (?, ?, ?, ?, ?, ?, 'current', ?, ?)`,
        id,
        matterId,
        target.id,
        canonicalJson(ordered),
        input.fileSha256,
        input.storagePath,
        input.exportedBy,
        ctx.now(),
      );
      if (matter.status === "in_review") transitionMatter(matterId, "review_complete");
      if (matter.status !== "exported") transitionMatter(matterId, "exported");
      ctx.audit({
        actorId: input.exportedBy,
        matterId,
        action: "memo.export",
        targetType: "memo",
        targetId: id,
        detail: {
          runId: target.id,
          fileSha256: input.fileSha256,
          reviews: ordered.length,
          reviewsSha256: hashOf(ordered),
        },
      });
      return getMemo(matterId, id) as MemoRow;
    });
  }

  // --- feedback -----------------------------------------------------------------------------

  /** How many missed issues one person may report against one run. */
  const MAX_MISSED_ISSUES_PER_RUN = 50;
  const MAX_LOCATION = 200;
  const UNKNOWN_RULE_MESSAGE = "the rule is not in this review's playbook";

  /**
   * Adds a piece of feedback. The kinds have a shape each, held here and by the database
   * (`feedback_shape`, migration 006):
   *
   * - `missed_issue` is about a run: it needs the run and a text, may name the rule of the run's
   *   playbook that should have applied (`ruleKey`, null for "not covered by any rule") and say
   *   where (`location`), and carries no finding and no reason code. A rule that is not in the
   *   run's playbook is refused (`unknown_rule`), and one person may report 50 against a run
   *   (`feedback_limit`).
   * - `rule` and `location` belong to a missed issue and to no other kind.
   *
   * Every message names a rule and never what the caller sent. The audit event holds ids, codes and
   * flags: the text and the location are never in it, only whether they were given.
   */
  function addFeedback(
    matterId: string,
    input: {
      userId: string;
      kind: FeedbackRow["kind"];
      runId?: string | null;
      findingId?: string | null;
      reasonCode?: string | null;
      rating?: number | null;
      text?: string | null;
      ruleKey?: string | null;
      location?: string | null;
    },
  ): FeedbackRow {
    if (!["finding_reason", "missed_issue", "rating", "comment"].includes(input.kind))
      throw new ValidationError("bad_kind", "feedback kind is not recognised");
    const reasonCode = input.reasonCode ?? null;
    if (reasonCode !== null) assertShortCode("reasonCode", reasonCode);
    const rating = input.rating ?? null;
    if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5))
      throw new ValidationError("bad_rating", "rating must be a whole number from 1 to 5");
    if (input.kind === "rating" && rating === null)
      throw new ValidationError("rating_required", "a rating needs a rating");
    const text = input.text ?? null;
    if (text !== null) cleanProse("feedback text", text, MAX_FEEDBACK_TEXT);
    if (
      (input.kind === "missed_issue" || input.kind === "comment") &&
      (text === null || text.trim() === "")
    )
      throw new ValidationError("text_required", `${input.kind} feedback needs text`);
    if (input.kind === "finding_reason" && !input.findingId)
      throw new ValidationError("finding_required", "finding_reason feedback names a finding");

    // The rule and the location are a missed issue's. Checked before anything is looked up.
    const ruleKey = input.ruleKey ?? null;
    const given = input.location ?? null;
    if (input.kind !== "missed_issue" && (ruleKey !== null || given !== null))
      throw new ValidationError(
        "field_not_allowed",
        "a rule and a location belong to a missed issue only",
      );
    if (input.kind === "missed_issue") {
      if (input.runId === undefined || input.runId === null)
        throw new ValidationError("run_required", "a missed issue is reported against a run");
      if (input.findingId !== undefined && input.findingId !== null)
        throw new ValidationError("finding_not_allowed", "a missed issue names no finding");
      if (reasonCode !== null)
        throw new ValidationError("field_not_allowed", "a missed issue carries no reason code");
      // What cannot be a rule key at all is as unknown as a key that is no rule of the playbook,
      // and is answered in the same words.
      if (ruleKey !== null && !RULE_KEY_PATTERN.test(ruleKey))
        throw new ValidationError("unknown_rule", UNKNOWN_RULE_MESSAGE);
    }
    const location = given === null ? null : cleanLabel("location", given, MAX_LOCATION);

    return tx(() => {
      requireMatter(matterId);
      requireUser(input.userId);
      const runId = input.runId ?? null;
      const findingId = input.findingId ?? null;
      const target = runId === null ? undefined : requireRun(matterId, runId);
      if (findingId !== null && !getFinding(matterId, findingId))
        throw new NotFoundError("finding");
      if (input.kind === "missed_issue" && target !== undefined) {
        // The rule must be one of the playbook this run was made with: a key from another playbook,
        // or one that was never a rule, is not a rule of this review.
        if (
          ruleKey !== null &&
          !playbooks.listRules(target.playbookVersionId).some((rule) => rule.key === ruleKey)
        )
          throw new ValidationError("unknown_rule", UNKNOWN_RULE_MESSAGE);
        const reported = get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM feedback WHERE matter_id = ? AND run_id = ? AND user_id = ? AND kind = 'missed_issue'",
          matterId,
          target.id,
          input.userId,
        );
        if ((reported?.n ?? 0) >= MAX_MISSED_ISSUES_PER_RUN)
          throw new ConflictError(
            "feedback_limit",
            "the most missed issues that one person can report on a review have been reported",
          );
      }
      const id = newId("fbk");
      run(
        `INSERT INTO feedback (id, matter_id, run_id, finding_id, user_id, kind, reason_code, rating, text, rule_key, location, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        matterId,
        runId,
        findingId,
        input.userId,
        input.kind,
        reasonCode,
        rating,
        text,
        ruleKey,
        location,
        ctx.now(),
      );
      // The text and the location are not audited: the audit log holds ids, codes and flags only.
      ctx.audit({
        actorId: input.userId,
        matterId,
        action: "feedback.add",
        targetType: "feedback",
        targetId: id,
        detail: {
          kind: input.kind,
          reasonCode,
          rating,
          hasText: text !== null,
          hasLocation: location !== null,
          ruleKey,
          findingId,
          runId,
        },
      });
      return toFeedback(get<RawFeedback>("SELECT * FROM feedback WHERE id = ?", id) as RawFeedback);
    });
  }

  /**
   * The feedback of a matter, oldest first. Every filter is optional and they are ANDed; the query
   * is anchored on the matter whatever the filter says, so an id of another matter finds nothing.
   */
  const listFeedback = (
    matterId: string,
    filter: {
      kind?: FeedbackRow["kind"];
      runId?: string;
      findingId?: string;
      userId?: string;
    } = {},
  ): FeedbackRow[] =>
    all<RawFeedback>(
      `SELECT * FROM feedback
       WHERE matter_id = ?1
         AND (?2 IS NULL OR kind = ?2)
         AND (?3 IS NULL OR run_id = ?3)
         AND (?4 IS NULL OR finding_id = ?4)
         AND (?5 IS NULL OR user_id = ?5)
       ORDER BY created_at, rowid`,
      matterId,
      filter.kind ?? null,
      filter.runId ?? null,
      filter.findingId ?? null,
      filter.userId ?? null,
    ).map(toFeedback);

  return {
    saveFindings,
    getFinding,
    listFindings,
    recordReview,
    getReview,
    listReviews,
    listReviewsForRule,
    getExportReadiness,
    recordMemo,
    getMemo,
    getCurrentMemo,
    listMemos,
    addFeedback,
    listFeedback,
  };
}

export type FindingsApi = ReturnType<typeof createFindingsApi>;
