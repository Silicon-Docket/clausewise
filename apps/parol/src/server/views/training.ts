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
