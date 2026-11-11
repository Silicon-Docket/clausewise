import type { MatterView, RunSummary, TrainingProgressView } from "../../src/services/views.js";
import { HelpPage } from "../../src/server/pages/help.js";
import { RunPage, render, type Chrome } from "../../src/server/pages/index.js";
import { QuickstartPage } from "../../src/server/pages/quickstart.js";
import { TrainerKeyPage } from "../../src/server/pages/training.js";
import { REFUSALS_TRAINING } from "../../src/server/routes/refusals-training.js";
import type {
  QuickstartStepView,
  TrainingStartView,
  TrainingStepView,
} from "../../src/server/views/training.js";
import {
  QUICKSTART_STEPS,
  T01,
  TRAINER_NOTES,
  TRAINING_STEPS,
  publicStep,
} from "../../src/training/index.js";
import {
  buildChrome,
  buildDocuments,
  buildIssueRows,
  buildFindingView,
  buildMatterSummary,
  buildMatterView,
  buildRunSummary,
  buildUsers,
  buildWarnings,
} from "./support.js";

/**
 * Fixtures of the quickstart and the help page (package W2.8): the page built from the same data the
 * route gives it (the two lists of steps in `src/training`, with the trainer's answer left out by
 * `publicStep`), in every state that changes what it shows. Everything here is synthetic.
 */

/** The ten steps as the route hands them to the page. */
export const QUICKSTART_VIEW: QuickstartStepView[] = QUICKSTART_STEPS.map((step) => ({
  n: step.n,
  text: step.text,
  built: step.availability === "built",
}));

/** The seven steps as the route hands them to the page: five fields, no key. */
export const EXERCISE_VIEW: TrainingStepView[] = TRAINING_STEPS.map(publicStep).map(
  ({ n, title, who, task, teaches }) => ({ n, title, who, task, teaches }),
);

export const START_VIEW: TrainingStartView = {
  people: buildUsers().map(({ userId, displayName, globalRole }) => ({
    userId,
    displayName,
    globalRole,
  })),
  relaxedSegregation: false,
  playbookAvailable: true,
};

export const OWN_TRAINING = { matterId: "m_training_t01" } as const;

/** The refusal of a reviewing attorney who is the person themselves, as the route puts it in the chrome. */
export const REFUSED_CHROME: Chrome = buildChrome({
  notice: {
    kind: "error",
    text: REFUSALS_TRAINING.phrases.bad_reviewer,
    todo: REFUSALS_TRAINING.todo.bad_reviewer,
    jump: REFUSALS_TRAINING.jump.bad_reviewer,
  },
});

export interface QuickstartOptions {
  chrome?: Chrome;
  ownTraining?: { matterId: string } | null;
  start?: TrainingStartView;
}

/** The quickstart page. With no option it is the page for a visitor. */
export function quickstartHtml(options: QuickstartOptions = {}): string {
  return render(
    QuickstartPage({
      chrome: options.chrome ?? buildChrome({ userName: null }),
      steps: QUICKSTART_VIEW,
      exercise: EXERCISE_VIEW,
      ownTraining: options.ownTraining,
      start: options.start,
    }),
  );
}

export const helpHtml = (chrome: Chrome = buildChrome({ userName: null })): string =>
  render(HelpPage({ chrome }));

/** A matter page with the picker of workflow versions, as the page of a server that registers two. */
export function matterWithWorkflows(): MatterView {
  return buildMatterView({
    workflows: [
      { label: "v1", status: "pilot", isDefault: true },
      { label: "v2", status: "candidate", isDefault: false },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// The training matter's own pages: the banner, the table of progress, the key
// ---------------------------------------------------------------------------------------------

/** What the matter service reports for each step in the state `state`; the notes are the real ones. */
const NOTE = {
  seeded: "Set up for you by the training script.",
  trainer: "Parol does not record this. Your trainer checks your answer.",
  step3: {
    not_yet: "Start a review with workflow version v2.",
    done: "A review under workflow version v2 exists. Your answer is for your trainer to check.",
  },
  step4: {
    not_yet:
      "Not done yet. Read the passages each finding cites and compare them with what the finding says.",
    done: "A finding was rejected with a reason.",
  },
  step5: { not_yet: "Not done yet.", done: "A finding was escalated with a reason." },
  step6: {
    not_yet: "Not done yet.",
    done: "An input changed after a review and the decisions went out of date.",
  },
  step7: {
    not_yet:
      "Not done yet. Still to do: run the review again after the change, decide every finding, export the memo, reject the finding from step 4 again.",
    done: "The memo of a new review (workflow version v2) holds your rejected finding.",
  },
} as const;

type Done = Partial<Record<3 | 4 | 5 | 6 | 7, boolean>>;

/** The progress of a training matter in which the steps named are done. */
export function progressWith(done: Done = {}): TrainingProgressView {
  const at = (n: 3 | 4 | 5 | 6 | 7) => (done[n] === true ? "done" : "not_yet");
  const title = (n: number) => TRAINING_STEPS[n - 1]!.title;
  const steps: TrainingProgressView["steps"] = [
    { n: 1, title: title(1), state: "seeded", note: NOTE.seeded },
    { n: 2, title: title(2), state: "trainer", note: NOTE.trainer },
    { n: 3, title: title(3), state: at(3), note: NOTE.step3[at(3)] },
    { n: 4, title: title(4), state: at(4), note: NOTE.step4[at(4)] },
    { n: 5, title: title(5), state: at(5), note: NOTE.step5[at(5)] },
    { n: 6, title: title(6), state: at(6), note: NOTE.step6[at(6)] },
    { n: 7, title: title(7), state: at(7), note: NOTE.step7[at(7)] },
  ];
  return {
    key: "T01",
    steps,
    checkable: 5,
    checkableDone: steps.filter((s) => s.state === "done").length,
  };
}

/** The matter page of the person's training matter, with the progress given. */
export function trainingMatterView(
  progress: TrainingProgressView = progressWith(),
  role: "associate" | "reviewer" | "viewer" = "associate",
): MatterView {
  return buildMatterView({
    matter: buildMatterSummary({ name: T01.matterName, role, training: "T01" }),
    training: progress,
  });
}

/** The review page of a training matter, read by the provider given (the simulated reader by default). */
export function trainingRunHtml(provider = "simulated"): string {
  const run: RunSummary = buildRunSummary({
    model: { provider, requested: "parol-simulated-reader", reported: null },
  });
  return render(
    RunPage({
      chrome: buildChrome(),
      matter: buildMatterSummary({ name: T01.matterName, training: "T01" }),
      run,
      issues: buildIssueRows(),
      selected: buildFindingView(),
      warnings: buildWarnings(),
      documents: buildDocuments(),
    }),
  );
}

/** The trainer's key as the route gives it to the legal engineer. */
export function trainerKeyHtml(
  chrome: Chrome = buildChrome({ globalRole: "legal_engineer" }),
): string {
  return render(
    TrainerKeyPage({
      chrome,
      steps: TRAINING_STEPS.map(({ n, title, who, task, teaches, key }) => ({
        n,
        title,
        who,
        task,
        teaches,
        key,
      })),
      notes: TRAINER_NOTES.map(({ heading, text }) => ({ heading, text })),
    }),
  );
}
