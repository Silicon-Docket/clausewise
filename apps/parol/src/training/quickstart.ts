/**
 * The ten steps of the quickstart (package W2.8). The quickstart page renders them; document 8 holds
 * the same ten texts, and `test/training/doc-agree.test.ts` fails when the document and this file
 * differ, so the page and the document cannot drift. Change a step here and in the document together.
 *
 * `text` uses a pair of `**` for bold and nothing else. A step is `built` when the application can do
 * it today; a step that is `not_built` is shown with the words "Not built yet" after it and no link.
 * `test/training/steps.test.ts` pins which steps are not built and its message says to change both
 * this list and that test, so a step cannot start to work without this list being looked at.
 */

export interface QuickstartStep {
  n: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  text: string;
  availability: "built" | "not_built";
}

export const QUICKSTART_STEPS: readonly QuickstartStep[] = [
  {
    n: 1,
    text: "**Sign in.** In this demonstration you choose a demo identity; there are no passwords. The banner tells you which environment you are in.",
    availability: "built",
  },
  {
    n: 2,
    text: "**New matter**: name it, type your client's exact legal name, add your reviewing attorney.",
    availability: "built",
  },
  {
    n: 3,
    text: "**Add documents**: the NDA, and any amendment with its date. Mark which NDA version is operative. Read any warnings.",
    availability: "built",
  },
  {
    n: 4,
    text: "**Choose the playbook version.** Only approved versions are listed.",
    availability: "built",
  },
  {
    n: 5,
    text: "**Start review.** The line above the button says where the text is sent.",
    availability: "built",
  },
  {
    n: 6,
    text: "**Read the issue table.** Each row has a status, a severity and, if the system could not stand behind it, an escalation reason. Click a row to see the passages it relies on, highlighted in the document.",
    availability: "built",
  },
  {
    n: 7,
    text: "**Leave notes** for your reviewer on anything you disagree with.",
    availability: "built",
  },
  {
    n: 8,
    text: "**Reviewer:** accept, edit, reject or escalate every finding. Edits, rejections and escalations need a reason, and edits and rejections need a reason code.",
    availability: "built",
  },
  {
    n: 9,
    text: "**Export the memo.** It contains only reviewed findings, open items first.",
    availability: "built",
  },
  {
    n: 10,
    text: "**Rate the matter** and use **Report a missed issue** for anything Parol did not catch.",
    availability: "built",
  },
];
