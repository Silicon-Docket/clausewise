import type { ObjectGenerator } from "@clausewise/llm";
import type { AuthorizedMatter } from "../auth/types.js";
import { roleAllows } from "../auth/actions.js";
import type { DocLabel, MatterRole } from "../contracts.js";
import { formatLocation } from "../location.js";
import { loadPlaybook } from "../playbooks/load.js";
import { settlementReason } from "../settlement.js";
import {
  INPUT_CHANGE_REASONS,
  type FeedbackRow,
  type FindingRecord,
  type MatterRow,
  type MemoRow,
  type PlaybookVersionRow,
  type Repository,
  type RunRow,
  type StoredIngestWarning,
} from "../store/index.js";
import { summarizeUsage } from "../usage/summary.js";
import type { ServiceConfig } from "./deps.js";
import {
  CANNOT_DECIDE,
  UNKNOWN_USER_NAME,
  WARNING_ORDER,
  staleReasonPhrase,
  staleWhileRunningPhrase,
} from "./phrases.js";
import type {
  DocumentView,
  EvidenceView,
  FindingView,
  IssueRow,
  MatterSummary,
  MemberView,
  MemoSummary,
  MissedIssueView,
  NoteView,
  PlaybookOption,
  RatingView,
  ReviewHistoryItem,
  RunProgress,
  RunSummary,
  UploadWarningView,
} from "./views.js";

/**
 * Turns what the store holds into what pages are given. Nothing here decides anything: whether a
 * user may act is decided by the service functions, and `canDecide` below only restates it for a
 * page that wants to show or hide a button.
 */
export function createPresenter(
  repo: Repository,
  config: Pick<ServiceConfig, "relaxedSegregation">,
  liveProgress: (runId: string) => RunProgress | undefined,
  /** The provider and model the process runs on now, which decide whether a failed run can resume. */
  generator?: Pick<ObjectGenerator, "provider" | "model">,
) {
  const userName = (userId: string): string =>
    repo.getUser(userId)?.displayName ?? UNKNOWN_USER_NAME;

  // The name of an approved playbook never changes (approval freezes the text), so it is read once.
  const playbookNames = new Map<string, string>();
  function playbookName(row: PlaybookVersionRow): string {
    const known = playbookNames.get(row.id);
    if (known !== undefined) return known;
    let name = row.slug;
    try {
      name = loadPlaybook({ yaml: row.yaml, slug: row.slug }).name;
    } catch {
      // A stored playbook that no longer loads is shown by its slug; the matter can still be read.
    }
    if (row.status === "approved") playbookNames.set(row.id, name);
    return name;
  }

  function playbookOption(row: PlaybookVersionRow): PlaybookOption {
    return {
      versionId: row.id,
      slug: row.slug,
      name: playbookName(row),
      version: row.version,
      approvedAt: row.approvedAt ?? "",
      ruleCount: repo.listRules(row.id).length,
    };
  }

  const playbookOptions = (): PlaybookOption[] =>
    repo
      .listPlaybookVersions()
      .filter((p) => p.status === "approved")
      .map(playbookOption);

  function matterSummary(matter: MatterRow, role: MatterRole): MatterSummary {
    const playbook =
      matter.playbookVersionId === null
        ? undefined
        : repo.getPlaybookVersion(matter.playbookVersionId);
    return {
      id: matter.id,
      name: matter.name,
      clientLegalName: matter.clientLegalName,
      status: matter.status,
      role,
      createdAt: matter.createdAt,
      retainUntil: matter.retainUntil,
      playbook: playbook === undefined ? null : { slug: playbook.slug, version: playbook.version },
      synthetic: matter.synthetic,
      training: matter.trainingKey,
    };
  }

  function members(matterId: string): MemberView[] {
    return repo.listMembers(matterId).map((m) => ({
      userId: m.userId,
      displayName: userName(m.userId),
      role: m.role,
    }));
  }

  function documents(matterId: string): DocumentView[] {
    const versions = repo.listVersions(matterId);
    return repo.listDocuments(matterId).map((document) => ({
      documentId: document.id,
      label: document.label,
      kind: document.kind,
      title: document.title,
      versions: versions
        .filter((v) => v.documentId === document.id)
        .map((v) => ({
          versionId: v.id,
          versionNo: v.versionNo,
          mediaType: v.mediaType,
          byteSize: v.byteSize,
          fileSha256: v.fileSha256,
          statedDate: v.statedDate,
          operative: v.operative,
          uploadedAt: v.uploadedAt,
          uploadedByName: userName(v.uploadedBy),
        })),
    }));
  }

  /** `ver_x:p22` as `D1-p22`. Null when the id is not in that form. */
  function spanLabelOf(spanId: string | null, label: DocLabel): string | null {
    if (spanId === null) return null;
    const index = /:p(\d+)$/.exec(spanId)?.[1];
    return index === undefined ? null : `${label}-p${index}`;
  }

  function warningView(w: StoredIngestWarning, label: DocLabel | null): UploadWarningView {
    return {
      code: w.code,
      documentLabel: label,
      spanLabel: label === null ? null : spanLabelOf(w.spanId, label),
      detail: w.detail,
    };
  }

  /**
   * The warnings that matter now: those of the versions that govern, and the notice on a re-saved
   * copy that is stored but not in use, which stays for as long as the copy is there so that the
   * associate can see there is a choice to make.
   */
  function warnings(matterId: string): UploadWarningView[] {
    const versions = repo.listVersions(matterId);
    const labels = new Map(repo.listDocuments(matterId).map((d) => [d.id, d.label]));
    const shown = new Map(
      versions
        .filter((v) => labels.has(v.documentId))
        .map((v) => [v.id, { label: labels.get(v.documentId) as DocLabel, version: v }]),
    );
    return repo
      .listIngestWarnings(matterId)
      .flatMap((w) => {
        const entry = shown.get(w.documentVersionId);
        if (entry === undefined) return [];
        const visible = entry.version.operative || w.code === "near_duplicate_version";
        return visible ? [{ w, label: entry.label }] : [];
      })
      .sort(
        (a, b) =>
          a.label.localeCompare(b.label) ||
          WARNING_ORDER.indexOf(a.w.code) - WARNING_ORDER.indexOf(b.w.code) ||
          a.w.seq - b.w.seq,
      )
      .map(({ w, label }) => warningView(w, label));
  }

  // --- runs ---------------------------------------------------------------------------------

  /** For a run that is no longer going: where it got to, read from the stages it recorded. */
  function progressFromStages(run: RunRow): RunProgress | null {
    const rows = repo.listStages(run.matterId, run.id);
    const done = (stage: string): number =>
      new Set(rows.filter((r) => r.stage === stage && r.status === "succeeded").map((r) => r.unit))
        .size;
    const seen = (stage: string): boolean => rows.some((r) => r.stage === stage);
    const rules = repo.listRules(run.playbookVersionId).length;
    if (seen("verify")) return { stage: "verify", done: done("verify"), total: rules };
    if (seen("analyze")) return { stage: "analyze", done: done("analyze"), total: rules };
    if (seen("retrieve")) return { stage: "retrieve", done: done("retrieve"), total: 1 };
    if (seen("extract")) return { stage: "extract", done: done("extract"), total: 1 };
    if (seen("ingest")) return { stage: "ingest", done: done("ingest"), total: 1 };
    return null;
  }

  function runSummary(run: RunRow): RunSummary {
    const matter = repo.getMatter(run.matterId);
    const progress =
      liveProgress(run.id) ??
      (run.status === "failed" || run.status === "cancelled" ? progressFromStages(run) : null);
    const current =
      run.status !== "superseded" &&
      matter?.currentInputsSha256 !== null &&
      matter?.currentInputsSha256 === run.inputsSha256;
    return {
      id: run.id,
      status: run.status,
      workflowLabel: run.manifest.workflow.label,
      playbook: { slug: run.manifest.playbook.slug, version: run.manifest.playbook.version },
      model: {
        provider: run.modelProvider,
        requested: run.modelRequested,
        reported: run.modelReported,
      },
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      startedByName: userName(run.startedBy),
      errorKind: run.errorKind,
      current,
      // The same two conditions as `RunService.resume`, which decides again when it is asked.
      ...(generator === undefined
        ? {}
        : {
            resumable:
              run.status === "failed" &&
              current &&
              run.modelProvider === generator.provider &&
              run.modelRequested === generator.model,
          }),
      progress,
      findingCount: repo.listFindings(run.matterId, run.id).length,
      usage: summarizeUsage(repo.summarizeRunUsage(run.matterId, run.id), run.modelProvider, {
        stoppedBySpend:
          run.errorKind === "spend_review_limit" || run.errorKind === "spend_daily_limit",
      }),
    };
  }

  /** Why the matter is stale, in fixed words, from the reason the store recorded on a finding. */
  function staleReason(matter: MatterRow): string | null {
    if (matter.status !== "stale") return null;
    for (const run of repo.listRunsForMatter(matter.id)) {
      const stale = repo.listFindings(matter.id, run.id).find((f) => f.validity === "stale");
      if (stale !== undefined) return staleReasonPhrase(stale.staleReason);
    }
    // No review ever saved a finding: the first one was stopped by the change, so the reason is
    // not on any finding. The store recorded it when it marked the run superseded.
    const changes = repo.listAuditEvents({
      matterId: matter.id,
      action: "inputs.changed",
      limit: 10_000,
    });
    const reason = changes[changes.length - 1]?.detail["reason"];
    return staleWhileRunningPhrase(typeof reason === "string" ? reason : null);
  }

  // --- findings -----------------------------------------------------------------------------

  function issueRow(f: FindingRecord): IssueRow {
    const review = f.currentReview ?? f.reviews[f.reviews.length - 1] ?? null;
    return {
      findingId: f.id,
      ruleKey: f.ruleKey,
      ruleTitle: f.rule.title,
      category: f.category,
      severity: f.severity,
      status: f.status,
      // Set for every row, undefined when nothing was settled: the key is there for a page that
      // reads it, and JSON leaves an undefined member out, so a row nothing settled keeps the
      // members it had before settlement existed.
      modelStatus: f.modelStatus ?? undefined,
      settlementReason: f.modelStatus === null ? undefined : settlementReason(f.rule),
      validity: f.validity,
      verificationState: f.verificationState,
      escalations: f.escalations,
      evidenceCount: f.evidence.length,
      review:
        review === null
          ? null
          : {
              decision: review.decision,
              reviewerName: review.reviewerName,
              at: review.createdAt,
              validity: review.validity,
            },
    };
  }

  /** The decision gate as a page shows it. The service function that records a decision decides it again. */
  function canDecide(
    am: AuthorizedMatter,
    f: FindingRecord,
    matter: MatterRow,
    run: RunRow | undefined,
  ): FindingView["canDecide"] {
    const deny = (reason: string) => ({ allowed: false, reason });
    if (!roleAllows(am.role, "review.decide", { relaxedSegregation: config.relaxedSegregation }))
      return deny(CANNOT_DECIDE.role);
    if (run === undefined) return deny(CANNOT_DECIDE.runNotCurrent);
    if (!config.relaxedSegregation && run.startedBy === am.principal.userId)
      return deny(CANNOT_DECIDE.segregation);
    if (f.validity !== "current" || run.status === "superseded") {
      // A finding that went stale only because a re-run replaced it has nothing wrong with its
      // inputs, and "the documents changed" would hide that a newer review exists.
      return deny(
        f.staleReason === INPUT_CHANGE_REASONS.rerunRequested
          ? CANNOT_DECIDE.replaced
          : CANNOT_DECIDE.stale,
      );
    }
    if (matter.status === "exported") return deny(CANNOT_DECIDE.exported);
    if (matter.status !== "in_review" && matter.status !== "review_complete")
      return deny(CANNOT_DECIDE.notOpen);
    if (run.status !== "succeeded" || run.inputsSha256 !== matter.currentInputsSha256)
      return deny(CANNOT_DECIDE.runNotCurrent);
    // The store refuses it too (`decision_conflict`); a form that cannot work is not offered.
    if (f.currentReview !== null && f.currentReview.reviewerId !== am.principal.userId)
      return deny(CANNOT_DECIDE.decidedByAnother);
    return { allowed: true, reason: null };
  }

  function findingView(am: AuthorizedMatter, f: FindingRecord): FindingView {
    const matter = repo.getMatter(f.matterId) as MatterRow;
    const run = repo.getRun(f.matterId, f.runId);
    const evidence: EvidenceView[] = f.evidence.map((e) => {
      const span = repo.getSpan(f.matterId, e.spanId);
      return {
        evidenceId: e.id,
        spanId: e.spanId,
        location: span === undefined ? "(location unavailable)" : formatLocation(span),
        quote: e.quote,
        role: e.role,
        quoteCheck: e.quoteCheck,
        supportCheck: e.supportCheck,
        offsets: e.offsets,
        spanText: span?.text ?? "",
      };
    });
    const reviews: ReviewHistoryItem[] = f.reviews.map((r) => ({
      decision: r.decision,
      reviewerName: r.reviewerName,
      at: r.createdAt,
      reason: r.reason,
      validity: r.validity,
      reasonCode: r.reasonCode,
      minorEdit: r.minorEdit,
      edits: r.edits,
    }));
    return {
      issue: issueRow(f),
      rule: {
        standard: f.rule.standard,
        fallback: f.rule.fallback,
        unacceptable: f.rule.unacceptable,
        fallbackLanguage: f.rule.fallbackLanguage,
        playbook: {
          slug: run?.manifest.playbook.slug ?? "",
          version: run?.manifest.playbook.version ?? "",
        },
      },
      discrepancy: f.discrepancy,
      explanation: f.explanation,
      fallbackLanguage: f.fallbackLanguage,
      fallbackBasis: f.fallbackBasis,
      conflict: f.conflict,
      abstainReason: f.abstainReason,
      evidence,
      checks: f.checks,
      reviews,
      contentSha256: f.contentSha256,
      canDecide: canDecide(am, f, matter, run),
    };
  }

  // --- memos --------------------------------------------------------------------------------

  /**
   * `parol-memo-<matter id without its prefix>-<yyyymmdd>.docx`: ids and a date, no text of ours or
   * theirs. A memo that a later one replaced has `-superseded-<start of its own id>` before the
   * extension. The file cannot say so itself (it is stored as built, under the hash recorded at
   * export), and two memos made on one day would otherwise download under the same name, with
   * nothing to tell the replaced one from the memo that replaced it.
   */
  function memoFileName(memo: MemoRow): string {
    const suffix = memo.matterId.replace(/^mat_/, "").replace(/[^A-Za-z0-9]/g, "");
    const date = memo.exportedAt.slice(0, 10).replace(/-/g, "");
    const own = memo.id
      .replace(/^memo_/, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 8);
    const marker = memo.status === "superseded" ? `-superseded${own === "" ? "" : `-${own}`}` : "";
    return `parol-memo-${suffix}-${date}${marker}.docx`;
  }

  function memoSummary(memo: MemoRow): MemoSummary {
    return {
      memoId: memo.id,
      runId: memo.runId,
      fileName: memoFileName(memo),
      fileSha256: memo.fileSha256,
      status: memo.status,
      exportedAt: memo.exportedAt,
      exportedByName: userName(memo.exportedBy),
    };
  }

  // --- feedback (package W2.6a) ---------------------------------------------------------------
  // What a person typed is carried through as it was stored; the pages show it through
  // `RevealedText`. Who wrote it is a name looked up now, as the name of a reviewer is.

  /**
   * A missed issue, with the title its rule has in the playbook of the run it was reported against.
   * `ruleTitles` maps a rule key to that title; a key it does not know (a playbook that no longer
   * lists it) is shown by its key and no title.
   */
  function missedIssueView(
    row: FeedbackRow,
    ruleTitles: ReadonlyMap<string, string>,
  ): MissedIssueView {
    return {
      feedbackId: row.id,
      runId: row.runId ?? "",
      ruleKey: row.ruleKey,
      ruleTitle: row.ruleKey === null ? null : (ruleTitles.get(row.ruleKey) ?? null),
      location: row.location,
      note: row.text ?? "",
      reporterName: userName(row.userId),
      at: row.createdAt,
    };
  }

  /** A note on a finding. */
  function noteView(row: FeedbackRow): NoteView {
    return {
      feedbackId: row.id,
      findingId: row.findingId ?? "",
      note: row.text ?? "",
      authorName: userName(row.userId),
      at: row.createdAt,
    };
  }

  /** A rating; null for a row that is not a rating of 1 to 5 (the database does not let one in). */
  function ratingView(row: FeedbackRow): RatingView | null {
    const rating = row.rating;
    if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4 && rating !== 5) return null;
    return { feedbackId: row.id, rating, comment: row.text, at: row.createdAt };
  }

  return {
    userName,
    playbookName,
    playbookOptions,
    matterSummary,
    members,
    documents,
    warnings,
    warningView,
    runSummary,
    staleReason,
    issueRow,
    findingView,
    memoFileName,
    memoSummary,
    missedIssueView,
    noteView,
    ratingView,
  };
}

export type Presenter = ReturnType<typeof createPresenter>;
