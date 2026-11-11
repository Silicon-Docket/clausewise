import type { AuthorizedMatter } from "../auth/types.js";
import type { ServiceDeps } from "./deps.js";
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
 * declared in `services/views.ts`. The methods are the stubs.
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
 * every test. The methods are the stubs.
 */
export function createFeedbackService(_deps: ServiceDeps, _present: Presenter): FeedbackService {
  return {
    reportMissedIssue() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
    addNote() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
    rate() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
    list() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
    ruleChoices() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
    myRating() {
      throw new Error("stub: W2.6a"); // STUB(W2.6a)
    },
  };
}
