/**
 * The seven steps of the training exercise (package W2.8), in one place. The quickstart page shows
 * `task`, `teaches` and `who`; the trainer's key shows `key`; document 8 holds the same task,
 * teaches and key in its table, and `test/training/doc-agree.test.ts` fails when the document and
 * this file differ. Change a step here and in the document together.
 *
 * The exercise uses the training matter T01 (`t01.ts`). Every document in it is synthetic, and the
 * reader that reviews it is the simulated reader, a program with a script and not a language model:
 * the exercise says how to read a finding whose quote is genuine and whose support is missing, and
 * nothing about how well any model reads an NDA.
 *
 * The `key` of a step is the trainer's answer. No page a trainee sees may show it, and none does:
 * pages are given `publicStep(step)`, which has no `key`, and a test searches every such page.
 */

/** How a step is known to be done: set up for the person, checked by the trainer, or read from stored events. */
export type RecordKind = "seeded" | "trainer" | "state";

/** A word the task uses that the person will see on a page: a heading, a label or a button. */
export interface ControlRef {
  page: "matter" | "run" | "finding" | "memos";
  label: string;
}

export interface TrainingStep {
  n: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Short, for a table of progress. */
  title: string;
  /** Who does it in the demonstration: the names of the demo identities say which. */
  who: "any" | "associate" | "reviewer" | "associate then reviewer";
  /** Document 8, column "Task". Shown to the trainee. */
  task: string;
  /** Document 8, column "What it teaches". Shown to the trainee. */
  teaches: string;
  /** Document 8, column "Answer key". For the trainer only. */
  key: string;
  record: RecordKind;
  /** The visible words the task uses, which the tests look for on the pages named. */
  controls: readonly ControlRef[];
}

export const TRAINING_STEPS: readonly TrainingStep[] = [
  {
    n: 1,
    title: "Check the intake",
    who: "any",
    task: "Open the training matter and check its intake: the NDA and the amendment with their stated dates, which version of each is operative, the playbook version, and the line that says where document text is sent",
    teaches: "Intake, operative versions, the destination line",
    key: "NDA operative; playbook 1.0.1 (the design said 1.0.0)",
    record: "seeded",
    controls: [
      { page: "matter", label: "Documents" },
      { page: "matter", label: "Where document text is sent" },
      { page: "matter", label: "Client and playbook" },
    ],
  },
  {
    n: 2,
    title: "Read the warning",
    who: "any",
    task: "Read the warning on the NDA. What will Parol do with that paragraph?",
    teaches: "Documents are data",
    key: "Parol gives it to the model as document text and cannot show that a model ignored it; the warning tells the reader to read it, and a finding that cites it is escalated",
    record: "trainer",
    controls: [{ page: "matter", label: "Warnings" }],
  },
  {
    n: 3,
    title: "Review with workflow v2",
    who: "associate",
    task: "Start a review with workflow version v2, then open DUR-1. Which passage governs, and why is the Section 6.1 quote marked superseded?",
    teaches: "Evidence roles, amendments",
    key: "Amendment Section 2 deletes 6.1",
    record: "state",
    controls: [
      { page: "matter", label: "Workflow version" },
      { page: "matter", label: "Start review" },
      { page: "matter", label: "Open the issue table" },
      { page: "run", label: "Duration of confidentiality obligations" },
    ],
  },
  {
    n: 4,
    title: "Reject the planted finding",
    who: "reviewer",
    task: "One finding in the review was planted by the training script: its quote is in the document but does not support it. Find it and reject it with a reason and a reason code",
    teaches: "Quote validity is not support",
    key: "The planted pds-1 finding quotes the definition clause, which says nothing about representatives",
    record: "state",
    controls: [
      { page: "finding", label: "Your decision" },
      { page: "finding", label: "Reject" },
      { page: "finding", label: "Reason" },
      { page: "finding", label: "Save decision" },
    ],
  },
  {
    n: 5,
    title: "Escalate a finding",
    who: "reviewer",
    task: "Escalate a finding you would send to a partner, with a reason",
    teaches: "Escalation is a decision",
    key: "Any reasoned choice; DUR-1 is the natural one, because the amendment reverses an agreed term",
    record: "state",
    controls: [{ page: "finding", label: "Escalate" }],
  },
  {
    n: 6,
    title: "Change a date",
    who: "associate",
    task: "The partner says the amendment took effect on 1 October 2026. Change its stated date to 2026-10-01 and save it. What happened to your decisions?",
    teaches: "Invalidation",
    key: "All stale; export blocked until re-run and re-decided",
    record: "state",
    controls: [{ page: "matter", label: "Save date" }],
  },
  {
    n: 7,
    title: "Run again and export",
    who: "associate then reviewer",
    task: "Run the review again with v2, decide all eight findings again (reject the planted one with a reason and a reason code), export the memo, and find your rejected finding in it",
    teaches: "Export gate, memo structure",
    key: "It is in the rejected appendix",
    record: "state",
    controls: [
      { page: "matter", label: "Run the review again" },
      { page: "matter", label: "Workflow version" },
      { page: "matter", label: "Re-run review" },
      { page: "memos", label: "Export memo" },
    ],
  },
];

/** A step as a page may receive it: everything but the trainer's answer and the page-finding words. */
export type PublicTrainingStep = Omit<TrainingStep, "key" | "controls">;

export function publicStep({
  key: _key,
  controls: _controls,
  ...rest
}: TrainingStep): PublicTrainingStep {
  return rest;
}
