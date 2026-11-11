import {
  decisionPane,
  decision,
  decidedWith,
  editWith,
  paneOf,
  refusedFindingPage,
} from "./feedback-support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the feedback capture panes (work package W2.6a), in the same shape as the
 * base list in variants.ts, which spreads this list after its own. The package adds an entry for
 * every state of a page that changes what the page shows, and only in this file.
 *
 * Slice A (the reason code and the minor-edit mark of a decision): the decision form with nothing
 * chosen and with a code and the box chosen, the history of a decided edit, a reject and an old
 * decision that carries neither, and the finding page that answers a refusal about the code and
 * about the box. The later slices (a missed issue, a note, the rating) add their states below.
 */
export const VARIANTS_FEEDBACK: Variant[] = [
  ["pane, decision form, nothing chosen", () => decisionPane(), { fragment: true }],
  [
    "pane, decision form, reason code and minor edit chosen",
    () =>
      decisionPane({
        decision: "edit",
        reason: "The wording is better with the date.",
        reasonCode: "bad_fallback",
        minorEdit: true,
      }),
    { fragment: true },
  ],
  [
    "pane, decided edit, reason code and minor edit",
    () => paneOf(decidedWith([editWith("bad_fallback", true)])),
    { fragment: true },
  ],
  [
    "pane, decided edit, reason code and not minor",
    () => paneOf(decidedWith([editWith("wrong_evidence", false)])),
    { fragment: true },
  ],
  [
    "pane, decided reject, reason code",
    () =>
      paneOf(
        decidedWith([
          editWith("unclear", false, "stale"),
          decision({ decision: "reject", reasonCode: "other" }),
        ]),
      ),
    { fragment: true },
  ],
  [
    "pane, decided before the code existed",
    () => paneOf(decidedWith([editWith(null, null)])),
    { fragment: true },
  ],
  [
    "finding page, refused: reason code missing",
    () => refusedFindingPage("reason_code_required", { decision: "reject", reason: "Not so." }),
  ],
  [
    "finding page, refused: minor edit with a status",
    () =>
      refusedFindingPage("minor_edit_status", {
        decision: "edit",
        reason: "Changed.",
        status: "compliant",
        reasonCode: "wrong_status",
        minorEdit: true,
      }),
  ],
];
