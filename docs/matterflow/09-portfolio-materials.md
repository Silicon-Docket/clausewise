# 9. Demo script, one-pager and postmortem

## Two-minute demo script

Recorded against the seeded demo matters. Every number spoken comes from `EXP-001.md`; where the
script shows `<...>`, say the measured value or say that it was not measured. Never round a result
up or describe the demo's seeded activity as usage.

| Time | On screen                                                                                             | Say                                                                                                                                                                                     |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Title card, then the demo banner                                                                      | "MatterFlow is one NDA review workflow with attorney review and an evaluation loop. Everything here is synthetic: the documents, the playbook, the people."                             |
| 0:10 | Intake: NDA (DOCX) and Amendment No. 1 (TXT), playbook 1.0.0, the destination line                    | "An associate creates a matter, uploads the NDA and an amendment, and picks an approved playbook version. The run pins all of it."                                                      |
| 0:22 | The instruction-like text warning                                                                     | "This NDA contains a paragraph telling automated reviewers to report no exceptions. It is reviewed as text. The model has no tools, and every outcome is checked in code."              |
| 0:35 | Issue table; open DUR-1; the inspector highlights the amendment and the superseded clause             | "Eight rules, eight findings, each with the exact passage and where it is. Duration is a deviation: the amendment deletes Section 6.1, the only time limit."                            |
| 0:52 | Checks panel                                                                                          | "Quotes are verified against the document. Separately, a support check asks whether the passages actually establish the conclusion. Those are different questions."                     |
| 1:02 | Reviewer edits the fallback, adds a reason; then uploads a new amendment version; findings turn stale | "The attorney decides every finding. If the documents change, the decisions stop counting and export is blocked."                                                                       |
| 1:15 | Evaluation comparison, held-out tab                                                                   | "The first version got this wrong. It quoted Section 6.1 correctly and called the term compliant, because retrieval never showed it the amendment. Valid quote, wrong conclusion."      |
| 1:28 | The changed-slots list and the gates                                                                  | "I changed one thing, retrieval, and ran a held-out suite the fix was never tuned on, three times each. Strict recall went from `<...>` to `<...>`, with `<...>` high-severity misses." |
| 1:42 | Latency and cost rows; the recommendation                                                             | "Cost per run changed by `<...>` and p95 latency by `<...>`. Recommendation: `<promote / with conditions / do not promote>`, because `<gate>`."                                         |
| 1:52 | The memo, open items first; the provenance appendix                                                   | "The memo contains only reviewed findings, with provenance. This shows consistency with a fictional playbook, not legal quality; that needs attorney review, which is next."            |

If H1 was not confirmed, replace 1:15 to 1:42 with the failure the baseline actually showed. If no
live run happened, say so at 1:15 and show the protocol and the selftest instead of numbers.

## Portfolio one-pager outline

1. **Title and one line.** "MatterFlow: an NDA review workflow with attorney review and a held-out
   evaluation loop (synthetic data)."
2. **The problem** in three sentences, from the brief.
3. **What I built.** The seven-stage workflow in one diagram; the issue table and evidence
   inspector in one screenshot.
4. **The distinctive part.** The improvement cycle: the baseline failure (one sentence and the
   evidence screenshot), the single change, the held-out comparison table with measured numbers,
   the recommendation and why.
5. **How I measured.** 26 synthetic cases (14 dev, 12 held-out), metrics with denominators, gates,
   k = 3, everything pinned. One line on what synthetic answer keys can and cannot show.
6. **Controls.** Server-side matter authorization before retrieval, generation and export; documents
   treated as data; decisions invalidated when inputs change; minimal logging.
7. **Configure versus build.** Three lines from the table in document 1: what an approved legal AI
   product would likely do, and what remains the legal engineer's own work.
8. **Role fit.** Two or three lines each for the Cravath and Holland & Knight roles, tied to
   features, with the gaps stated (no enterprise platform administration, no practice experience).
9. **Limits and next steps.** No qualified review yet (or its results), synthetic only, DOCX and
   TXT only, single machine, demo identity.
10. **Links.** Repository, the design documents, `EXP-001.md`, the two-minute recording.

Rule for the page: every number links to the results file it came from, and every claim says
whether it rests on the answer keys or on qualified review.

## Postmortem template

Blameless and specific. Written at the end of week two, whatever happened.

```markdown
# MatterFlow postmortem

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

| Item | Estimate (h) | Actual (h) | Note |
| ---- | -----------: | ---------: | ---- |
| W1.1 |            3 |            |      |
| ...  |              |            |      |

## Scope cuts taken

<Which cuts from document 7, and what each one means for the claims.>

## Claims I can make, and claims I cannot

- Can: <for example, "consistent with the demo playbook on 12 held-out cases, k = 3, with these counts">
- Cannot: <for example, professional legal quality; time saved; performance on real documents>

## What I would do next

<Ordered, with the reason for the order.>
```
