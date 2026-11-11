# 9. Demo script, one-pager and postmortem

**Implementation status.** This document is a script and two templates, and none of the three has
been used: nothing was recorded, no one-pager was written and no postmortem exists. What the demo
can back today is the walk-through in `apps/parol/README.md` (about two minutes, against a scripted
simulated reader that is not a language model, and that reads two document sets only, the worked
example and the training matter T01, and declines everything else, including one changed word of
either): intake, a review under workflow v1 and v2, the
evidence and checks panel, an attorney's decision, invalidation, and the separation of two users'
matters. The memo is not in that script (it needs every finding decided, and the walk-through has
one decided); the README describes it separately. It can back the evaluation half of the script (1:15 to 1:42) only in part: the
comparison page (`/evaluations`, for the legal engineer and the administrator) shows a comparison of
two simulated runs, labelled SIMULATED, which the evaluation command publishes. There is no live run
(the held-out set is written, and no live run has used it), so there is no held-out result to show and
every `<...>` stays empty. Part 3 also built what the script does not use: the training matter with a quickstart,
the feedback forms and the pilot measures page, none of which has data from a pilot. **Never run
live:** no number measured on a model exists, and none may be spoken, written or shown.

## Two-minute demo script

Recorded against the seeded demo matters. Every number spoken comes from `EXP-001.md`; where the
script shows `<...>`, say the measured value or say that it was not measured. Never round a result
up or describe the demo's seeded activity as usage.

`EXP-001.md` holds no measured table today, so no number can be spoken. The last column says what
the application can back now, against the two matters that the first command seeds and the second
command serves:

```sh
PAROL_DEMO_IDENTITY=1 pnpm parol:seed
PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol
```

The cut-down script for what exists, with the exact clicks, is "A walk-through of about two
minutes" in [apps/parol/README.md](../../apps/parol/README.md).

| Time | On screen                                                                                                               | Say                                                                                                                                                                                                                                                                                                                                 | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Title card, then the demo banner                                                                                        | "Parol is one NDA review workflow with attorney review and an evaluation loop. Everything here is synthetic: the documents, the playbook, the people."                                                                                                                                                                              | **Supported.** Every page carries the banner "DEMO: synthetic documents, demo identity, not for client work". The title card is recording material. The evaluation loop runs from a command (`pnpm eval:parol`); the comparison page (`/evaluations`) shows a comparison that the command published, labelled SIMULATED when the run was scripted                                                                                                                                                                                                                                                                                                         |
| 0:10 | Intake: NDA (DOCX) and Amendment No. 1 (TXT), playbook 1.0.1, the destination line                                      | "An associate creates a matter, uploads the NDA and an amendment, and picks an approved playbook version. The run pins all of it."                                                                                                                                                                                                  | **Supported.** The seeded matter "Lanternfish / Corvane NDA" holds both files and shows playbook 1.0.1 and the line "Where document text is sent", which names the scripted stand-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 0:22 | The instruction-like text warning                                                                                       | "This NDA contains a paragraph telling automated reviewers to report no exceptions. The review gives it to the model as document text, and Parol cannot show that a model ignored it. The model has no tools, its quotes, labels and escalation reasons are checked in code, and a finding that cites that paragraph is escalated." | **Partly supported.** The warning appears for `fixtures/parol/files/parol-d08-nda.docx`, added to a matter for the client "Larkspur Freight Systems, Inc.", and the simulated reader declines that document, so every rule comes out undetermined and escalated, which shows nothing about how a model treats the paragraph. With `pnpm parol:seed --training` the warning is also on the NDA of the training matter T01, which the simulated reader does read (the worked example with that paragraph added) and in which its script plants one wrong finding; that finding is the script's and says nothing about a model                               |
| 0:35 | Issue table; open DUR-1; the inspector highlights the amendment and the superseded clause                               | "Eight rules, eight findings, each with the exact passage and where it is. Duration is a deviation: the amendment deletes Section 6.1, the only time limit."                                                                                                                                                                        | **Supported under workflow v2 only.** The version picker starts on v1, under which DUR-1 reads Compliant. Under v2 the inspector shows the amendment as governing and Section 6.1 struck through as superseded                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 0:52 | Checks panel                                                                                                            | "Quotes are verified against the document. Separately, a support check asks whether the passages actually establish the conclusion. Those are different questions."                                                                                                                                                                 | **Partly.** The panel lists each check and its outcome. The model support check is built and pinned by neither workflow version the application ships (v1 and v2), so the panel says "Support not checked". Say instead that the check exists, is off in the application, and is on in an evaluation-only version (v3) whose checker has not been measured                                                                                                                                                                                                                                                                                                |
| 1:02 | Reviewer edits the fallback, adds a reason and a reason code; then uploads a new amendment version; findings turn stale | "The attorney decides every finding. If the documents change, the decisions stop counting and export is blocked."                                                                                                                                                                                                                   | **Partly.** Editing with a reason and a reason code, and the stale state, are supported. A changed stated date stales the review without changing a word. A new amendment version also stales it, but the simulated reader declines any edited document, so the re-run is all undetermined                                                                                                                                                                                                                                                                                                                                                                |
| 1:15 | Evaluation comparison, held-out tab                                                                                     | "The first version got this wrong. It quoted Section 6.1 correctly and called the term compliant, because retrieval never showed it the amendment. Valid quote, wrong conclusion."                                                                                                                                                  | **Partly supported.** The comparison page shows a comparison of two simulated runs, labelled SIMULATED in capitals. For `PAROL-D05` its changed-slots list shows the v1 result for `dur-1` as `Compliant` and wrong ("Missed an issue and raised no flag") and the v2 result as `Deviation` and right, and the evidence trail shows v1 not shown the amendment paragraph `D2-p3` and v2 shown it and citing it as governing. That is the simulated reader's, by construction, and is not a finding about any model. The held-out set is written (12 cases) and no live run has used it, so there is no held-out result to show, and no model has been run |
| 1:28 | The changed-slots list and the gates                                                                                    | "I changed one thing, retrieval, and ran a held-out suite the fix was never tuned on, three times each. Strict recall went from `<...>` to `<...>`, with `<...>` high-severity misses."                                                                                                                                             | **Partly supported.** The page lists the changed slots, regressions first, with their counts ("n of N paired slots changed"), and the 14 gates of both versions as Pass, Fail or Not evaluated with the reason beside each. For a scripted comparison it says that the scores are not a measurement of any model. Nothing was run three times on a model, so every `<...>` stays empty                                                                                                                                                                                                                                                                    |
| 1:42 | Latency and cost rows; the recommendation                                                                               | "Cost per run changed by `<...>` and p95 latency by `<...>`. Recommendation: `<promote / with conditions / do not promote>`, because `<gate>`."                                                                                                                                                                                     | **Not available.** No latency or cost was measured: the page shows those rows as n/a for a scripted run. The decision rule needs all 14 gates to pass. G1 has an input with `--exposure` and G11 with `--calibration` (workflow v3, live or replay), so the tooling can reach "promote", and no run has: the rule is skipped for a selftest, a simulated run and a replay, which the page says ("The decision rule is not applied"), and there is no live run. The page offers draft promotion record text with the decision and the signature left blank, and never recommends                                                                           |
| 1:52 | The memo, open items first; the provenance appendix                                                                     | "The memo contains only reviewed findings, with provenance. This shows consistency with a fictional playbook, not legal quality; that needs attorney review, which is next."                                                                                                                                                        | **Supported once every finding is decided.** The memo opens with open items, ends with Appendix A (rejected findings) and Appendix B (provenance), and its provenance carries a "Stand-in reader" line saying a program and not a language model produced the findings. When an upload raised warnings, a "Document warnings" section comes before the open items                                                                                                                                                                                                                                                                                         |

**Deviation.** The first draft said at 0:22 that "every outcome is checked in code". That is too
strong: quotes, passage labels, escalation reasons and consistency of the numbers are checked in
code, and since week-two part 3 a `missing` or `not_applicable` status is settled from the playbook's
flags, but a `compliant` or `deviation` status of a finding is the reader's (see
[document 6](06-access-and-governance.md#documents-are-data) and gap 6 of
[document 7](07-delivery-plan.md#known-gaps)).
The version at 0:10 was 1.0.0 in the first draft; the seeded playbook is 1.0.1.

If H1 was not confirmed, replace 1:15 to 1:42 with the failure the baseline actually showed. If no
live run happened, say so at 1:15 and show the protocol and the selftest instead of numbers. **No
live run has happened, so the second branch is the one that applies.** What can be shown instead is
the protocol ([EXP-001.md](experiments/EXP-001.md), a draft), `pnpm eval:parol --selftest` (a
scripted oracle that reads the answer key, so its perfect score says nothing about a model), the
Markdown report of `pnpm eval:parol --simulate` (or the same comparison published to the page with
`--publish`, where it is labelled SIMULATED) and the exposure suite (`pnpm eval:parol --selftest
--exposure`, which tests the application with a scripted stand-in and not a model), each labelled as
what it is.

## Portfolio one-pager outline

**Status: not written.** The outline is the plan. After each item, _Today_ says what the
repository can support if the page were written now. Where it says that a result does not exist,
the page must say so and must not borrow a number from a selftest or a simulated reader.

1. **Title and one line.** "Parol: an NDA review workflow with attorney review and a held-out
   evaluation loop (synthetic data)." _Today:_ the loop is built and has not been run on a model.
   Until a live held-out run exists, write "with a held-out evaluation harness" and say it has not
   been run on a model.
2. **The problem** in three sentences, from the brief. _Today:_ can be written from
   [document 1](01-product-brief.md).
3. **What I built.** The seven-stage workflow in one diagram; the issue table and evidence
   inspector in one screenshot. _Today:_ the diagram is the stage graph in
   [document 2](02-experience-and-architecture.md#stage-graph); the pages exist (the issue table and
   inspector, the comparison page, the pilot measures page, the quickstart), and no
   screenshot is stored in the repository.
4. **The distinctive part.** The improvement cycle: the baseline failure (one sentence and the
   evidence screenshot), the single change, the held-out comparison table with measured numbers,
   the recommendation and why. _Today:_ **cannot be written.** No baseline was run, no live run has used
   the held-out set (written, 12 cases, hash committed) and there is no measured table. The retrieval gap can be shown only as the
   simulated reader's by-construction contrast between workflow versions v1 and v2 (in the worked example
   or on the comparison page, where it is labelled SIMULATED), and it says nothing about whether a
   real model fails the same way (hypothesis H1, untested).
5. **How I measured.** 26 synthetic cases (14 dev, 12 held-out), metrics with denominators, gates,
   k = 3, everything pinned. One line on what synthetic answer keys can and cannot show. _Today:_
   all 26 cases are written (14 development, 12 held-out), with a 40-pair calibration set for the
   support checker; the metrics, the gates, the pins and record and replay are built; no run on a
   model has been made, so none used k = 3 (a test of the scoring code repeats the scripted oracle three
   times, which says nothing about any model).
6. **Controls.** Server-side matter authorization before retrieval, generation and export; documents
   treated as data; decisions invalidated when inputs change; minimal logging. _Today:_ all four
   are built and tested (see [document 6](06-access-and-governance.md), which also lists the
   gaps). The claim that documents are treated as data has been tested with scripted models only.
7. **Configure versus build.** Three lines from the table in document 1: what an approved legal AI
   product would likely do, and what remains the legal engineer's own work. _Today:_ can be written;
   the table is a reasoned expectation, checked against no product.
8. **Role fit.** Two or three lines each for the Cravath and Holland & Knight roles, tied to
   features, with the gaps stated (no enterprise platform administration, no practice experience).
   _Today:_ can be written from the evidence column in document 1; the Holland & Knight posting
   was not read, so that mapping stays marked unverified.
9. **Limits and next steps.** No qualified review yet (or its results), synthetic only, DOCX and
   TXT only, single machine, demo identity. _Today:_ add that no real model has been run, that no
   pilot has run (the pilot measures page is built and its pilot scope is empty), and that no person
   has used the pages with a keyboard alone or a screen reader.
10. **Links.** Repository, the design documents, `EXP-001.md`, the two-minute recording. _Today:_
    the recording does not exist, and `EXP-001.md` is a draft with no results.

Rule for the page: every number links to the results file it came from, and every claim says
whether it rests on the answer keys or on qualified review.

## Postmortem template

Blameless and specific. Written at the end of week two, whatever happened.

**Status: not written.** What is already known is in the section after the template. The
"Estimates against actuals" table cannot be filled in: **actual hours were not tracked**, and none
may be reconstructed afterwards.

```markdown
# Parol postmortem

## Summary

<Three sentences: what was planned, what was delivered, the single most important finding.>

## Goals and outcomes

| Goal                                          | Outcome              | Evidence       |
| --------------------------------------------- | -------------------- | -------------- |
| Workflow runs end to end on synthetic matters | <met / partly / not> | <link>         |
| Improvement cycle with real runs              | <...>                | EXP-001        |
| Held-out comparison with pinned versions      | <...>                | <results file> |
| Pilot materials                               | <...>                | document 8     |

## What the measurements showed

<The comparison table, copied from EXP-001, including results that do not favour the revision.
Which gates failed and why.>

## What worked

<Decisions that held up, with the evidence.>

## What did not work

<Failures, dead ends, wrong assumptions. For each: what happened, why, what I would do instead.>

## Surprises

<Things the plan did not predict: model behaviour, cost, the time cases took to write.>

## Estimates against actuals

| Item | Estimate (h) |  Actual (h) | Note |
| ---- | -----------: | ----------: | ---- |
| W1.1 |            3 | not tracked |      |
| ...  |              |             |      |

## Scope cuts taken

<Which cuts from document 7, and what each one means for the claims.>

## Claims I can make, and claims I cannot

- Can: <for example, "consistent with the demo playbook on 12 held-out cases, k = 3, with these counts">
- Cannot: <for example, professional legal quality; time saved; performance on real documents>

## What I would do next

<Ordered, with the reason for the order.>
```

## Known today, as inputs for the postmortem

Not the postmortem. These are the facts the repository supports now, each with where to check it;
the template above is filled in from them and from the runs that have not happened yet.

| Goal                                                   | Outcome today | Evidence                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow runs end to end on synthetic matters          | Partly        | The worked example, upload to memo, with the scripted simulated reader: `apps/parol/test/e2e/worked-example.test.ts`, `apps/parol/test/demo/walkthrough.test.ts`                                                                                                                                                                                                        |
| Synthetic dataset with answer keys and a held-out seal | Met           | `pnpm fixtures:parol --check`: 26 cases (14 development, 12 held-out) and 40 calibration pairs; the held-out hash is in `fixtures/parol/splits.json` and committed ([document 7](07-delivery-plan.md), W2.1). A fact about the dataset, not a result about any model                                                                                                    |
| Improvement cycle with real runs                       | Not met       | No live run was made ([document 7](07-delivery-plan.md), W2.4)                                                                                                                                                                                                                                                                                                          |
| Held-out comparison with pinned versions               | Not met       | The tooling is built and the held-out set is written (12 cases, hash committed); no run has used it, because no live run was made (`pnpm fixtures:parol --check`)                                                                                                                                                                                                       |
| Pilot materials                                        | Partly        | The tooling is built and tested with synthetic data (feedback forms, timers, a reference list, the measures page and CSV, the training matter, quickstart and help), and [document 8](08-pilot-and-enablement.md) is the plan and marks what is not built. The go/no-go memo is a template. No pilot has run and the pilot scope of the measures page is empty (gap 30) |

Scope cuts taken, from [document 7](07-delivery-plan.md#scope-cuts-in-order): cut 1 (no comparison
page, only the Markdown report) was not taken, because the page exists, and it shows scripted
comparisons only; cut 3 (no pilot measures page) was not taken either, because feedback capture and
the measures page are built, over synthetic data only; cut 4 is half taken (the support check, its 40-pair calibration set and
the step that measures it are built; it is off in the two versions the application ships, on in the
evaluation-only v3, and not measured). The hours in the estimates table were not tracked. The claims that can be made today are
the ones about consistency of the machinery: that the run page, the matter page, the memo, the
evaluation page and the evaluation reports say so when they show the output of a selftest or a
simulated reader (the JSON findings carry no label, only the run record names the provider), and that
no score of any model exists.
