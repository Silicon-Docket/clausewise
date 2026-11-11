import { comparisonPage, heldoutBody, liveBody, sideFacts } from "../evaluations/fixtures.js";
import { comparisonHtml, listHtml, memorySource } from "../evaluations/render.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the evaluation comparison page (work package W2.5), in the same shape as the
 * base list in variants.ts, which spreads this list after its own. Each page is built from a
 * document made by hand and shown by the real service, in every state that changes what the page
 * shows. Every document is synthetic and every run in them is simulated or invented.
 */

const simulated = comparisonPage();
const live = comparisonPage(liveBody());
const heldout = comparisonPage(heldoutBody());
const opened = comparisonPage({ ...heldoutBody(), heldoutTrailsOpened: true }, "opened");
const scripted = comparisonPage(
  {
    sides: {
      baseline: sideFacts("v1", { mode: "selftest" }),
      candidate: sideFacts("v2", { mode: "replay" }),
    },
  },
  "scripted",
);

const SLOT = { caseKey: "PAROL-D05", ruleKey: "dur-1" } as const;

export const VARIANTS_EVALUATIONS: Variant[] = [
  ["evaluations, none published", () => listHtml(memorySource([]))],
  [
    "evaluations, several, and files that cannot be used",
    () =>
      listHtml(
        memorySource(
          [simulated, live, heldout, scripted],
          [
            { name: "cmp_aaaaaaaaaaaaaaaa.json", problem: "fingerprint_mismatch" },
            { name: "cmp_bbbbbbbbbbbbbbbb.json", problem: "too_large" },
          ],
        ),
      ),
  ],
  ["evaluation comparison, simulated runs", () => comparisonHtml(simulated)],
  ["evaluation comparison, a slot with its trail", () => comparisonHtml(simulated, SLOT)],
  [
    "evaluation comparison, a slot whose trail was not recorded",
    () => comparisonHtml(simulated, { caseKey: "PAROL-D05", ruleKey: "ret-1" }),
  ],
  [
    "evaluation comparison, a slot that did not change",
    () => comparisonHtml(simulated, { caseKey: "PAROL-D05", ruleKey: "gov-1" }),
  ],
  [
    "evaluation comparison, held-out split, sealed",
    () => comparisonHtml(heldout, { split: "heldout" }),
  ],
  [
    "evaluation comparison, a sealed held-out slot",
    () => comparisonHtml(heldout, { split: "heldout", caseKey: "PAROL-H02", ruleKey: "dur-1" }),
  ],
  [
    "evaluation comparison, held-out trails opened",
    () => comparisonHtml(opened, { split: "heldout" }),
  ],
  [
    "evaluation comparison, live runs, one not clean, with a decision",
    () => comparisonHtml(live, SLOT),
  ],
  ["evaluation comparison, a selftest against a replay", () => comparisonHtml(scripted)],
];
