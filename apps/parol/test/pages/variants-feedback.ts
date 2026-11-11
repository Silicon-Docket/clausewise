import {
  decisionPane,
  decision,
  decidedWith,
  editWith,
  feedbackProps,
  paneOf,
  refusedFindingPage,
  refusedRunPage,
  report,
  runPageWith,
} from "./feedback-support.js";
import { buildRunSummary } from "./support.js";
import type { Variant } from "./variants.js";

/**
 * The page fixtures of the feedback capture panes (work package W2.6a), in the same shape as the
 * base list in variants.ts, which spreads this list after its own. The package adds an entry for
 * every state of a page that changes what the page shows, and only in this file.
 *
 * Slice A (the reason code and the minor-edit mark of a decision): the decision form with nothing
 * chosen and with a code and the box chosen, the history of a decided edit, a reject and an old
 * decision that carries neither, and the finding page that answers a refusal about the code and
 * about the box.
 *
 * Slice B (a missed issue): the review page with the section of reports, with nothing reported, with
 * reports of every shape (a rule named, not covered, no place, text a hostile document could hold),
 * with the form as it was typed when a report was refused, with the page that answers each refusal,
 * with a review that has no findings, and with a review that is out of date. The later slices (a
 * note, the rating) add their states below.
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
  ["run page, report of a missed issue, nothing reported yet", () => runPageWith(feedbackProps())],
  [
    "run page, report of a missed issue, reports listed",
    () =>
      runPageWith(
        feedbackProps({
          items: [
            report(),
            report({
              feedbackId: "fbk_0002",
              ruleKey: null,
              ruleTitle: null,
              location: null,
              note: "Nothing in the playbook covers a non-solicitation clause.\nIt is in Section 11.",
              reporterName: "A. Ruiz",
              at: "2026-11-03T16:02:00Z",
            }),
            report({
              feedbackId: "fbk_0003",
              ruleKey: "gov-1",
              ruleTitle: null,
              location: "NDA, Section 9.2",
              note: "Governing law is Delaware, which is outside the list.",
              reporterName: "R. Okoye",
              at: "2026-11-04T09:15:00Z",
            }),
          ],
        }),
      ),
  ],
  [
    "run page, report of a missed issue, text a hostile document could hold",
    () =>
      runPageWith(
        feedbackProps({
          items: [
            report({
              ruleKey: "dur-1",
              ruleTitle: "<script>window.pwned = 1</script>",
              location: '"><img src=x onerror="window.pwned=1">',
              note: "pay \u202e1000\u202c now, con\u200bfi\u200ddential </textarea><script>1</script>",
              reporterName: "<b>Mallory</b>",
            }),
          ],
        }),
      ),
  ],
  [
    "run page, report of a missed issue, a rule and a note typed and kept after a refusal",
    () =>
      runPageWith(
        feedbackProps({
          draft: {
            ruleKey: "gov-1",
            location: "NDA, Section 9.2",
            note: "Governing law is Delaware.\nIt is not on the list.",
          },
        }),
      ),
  ],
  [
    "run page, report of a missed issue, a long note kept after a refusal",
    () =>
      runPageWith(
        feedbackProps({ draft: { ruleKey: "(none)", note: "A long note. ".repeat(500) } }),
      ),
  ],
  [
    "run page, report refused: no rule chosen",
    () => refusedRunPage("rule_required", { location: "Section 4", note: "A note." }),
  ],
  [
    "run page, report refused: rule not in the playbook",
    () => refusedRunPage("unknown_rule", { note: "A note." }),
  ],
  [
    "run page, report refused: note empty",
    () => refusedRunPage("note_required", { ruleKey: "dur-1" }),
  ],
  [
    "run page, report refused: note too long",
    () => refusedRunPage("note_too_long", { ruleKey: "(none)", note: "n".repeat(4001) }),
  ],
  [
    "run page, report refused: location too long",
    () =>
      refusedRunPage("location_too_long", {
        ruleKey: "dur-1",
        location: "l".repeat(201),
        note: "A note.",
      }),
  ],
  [
    "run page, report refused: the review is full of this person's reports",
    () =>
      refusedRunPage(
        "feedback_limit",
        { ruleKey: "dur-1", note: "A note." },
        { status: "conflict" },
      ),
  ],
  [
    "run page, a review with no findings: the sentence in place of the form",
    () =>
      runPageWith(feedbackProps(), {
        issues: [],
        run: buildRunSummary({ status: "failed", errorKind: "provider_error", findingCount: 0 }),
      }),
  ],
  [
    "run page, report refused: the review has no findings",
    () =>
      refusedRunPage(
        "run_has_no_findings",
        { note: "A note." },
        {
          status: "conflict",
          issues: [],
          run: buildRunSummary({ status: "cancelled", findingCount: 0 }),
        },
      ),
  ],
  [
    "run page, report of a missed issue on a review that is out of date",
    () =>
      runPageWith(feedbackProps({ items: [report()] }), {
        run: buildRunSummary({ current: false }),
      }),
  ],
  ["run page, no section of reports (a page made without the feedback)", () => runPageWith(null)],
];
