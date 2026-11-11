/**
 * The trainer's notes (package W2.8): fixed text under the answer key on the trainer's page
 * (`GET /training/key`). They say what the exercise teaches, which finding the training script
 * gets wrong, what Parol does not record, and what the exercise cannot show. They rest on
 * `docs/parol/08` and `docs/parol/07`, and like the key itself they are for the trainer and never
 * reach a page a trainee is given.
 */

export interface TrainerNote {
  heading: string;
  text: string;
}

export const TRAINER_NOTES: readonly TrainerNote[] = [
  {
    heading: "What the exercise teaches",
    text: "The seven lines in the column What it teaches are the answer to this. In one sentence: a quote that is found in the document is not a quote that supports the finding.",
  },
  {
    heading: "The planted finding",
    text: "In every review of the training matter the simulated reader's script gives PDS-1, Disclosure to representatives, the status Compliant and cites Section 1.2, the definition of Confidential Information. The quote is in the document, the quote check passes and every automatic check passes. The support check is off in both shipped workflow versions, so the page says Support not checked. The passage defines a term and says nothing about disclosure to representatives. This is the kind of error the model support check is meant to catch; that check has never been run on a model (docs/parol/07, known gap 3).",
  },
  {
    heading: "What Parol does not record",
    text: "Step 2, and the answer to step 3. Step 6 can also be done by uploading a changed amendment; the simulated reader declines any changed document, so the next review is all Undetermined.",
  },
  {
    heading: "Limits",
    text: "No person has been timed on this exercise, and the planned 20 minutes is the plan's figure. The exercise says nothing about how well any model reads an NDA.",
  },
];
