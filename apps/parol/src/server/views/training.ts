/**
 * What the quickstart page and the training pages are given, and the words they add (package W2.8).
 * A page cannot import `src/training`, so the route builds these views from that module's data and
 * hands them over; this file holds their types and the few pure helpers the pages share. A view of
 * a training step has no answer key: the key is a field of `src/training/steps.ts` only, and the
 * route that renders a step for a trainee passes it through `publicStep` first.
 */

/** One of the ten steps of the quickstart. `built` is false for a step the application cannot do yet. */
export interface QuickstartStepView {
  n: number;
  /** With `**` pairs for bold and nothing else; `strongSegments` reads them. */
  text: string;
  built: boolean;
}

/** Who does a step of the exercise. The names of the demo identities say which. */
export type TrainingWho = "any" | "associate" | "reviewer" | "associate then reviewer";

export const TRAINING_WHO_LABEL: Record<TrainingWho, string> = {
  any: "Anyone",
  associate: "Associate",
  reviewer: "Reviewing attorney",
  "associate then reviewer": "Associate, then reviewing attorney",
};

/** One of the seven steps of the exercise, as a trainee may read it: no answer key. */
export interface TrainingStepView {
  n: number;
  title: string;
  who: TrainingWho;
  task: string;
  teaches: string;
}

/** A piece of a text with bold marked by `**` pairs. */
export interface StrongSegment {
  text: string;
  strong: boolean;
}

/**
 * Splits a text on `**` pairs into pieces that alternate between plain and bold. No markup is read
 * or built here: the page turns a bold piece into `<strong>` and escapes both. A `**` that is never
 * closed leaves the rest of the text plain, and an empty piece is dropped.
 */
export function strongSegments(text: string): StrongSegment[] {
  const parts = text.split("**");
  const closed = parts.length % 2 === 1;
  const segments: StrongSegment[] = [];
  parts.forEach((part, index) => {
    if (part === "") return;
    // Odd pieces sit between a pair; a last piece with no closing pair is plain text.
    const strong = index % 2 === 1 && (closed || index < parts.length - 1);
    segments.push({ text: part, strong });
  });
  return segments;
}

/** A phrase as a sentence: the full stop is added unless the text already ends a sentence. */
export const asSentence = (text: string): string => (/[.?!]$/.test(text) ? text : `${text}.`);

/** The text of a step with the bold marks removed, as a reader hears it. */
export const plainStrong = (text: string): string => text.replaceAll("**", "");

/** The person to choose in a field of the start form: a demo identity. */
export interface TrainingPerson {
  userId: string;
  displayName: string;
  globalRole: string;
}

/** What the start form of the training matter needs, and what it keeps after a refusal. */
export interface TrainingStartView {
  people: readonly TrainingPerson[];
  /** True when the server lets one person be both associate and reviewer. */
  relaxedSegregation: boolean;
  /** False when no approved version of the playbook T01 uses exists: the form is replaced by a sentence. */
  playbookAvailable: boolean;
  /** What was chosen in the last post that was refused, so the choice is kept. */
  chosen?: { reviewerUserId: string | null; trainerUserId: string | null } | undefined;
}

// ---------------------------------------------------------------------------------------------
// The training banner and the table of progress
// ---------------------------------------------------------------------------------------------

/** Where a step stands, as `TrainingStepProgress.state` says it. */
export type StepState = "done" | "not_yet" | "seeded" | "trainer";

/** The words of each state. The page shows them next to a shape, so colour is never the only signal. */
export const STEP_STATE_LABEL: Record<StepState, string> = {
  done: "Done",
  not_yet: "Not yet",
  seeded: "Set up for you",
  trainer: "Your trainer checks this",
};

/**
 * The provider name of the simulated reader, as a run records it. It is written here and not
 * imported because a page cannot import the demonstration's code; `test/pages/training-section.test.ts`
 * pins it equal to `SIMULATED_PROVIDER`.
 */
export const SIMULATED_PROVIDER_NAME = "simulated";

/**
 * What the banner of a training matter says. The full form is on the matter page and the short form
 * on the review page. Both say that the reader is a program with a script and not a language model,
 * that one finding is wrong on purpose, and that nothing here says how well any model reads an NDA.
 * The banner is the one place a page of a training matter may say that a finding is planted: the
 * row and the pane of that finding say nothing of the kind.
 */
export const TRAINING_BANNER = {
  full: "The documents are synthetic and the reader is the simulated reader, a program with a script, not a language model. In every review of this matter the script gets one finding wrong on purpose, as part of the exercise. Finding it is step 4. Nothing here says how well any model reads an NDA.",
  compact:
    "The simulated reader, a program with a script and not a language model, reads these synthetic documents and gets one finding wrong on purpose. Finding it is step 4. Nothing here says how well any model reads an NDA.",
  /** Added on the review page when the review was not read by the simulated reader. */
  notSimulated:
    "This review was not read by the simulated reader, so it holds no planted finding and the exercise does not apply to it.",
} as const;

/** The heading of the banner: the key is a fixed code (a letter and two digits), shown as it is. */
export const trainingBannerHeading = (key: string): string => `Training matter ${key}`;

/**
 * The sentence above the table of progress. It states both denominators: five of the seven steps
 * can be checked from what Parol stores, and "done" counts out of those five.
 */
export function progressSentence(done: number, checkable: number, steps: number): string {
  return `Parol can check ${checkable} of the ${steps} steps from what it stores (steps 3 to 7). ${done} of those ${checkable} are done. Step 1 was set up for you, and step 2 is checked by your trainer.`;
}

/** One step of the exercise with its answer: what the trainer's page is given, and no page else. */
export interface TrainerStepView extends TrainingStepView {
  key: string;
}

/** One of the trainer's notes. */
export interface TrainerNoteView {
  heading: string;
  text: string;
}
