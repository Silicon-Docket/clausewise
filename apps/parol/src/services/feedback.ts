import type { AuthorizedMatter } from "../auth/types.js";
import { ConflictError, NotFoundError, type FeedbackRow, type RunRow } from "../store/index.js";
import { requireRole, type ServiceDeps } from "./deps.js";
import type { Presenter } from "./present.js";
import type {
  MatterFeedbackView,
  MissedIssueView,
  NoteView,
  RatingView,
  RuleChoice,
} from "./views.js";

/**
 * Feedback capture, as data (package W2.6a): a missed issue against a run, a note on a finding,
 * the person's rating of a matter. Every function takes an `AuthorizedMatter`, calls `requireRole`
 * first, works on `am.matterId` only, and throws errors that repeat nothing the caller sent.
 *
 * Contract commit CC2: the interface is the design's (W2.6a section 3.4). The views it returns are
 * declared in `services/views.ts`.
 *
 * Slice B (a missed issue) fills `reportMissedIssue`, `ruleChoices` and `list`. `addNote` (slice D),
 * `rate` and `myRating` (slice C) are still the stubs of the contract commit.
 */
export interface FeedbackService {
  /** A missed issue against one run of the matter. 404 for a run of another matter; 409 run_has_no_findings. */
  reportMissedIssue(
    am: AuthorizedMatter,
    runId: string,
    input: { ruleKey: string | null; location: string | null; note: string },
  ): MissedIssueView;
  /** A note on a finding. 404 for a finding of another matter; 409 finding_not_current when it is out of date. */
  addNote(am: AuthorizedMatter, findingId: string, input: { note: string }): NoteView;
  /** The caller's rating. 409 not_exported before the first memo; 409 already_rated. */
  rate(am: AuthorizedMatter, input: { rating: number; comment: string | null }): RatingView;
  /** Everything the caller may read of the matter's feedback: all reports, all notes, only their own rating. */
  list(am: AuthorizedMatter): MatterFeedbackView;
  /** The rules of the run's playbook, in playbook order, for the report form. 404 for a foreign run. */
  ruleChoices(am: AuthorizedMatter, runId: string): RuleChoice[];
  /** The caller's own rating, or null. */
  myRating(am: AuthorizedMatter): RatingView | null;
}

/**
 * Builds the service. It must not throw here: `createServices` calls it for every process and
 * every test.
 *
 * What a missed issue is: a remark about a review as it stood, made by anyone on the matter. It
 * changes no finding, no decision and no gate of the export, and it is not part of the memo. It is
 * bound to a run and not to a content hash, so it stays true of the run it was made about, which is
 * shown as out of date when the documents change.
 */
export function createFeedbackService(deps: ServiceDeps, present: Presenter): FeedbackService {
  const { repo, config } = deps;

  /** A run of this matter, or a 404 that is the same for a run of another matter and for none. */
  const requireRun = (am: AuthorizedMatter, runId: string): RunRow => {
    const run = repo.getRun(am.matterId, runId);
    if (run === undefined) throw new NotFoundError("run");
    return run;
  };

  /** The title of each rule of the playbook the run was made with, by rule key. */
  const titlesOf = (playbookVersionId: string): Map<string, string> =>
    new Map(repo.listRules(playbookVersionId).map((rule) => [rule.key, rule.title]));

  return {
    reportMissedIssue(am, runId, input) {
      requireRole(am, "feedback.add", config);
      const run = requireRun(am, runId);
      // A report says what a review left out; a run that produced no findings left out everything,
      // and a report against it would say nothing. The person is told why in words.
      if (repo.listFindings(am.matterId, run.id).length === 0)
        throw new ConflictError(
          "run_has_no_findings",
          "this review has no findings, so there is nothing to report a miss against",
        );
      const row = repo.addFeedback(am.matterId, {
        // The person is the signed-in one; nothing in the request names anyone.
        userId: am.principal.userId,
        kind: "missed_issue",
        runId: run.id,
        ruleKey: input.ruleKey,
        location: input.location,
        text: input.note,
      });
      return present.missedIssueView(row, titlesOf(run.playbookVersionId));
    },

    addNote() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },

    rate() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },

    list(am) {
      requireRole(am, "matter.read", config);
      // Every report and every note of the matter, but only the caller's own rating: another
      // person's rating is not theirs to read, and so is never in this answer.
      const rows = repo.listFeedback(am.matterId);
      const titles = new Map<string, Map<string, string>>();
      const titlesFor = (runId: string): Map<string, string> => {
        const known = titles.get(runId);
        if (known !== undefined) return known;
        const run = repo.getRun(am.matterId, runId);
        const made =
          run === undefined ? new Map<string, string>() : titlesOf(run.playbookVersionId);
        titles.set(runId, made);
        return made;
      };
      const mine: FeedbackRow | undefined = rows.find(
        (row) => row.kind === "rating" && row.userId === am.principal.userId,
      );
      return {
        missedIssues: rows
          .filter((row) => row.kind === "missed_issue" && row.runId !== null)
          .map((row) => present.missedIssueView(row, titlesFor(row.runId ?? ""))),
        notes: rows
          .filter((row) => row.kind === "comment" && row.findingId !== null)
          .map(present.noteView),
        myRating: mine === undefined ? null : present.ratingView(mine),
      };
    },

    ruleChoices(am, runId) {
      requireRole(am, "run.read", config);
      const run = requireRun(am, runId);
      // In the playbook's own order, which is the order its findings and its memo follow.
      return repo
        .listRules(run.playbookVersionId)
        .map((rule) => ({ ruleKey: rule.key, title: rule.title }));
    },

    myRating() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
  };
}
