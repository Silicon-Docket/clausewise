import type { TrainingProgressView } from "../../services/views.js";
import { urls } from "../urls.js";
import {
  SIMULATED_PROVIDER_NAME,
  STEP_STATE_LABEL,
  TRAINING_BANNER,
  TRAINING_WHO_LABEL,
  asSentence,
  progressSentence,
  trainingBannerHeading,
  type StepState,
  type TrainerNoteView,
  type TrainerStepView,
} from "../views/training.js";
import { Chip, ScrollBox, Section, type ShapeName, type Tone } from "./components.js";
import { Layout, type Chrome } from "./layout.js";

/**
 * The training matter on the matter page and the run page (package W2.8): a banner that says what
 * the exercise is, and the table of steps with where each stands. The trainer's key has its page
 * here too.
 *
 * The banner decides for itself whether to show: it is given the matter's training key and shows
 * nothing when there is none, so a host page calls it for every matter. The run page calls it with
 * `compact`. The matter page calls both. The file name is letters only because a page may import
 * another page only by such a name (the static test).
 *
 * No page here renders a step's answer except `TrainerKeyPage`, and that page is given the answers
 * only by the route for the legal engineer and the administrator. The table of progress has notes
 * that name no rule and no title, so it can be shown to a trainee.
 */

export interface TrainingBannerProps {
  /** The short form for the run page; the matter page shows the full form. */
  compact?: boolean;
  /** `MatterSummary.training`. Null or absent: an ordinary matter, and nothing is shown. */
  training?: string | null | undefined;
  /** The provider of the run being shown (`RunSummary.model.provider`), for the run page's second sentence. */
  provider?: string | undefined;
}

export function TrainingBanner(props: TrainingBannerProps) {
  const { training, provider } = props;
  if (training === null || training === undefined) return null;
  const notSimulated = provider !== undefined && provider !== SIMULATED_PROVIDER_NAME;
  return (
    <section class="banner banner-training" aria-labelledby="training-banner-heading">
      <h2 id="training-banner-heading">{trainingBannerHeading(training)}</h2>
      <p>{props.compact === true ? TRAINING_BANNER.compact : TRAINING_BANNER.full}</p>
      {notSimulated ? <p>{TRAINING_BANNER.notSimulated}</p> : null}
      <p>
        <a href={urls.quickstart()}>Quickstart</a>
      </p>
    </section>
  );
}

/** A state of a step as a chip: the word, and a shape that says it without colour. */
const STATE_LOOK: Record<StepState, { tone: Tone; shape: ShapeName }> = {
  done: { tone: "ok", shape: "circle" },
  not_yet: { tone: "neutral", shape: "ring" },
  seeded: { tone: "info", shape: "square" },
  trainer: { tone: "info", shape: "diamond" },
};

/** A state this list lacks is shown as not yet; a class is never built from the value. */
const stateOf = (state: string): StepState =>
  Object.hasOwn(STATE_LOOK, state) ? (state as StepState) : "not_yet";

export interface TrainingSectionProps {
  /** `MatterView.training`. Null or absent: an ordinary matter, and nothing is shown. */
  progress?: TrainingProgressView | null | undefined;
}

export function TrainingSection(props: TrainingSectionProps) {
  const { progress } = props;
  if (progress === null || progress === undefined) return null;
  return (
    <Section
      id="training-progress"
      title="Training progress"
      note="Read from what Parol stores about this matter. Nothing here is timed, and it is not a score."
    >
      <p>{progressSentence(progress.checkableDone, progress.checkable, progress.steps.length)}</p>
      <ScrollBox label="Steps of the training exercise">
        <table class="data-table progress-table">
          <caption class="sr-only">Where each step of the training exercise stands</caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Where it stands</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {progress.steps.map((step) => {
              const state = stateOf(step.state);
              const look = STATE_LOOK[state];
              return (
                <tr>
                  <th scope="row">
                    Step {step.n}: {step.title}
                  </th>
                  <td>
                    <Chip tone={look.tone} shape={look.shape}>
                      {STEP_STATE_LABEL[state]}
                    </Chip>
                  </td>
                  <td>{step.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </ScrollBox>
    </Section>
  );
}

export interface TrainerKeyPageProps {
  chrome: Chrome;
  /** The seven steps with the trainer's answer. Only the route for the trainer roles builds them. */
  steps: readonly TrainerStepView[];
  notes: readonly TrainerNoteView[];
}

/**
 * The trainer's key: the answer to each step of the exercise and the trainer's notes. The route
 * that serves it answers 403 to anyone who is not the legal engineer or an administrator, so this
 * page is only ever built for them. What it says about its own limit is true of the whole key: the
 * demonstration sign-in has no passwords, so the limit is a courtesy to trainees and not a control.
 */
export function TrainerKeyPage(props: TrainerKeyPageProps) {
  return (
    <Layout title="Trainer's key" chrome={props.chrome}>
      <h1>Trainer's key</h1>
      <p class="lead">
        The answers to the seven steps of the training exercise, and notes for the trainer.
      </p>
      <p>
        This page is for the legal engineer and the administrators, and the server refuses anyone
        else. That is a courtesy to trainees and not a control: the demonstration sign-in has no
        passwords, and the same answers are in the pilot document (docs/parol/08) and in the source.
        The exercise has been walked by a script and not by a person, and the planned 20 minutes is
        the plan's figure, which nobody has timed.
      </p>
      <Section id="answer-key" title="Answer key">
        <ScrollBox label="Answers to the seven steps">
          <table class="data-table training-key">
            <caption class="sr-only">Answer key</caption>
            <thead>
              <tr>
                <th scope="col">Step</th>
                <th scope="col">Task</th>
                <th scope="col">Answer</th>
              </tr>
            </thead>
            <tbody>
              {props.steps.map((step) => (
                <tr>
                  <th scope="row">
                    Step {step.n}: {step.title}
                  </th>
                  <td>
                    <p>{asSentence(step.task)}</p>
                    <p class="muted">Who: {TRAINING_WHO_LABEL[step.who]}</p>
                  </td>
                  <td>{asSentence(step.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollBox>
      </Section>
      <Section id="trainer-notes" title="Notes for the trainer">
        {props.notes.map((note) => (
          <>
            <h3>{note.heading}</h3>
            <p>{note.text}</p>
          </>
        ))}
      </Section>
      <p>
        <a href={urls.quickstart()}>Back to the quickstart</a>
      </p>
    </Layout>
  );
}
