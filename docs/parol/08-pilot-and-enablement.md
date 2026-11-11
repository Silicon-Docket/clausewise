# 8. Pilot and enablement

**Implementation status.** This is a hypothetical pilot plan and no pilot has run. What the demo can
back today is the review workflow itself: a matter, uploads, a review, attorney decisions, invalidation
and a Word memo, exercised against a scripted simulated reader and not a language model. Not built:
the training matter T01 and its completion record, a quickstart page, feedback capture (reason
codes, missed-issue report, rating), timers, the pilot measures and the rollback switch. Of the seven
training steps, three are supported by the seeded matter, two partly, and two not (the tables below
say which). No pilot number, rate or time exists, and none may be taken from the seeded matters or
the simulated reader. Nothing here has been run against a live model.

**This is a hypothetical pilot plan.** No pilot has run. The demo seeds activity so the screens
have something to show; seeded events are flagged synthetic, and the pilot measures exclude them.
Nothing seeded, simulated or produced by the author's own testing may be described as adoption,
usage or time saved.

**Deviation.** The seed (`pnpm parol:seed`) creates two matters, both flagged synthetic (every matter
the application creates is), and, only with `--run`, one or two reviews of the first matter. It seeds
no decisions, timers, ratings or other activity, and the pilot measures page that would exclude
seeded events does not exist. The two matters belong to demo identities, so they are also easy to
exclude by user.

## Pilot design

| Element          | Proposal                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Group            | One practice group: four associates who review NDAs, two reviewing attorneys, one legal engineer, one sponsor            |
| Length           | Five weeks: one of baseline, one of training and shadow mode, three of assisted use                                      |
| Documents        | Synthetic NDAs in phases 0 and 1; in phase 2 only what the practice and the firm's security review approve for the pilot |
| Workflow version | Only a version promoted through the gates in [document 5](05-evaluation.md#release-gates-proposed), pinned for the pilot |
| Success owner    | The sponsor decides go or no-go from the evidence below                                                                  |

**Phase 0, manual baseline (week 1).** Each associate reviews four NDAs the usual way, and the
reviewing attorneys review those first passes, both timed with a start and stop button that records
active minutes. Reviewers also record the issues they found, which become the reference list for
shadow mode. Without this phase there is no time comparison, and no time-saved claim may be made.

**Phase 1, training and shadow mode (week 2).** The 20-minute training exercise below, then each
associate reviews the same four NDAs again with Parol. The issue lists are compared slot by
slot with the phase 0 lists. Shadow mode measures what Parol misses, not what it saves, because
the associate has seen the documents before.

**Phase 2, assisted use (weeks 3 to 5).** New NDAs go through Parol with attorney review. Time,
decisions, corrections, missed-issue reports and ratings are recorded.

**What the software supports today.** Only part of this design can be run with the code that exists.

| Need                                                          | Today                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matters, uploads, a review, decisions, a memo                 | Built. Exercised with the simulated reader only; no real NDA has been through it, and the demo identity is not authentication                                                                                                         |
| A workflow version promoted through the gates, pinned         | **Not built.** The store can mark a workflow version `pilot` with a promotion record, and a review then defaults to the latest one, but no route or page does it, and no version has been promoted: `v1` and `v2` are both candidates |
| Timers: active minutes per NDA, associate and attorney        | **Not built.** No start and stop button, no stored minutes. Without them no time claim may be made (see Measures)                                                                                                                     |
| Phase 0 and shadow-mode issue lists and their slot comparison | **Not built.** The slot comparison exists only between a run and the evaluation answer keys                                                                                                                                           |
| Corrections, missed-issue reports, ratings                    | **Not built.** A decision stores its kind and a free-text reason, and an edit stores the changed fields; there are no reason codes, no missed-issue report and no rating                                                              |
| The pilot measures and their CSV                              | **Not built** (see Measures)                                                                                                                                                                                                          |
| Real participants, identities and documents                   | **Not available.** The identities are four demo users without passwords, and nothing here has had a security review                                                                                                                   |

## Attorney acceptance criteria

Proposed with the reviewing attorneys before the pilot starts, and not changed during it.

| #   | Criterion                                                                                                   | Measured by                                      | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | No exported memo contains a quotation that is not in the document                                           | Export-time re-verification; spot check          | Re-verification at export is built and tested (a quote that no longer matches stops the export). The spot check is a human step                                                                                                                                                                                                                                                                                                                         |
| A2  | In shadow mode, every high-severity issue on the reviewers' reference list is flagged or escalated by Parol | Slot comparison with phase 0 lists               | **Not built:** no reference-list entry and no comparison against it                                                                                                                                                                                                                                                                                                                                                                                     |
| A3  | At least 80 percent of findings are accepted, or edited with what the reviewer marks as a minor edit        | Decisions and edit size                          | **Not built:** decisions and edits are stored, but there is no minor-edit marker and no computation                                                                                                                                                                                                                                                                                                                                                     |
| A4  | A reviewer can check any finding's evidence without leaving the page                                        | Observation during training                      | The review page opens each finding's passages, highlighted, in an inspector beside the issue table; the observation has not been done                                                                                                                                                                                                                                                                                                                   |
| A5  | Median answer of at least 4 of 5 to "I would use this for my next NDA"                                      | Post-matter rating                               | **Not built:** no rating                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A6  | Median active time per NDA (associate plus attorney) is no worse than the phase 0 median                    | Timers, both phases                              | **Not built:** no timers                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A7  | No unauthorized access event and no instruction-driven change in output                                     | Audit log, evaluation suite on the pilot version | The audit log is built and tested but records changes, not refusals; refusals appear only as a status in the access log, which goes to standard output and is not stored. The evaluation suite has been run only against a scripted oracle and a simulated reader, and its exposure suite (`--exposure`) tests the application with a scripted stand-in for the model, so no real model has been observed with either access or an embedded instruction |

## Training exercise (20 minutes)

Uses the seeded training matter T01: the documents of evaluation case `PAROL-D05`, with the instruction
paragraph from `PAROL-D08` added to the NDA and one planted finding. T01 is never used in evaluation.
The trainer has the answer key; the trainee does not.

**Not built: T01.** No training matter exists. What the seed creates is the matter "Lanternfish /
Corvane NDA", whose two documents are the committed files of case `PAROL-D05`
(`fixtures/parol/files/parol-d05-nda.docx` and `parol-d05-amendment-1.txt`). It has no instruction
paragraph and no planted finding. The simulated reader that reviews it is a table written in advance
from those two documents: it answers from the passages it is shown, so a planted finding cannot be
added, and it declines (every rule `undetermined`, escalated) any document in which a single
paragraph was changed. The exercise below is therefore a design. The last column says what the seeded
matter supports today.

| Step | Task                                                                                                                                                                                                           | What it teaches                                  | Answer key                                                                                                                                                              | Today                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Open the training matter and check its intake: the NDA and the amendment with their stated dates, which version of each is operative, the playbook version, and the line that says where document text is sent | Intake, operative versions, the destination line | NDA operative; playbook 1.0.1 (the design said 1.0.0)                                                                                                                   | **Supported.** T01 is made for you, by `pnpm parol:seed --training` or by the button on the quickstart page. The matter page shows the NDA and the amendment with their stated dates, which version of each is operative, the playbook version (1.0.1) and the line that says where document text is sent                                                                                   |
| 2    | Read the warning on the NDA. What will Parol do with that paragraph?                                                                                                                                           | Documents are data                               | Parol gives it to the model as document text and cannot show that a model ignored it; the warning tells the reader to read it, and a finding that cites it is escalated | **Supported.** The NDA of T01 carries the instruction paragraph of `PAROL-D08`, so the matter page shows the warning for it. The trainer checks the answer; Parol does not record it. The simulated reader reads T01, so what a review of it does with the paragraph says nothing about what a model would do                                                                               |
| 3    | Start a review with workflow version v2, then open DUR-1. Which passage governs, and why is the Section 6.1 quote marked superseded?                                                                           | Evidence roles, amendments                       | Amendment Section 2 deletes 6.1                                                                                                                                         | **Supported under workflow v2 only.** The picker on the matter page starts on v1, under which DUR-1 reads `Compliant`; the trainee has to run the review under v2, and then the inspector shows the amendment as governing and Section 6.1 struck through as superseded                                                                                                                     |
| 4    | One finding in the review was planted by the training script: its quote is in the document but does not support it. Find it and reject it with a reason and a reason code                                      | Quote validity is not support                    | The planted `pds-1` finding quotes the definition clause, which says nothing about representatives                                                                      | **Supported, with a limit.** In every review of T01 under v1 and under v2 the simulated reader's script gives `pds-1` the status `Compliant` and cites Section 1.2, so the quote is verified, no flag is raised and the page reads Support not checked. The planted finding is a property of that script, not of a model                                                                    |
| 5    | Escalate a finding you would send to a partner, with a reason                                                                                                                                                  | Escalation is a decision                         | Any reasoned choice; DUR-1 is the natural one, because the amendment reverses an agreed term                                                                            | **Supported.** Signed in as the reviewing attorney, the decision form has Escalate and requires a reason                                                                                                                                                                                                                                                                                    |
| 6    | The partner says the amendment took effect on 1 October 2026. Change its stated date to 2026-10-01 and save it. What happened to your decisions?                                                               | Invalidation                                     | All stale; export blocked until re-run and re-decided                                                                                                                   | **Supported by changing the stated date.** A changed stated date makes every finding and decision stale and blocks export, as a changed version does. An uploaded changed amendment would make the simulated reader decline, so the next review would be all `undetermined`; the exercise uses the date for that reason                                                                     |
| 7    | Run the review again with v2, decide all eight findings again (reject the planted one with a reason and a reason code), export the memo, and find your rejected finding in it                                  | Export gate, memo structure                      | It is in the rejected appendix                                                                                                                                          | **Supported.** A re-run of T01 under v2 gives eight findings, the planted one among them and with no decision on it; the decisions of steps 4 and 5 do not carry over. Deciding all eight and exporting work as for any matter, a rejected finding is in the memo's appendix, and export is refused while any finding is undecided. The memo states that the reader was a scripted stand-in |

Completion is recorded per step; trainees who miss steps 3 or 4 repeat them with the trainer. **Not
built:** nothing records completion of a step.

## Quickstart

**Not built:** the quickstart page. What exists is `apps/parol/README.md`, and these are the
commands it gives to run the demonstration (Node 22 and pnpm 10, from the Clausewise folder). The seed
(with `--run v1 --run v2`) and the server were run while this status was written, with the data folder
set to a scratch folder and the server answering `/healthz`; `pnpm install` was not run:

```sh
pnpm install
PAROL_DEMO_IDENTITY=1 pnpm parol:seed
PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol
```

Then open `http://127.0.0.1:8787` and choose an identity. `PAROL_SCRIPTED=1` makes the simulated
reader read the documents, so nothing is sent anywhere. Without it the server needs a provider key
and sends the text of every document to that provider, which is not for anything but synthetic
documents. Add `--run v1 --run v2` to the seed to have both reviews of the first matter made for
you.

The ten steps below are the design. The notes after them say which exist.

1. **Sign in.** In this demonstration you choose a demo identity; there are no passwords. The banner
   tells you which environment you are in.
2. **New matter**: name it, type your client's exact legal name, add your reviewing attorney.
3. **Add documents**: the NDA, and any amendment with its date. Mark which NDA version is operative.
   Read any warnings.
4. **Choose the playbook version.** Only approved versions are listed.
5. **Start review.** The line above the button says where the text is sent.
6. **Read the issue table.** Each row has a status, a severity and, if the system could not stand
   behind it, an escalation reason. Click a row to see the passages it relies on, highlighted in the
   document.
7. **Leave notes** for your reviewer on anything you disagree with.
8. **Reviewer:** accept, edit, reject or escalate every finding. Edits, rejections and escalations
   need a reason, and edits and rejections need a reason code.
9. **Export the memo.** It contains only reviewed findings, open items first.
10. **Rate the matter** and use **Report a missed issue** for anything Parol did not catch.

What Parol will not do: decide anything, send anything to the other side, or review PDFs,
footnotes, headers or pictures. When documents change, earlier decisions stop counting.

**What exists of these steps today.** Steps 2 to 6, 8 and 9 exist: the matters page has a form for
the matter name, the client's name, the reviewing attorney and the playbook; the matter page has the
documents and stated dates, the operative version, the start button and the line about where text is
sent; the issue table and the evidence inspector are on the review page; the decision form and the
memo export follow. Step 1 is the demo identity picker, not a pilot identity, and its
banner is the one on every page. **Not built:** step 7 (there are no notes for the reviewer) and step
10 (no rating and no "Report a missed issue"). The headings and wording of the pages are the
application's, and the steps above are a paraphrase.

## Feedback collection

| Channel                       | When                          | What                                                                            | Today                                                                                                   |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Reason code on edit or reject | Every such decision           | wrong status, wrong evidence, missed context, bad fallback, unclear, other      | **Not built.** The decision form takes a free-text reason; the `feedback` table has a column for a code |
| Report a missed issue         | Any time on a matter          | Rule (or "not covered"), location, note. The main source for recall in real use | **Not built.** No route, form or page; the `feedback` table and the `feedback.add` permission exist     |
| Post-matter rating            | At export                     | "I would use this for my next NDA", 1 to 5, optional comment                    | **Not built.** Same table, no form                                                                      |
| Weekly pulse                  | Fridays, three questions      | Trust in findings, time spent checking, the worst moment of the week            | A process, not software; nothing to build                                                               |
| Interviews                    | Mid-pilot and end, 20 minutes | What they stopped checking, what they never trust, what they would change       | A process, not software                                                                                 |
| Office hours                  | Twice a week, 30 minutes      | Questions; observed use                                                         | A process, not software                                                                                 |

The legal engineer triages feedback weekly into failure records using the taxonomy in
[document 5](05-evaluation.md#root-cause-taxonomy). A change prompted by feedback is made as a new
workflow or playbook version and goes through the gates; the pilot's pinned version does not change
mid-week.

## Measures

Computed from stored events, excluding synthetic users and seeded matters.

| Measure               | Definition                                                                    | Denominator                                  |
| --------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| Completion            | Matters exported                                                              | Matters with a run started                   |
| Repeat usage          | Participants who started matters in at least two different pilot weeks        | Participants trained                         |
| Correction rate       | Decisions that are edit or reject, overall and by reason code                 | Decided findings                             |
| Missed-issue rate     | Missed-issue reports                                                          | Exported matters (also per rule)             |
| Escalation rate       | Findings escalated by the system, and by reviewers, separately                | Findings                                     |
| Satisfaction          | Median and distribution of the post-matter rating                             | Ratings given (with the response rate shown) |
| Active time           | Median active minutes per NDA, associate and attorney separately and combined | Timed NDAs, per phase                        |
| Shadow-mode agreement | Reference-list issues that Parol flagged or escalated, by severity            | Reference-list issues                        |

**Not built:** the measures. No page, query or CSV script computes any row of this table. What the
database holds that a script could use: matters (with a `synthetic` flag and the creator), runs and
their workflow versions, findings with the escalations the system raised, decisions with their kind,
reason and changed fields, memos (so exports) and the audit log. What it does not hold: active time,
ratings, missed-issue reports, reason codes, the pilot week of a matter, which participants were
trained, or any reference list for shadow mode. Until those exist, the Completion, Correction rate
and Escalation rate rows are computable in principle, and the Repeat usage, Missed-issue rate,
Satisfaction, Active time and Shadow-mode agreement rows are not.

**Time claims.** A difference in time is reported only as medians from phase 0 and phase 2 with
their sample sizes, attorney review time included, and with the caveat that documents differ
between phases. With four associates the result is indicative at best. Annualised savings are not
computed from a pilot this size.

## Go/no-go recommendation (template for the sponsor)

```markdown
# Parol NDA pilot: recommendation

**Recommendation:** Go | Go with conditions | No-go
**Workflow version:** v<n> (promotion record <link>), playbook <version>, model <id>

## What we measured

- Participants: <n> associates, <n> reviewing attorneys; matters exported: <n> of <n> started
- Acceptance criteria A1 to A7: <met / not met, one line each with the number and denominator>
- Shadow mode: <x of y> high-severity reference issues flagged or escalated
- Corrections: <rate>, most common reason <code>; missed-issue reports: <n>
- Time: phase 0 median <m> min (n = <n>), phase 2 median <m> min (n = <n>), attorney review included
- Satisfaction: median <r> (response rate <p>)

## What we did not measure or cannot conclude

- <for example: no PDF documents; four associates; documents differ between phases>

## Risks and conditions

- <condition, owner, date>

## If go

- Scope of expansion, next gate, review date

## If no-go

- What would have to change, and whether a re-pilot is worth it
```

## Rollback plan

**Triggers** (any one): an unauthorized access event; an exported memo with an unverifiable
quotation; a high-severity silent miss confirmed in phase 2; an instruction-driven change in output;
a provider outage or terms change that blocks use; the sponsor's call.

**Steps.**

1. Set the pilot pointer to the previous promoted workflow version, or disable new runs entirely.
   Existing matters keep their runs; findings from the withdrawn version are labelled with it.
2. Tell participants the same day: what happened, what to do with matters in progress (finish them
   manually or re-run on the previous version), and that exported memos from the affected version
   must be re-checked by a reviewer.
3. List affected matters and memos from the provenance records (run, workflow version, dates).
4. Write a failure record and, where relevant, add a case to the evaluation set that reproduces it
   before any fix.
5. Resume only with a version that passes the gates, including the new case, and with the
   sponsor's agreement.

Rollback never deletes matter data early; retention follows the normal schedule.
