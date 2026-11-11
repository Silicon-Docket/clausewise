import { globalRoleAllows } from "../../auth/actions.js";
import { urls } from "../urls.js";
import {
  TRAINING_WHO_LABEL,
  asSentence,
  strongSegments,
  type QuickstartStepView,
  type TrainingStartView,
  type TrainingStepView,
} from "../views/training.js";
import { revealToString } from "../views/reveal.js";
import { Field, Section } from "./components.js";
import { FIELDS } from "./forms.js";
import { Layout, csrfField, type Chrome } from "./layout.js";

/**
 * The quickstart (package W2.8): the ten steps of using Parol, and the training exercise that
 * teaches them on a matter made for it. It is open to everyone, a visitor included, and every word
 * on it is fixed text or a person's own matter link: nothing here is document text, and the
 * trainer's answers are not on it (the steps it receives have no key).
 *
 * What the page says it cannot show is said on it: the exercise has been walked by a script and not
 * by a person, the 20 minutes is the plan's figure and nobody has timed it, the reader is a program
 * with a script and not a language model, and the sign-in is not authentication.
 */

/** The same sentence the start refuses with when no approved playbook exists (refusals-training.ts). */
export const NO_PLAYBOOK_SENTENCE =
  "No approved playbook version is available, so the training matter cannot be made. Ask whoever runs the server.";

export interface QuickstartPageProps {
  chrome: Chrome;
  /** The ten steps, from one source that document 8 is checked against. */
  steps: readonly QuickstartStepView[];
  /** The seven steps of the exercise, without the answer key. */
  exercise: readonly TrainingStepView[];
  /** The training matter the signed-in person has, if any. */
  ownTraining?: { matterId: string } | null | undefined;
  /** What the start form needs; given only to a signed-in person who has no training matter. */
  start?: TrainingStartView | undefined;
}

/** Text with its `**` pairs as bold. The pieces are escaped like every other text. */
function Strong({ text }: { text: string }) {
  return (
    <>
      {strongSegments(text).map((segment) =>
        segment.strong ? <strong>{segment.text}</strong> : segment.text,
      )}
    </>
  );
}

function BeforeYouStart() {
  return (
    <Section id="before-you-start" title="Before you start">
      <ul>
        <li>
          Every document, party and person here is synthetic. The sign-in has no passwords and is
          not authentication, so nothing real belongs in it.
        </li>
        <li>
          The reader is the simulated reader: a program with a table of answers written in advance,
          not a language model. What it does here says nothing about how well any model reads an
          NDA.
        </li>
        <li>
          Parol drafts findings. An attorney decides every one. It will not decide anything, send
          anything to the other side, or review PDFs, footnotes, headers or pictures. When documents
          change, earlier decisions stop counting.
        </li>
        <li>
          The exercise needs the simulated reader, which the server uses when it is started for the
          demonstration (<code>PAROL_SCRIPTED=1</code>). With a provider key the planted finding
          does not appear, and step 4 cannot be done.
        </li>
      </ul>
    </Section>
  );
}

function TenSteps({ steps }: { steps: readonly QuickstartStepView[] }) {
  return (
    <Section
      id="ten-steps"
      title="The ten steps"
      note="This is the order of work on a real matter. The training exercise below goes through the middle of it, on a matter made for the purpose."
    >
      <ol class="quickstart-steps">
        {steps.map((step) => (
          <li>
            <Strong text={step.text} />
            {step.built ? null : (
              <>
                {" "}
                <span class="muted">Not built yet.</span>
              </>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
}

function StartForm({ chrome, start }: { chrome: Chrome; start: TrainingStartView }) {
  const chosen = start.chosen;
  return (
    <form method="post" action={urls.training()} class="stack form-panel" id="training-start">
      {csrfField(chrome.csrfToken)}
      <Field
        id="training-reviewer"
        label="Reviewing attorney"
        hint={
          start.relaxedSegregation
            ? "This person decides the findings. You may leave it empty, because this server lets one person do both."
            : "This person decides the findings. It cannot be you unless the server is set for one person."
        }
      >
        <select
          id="training-reviewer"
          name={FIELDS.reviewerUserId}
          required={!start.relaxedSegregation}
          aria-describedby="training-reviewer-hint"
        >
          <option value="">Choose a person</option>
          {start.people.map((person) => (
            <option value={person.userId} selected={chosen?.reviewerUserId === person.userId}>
              {revealToString(person.displayName)}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="training-trainer"
        label="Trainer (optional)"
        hint="A trainer can open the matter and read it. Like any member they can add notes, report a missed issue and rate the matter. They cannot decide a finding, start or change a review, export the memo or change the matter."
      >
        <select
          id="training-trainer"
          name={FIELDS.trainerUserId}
          aria-describedby="training-trainer-hint"
        >
          <option value="">No trainer</option>
          {start.people.map((person) => (
            <option value={person.userId} selected={chosen?.trainerUserId === person.userId}>
              {revealToString(person.displayName)}
            </option>
          ))}
        </select>
      </Field>
      <div class="actions">
        <button type="submit" class="button button-primary">
          Start the training matter
        </button>
      </div>
    </form>
  );
}

/** What the person does to begin: sign in, make the matter, or open the one they have. */
function BeginExercise(props: QuickstartPageProps) {
  const { chrome, ownTraining, start } = props;
  if (chrome.userName === null)
    return (
      <p>
        Sign in first. <a href={urls.home()}>Choose a demo identity</a>.
      </p>
    );
  if (ownTraining !== null && ownTraining !== undefined)
    return (
      <p>
        <a href={urls.matter(ownTraining.matterId)}>Open the training matter</a>
      </p>
    );
  if (start === undefined) return null;
  if (!start.playbookAvailable) return <p class="empty">{NO_PLAYBOOK_SENTENCE}</p>;
  return <StartForm chrome={chrome} start={start} />;
}

/**
 * The way to the trainer's key, for the roles the key page is open to. The page answers anyone else
 * with a refusal, so showing the link only to these roles is a courtesy and the route is the control.
 */
function TrainerLink({ chrome }: { chrome: Chrome }) {
  if (chrome.globalRole === undefined || !globalRoleAllows(chrome.globalRole, "training.key"))
    return null;
  return (
    <p>
      For the trainer: <a href={urls.trainerKey()}>Trainer's key</a>, the answer to each step.
    </p>
  );
}

function Exercise(props: QuickstartPageProps) {
  return (
    <Section
      id="training-exercise"
      title="The training exercise"
      note="Seven steps on a matter made for the purpose. The plan puts the exercise at about 20 minutes."
    >
      <p>
        The training matter is the documents of the worked example, a mutual NDA and its amendment,
        with one instruction paragraph added to the NDA. The matter and its documents are set up for
        you. No person has done the exercise yet, and nobody has timed it.
      </p>
      <p>
        The associate runs reviews and changes dates. The reviewing attorney decides the findings
        and exports the memo. In the demonstration the names say which: choose the identity whose
        name ends in (associate) or (reviewing attorney). The person who starts a review cannot
        decide its findings, so sign out and in as the other person where a step says so. A server
        started with <code>PAROL_RELAXED_SEGREGATION=1</code> lets the associate decide too, and the
        memo then says so.
      </p>
      <BeginExercise {...props} />
      <ol class="training-steps">
        {props.exercise.map((step) => (
          <li>
            <h3>
              Step {step.n}: {step.title}
            </h3>
            <p class="muted">Who: {TRAINING_WHO_LABEL[step.who]}</p>
            <p>{asSentence(step.task)}</p>
            <p class="muted">What it teaches: {asSentence(step.teaches)}</p>
          </li>
        ))}
      </ol>
      <TrainerLink chrome={props.chrome} />
    </Section>
  );
}

export function QuickstartPage(props: QuickstartPageProps) {
  return (
    <Layout title="Quickstart" chrome={props.chrome}>
      <h1>Quickstart</h1>
      <p class="lead">
        How to use Parol, in ten steps, and a training exercise that practises them. If you have
        never used it, start with the exercise.
      </p>
      <nav aria-label="On this page" class="help-topics">
        <ul class="nav-list">
          <li>
            <a href="#before-you-start">Before you start</a>
          </li>
          <li>
            <a href="#ten-steps">The ten steps</a>
          </li>
          <li>
            <a href="#training-exercise">The training exercise</a>
          </li>
        </ul>
      </nav>
      <BeforeYouStart />
      <TenSteps steps={props.steps} />
      <Exercise {...props} />
      <p>
        The words on the review page are explained on the <a href={urls.help()}>help page</a>.
      </p>
    </Layout>
  );
}
