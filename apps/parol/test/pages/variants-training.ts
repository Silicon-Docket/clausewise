import {
  OWN_TRAINING,
  REFUSED_CHROME,
  START_VIEW,
  helpHtml,
  matterWithWorkflows,
  quickstartHtml,
} from "./training-support.js";
import { matterPage, mattersPage } from "./render.js";
import { buildChrome, buildMatterSummary } from "./support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the training banner, the quickstart and the help pages (work package W2.8), in the same shape as the base list in
 * variants.ts, which spreads this list after its own. The package adds an entry for every state of
 * a page that changes what the page shows, and only in this file.
 *
 * The quickstart for a visitor, for a signed-in person without a training matter (the start form,
 * the form after a refusal with its choices kept, the form of a server for one person, and the page
 * when no playbook is approved) and for one who has a training matter; the help page; the list of
 * matters with a training matter in it; and the matter page with the picker of workflow versions,
 * which the exercise names.
 */
const signedIn = buildChrome();

export const VARIANTS_TRAINING: Variant[] = [
  ["quickstart, visitor", () => quickstartHtml()],
  [
    "quickstart, signed in, no training matter",
    () => quickstartHtml({ chrome: signedIn, start: START_VIEW }),
  ],
  [
    "quickstart, signed in, the start refused and the choices kept",
    () =>
      quickstartHtml({
        chrome: REFUSED_CHROME,
        start: {
          ...START_VIEW,
          chosen: { reviewerUserId: "u_ruiz", trainerUserId: "u_okafor" },
        },
      }),
  ],
  [
    "quickstart, signed in, a server for one person",
    () => quickstartHtml({ chrome: signedIn, start: { ...START_VIEW, relaxedSegregation: true } }),
  ],
  [
    "quickstart, signed in, no approved playbook",
    () => quickstartHtml({ chrome: signedIn, start: { ...START_VIEW, playbookAvailable: false } }),
  ],
  [
    "quickstart, signed in, has a training matter",
    () => quickstartHtml({ chrome: signedIn, ownTraining: OWN_TRAINING }),
  ],
  ["help", () => helpHtml()],
  ["help, signed in", () => helpHtml(signedIn)],
  [
    "matters, a training matter",
    () =>
      mattersPage(
        [
          buildMatterSummary(),
          buildMatterSummary({
            id: "m_training_t01",
            name: "Training: Lanternfish / Corvane NDA (T01)",
            status: "draft",
            training: "T01",
          }),
        ],
        signedIn,
      ),
  ],
  ["matter, two workflow versions, associate", () => matterPage(matterWithWorkflows())],
];
