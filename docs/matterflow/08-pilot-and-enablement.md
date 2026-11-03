# 8. Pilot and enablement

**This is a hypothetical pilot plan.** No pilot has run. The demo seeds activity so the screens
have something to show; seeded events are flagged synthetic, and the pilot measures exclude them.
Nothing seeded, simulated or produced by the author's own testing may be described as adoption,
usage or time saved.

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
associate reviews the same four NDAs again with MatterFlow. The issue lists are compared slot by
slot with the phase 0 lists. Shadow mode measures what MatterFlow misses, not what it saves, because
the associate has seen the documents before.

**Phase 2, assisted use (weeks 3 to 5).** New NDAs go through MatterFlow with attorney review. Time,
decisions, corrections, missed-issue reports and ratings are recorded.

## Attorney acceptance criteria

Proposed with the reviewing attorneys before the pilot starts, and not changed during it.

| #   | Criterion                                                                                                        | Measured by                                      |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A1  | No exported memo contains a quotation that is not in the document                                                | Export-time re-verification; spot check          |
| A2  | In shadow mode, every high-severity issue on the reviewers' reference list is flagged or escalated by MatterFlow | Slot comparison with phase 0 lists               |
| A3  | At least 80 percent of findings are accepted, or edited with what the reviewer marks as a minor edit             | Decisions and edit size                          |
| A4  | A reviewer can check any finding's evidence without leaving the page                                             | Observation during training                      |
| A5  | Median answer of at least 4 of 5 to "I would use this for my next NDA"                                           | Post-matter rating                               |
| A6  | Median active time per NDA (associate plus attorney) is no worse than the phase 0 median                         | Timers, both phases                              |
| A7  | No unauthorized access event and no instruction-driven change in output                                          | Audit log, evaluation suite on the pilot version |

## Training exercise (20 minutes)

Uses the seeded training matter T01: the documents of evaluation case `MF-D05`, with the instruction
paragraph from `MF-D08` added to the NDA and one planted finding. T01 is never used in evaluation.
The trainer has the answer key; the trainee does not.

| Step | Task                                                                                                                                                   | What it teaches                                  | Answer key                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1    | Create the matter, upload the NDA and the amendment, pick the playbook version                                                                         | Intake, operative versions, the destination line | NDA operative; playbook 1.0.0                                                                      |
| 2    | Read the warning on the NDA. What will MatterFlow do with that paragraph?                                                                              | Documents are data                               | Nothing: it is reviewed as text; the warning only draws attention                                  |
| 3    | Open DUR-1. Which passage governs, and why is the Section 6.1 quote marked superseded?                                                                 | Evidence roles, amendments                       | Amendment Section 2 deletes 6.1                                                                    |
| 4    | The trainer has planted a finding (seeded in the training matter only) whose quote exists but does not support it. Find it and reject it with a reason | Quote validity is not support                    | The planted `pds-1` finding quotes the definition clause, which says nothing about representatives |
| 5    | Escalate a finding you would send to a partner, with a reason                                                                                          | Escalation is a decision                         | Any reasoned choice; DUR-1 is the natural one, because the amendment reverses an agreed term       |
| 6    | Upload a corrected amendment. What happened to your decisions?                                                                                         | Invalidation                                     | All stale; export blocked until re-run and re-decided                                              |
| 7    | Re-run, decide, export the memo, and find your rejected finding in it                                                                                  | Export gate, memo structure                      | It is in the rejected appendix                                                                     |

Completion is recorded per step; trainees who miss steps 3 or 4 repeat them with the trainer.

## Quickstart

1. Sign in with your pilot identity. The banner tells you which environment you are in.
2. **New matter**: name it, type your client's exact legal name, add your reviewing attorney.
3. **Add documents**: the NDA, and any amendment with its date. Mark which NDA version is operative.
   Read any warnings.
4. **Choose the playbook version.** Only approved versions are listed.
5. **Start review.** The line above the button says where the text is sent.
6. **Read the issue table.** Each row has a status, a severity and, if the system could not stand
   behind it, an escalation reason. Click a row to see the passages it relies on, highlighted in the
   document.
7. **Leave notes** for your reviewer on anything you disagree with.
8. **Reviewer:** accept, edit, reject or escalate every finding. Edits and rejections need a reason.
9. **Export the memo.** It contains only reviewed findings, open items first.
10. **Rate the matter** and use **Report a missed issue** for anything MatterFlow did not catch.

What MatterFlow will not do: decide anything, send anything to the other side, or review PDFs,
footnotes, headers or pictures. When documents change, earlier decisions stop counting.

## Feedback collection

| Channel                       | When                          | What                                                                            |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| Reason code on edit or reject | Every such decision           | wrong status, wrong evidence, missed context, bad fallback, unclear, other      |
| Report a missed issue         | Any time on a matter          | Rule (or "not covered"), location, note. The main source for recall in real use |
| Post-matter rating            | At export                     | "I would use this for my next NDA", 1 to 5, optional comment                    |
| Weekly pulse                  | Fridays, three questions      | Trust in findings, time spent checking, the worst moment of the week            |
| Interviews                    | Mid-pilot and end, 20 minutes | What they stopped checking, what they never trust, what they would change       |
| Office hours                  | Twice a week, 30 minutes      | Questions; observed use                                                         |

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
| Shadow-mode agreement | Reference-list issues that MatterFlow flagged or escalated, by severity       | Reference-list issues                        |

**Time claims.** A difference in time is reported only as medians from phase 0 and phase 2 with
their sample sizes, attorney review time included, and with the caveat that documents differ
between phases. With four associates the result is indicative at best. Annualised savings are not
computed from a pilot this size.

## Go/no-go recommendation (template for the sponsor)

```markdown
# MatterFlow NDA pilot: recommendation

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
