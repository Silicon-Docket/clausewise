import { PLANTED_RULE_KEY } from "../demo/training-example.js";
import type { TrainingProgressView, TrainingStepProgress } from "../services/views.js";
import {
  INPUT_CHANGE_REASONS,
  NotFoundError,
  type FindingRecord,
  type Repository,
} from "../store/index.js";
import { TRAINING_STEPS } from "./steps.js";

/**
 * How far a person has got through the training exercise (package W2.8), read from what the
 * application stores and from nothing a person typed: the reviews of the findings, the runs, the
 * memos and the audit log of the one matter. Nothing is added to the database for it, so deleting
 * the matter deletes the progress with it, and the retention job needs to know nothing about it.
 *
 * Parol can check steps 3 to 7. Step 1 is set up by the start (the matter is made with both
 * documents), and step 2 is a question that only the trainer can mark, so Parol says so and shows
 * no state for it. The page states the denominator: five steps are checkable, so "done" counts out
 * of five and never out of seven.
 *
 * Nothing a note says may point at the finding the exercise plants: the notes name no rule, no
 * title and no word that gives the finding away. `PLANTED_RULE_KEY` is used to find the finding,
 * and is never written into a note (a test searches every note of every state).
 *
 * `trainingProgress` reads the rows of the one matter it is given and is called only from the
 * matter service's `view`, after the role check of `matter.read`, so it is reached only through an
 * `AuthorizedMatter`.
 */

/** The steps Parol can check from what it stores. */
export const CHECKABLE_STEPS = [3, 4, 5, 6, 7] as const;

/** The workflow version step 3 asks for. */
const STEP_THREE_WORKFLOW = "v2";

/** The reasons for an input change that count as the change of step 6: a date, a document or the operative version. */
const STEP_SIX_REASONS: readonly string[] = [
  INPUT_CHANGE_REASONS.statedDateChanged,
  INPUT_CHANGE_REASONS.documentChanged,
  INPUT_CHANGE_REASONS.operativeChanged,
];

/** The parts of step 7 in the order a person does them, as the note names the ones still missing. */
const STEP_SEVEN_PARTS = {
  rerun: "run the review again after the change",
  decide: "decide every finding",
  export: "export the memo",
  reject: "reject the finding from step 4 again",
} as const;

const hasText = (reason: string | null): boolean => reason !== null && reason.trim() !== "";

/** Every audit event of the matter with this action, oldest first (the store returns a page at a time). */
function eventsOf(repo: Repository, matterId: string, action: string) {
  const events = [];
  let afterSeq = 0;
  for (;;) {
    const page = repo.listMatterAuditEvents(matterId, { action, afterSeq, limit: 1000 });
    events.push(...page.events);
    if (page.nextAfterSeq === null) return events;
    afterSeq = page.nextAfterSeq;
  }
}

/** The finding of a run that the exercise is about, if the run holds one. */
const exerciseFinding = (findings: readonly FindingRecord[]): FindingRecord | undefined =>
  findings.find((f) => f.ruleKey === PLANTED_RULE_KEY);

const plain = (n: number, state: TrainingStepProgress["state"], note: string) => {
  const step = TRAINING_STEPS[n - 1];
  if (step === undefined) throw new RangeError("there is no such training step");
  return { n, title: step.title, state, note };
};

export function trainingProgress(repo: Repository, matterId: string): TrainingProgressView {
  const matter = repo.getMatter(matterId);
  if (matter === undefined || matter.trainingKey === null) throw new NotFoundError("matter");

  const runs = repo.listRunsForMatter(matterId); // newest first
  const findingsOf = new Map(runs.map((run) => [run.id, repo.listFindings(matterId, run.id)]));
  const allFindings = [...findingsOf.values()].flat();
  const documents = repo.listDocuments(matterId);

  // Step 1: both documents are still on the matter.
  const hasNda = documents.some((d) => d.kind === "nda");
  const hasAmendment = documents.some((d) => d.kind === "amendment");

  // Step 3: a review under the workflow version the step names exists and holds findings.
  const reviewedWithV2 = runs.some(
    (run) =>
      run.manifest.workflow.label === STEP_THREE_WORKFLOW &&
      (run.status === "succeeded" || run.status === "superseded") &&
      (findingsOf.get(run.id)?.length ?? 0) > 0,
  );

  // Step 4: the finding the exercise is about was rejected, with a reason, in some review.
  const rejectedExercise = allFindings.some(
    (f) =>
      f.ruleKey === PLANTED_RULE_KEY &&
      f.reviews.some((r) => r.decision === "reject" && hasText(r.reason)),
  );

  // Step 5: some finding was escalated with a reason.
  const escalated = allFindings.some((f) =>
    f.reviews.some((r) => r.decision === "escalate" && hasText(r.reason)),
  );

  // Step 6: an input changed after a review and took decisions out of date. The first such change
  // is the one step 7 is measured from.
  const change = eventsOf(repo, matterId, "inputs.changed").find((event) => {
    const reason = event.detail["reason"];
    const stale = event.detail["findingsMarkedStale"];
    return (
      typeof reason === "string" &&
      STEP_SIX_REASONS.includes(reason) &&
      typeof stale === "number" &&
      stale > 0
    );
  });

  // Step 7: the memo of a review started after that change holds the rejection again. "After" is
  // the order of the audit log, which does not tie the way two clock readings can.
  const startOrder = new Map(
    eventsOf(repo, matterId, "run.create").map((event) => [event.targetId, event.seq]),
  );
  const startedAfterChange = (runId: string): boolean => {
    const started = startOrder.get(runId);
    return change !== undefined && started !== undefined && started > change.seq;
  };
  const memos = repo.listMemos(matterId).filter((memo) => memo.status === "current");
  let memoOfRun: { workflowLabel: string } | undefined;
  for (const memo of memos) {
    if (!startedAfterChange(memo.runId)) continue;
    const run = runs.find((r) => r.id === memo.runId);
    const found = exerciseFinding(findingsOf.get(memo.runId) ?? []);
    const decision = found?.currentReview ?? null;
    if (
      run !== undefined &&
      decision !== null &&
      decision.decision === "reject" &&
      memo.reviewIds.includes(decision.id)
    ) {
      memoOfRun = { workflowLabel: run.manifest.workflow.label };
      break;
    }
  }

  // What is still missing from step 7, named in the order a person does it, from the newest review
  // that started after the change.
  const missingFromSeven = (): string[] => {
    const again = runs.find(
      (run) => startedAfterChange(run.id) && (findingsOf.get(run.id)?.length ?? 0) > 0,
    );
    if (again === undefined) return Object.values(STEP_SEVEN_PARTS);
    const found = findingsOf.get(again.id) ?? [];
    const missing: string[] = [];
    if (found.some((f) => f.currentReview === null)) missing.push(STEP_SEVEN_PARTS.decide);
    if (!memos.some((memo) => memo.runId === again.id)) missing.push(STEP_SEVEN_PARTS.export);
    if (exerciseFinding(found)?.currentReview?.decision !== "reject")
      missing.push(STEP_SEVEN_PARTS.reject);
    return missing;
  };

  const steps: TrainingStepProgress[] = [
    hasNda && hasAmendment
      ? plain(1, "seeded", "Set up for you by the training script.")
      : plain(1, "not_yet", "Add the two documents again, or start a new training matter."),
    plain(2, "trainer", "Parol does not record this. Your trainer checks your answer."),
    reviewedWithV2
      ? plain(
          3,
          "done",
          "A review under workflow version v2 exists. Your answer is for your trainer to check.",
        )
      : plain(3, "not_yet", "Start a review with workflow version v2."),
    rejectedExercise
      ? plain(4, "done", "A finding was rejected with a reason.")
      : plain(
          4,
          "not_yet",
          "Not done yet. Read the passages each finding cites and compare them with what the finding says.",
        ),
    escalated
      ? plain(5, "done", "A finding was escalated with a reason.")
      : plain(5, "not_yet", "Not done yet."),
    change !== undefined
      ? plain(6, "done", "An input changed after a review and the decisions went out of date.")
      : plain(6, "not_yet", "Not done yet."),
    memoOfRun !== undefined
      ? plain(
          7,
          "done",
          `The memo of a new review (workflow version ${memoOfRun.workflowLabel}) holds your rejected finding.`,
        )
      : plain(7, "not_yet", `Not done yet. Still to do: ${missingFromSeven().join(", ")}.`),
  ];

  return {
    key: matter.trainingKey,
    steps,
    checkable: CHECKABLE_STEPS.length,
    checkableDone: steps.filter((s) => CHECKABLE_STEPS.some((n) => n === s.n) && s.state === "done")
      .length,
  };
}

/**
 * The people who made a training matter and have done every step Parol can check on it (steps 3
 * to 7). It is a hint and nothing more (plan R4): the pilot's roster of trained participants is
 * what the trainer records, and this list is shown beside each name in that form as "completed
 * steps 3 to 7 of the training matter". No measure takes it as an input. It states nothing about
 * time or competence, only that the stored events of one exercise are all there.
 */
export function trainedUserIds(repo: Repository): string[] {
  const trained = new Set<string>();
  for (const { id, createdBy } of repo.listTrainingMatters()) {
    const progress = trainingProgress(repo, id);
    if (progress.checkableDone === progress.checkable) trained.add(createdBy);
  }
  return [...trained].sort();
}
