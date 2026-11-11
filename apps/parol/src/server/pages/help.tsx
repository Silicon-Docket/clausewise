import type { FindingView, IssueRow } from "../../services/views.js";

/**
 * In-app help for the words the review uses (package W2.8): two `<details>` disclosures that sit
 * inside the run page and the finding pane. They hold fixed text taken from the same tables the
 * chips use, so a word is explained where it is shown.
 *
 * Contract commit CC2: the props and the places in the pages are final; both components render
 * nothing until W2.8 fills them. The host pages (`run.tsx`, `finding.tsx`) belong to W2.6a from
 * here on, so W2.8 never edits them. The file name is letters only because a page may import
 * another page only by such a name (the static test).
 */

export interface WordsHelpProps {
  /** Every issue row of the run, so the help lists the flags this run carries and no others. */
  rows: readonly IssueRow[];
}

/** "What the words mean", on the run page after the keyboard list. W2.8 returns the `#words-help` disclosure here. */
export function WordsHelp(_props: WordsHelpProps) {
  // STUB(W2.8): renders nothing.
  return null;
}

export interface ContextHelpProps {
  finding: FindingView;
}

/** "What these words mean for this finding", in the finding pane before the evidence. W2.8 returns the disclosure here. */
export function ContextHelp(_props: ContextHelpProps) {
  // STUB(W2.8): renders nothing.
  return null;
}
