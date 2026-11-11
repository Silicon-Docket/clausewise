import type { RefusalFragment } from "./notices.js";

/**
 * The refusal phrases, notices and guidance of package W2.8 (training matter and quickstart).
 * `routes/notices.ts` merges it with the core fragment and the other three, and refuses a code that
 * two fragments define.
 *
 * Write each code once, with its phrase, the sentence inside the phrase that says what to do
 * (`todo`) and, if there is a place on the page to fix it, a `jump` to `#id`. Keep the
 * `as const satisfies RefusalFragment`: it is how a notice code written here becomes a
 * `NoticeCode` with no edit to `notices.ts`.
 *
 * The first four codes are the refusals of the start form of the training matter (`POST /training`),
 * answered on the page the form is on. The reviewing attorney and the trainer are chosen in two
 * fields, `#training-reviewer` and `#training-trainer`, inside the form `#training-start`;
 * `unknown_identity` can be either of them, so its jump leads to the form. `no_playbook` and
 * `training_files_missing` are not the person's to fix: they say so and who to ask.
 */
export const REFUSALS_TRAINING = {
  phrases: {
    reviewer_required:
      "Nobody was chosen to decide the findings. Choose a reviewing attorney from the list.",
    bad_reviewer:
      "The reviewing attorney cannot be you, because the person who starts a review cannot decide its findings. Choose someone else.",
    bad_trainer:
      "The trainer cannot be you or the reviewing attorney, who are on the matter already. Choose someone else, or no trainer.",
    unknown_identity: "That person is not one of the listed people. Choose one from the list.",
    no_playbook:
      "No approved playbook version is available, so the training matter cannot be made. Ask whoever runs the server.",
    training_files_missing:
      "The training documents are missing from this installation. Ask whoever runs the server.",
  },
  todo: {
    reviewer_required: "Choose a reviewing attorney from the list.",
    bad_reviewer: "Choose someone else.",
    bad_trainer: "Choose someone else, or no trainer.",
    unknown_identity: "Choose one from the list.",
    no_playbook: "Ask whoever runs the server.",
    training_files_missing: "Ask whoever runs the server.",
  },
  jump: {
    reviewer_required: { href: "#training-reviewer", label: "Go to the reviewing attorney field" },
    bad_reviewer: { href: "#training-reviewer", label: "Go to the reviewing attorney field" },
    bad_trainer: { href: "#training-trainer", label: "Go to the trainer field" },
    unknown_identity: { href: "#training-start", label: "Go to the start form" },
  },
  notices: {
    "training-started": "The training matter is ready. Follow the quickstart from step 1.",
    "training-exists": {
      kind: "info",
      text: "You already have a training matter, so no second one was made. This is it.",
    },
  },
} as const satisfies RefusalFragment;
