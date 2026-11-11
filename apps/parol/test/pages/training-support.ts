import type { MatterView } from "../../src/services/views.js";
import { HelpPage } from "../../src/server/pages/help.js";
import { render, type Chrome } from "../../src/server/pages/index.js";
import { QuickstartPage } from "../../src/server/pages/quickstart.js";
import { REFUSALS_TRAINING } from "../../src/server/routes/refusals-training.js";
import type {
  QuickstartStepView,
  TrainingStartView,
  TrainingStepView,
} from "../../src/server/views/training.js";
import { QUICKSTART_STEPS, TRAINING_STEPS, publicStep } from "../../src/training/index.js";
import { buildChrome, buildMatterView, buildUsers } from "./support.js";

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
