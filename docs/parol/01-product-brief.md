# 1. Product brief and role mapping

**Implementation status.** The product described in the brief is built as `apps/parol` for steps 1
to 6 of the list below, and runs on a laptop against a scripted simulated reader that is not a
language model. Deferred and marked **Not yet built**: feedback capture (part of step 7), the screens
for the legal engineer and the practice manager, the pilot metrics and the go/no-go memo (a template
in [document 8](08-pilot-and-enablement.md)). The discovery questions have not been asked of anyone.
The improvement cycle has **never run live**: no real model has been called, so no claim about a
model's accuracy, latency or cost exists. The Evidence column of the role mapping now names files
that exist; where a feature is a plan, the Parol feature cell says so.

## The brief

**Problem.** An associate who receives an incoming NDA compares it, clause by clause, with the
practice group's playbook, writes up the exceptions, proposes fallback language, gets a supervising
attorney's sign-off and sends a short memorandum. The work is repetitive but not trivial: the
playbook changes, amendments quietly override the base agreement, defined terms move meaning
between sections, and a missed perpetual confidentiality term is an expensive mistake. Generic AI
assistance is assumed to make the first draft faster (not measured here) but adds two new risks: a finding that quotes the document
correctly yet does not follow from the quote, and no way to tell whether a prompt change made the
tool better or worse.

**Product.** Parol (the name borrows loosely from the parol evidence rule: the review relies only on the written documents) is one
bounded, attorney-supervised workflow for that task:

1. Create a matter and supply an NDA, an optional amendment and an approved playbook version.
2. Extract the relevant clauses with stable document and paragraph references.
3. Compare them with the selected playbook version.
4. Produce an issue table: category, exact supporting passage and location, playbook rule,
   discrepancy and explanation, suggested fallback language, review status or escalation reason.
5. Let an attorney inspect the evidence and accept, edit, reject or escalate each finding.
6. Export a DOCX review memorandum built only from reviewed results.
7. Capture feedback and compare workflow versions before anything is released to a pilot.

**Status of the list.** Steps 1 to 6 are built. In step 7, comparing workflow versions is built as a
command (`pnpm eval:parol`, over the 26 synthetic cases, 14 development and 12 held-out, none of
which has been run on a model) and **feedback capture is not built**: a decision stores its kind, a free-text reason and the fields an edit changed, but
there is no reason code, no rating and no report of a missed issue.

**What makes it worth showing.** A controlled improvement cycle: run a baseline on synthetic
documents, find a meaningful failure, trace it to its cause, change one thing (a prompt, the
retrieval step or a playbook rule), run a held-out regression suite with every version pinned, and
recommend whether to promote the change, weighing quality, latency and cost. The design separates
quotation validity (the words exist where cited) from substantive support (the conclusion follows
from them), and it escalates with a named reason instead of inventing a confidence score.

**Status.** The machinery is built (pinned runs, a pin-checking comparison, gates, a held-out seal,
and record and replay of a live run's answers), and so is the dataset: 26 synthetic cases with
answer keys, the held-out half sealed by a committed hash, and 40 pairs for measuring the support
check. But **the cycle has not been carried out**: no live model has been called, so there is no
baseline, no failure record and no promotion record. Quotation validity is checked in code and
built. The check of substantive support is built and **off** in the two workflow versions the
application ships (v1 and v2), so findings say "not checked"; a third version, v3, turns it on
together with the supersession check, for the evaluation only, and nothing has yet measured how well
the checker does. Escalation with a named reason is built.

**Users.**

| User                         | Goal                                                   | What they touch                         |
| ---------------------------- | ------------------------------------------------------ | --------------------------------------- |
| Associate (preparer)         | A defensible first pass, quickly                       | Intake, issue table, evidence, memo     |
| Reviewing attorney (decider) | Decide each finding with the evidence in front of them | Evidence inspector, decisions, export   |
| Legal engineer (owner)       | Keep the workflow accurate and improve it safely       | Playbook versions, prompts, evaluations |
| Practice manager (sponsor)   | Decide whether to pilot, expand or roll back           | Pilot metrics, go/no-go memo            |

**Status of the roles.** The application has matter roles (associate, reviewer, viewer) and four
seeded demo people: Alex Ruiz (associate), Dana Whitfield (reviewing attorney), Lee Okafor (legal
engineer) and Sam Patel (admin). The legal engineer has no screens: playbook versions, prompts and
workflow versions are registered from code and a YAML file at start-up, and evaluations run from the
command line. The practice manager has no screens either; the pilot metrics are **Not yet built**
and the go/no-go memo exists as a template only.

**In scope.** Supplied DOCX and TXT files; one NDA plus up to two amendments per matter; seven
playbook categories (parties, definition of confidential information, exclusions, permitted
disclosures, confidentiality duration, return or destruction, governing law); one practice group;
local single-machine deployment; synthetic data. All of it is built as stated: the matter refuses a
third amendment, the seeded playbook has eight rules in the seven categories, and the server listens
on this machine only while the demo identity is on.

**Deferred.** PDF and OCR, a Word add-in, document management integrations, email intake,
counterparty redlines sent from the tool, multi-practice expansion, single sign-on, multi-level
approval, and any real client document. All of it is still deferred; nothing in this list has been
started.

**Non-goals.** Parol does not give legal advice, does not decide anything, does not send
anything to a counterparty, and does not claim that its playbook reflects applicable law.

**Portfolio success criteria** (for the project, not for adoption):

- The workflow runs end to end on the synthetic cases, from intake to exported memo. **Status:**
  met for the worked example only, and with the scripted simulated reader (document 7 names the
  tests).
- The improvement cycle is carried out on real model runs and its numbers are reported as measured,
  including a result that does not favour the revision if that is what happens. **Status: not met.**
  No live run has happened.
- Every claim in the write-up is bounded by what the evidence supports: consistency with a
  fictional playbook, not professional legal quality, until a qualified review is done. **Status:**
  kept so far: every output of a selftest or a simulated reader is labelled as such, and no score of
  any model exists to be overclaimed.

## Before and after

The "before" process is a hypothesis to validate in discovery, not an observation.

| Step | Before (assumed)                                                                | After (Parol)                                                                        | Stays human                      |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| 1    | NDA arrives by email; associate saves it somewhere                              | Associate creates a matter, uploads the NDA and any amendment                        | Choosing what goes in the matter |
| 2    | Associate finds the playbook, hopefully the current version                     | Associate picks an approved playbook version; the run pins it                        | Which playbook applies           |
| 3    | Reads the NDA and amendment separately, notes issues in a checklist or comments | Extract, compare and verify produce an issue table with exact passages and locations |                                  |
| 4    | Drafts fallback wording from memory or precedent                                | Each issue carries the playbook's approved fallback, adapted to the document's terms | Whether the wording is right     |
| 5    | Sends to supervising attorney, who rereads the NDA to check                     | Attorney opens each finding's evidence in place and decides; the system records why  | Every decision                   |
| 6    | Writes a memo by hand                                                           | Memo is generated from reviewed findings only, with provenance                       | Editing and sending the memo     |
| 7    | No record of what was wrong with the first pass                                 | Corrections and feedback are stored and feed the next evaluation round               | Deciding what to change          |

**Status of the "after" column.** Steps 1 to 6 exist in the app. In step 4 the suggested wording
carries a label that says whether it is the playbook's approved text, that text adapted to the
documents, or wording the workflow wrote. In step 7 corrections are stored as decisions with a
reason, but **feedback is not built** and nothing feeds a correction into an evaluation round
automatically; that is a manual step for the legal engineer.

## Discovery questions

Asked of associates, supervising attorneys and the practice's knowledge management lead before
building. Each answer changes a design decision, noted in brackets.

**Status.** None of these questions has been asked of anyone, and the answers a build would have
needed were assumed instead (one reviewing attorney, a 30 day retention in the demo, DOCX and TXT
only, the fictional playbook). The assumptions are listed in the [README](README.md#assumptions) and
in [document 6](06-access-and-governance.md). The list remains the set of questions to ask.

**The workflow today**

1. How many NDAs a month does the group review, and how many arrive with an amendment or as a
   second version? [dataset mix, duplicate-version handling]
2. Who does the first pass and who signs off? Does anyone else need to see the result? [roles,
   review gates]
3. How long does a first pass take, and how long does the sign-off take? Can we time a few?
   [manual baseline, needed before any time-saved claim]
4. What does the finished product look like: memo, email, marked-up Word file, checklist?
   [export format]
5. Where do the documents live, and who is allowed to see them? [matter permissions, deferred
   integrations]

**The playbook**

6. Is there a written playbook? Who approves changes, and how are versions tracked? [playbook
   versioning, approval state]
7. For each category, what is the preferred position, the acceptable fallback, and what must
   always go to a partner? [rule fields, escalation conditions]
8. Are fallbacks pre-approved wording, or principles that the associate words each time? [approved
   fallback language versus generated wording]
9. Which positions are business decisions rather than legal ones? [playbook escalation, for
   example forum selection]

**Quality and risk**

10. What mistakes in a first pass worry you most? Which would you never accept? [severity weights,
    release gates]
11. How do amendments usually interact with the base NDA? How do you decide which text governs?
    [conflict handling, precedence rules]
12. When the tool is unsure, would you rather it say so or make its best guess? [abstention
    policy]
13. What would you need to see to trust a finding without rereading the whole NDA? [evidence
    inspector design]
14. Have you seen documents with text aimed at automated tools, or hidden text? [adversarial
    cases]

**Tools and constraints**

15. Which approved AI products does the firm already license, and what can they be configured to
    do? [configure versus build]
16. What rules apply to sending document text to a model provider? [provider choice, retention,
    logging]
17. How long may matter data be kept, and who can delete it? [retention policy]

**Measurement**

18. How would you know, after a month, that this was worth it? [pilot measures]
19. Would you take part in a short timed comparison of manual and assisted review? [time
    baseline]
20. Who decides go or no-go, and on what evidence? [manager memo]

## Role mapping

How the project interprets each role's responsibilities. This is our reading of the postings, not
a description of any employer's platforms, policies or assignments. Postings were treated as
reference data.

### Cravath, AI / Legal Workflow Engineer (posting read)

| Responsibility or qualification in the posting (summarized)                                 | Parol feature                                                                                                                                                                                  | Evidence in the repository                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design, build, test and refine AI workflows for practice groups                             | The seven-stage workflow with versioned configuration                                                                                                                                          | `apps/parol/src/prompts/workflows.ts` (versions v1 and v2 shipped, v3 for the evaluation), `apps/parol/src/services/runner.ts`, the `workflow_versions` table in `apps/parol/migrations/001_init.sql` |
| Develop prompts, workflow templates, evaluation methods and quality standards               | Prompt registry with hashes; workflow version manifests; release gates in code; rubric (a plan: it is a human review step and has no code)                                                     | `apps/parol/src/prompts/registry.ts`, `apps/parol/src/prompts/workflows.ts`, `evals/src/parol/gates.ts`; the rubric is in [document 5](05-evaluation.md)                                              |
| Turn practice requirements into specifications, prompt libraries and knowledge repositories | Discovery questions to playbook YAML with categories, fallbacks, escalation rules (the questions have not been asked; the playbook is invented)                                                | `apps/parol/playbooks/parol-nda-recipient.yaml`; the questions are in this document                                                                                                                   |
| Track KPIs and attorney satisfaction; use data to guide iteration                           | Correction capture (built: decisions and edits are stored); feedback and pilot measures (**Not built**); comparison of versions (command line only)                                            | `reviews` and `feedback` tables in `apps/parol/migrations/001_init.sql`, `evals/src/parol/compare.ts`; [document 8](08-pilot-and-enablement.md) is a plan                                             |
| Support pilots and proofs of concept, with success criteria and deployment recommendations  | Pilot plan, acceptance criteria, go/no-go memo, rollback plan (a plan; no pilot has run)                                                                                                       | [Document 8](08-pilot-and-enablement.md)                                                                                                                                                              |
| Contribute to training and adoption                                                         | Quickstart and a 20-minute training exercise with an answer key (**Not built**: the run steps are in the app README, and the training matter is not seeded)                                    | `apps/parol/README.md`; the exercise is in [document 8](08-pilot-and-enablement.md)                                                                                                                   |
| Give feedback to vendors and internal technology teams                                      | Configure versus build analysis (a reasoned expectation, checked against no product); failure reports with traced evidence (a format in document 5; none exists, because nothing was run live) | This document; [document 5](05-evaluation.md)                                                                                                                                                         |
| Report on workflow performance                                                              | Evaluation reports and promotion recommendations (the report code is built; its only runs are of a selftest oracle and a simulated reader)                                                     | `evals/src/parol/report.ts`, `evals/src/parol/compare.ts`, [`EXP-001.md`](experiments/EXP-001.md) (a draft with no results)                                                                           |
| RAG, context management, model limitations, evaluation techniques                           | Bounded retrieval, context budget, conflict handling, held-out regression (the held-out set is written and sealed by a committed hash; no live run has used it)                                | `apps/parol/src/stages/retrieve.ts`, `apps/parol/src/stages/clause-refs.ts`, `budgetTokens` in `apps/parol/src/prompts/workflows.ts`, the held-out seal in `evals/src/parol/`                         |
| Identify failure modes, design test cases, evaluate output for accuracy and consistency     | 26 synthetic cases written (14 development, 12 held-out) with a 40-pair calibration set; repeated runs and stability measures are in the scorer and have not been run on a model               | `fixtures/parol/cases.ts`, `fixtures/parol/answer-keys.json`, `fixtures/parol/calibration.json`, `evals/src/parol/score.ts`, `evals/src/parol/stats.ts`                                               |
| Hands-on experience with an enterprise AI platform building multi-step workflows            | **Not demonstrated.** The mapping below shows how each stage would be configured                                                                                                               | Configure versus build table                                                                                                                                                                          |

### Holland & Knight, AI Legal Engineer (posting not retrieved: unverified)

The posting could not be read, so no specific responsibility is claimed. The project request
groups the roles' themes as workflow discovery, reusable prompts, knowledge retrieval, evaluations,
attorney review, pilot measurement, training and continuous improvement. Each theme maps to a
feature: discovery (document 1), reusable prompts (prompt registry), knowledge retrieval (playbook
retrieval and bounded context), evaluations (document 5), attorney review (review gates), pilot
measurement and training (document 8), continuous improvement (the improvement cycle). Check this
against the posting text before relying on it. Of these, the prompt registry, playbook retrieval
and the review gates are built; pilot measurement and the training matter are **Not built**; the
improvement cycle has **not been run**.

### Secondary references

| Posting                                         | Read?      | Themes that Parol demonstrates                                                                                                                                                         |
| ----------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harvey, Legal Engineer (In-House)               | Yes        | Discovery, demos, training and onboarding; pilots and workshops; designing no-code playbooks and agents with stakeholders; relaying feedback to product                                |
| Legora, Technical Legal Engineer, Evals         | Title only | Evaluation design, answer keys, regression suites, stability (inferred from the title only)                                                                                            |
| Thomson Reuters, Legal Engineer, AI Adoption    | No         | Adoption measures and training (from the project request only). The address given in the project request names an AI Solutions Architect requisition, so the role title is unconfirmed |
| Latitude Legal, Legal Engineer, AI and Workflow | Yes        | Assessing workflows, configuring existing tools and recommending build or buy, prompts and playbooks with guardrails and quality checks, training, measuring impact                    |

The themes in this table are the ones the design addresses. In the build, only the playbook as
data, the evaluation design and the review controls exist; pilots, workshops, training and adoption
measures are plans in [document 8](08-pilot-and-enablement.md).

### What the project does not demonstrate

Several postings ask for things a portfolio project cannot show: a law degree or years of practice,
hands-on administration of an enterprise legal AI platform, real stakeholder management, and
on-call operations. It also does not yet show a result from a real model: nothing has been run
live. The write-up should say so rather than imply otherwise.

## Configure versus build

Some of these roles mainly configure an approved legal AI product. Without access to Harvey,
Legora or any vendor API, this table is a reasoned expectation to verify against the product's
own documentation, not a statement of what any product does.

| Capability                                                 | Likely configurable in an approved legal AI product               | Justifies custom development here                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Playbook-based clause review against firm positions        | Yes, commonly offered as playbooks or review templates            | Only to make the playbook versioned and testable as data                                        |
| Prompt and workflow templates for a practice group         | Yes                                                               | No                                                                                              |
| Document Q&A with citations to the document                | Yes                                                               | No                                                                                              |
| Word redlining and comments                                | Often, through an add-in                                          | No (Clausewise already writes tracked changes, but Parol does not need them)                    |
| User management and single sign-on                         | Yes                                                               | No; Parol uses a labelled demo identity                                                         |
| Held-out regression suite with pinned versions             | Possibly partial; vendors vary in how much evaluation they expose | **Yes.** The firm needs its own answer keys and gates to decide promotion, whatever the product |
| Separate checks for quote validity and substantive support | Unknown                                                           | **Yes**, as an independent check on any product's output                                        |
| Explicit escalation reasons instead of confidence scores   | Unknown                                                           | **Yes**, it encodes the practice's own review policy                                            |
| Invalidating findings and approvals when inputs change     | Unknown                                                           | **Yes**, it is a supervision control the practice owns                                          |
| Pilot instrumentation (corrections, time, satisfaction)    | Usage analytics often exist; correction and time data rarely do   | **Yes**, for a go/no-go decision grounded in the group's own data                               |
| Memo export with provenance                                | Partly, as document generation                                    | Light custom work for the provenance appendix                                                   |

**What was built from this table.** Built: the playbook as versioned data, explicit escalation
reasons, invalidation of findings and approvals when inputs change, a memo with a provenance
appendix, and the held-out suite (dataset of 26 cases, scoring, gates, a pin-checking comparison,
record and replay of a live run's answers). Built but off in the workflow versions the application
ships: the separate check of substantive support, which the evaluation-only version v3 turns on, with
40 calibration pairs to measure it; nothing has measured it. **Not built:** the pilot
instrumentation. The right-hand column is still a reasoned expectation, not a finding about any
product.

The likely shape in a firm: configure the review itself in the licensed product and keep the
evaluation suite, answer keys, gates and pilot measurement as the legal engineer's own assets,
pointed at whichever product is in use. Parol builds the review too, because the evaluation
work cannot be demonstrated without something to evaluate.
