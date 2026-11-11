# 8. Pilot and enablement

**Implementation status.** This is a hypothetical pilot plan and no pilot has run. What the software
can back today is the review workflow itself (a matter, uploads, a review, attorney decisions,
invalidation and a Word memo) and, built in week-two part 3, the tooling around it: a reason code and
a minor-edit mark on a decision, notes on a finding, a report of a missed issue, a post-matter rating,
timers, a reference list for shadow mode, the pilot measures page and its CSV, the training matter T01
with a quickstart page, a help page and a trainer's key. All of it is tested against scripted wires
and synthetic data, with the simulated reader, which is a script and not a language model. Of the seven
training steps, Parol can check five (3 to 7) from stored events, the first is set up for the trainee
and the second is checked by the trainer; all seven can be done with the simulated reader. Not built:
the go/no-go memo (a template below), the rollback switch, and real participants, identities and
documents. **No pilot number, rate or time exists**: the pilot scope of the measures page is empty on
every database this build can make (known gap 30 of [document 7](07-delivery-plan.md#known-gaps)), and
no figure may be taken from the seeded matters, the demonstration scenario or the simulated reader.
Nobody has done or timed the training exercise, no person has used the pages with a keyboard alone or
a screen reader, and nothing here has been run against a live model.

**This is a hypothetical pilot plan.** No pilot has run. The demo can seed activity so the screens
have something to show; seeded events are flagged synthetic, and the pilot scope of the measures
excludes them. Nothing seeded, simulated or produced by the author's own testing may be described as
adoption, usage or time saved.

**Deviation.** The seed (`pnpm parol:seed`) creates two matters, both flagged synthetic (every matter
the application creates is), and, only with `--run`, one or two reviews of the first matter. It seeds
no decisions, timers, ratings or other activity. Two options add to it. `--training` makes the
training matter T01 for the demo associate, with the demo reviewing attorney on it and the legal
engineer as its trainer; a training matter carries a training key, and the measures exclude it with
`matters.training_key IS NULL` (below). `--pilot-demo` makes a backdated scenario through the same
services the screens use, by demonstration identities, on synthetic matters, read by the scripted
reader: a pilot calendar that starts 29 days before the day it is run, six matters (two baseline and
four assisted), and, as the seed prints them when run, 16 timed sittings, 2 reference lists, 6
reviews, 32 decisions, 3 exported memos, 3 missed-issue reports and 5 ratings. Those are counts of
what the seed did, not measures, and a fresh data folder is advised because the rows are dated weeks
back. Its figures are shown only in the synthetic scope of the pilot page, under a banner that says
they are not pilot data. The matters belong to demo identities, so they are also easy to exclude by
user.

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
In the software the matter for each NDA is made in week 1 with its documents and playbook, the
timers are run on it, and the reviewing attorney saves the reference list on it before any review has
started; no review runs in this phase.

**Phase 1, training and shadow mode (week 2).** The 20-minute training exercise below, then each
associate reviews the same four NDAs again with Parol. The issue lists are compared slot by
slot with the phase 0 lists. Shadow mode measures what Parol misses, not what it saves, because
the associate has seen the documents before. The shadow review is a review on the same matter as the
baseline (a decision of the project, open to the owner: document 7, [decisions of part
3](07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn)), and a database
trigger closes the reference list when any review of the matter starts, so the list cannot be fitted to
Parol's answer. The alternative, a second matter linked to the first, needs a stored link between two
matters that nothing describes.

**Phase 2, assisted use (weeks 3 to 5).** New NDAs go through Parol with attorney review. Time,
decisions, corrections, missed-issue reports and ratings are recorded.

**What the software supports today.** Only part of this design can be run with the code that exists.

| Need                                                          | Today                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matters, uploads, a review, decisions, a memo                 | Built. Exercised with the simulated reader only; no real NDA has been through it, and the demo identity is not authentication                                                                                                                                                                                 |
| A workflow version promoted through the gates, pinned         | **Not built.** The store can mark a workflow version `pilot` with a promotion record, and a review then defaults to the latest one, but no route or page does it, and no version has been promoted: `v1` and `v2` are both candidates                                                                         |
| Timers: active minutes per NDA, associate and attorney        | **Built.** "Start timer" and "Stop timer" on the matter page, for the associate and the reviewing attorney; the server's clock writes both ends, one timer can run for a person at a time, and a stopped timer is final. Tested with synthetic matters; nobody has been timed for a pilot                     |
| Phase 0 and shadow-mode issue lists and their slot comparison | **Built.** A reference list per matter, saved by the reviewing attorney before any review of the matter has started and closed from then on; the pilot page compares it with the latest finished review of the matter (shadow-mode agreement, by severity). No reference list has been written by an attorney |
| Corrections, missed-issue reports, ratings                    | **Built.** An edit or a reject carries a reason code, an edit a minor-edit mark; a person on the matter can leave a note on a finding, report an issue the review missed, and rate the matter once a memo is exported. Tested; no attorney has used any of it                                                 |
| The pilot measures and their CSV                              | **Built** (see Measures). The pilot scope is empty on every database this build can make, so the page has no pilot figure to show                                                                                                                                                                             |
| Training exercise, quickstart and help                        | **Built** (T01, the quickstart page, the help page, progress derived from stored events). Exercised with the simulated reader only, by a script and not by a person                                                                                                                                           |
| Deleting matters when their date passes                       | **Built as a command**, `pnpm parol:retain` (a dry run unless `--apply` is given). Nothing runs it by itself, and there is no legal hold (document 6)                                                                                                                                                         |
| Real participants, identities and documents                   | **Not available.** The identities are four demo users without passwords, and nothing here has had a security review                                                                                                                                                                                           |

## Attorney acceptance criteria

Proposed with the reviewing attorneys before the pilot starts, and not changed during it.

| #   | Criterion                                                                                                   | Measured by                                      | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | No exported memo contains a quotation that is not in the document                                           | Export-time re-verification; spot check          | Re-verification at export is built and tested (a quote that no longer matches stops the export). The spot check is a human step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| A2  | In shadow mode, every high-severity issue on the reviewers' reference list is flagged or escalated by Parol | Slot comparison with phase 0 lists               | The entry and the comparison are built: the reviewing attorney saves a reference list on the matter before any review, and the pilot page shows, by severity, how many of its issues the latest finished review flagged (a `deviation` or `missing` status for the rule, or an escalation by the system). The High row is the one this criterion reads. The page does not judge it, and no reference list has been written by an attorney                                                                                                                                                                                                                                                                                                                  |
| A3  | At least 80 percent of findings are accepted, or edited with what the reviewer marks as a minor edit        | Decisions and edit size                          | The minor-edit mark exists (an edit carries it, and a change of status is never minor) and the pilot page shows "Accepted or minor edit" as a count of decided findings. The page does not judge the 80 percent, and no attorney has decided a finding in a pilot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A4  | A reviewer can check any finding's evidence without leaving the page                                        | Observation during training                      | The review page opens each finding's passages, highlighted, in an inspector beside the issue table; the observation has not been done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| A5  | Median answer of at least 4 of 5 to "I would use this for my next NDA"                                      | Post-matter rating                               | The rating exists (1 to 5, "I would use this for my next NDA", with an optional comment, given once a memo is exported) and the pilot page shows the median with the number of ratings, the minimum and the maximum. The page does not judge the 4, and nobody has rated a matter outside the demonstration                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A6  | Median active time per NDA (associate plus attorney) is no worse than the phase 0 median                    | Timers, both phases                              | Timers and phase medians exist (associate, attorney and combined, with the number of NDAs, the minimum and the maximum). "No worse than the phase 0 median" is deliberately not computed: the page shows no difference between phases, because documents differ between phases and the group is small. Nobody has been timed in a pilot                                                                                                                                                                                                                                                                                                                                                                                                                    |
| A7  | No unauthorized access event and no instruction-driven change in output                                     | Audit log, evaluation suite on the pilot version | The audit log records changes only, not reads and not refusals, by decision (document 6). A refusal is a 403 or 404 line in the access log, which names the user and the route and not the matter, goes to standard output and is not stored. Evidence for "no unauthorized access" is the probe matrix and the exposure suite, which test the guard; it is not a count of refusals, because a refusal is the control working. The evaluation suite has been run only against a scripted oracle and a simulated reader, and its exposure suite (`--exposure`) tests the application with a scripted stand-in for the model. Neither has met a real model or a real pilot, so no real model has been observed with either access or an embedded instruction |

## Training exercise (20 minutes)

Uses the training matter T01: the documents of evaluation case `PAROL-D05`, with the instruction
paragraph from `PAROL-D08` added to the NDA and one planted finding. T01 is never used in evaluation.
The trainer has the answer key; the trainee does not.

**How T01 is made.** Its two files are `apps/parol/training/t01-nda.docx` and
`apps/parol/training/t01-amendment-1.txt`, built from `PAROL-D05` and `PAROL-D08` by `pnpm
fixtures:parol:training` (`--check` says whether they are up to date); the amendment is the one of
`PAROL-D05`. A trainee makes the matter with the button on the quickstart page, where a trainer can be named (it is
optional), or `pnpm parol:seed --training` makes it for the demo associate and names the legal
engineer as trainer. A trainer is added to the matter as a viewer: they can read it, add notes, report a missed issue and rate the matter, and cannot decide a
finding, start or change a review, export the memo or change the matter. A person has at most one
training matter. The matter page shows the warning on the NDA (the instruction paragraph) and a
"Training progress" table.

**The planted finding is the simulated reader's script.** It is not a seeded row: the store accepts
a finding only from the stages, and a seeded one would vanish at step 6. For T01 and nothing else
(the reader checks that every paragraph shown is a paragraph of the worked example or the instruction
paragraph, that the instruction paragraph is among them, and that the first document's title carries
"(training T01)") the script answers rule `pds-1` as `Compliant` and cites Section 1.2, the definition
of Confidential Information: a quote that is in the document and says nothing about disclosure to
representatives. It goes through the real analyze and verify stages and the same quote check as any
finding, so it passes every automatic check, and the page reads Support not checked. It says
nothing about how well any model reads an NDA. With a provider key the finding does not appear and
step 4 cannot be done, and nothing stops a trainee from starting a review of T01 on a live provider;
the quickstart and the seed say so in words (known gap 35 of
[document 7](07-delivery-plan.md#known-gaps)). The reader still declines any other document,
including T01 with one word changed, so step 6 changes a stated date and does not upload a corrected
amendment. That the planted finding comes from the script, and that step 6 does so, are decisions of
the build that the project owner can overturn (document 7, [decisions of part
3](07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn), number 9).

**The trainer's key** is `GET /training/key`: the table below, in the same words (a test keeps the page
and this table in step), and notes for the trainer. It is shown to the legal engineer and the
administrator, and anyone else gets 403. That is a courtesy to trainees and not a control: the
demonstration sign-in has no passwords, and the same answers are in this document and in the source.

**T01 is never used in evaluation**, and four things hold it: it is not in the dataset or either
split (it lives in `apps/parol/training`, not `fixtures/parol`); two triggers of migration 007 refuse
an evaluation run and an evaluation result on a training matter; the reader plants the finding only
for it; and a test covers each.

**The 20 minutes are the plan's figure.** Nobody has done the exercise or timed it. A script has
walked it (`apps/parol/test/training/walkthrough.test.ts`), which shows that the steps work and not
that a person can follow them. The last column of the table says what each step supports today.
Steps 3 and 7 say to use workflow v2: choose it in the "Workflow version" picker of the matter page.
The "Re-run review" button inside the "Results are out of date" banner sends no workflow and so uses
the default version, v1 (known gap 36 of [document 7](07-delivery-plan.md#known-gaps)).

| Step | Task                                                                                                                                                                                                           | What it teaches                                  | Answer key                                                                                                                                                              | Today                                                                                                                                                                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Open the training matter and check its intake: the NDA and the amendment with their stated dates, which version of each is operative, the playbook version, and the line that says where document text is sent | Intake, operative versions, the destination line | NDA operative; playbook 1.0.1 (the design said 1.0.0)                                                                                                                   | **Supported.** T01 is made for you, by `pnpm parol:seed --training` or by the button on the quickstart page. The matter page shows the NDA and the amendment with their stated dates, which version of each is operative, the playbook version (1.0.1) and the line that says where document text is sent                                                                                   |
| 2    | Read the warning on the NDA. What will Parol do with that paragraph?                                                                                                                                           | Documents are data                               | Parol gives it to the model as document text and cannot show that a model ignored it; the warning tells the reader to read it, and a finding that cites it is escalated | **Supported.** The NDA of T01 carries the instruction paragraph of `PAROL-D08`, so the matter page shows the warning for it. The trainer checks the answer; Parol does not record it. The simulated reader reads T01, so what a review of it does with the paragraph says nothing about what a model would do                                                                               |
| 3    | Start a review with workflow version v2, then open DUR-1. Which passage governs, and why is the Section 6.1 quote marked superseded?                                                                           | Evidence roles, amendments                       | Amendment Section 2 deletes 6.1                                                                                                                                         | **Supported under workflow v2 only.** The picker on the matter page starts on v1, under which DUR-1 reads `Compliant`; the trainee has to run the review under v2, and then the inspector shows the amendment as governing and Section 6.1 struck through as superseded                                                                                                                     |
| 4    | One finding in the review was planted by the training script: its quote is in the document but does not support it. Find it and reject it with a reason and a reason code                                      | Quote validity is not support                    | The planted `pds-1` finding quotes the definition clause, which says nothing about representatives                                                                      | **Supported, with a limit.** In every review of T01 under v1 and under v2 the simulated reader's script gives `pds-1` the status `Compliant` and cites Section 1.2, so the quote is verified, no flag is raised and the page reads Support not checked. The planted finding is a property of that script, not of a model                                                                    |
| 5    | Escalate a finding you would send to a partner, with a reason                                                                                                                                                  | Escalation is a decision                         | Any reasoned choice; DUR-1 is the natural one, because the amendment reverses an agreed term                                                                            | **Supported.** Signed in as the reviewing attorney, the decision form has Escalate and requires a reason                                                                                                                                                                                                                                                                                    |
| 6    | The partner says the amendment took effect on 1 October 2026. Change its stated date to 2026-10-01 and save it. What happened to your decisions?                                                               | Invalidation                                     | All stale; export blocked until re-run and re-decided                                                                                                                   | **Supported by changing the stated date.** A changed stated date makes every finding and decision stale and blocks export, as a changed version does. An uploaded changed amendment would make the simulated reader decline, so the next review would be all `undetermined`; the exercise uses the date for that reason                                                                     |
| 7    | Run the review again with v2, decide all eight findings again (reject the planted one with a reason and a reason code), export the memo, and find your rejected finding in it                                  | Export gate, memo structure                      | It is in the rejected appendix                                                                                                                                          | **Supported.** A re-run of T01 under v2 gives eight findings, the planted one among them and with no decision on it; the decisions of steps 4 and 5 do not carry over. Deciding all eight and exporting work as for any matter, a rejected finding is in the memo's appendix, and export is refused while any finding is undecided. The memo states that the reader was a scripted stand-in |

Completion is read from what Parol stored, per step: steps 3 to 7 are shown as done from reviews,
runs, memos and the audit log, with the denominator 5 ("Parol can check 5 of the 7 steps"); step 1 is
set up for the trainee; step 2 and the answer to step 3 are checked by the trainer, and Parol does not
record them. Nothing is timed and the table is not a score. Trainees who miss steps 3 or 4 repeat them
with the trainer.

## Quickstart

The quickstart page exists: `GET /quickstart`, open to everyone whether signed in or not, with the
ten steps below, the training exercise above with a button that makes the training matter T01, and a
link to the help page (`GET /help`), which explains the words the review pages use. These are the
commands in `apps/parol/README.md` to run the demonstration (Node 22 and pnpm 10, from the Clausewise
folder). The seed (with `--run v1 --run v2 --training`) and the server were run on 11 November 2026 while
this status was written, with the data folder set to a scratch folder and the server answering
`/healthz`; `pnpm install` was not run:

```sh
pnpm install
PAROL_DEMO_IDENTITY=1 pnpm parol:seed
PAROL_DEMO_IDENTITY=1 pnpm parol:seed --training
PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol
```

Then open `http://127.0.0.1:8787` and choose an identity. `PAROL_SCRIPTED=1` makes the simulated
reader read the documents, so nothing is sent anywhere. Without it the server needs a provider key
and sends the text of every document to that provider, which is not for anything but synthetic
documents. Add `--run v1 --run v2` to the seed to have both reviews of the first matter made for
you. `--training` makes the training matter, and the exercise needs `PAROL_SCRIPTED=1`: with a provider
key the planted finding does not appear.

The ten steps below are the quickstart page's, word for word (a test, `doc-agree.test.ts`, fails when
the page and this list differ). The note after them says which exist.

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

**What exists of these steps today.** All ten exist, and the quickstart page marks none as "Not built
yet". Steps 2 to 6, 8 and 9 are the matters page (a form for the matter name, the client's name, the
reviewing attorney, the playbook and how many days to keep the matter), the matter page (the documents
and stated dates, the operative version, the start button and the line about where text is sent), the
issue table and the evidence inspector on the review page, and the decision form and the memo export.
Step 7 is the "Notes on this finding" section of the finding page, with its "Add note" button; a note
is free text for the reviewer, is not part of the decision, and is not printed in the memo. Step 8
asks for a reason on an edit, a rejection and an escalation, and for a reason code on an edit and a
rejection. Step 10 is "Save rating" on the memos page, available once a memo is exported, and "Report
missed issue" on the review page. Step 1 is the demo identity picker, not a pilot identity, and its
banner is the one on every page. The headings and wording of the pages are the application's, and the
steps above are a paraphrase.

## Feedback collection

| Channel                       | When                          | What                                                                            | Today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reason code on edit or reject | Every such decision           | wrong status, wrong evidence, missed context, bad fallback, unclear, other      | **Built.** The decision form has a "Reason code" select with these six codes (`wrong_status`, `wrong_evidence`, `missed_context`, `bad_fallback`, `unclear`, `other`); an edit and a reject need one, an accept and an escalate must not carry one. A decision made before reason codes existed carries none, and the pilot page counts it in a row "Not recorded (decided before reason codes were recorded)" when there is one. The wording of the six codes was written by the project and has not been agreed with attorneys (gap 37) |
| Report a missed issue         | Any time on a matter          | Rule (or "not covered"), location, note. The main source for recall in real use | **Built.** A "Report a missed issue" form on the review page (a rule of the review's playbook or "Not covered by any rule", a place, a note) and a JSON twin, for any member of the matter. A report stays with the review it was made on and is not carried to a new one; one person may write at most 50 on a review. It changes no finding and no decision                                                                                                                                                                             |
| Post-matter rating            | At export                     | "I would use this for my next NDA", 1 to 5, optional comment                    | **Built.** "Save rating" on the memos page, once a memo is exported: 1 to 5 and an optional comment, one rating for each person and matter, stored against the newest memo's review, and final. Each person reads only their own                                                                                                                                                                                                                                                                                                          |
| Note on a finding             | Any time on a finding         | Free text for the reviewer, for example where the associate disagrees           | **Built** (not in the plan's table; a decision of the build that the owner can cut, number 8 of the [decisions of part 3](07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn)). Not part of the decision, not printed in the memo, feeds no measure and is kept out of the CSV; at most 20 on a finding by one person                                                                                                                                                                                            |
| Weekly pulse                  | Fridays, three questions      | Trust in findings, time spent checking, the worst moment of the week            | A process, not software; nothing to build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Interviews                    | Mid-pilot and end, 20 minutes | What they stopped checking, what they never trust, what they would change       | A process, not software                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Office hours                  | Twice a week, 30 minutes      | Questions; observed use                                                         | A process, not software                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The legal engineer triages feedback weekly into failure records using the taxonomy in
[document 5](05-evaluation.md#root-cause-taxonomy). A change prompted by feedback is made as a new
workflow or playbook version and goes through the gates; the pilot's pinned version does not change
mid-week.

## Measures

Computed from stored events by the pilot measures page (`GET /pilot`, for the legal engineer and the
administrator) and downloaded as a CSV (`GET /pilot/measures.csv`: the same rows as codes and
numbers, one scope per file, with the scope on every row). The page has two scopes. The **pilot
scope** holds matters not marked synthetic whose creator is not a demonstration identity (and, if a
review was started on the matter, whose first review was not started by one), and people who are not
demonstration identities. The **synthetic scope**, `?scope=synthetic`, is everything else. Training
matters (T01) are in neither scope: a matter that carries a training key is left out with
`matters.training_key IS NULL`, so a trainee's exercise is never counted as use.

| Measure                | Definition                                                                    | Denominator                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Completion             | Matters exported                                                              | Matters with a run started                                                   |
| Repeat usage           | Participants who started matters in at least two different pilot weeks        | Participants trained                                                         |
| Correction rate        | Decisions that are edit or reject, overall and by reason code                 | Decided findings                                                             |
| Accepted or minor edit | Decisions that are accept, or an edit marked as a minor edit                  | Decided findings                                                             |
| Missed-issue rate      | Missed-issue reports, overall and per rule                                    | Exported matters (a count of reports per matter, not a share)                |
| Escalation rate        | Findings escalated by the system, and by reviewers, separately                | Findings of finished reviews (the reviewers' row also over decided findings) |
| Satisfaction           | Median and distribution of the post-matter rating                             | Ratings given, and ratings given out of the ratings that could be given      |
| Active time            | Median active minutes per NDA, associate and attorney separately and combined | Timed NDAs, per phase                                                        |
| Shadow-mode agreement  | Reference-list issues that Parol flagged or escalated, by severity            | Reference-list issues on matters that have a finished review                 |

"Accepted or minor edit" is not in the plan's table: it is the number that criterion A3 reads, and
the page adds it beside the correction rate. Every row states its numerator and its denominator in
words and numbers, and a row with nothing to count reads "No data" with one of three fixed reasons
(no pilot calendar can be counted from, every matter belongs to the other scope, or nothing meets the
definition), never 0 percent of nothing. The page also shows the measures by pilot phase, the
correction rate by reason code, missed issues by rule, the distribution of the rating, shadow-mode
agreement by severity, and the active-time medians with the number of NDAs, the minimum and the
maximum, and a population table that gives a count for every exclusion. It judges none of the
acceptance criteria A1 to A7 and recommends neither go nor no-go.

**Built, and with no pilot result.** The pilot scope is empty on every database this build can make:
`users.demo` is checked to 1 in the schema, so every person is a demonstration identity, and a
matter made by one is not in the pilot scope (known gap 30 of
[document 7](07-delivery-plan.md#known-gaps)). Every measure of the pilot scope therefore reads "No
data". The computation for that scope is tested with a hand-written fixture
(`apps/parol/test/pilot/f1.ts`) that holds people the database cannot, and the synthetic scope is
tested with matters made through the services; neither is a pilot. What the synthetic scope shows
after `pnpm parol:seed --pilot-demo` comes from demonstration identities and the scripted reader,
under a banner that says it is not pilot data, adoption, accuracy or time saved. The sentence on the
page that says the pilot scope is empty because this build has demonstration identities only becomes
false on the day identity is real.

**How the page reads the terms of the table.** Weeks are counted in UTC from the pilot's start date,
which an administrator or the legal engineer sets on the page (`pilot.manage`; every date that was set
is kept): week 1 is the baseline, week 2 training and shadow mode, weeks 3 to 5 assisted use. A
matter's week is the week its first review started and a timer's week is the week it started, and
a record outside the five weeks, or any record while no start date is set, is counted in no measure
and shown in the population table. "Started a matter" means that a review was started on it,
whatever became of the review; "exported" means that a memo was ever exported for it. A decision
counts while it counts for the memo, so one replaced by a later decision of the same reviewer, or made
out of date by a new review or a change to a document, the client name or the playbook, is not
counted. A rating counts once for each associate or reviewing attorney of an exported matter (the
latest); a viewer's rating is not counted. A matter deleted by its creator, an administrator or
retention has no rows and is in no denominator; the population table counts such matters from the
audit log. A timer is the seconds between pressing Start and pressing Stop on the server's clock
(not measured attention; a timer left running is not counted, and a stopped timer cannot be edited),
and a matter's time in a phase is the sum of one role's closed timers that started in that phase. Shadow-mode
agreement counts a reference-list issue as agreed when the latest finished review of the matter
gave its rule a `deviation` or `missing` status or escalated it by the system; an issue that no rule
covers counts as not agreed. No figure is given for a person.

**Which participants were trained.** Repeat usage uses the roster that the trainer records on the
pilot page ("People who were trained", saved with `pilot.manage`), because whether a person has done
the exercise cannot be worked out reliably: steps 1 and 2 of the exercise are not recorded. The roster
is the definition. A hint is shown beside each name when the person made a training matter and Parol
can see steps 3 to 7 done on it ("completed steps 3 to 7 of the training matter"), and it is the input
to no measure. While no start date is set, repeat usage has no denominator, although the size of the
roster is still shown.

**Retention against the length of the pilot.** The retention command deletes a matter once its date
has passed, and a deleted matter leaves every measure computed from stored events: its timers, its
reference list, its decisions, reports and ratings go with it, and it is in no denominator. The default
is 30 days and the pilot is five weeks, so a matter made in week 1 can be deleted before week 5. The
decision taken, which the project owner can overturn (document 7, [decisions of part
3](07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn), number 5, and gap 31), is
to keep 30 as the default: the new-matter form and the matter page take 1 to 90 days, so the pilot
operator can choose longer dates; the pilot page counts the in-scope matters whose date falls before
the end of week 5 and tells the reader to download the CSV before then; and the CSV, downloaded every
week, is the record. The retention rules themselves are in
[document 6](06-access-and-governance.md#retention-and-deletion), and the 90-day ceiling is a
placeholder for the unanswered question 17 of [document 1](01-product-brief.md#discovery-questions). No
pilot has run, so no measure has yet lost a matter.

**What a seeded matter is.** Seeded matters, the demonstration scenario and training matters are
excluded from the pilot scope by their flags (synthetic, a demonstration creator, a training key). The
two scopes partition the matters that are not training matters, so none is counted twice (a test
checks it), and the exclusion of a training matter is by the key and not by who made it.

**Free text.** A note, a missed-issue report, its place and the comment of a rating are typed by a
person, may hold pasted document text, are not checked against the documents, feed no measure and are
not in the CSV (gap 37). Reports are counted; their words are not read by the page.

**Time claims.** A difference in time is reported only as medians from phase 0 and phase 2 with
their sample sizes, attorney review time included, and with the caveat that documents differ
between phases. With four associates the result is indicative at best. Annualised savings are not
computed from a pilot this size. The page computes medians only, each with the number of NDAs, the
minimum and the maximum, and no mean, no difference between phases and no saving; any difference is
for a person to compute from the medians and to caveat.

## Go/no-go recommendation (template for the sponsor)

**Status: a template only.** Nothing generates it, and the pilot measures page does not recommend. The
figures it asks for would come from that page and its CSV with their denominators, and no pilot has
produced any.

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

Rollback never deletes matter data early; retention follows the normal schedule. That schedule is
the operator's command (`pnpm parol:retain`), which nothing runs by itself, and there is no legal hold,
so a rollback should extend the date of matters under investigation (an associate does it on the
matter page) before the command runs. The rollback switch of step 1 is not built (see "What the
software supports today"), so the steps above are a plan.
