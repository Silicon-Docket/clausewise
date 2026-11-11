import { CANNOT_ADD_NOTE } from "../../src/services/phrases.js";
import {
  decisionPane,
  decision,
  decidedWith,
  editWith,
  feedbackProps,
  memosPageWith,
  noteOf,
  notesPane,
  paneOf,
  ratingGiven,
  ratingProps,
  ratingSectionOf,
  refusedFindingPage,
  refusedMemosPage,
  refusedNotePage,
  refusedRunPage,
  report,
  runPageWith,
  runPageWithNotes,
} from "./feedback-support.js";
import { buildFindingView, buildRunSummary } from "./support.js";
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
 * with a review that has no findings, and with a review that is out of date.
 *
 * Slice C (the rating): the memos page in the four states of the rating, the section alone, and the
 * page that answers each refusal of a rating.
 *
 * Slice D (the notes on a finding): the pane with no note, with notes of every shape, with text a
 * hostile document could hold, with a note kept after a refusal and with the form replaced by the
 * reason a note cannot be added; the finding page that answers each refusal of a note; and the
 * review page with the notes in the inspector and their counts in the issue table.
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

  // --- the rating of a matter (slice C) --------------------------------------------------------
  [
    "memos page, rating, the matter has no memo yet",
    () => memosPageWith(ratingProps({ hasMemo: false, runId: null })),
  ],
  ["memos page, rating, the form beside the memo", () => memosPageWith(ratingProps())],
  [
    "memos page, rating, the form for a viewer, who cannot export",
    () => memosPageWith(ratingProps(), { canExport: false }),
  ],
  [
    "memos page, rating, given with words",
    () => memosPageWith(ratingProps({ given: ratingGiven() })),
  ],
  ["memos page, rating, a page made without the rating section", () => memosPageWith(null)],
  [
    "pane, rating, the form with nothing chosen",
    () => ratingSectionOf(ratingProps()),
    { fragment: true },
  ],
  [
    "pane, rating, a mark and a comment kept after a refusal",
    () =>
      ratingSectionOf(
        ratingProps({
          draft: { rating: 2, comment: "It missed the amendment.\nI would not rely on it." },
        }),
      ),
    { fragment: true },
  ],
  [
    "pane, rating, a long comment kept after a refusal",
    () =>
      ratingSectionOf(
        ratingProps({ draft: { rating: 5, comment: "A long comment. ".repeat(500) } }),
      ),
    { fragment: true },
  ],
  [
    "pane, rating, given with words",
    () => ratingSectionOf(ratingProps({ given: ratingGiven() })),
    { fragment: true },
  ],
  [
    "pane, rating, given with no words, the lowest mark",
    () => ratingSectionOf(ratingProps({ given: ratingGiven({ rating: 1, comment: null }) })),
    { fragment: true },
  ],
  [
    "pane, rating, given with text a hostile document could hold",
    () =>
      ratingSectionOf(
        ratingProps({
          given: ratingGiven({
            comment:
              "pay \u202e1000\u202c now, con\u200bfi\u200ddential </textarea><script>window.pwned = 1</script>",
          }),
        }),
      ),
    { fragment: true },
  ],
  [
    "pane, rating, no memo, so no link to the report",
    () => ratingSectionOf(ratingProps({ hasMemo: false, runId: null })),
    { fragment: true },
  ],
  [
    "memos page, rating refused: no mark chosen",
    () => refusedMemosPage("rating_required", { comment: "I kept my words." }),
  ],
  [
    "memos page, rating refused: a mark the form does not offer",
    () => refusedMemosPage("bad_rating", { comment: "I kept my words." }),
  ],
  [
    "memos page, rating refused: comment too long",
    () => refusedMemosPage("comment_too_long", { rating: 3, comment: "c".repeat(4001) }),
  ],
  [
    "memos page, rating refused: already rated",
    () =>
      refusedMemosPage(
        "already_rated",
        { rating: 5 },
        {
          status: "conflict",
          rating: { given: ratingGiven({ rating: 2 }) },
        },
      ),
  ],
  [
    "memos page, rating refused: the matter has no memo yet",
    () =>
      refusedMemosPage(
        "not_exported",
        { rating: 4 },
        {
          status: "conflict",
          rating: { hasMemo: false, runId: null },
        },
      ),
  ],

  // --- the notes on a finding (slice D) --------------------------------------------------------
  ["pane, notes, none written yet, the form", () => notesPane([]), { fragment: true }],
  [
    "pane, notes, three notes and the form",
    () =>
      notesPane([
        noteOf(),
        noteOf({
          feedbackId: "fbk_0201",
          note: "The amendment is dated after the NDA.\nSo Section 9.3 may not reach it.",
          authorName: "D. Whitfield",
          at: "2026-11-03T14:40:00Z",
        }),
        noteOf({
          feedbackId: "fbk_0202",
          note: "Agreed, I will look at the dates.",
          authorName: "R. Okoye",
          at: "2026-11-04T08:12:00Z",
        }),
      ]),
    { fragment: true },
  ],
  [
    "pane, notes, text a hostile document could hold",
    () =>
      notesPane([
        noteOf({
          note: "pay \u202e1000\u202c now, con\u200bfi\u200ddential </textarea><script>window.pwned = 1</script>",
          authorName: "<b>Mallory</b>",
        }),
      ]),
    { fragment: true },
  ],
  [
    "pane, notes, a note kept after a refusal",
    () =>
      notesPane([noteOf()], {
        noteDraft: { note: "I kept my words.\nThey were not lost to the refusal." },
      }),
    { fragment: true },
  ],
  [
    "pane, notes, a long note kept after a refusal",
    () => notesPane([], { noteDraft: { note: "A long note. ".repeat(500) } }),
    { fragment: true },
  ],
  [
    "pane, notes, the finding is out of date: the reason in place of the form",
    () =>
      notesPane([noteOf()], {
        canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale },
        finding: buildFindingView({ issue: { ...buildFindingView().issue, validity: "stale" } }),
      }),
    { fragment: true },
  ],
  [
    "pane, notes, a role that cannot add: the reason in place of the form",
    () => notesPane([], { canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.role } }),
    { fragment: true },
  ],
  [
    "pane, notes, no reason given: the general sentence in place of the form",
    () => notesPane([], { canAddNote: { allowed: false, reason: null } }),
    { fragment: true },
  ],
  [
    "finding page, note refused: empty",
    () => refusedNotePage("finding_note_required", { note: "   " }),
  ],
  [
    "finding page, note refused: too long",
    () => refusedNotePage("finding_note_too_long", { note: "n".repeat(4001) }),
  ],
  [
    "finding page, note refused: this person has written the most they may",
    () => refusedNotePage("feedback_limit", { note: "One more." }, { status: "conflict" }),
  ],
  [
    "finding page, note refused: the finding is out of date",
    () =>
      refusedNotePage(
        "finding_not_current",
        { note: "Too late." },
        { status: "conflict", canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale } },
      ),
  ],
  [
    "run page, the inspector with notes and the counts in the issue table",
    () =>
      runPageWithNotes([noteOf(), noteOf({ feedbackId: "fbk_0201", authorName: "R. Okoye" })], {
        counts: { "dur-1": 2, "exc-1": 1 },
      }),
  ],
  [
    "run page, the inspector on a finding that is out of date, with its notes",
    () =>
      runPageWithNotes([noteOf()], {
        counts: { "dur-1": 1 },
        canAddNote: { allowed: false, reason: CANNOT_ADD_NOTE.stale },
      }),
  ],
];
