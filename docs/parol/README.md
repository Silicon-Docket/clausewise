# Parol: NDA Review and Workflow Evaluation Pilot

**Implementation status.** The design is implemented as a working application: `apps/parol` (run
steps in its [README](../../apps/parol/README.md)), the dataset in `fixtures/parol` and the evaluation
code in `evals/src/parol`. Built and tested: matters and permissions, Word and plain text upload, the
review workflow with its checks and the settling of statuses from the playbook's flags, attorney
decisions with a reason code, invalidation, the Word memorandum, feedback capture (notes on a finding,
reports of a missed issue, a post-matter rating), timers and a reference list for shadow mode, the
application's own recording of usage and its spend guard, retention and audit verification (two
commands and a page), the training matter with a quickstart and a help page, error pages that say what
to do, rules over the HTML of every page for keyboard use and error wording, a numeric contrast check of
the stylesheet's colour pairs, an optional real-browser part (run on one machine in Chromium only), and,
on the evaluation side, all 26 planned
cases (14 development and 12 held-out, with the held-out hash committed), a 40-pair calibration set for
the support checker, scoring, the runner with record and replay of a live run's answers, a candidate
workflow version (v3) that turns the support check on for the evaluation only, the calibration step,
an exposure suite that tests the application and not a model, a page that shows a published comparison
of two workflow versions, and a pilot measures page with a CSV. All of it was tested against scripted
wires, a scripted simulated reader and synthetic data. Not built, and marked **Not built** or
**Planned** where each document describes it: the go/no-go memo, the rollback switch, a scheduler for
the retention command, and real participants and identities (so the pilot scope of the measures page is
empty on every database this build can make). **Never run live:** no real model has been called, so
there is no first live run, no baseline, no improvement cycle, no failure record, no promotion record,
no frozen pre-registration (`EXP-001`), no measured number for the portfolio and no qualified review of
the dataset, and the first live run needs the project owner to supply a provider key and approve the
spend. The demonstration uses a scripted simulated reader, which is not a language model, so no score,
latency or cost of any model exists, and no person has used the pages with a keyboard alone or a screen
reader. No number in these documents is a measurement of a model. Each is a proposed gate or target, an
estimate, a count (of code, tests, cases or findings), an observation from a test or an attack review,
or output from the selftest oracle (a program that answers from the answer key, so it scores perfectly
by design), the simulated reader or the exposure suite (a test of the application with a scripted
stand-in for the model), and the text says which. What part 3 left open is numbered in the known gaps
of [document 7](07-delivery-plan.md#known-gaps), 30 to 37.

Parol is a portfolio project that sets out the work of an internal AI / Legal Workflow Engineer:
discovering a legal workflow, encoding a practice group's playbook, building one bounded
AI-assisted workflow with attorney review, and measuring it with a held-out evaluation suite so
that a revision can be judged on evidence before a pilot. The playbook and the workflow are built.
Discovery has not been held, the held-out suite is written and sealed but no live run has used it, and no
revision has been judged. The legal task is NDA review against a fictional practice-group playbook.

**The name.** In general terms, the parol evidence rule keeps outside evidence from contradicting
the terms of a fully integrated written agreement, subject to exceptions. Parol borrows the idea
loosely: the only sources a finding may rely on are the documents in the matter, every conclusion
must cite them, and the review is told to treat text in those documents as evidence and never as
instruction. Whether a real model does so has not been observed.

It is a web application inside Clausewise (`apps/parol`), because Clausewise already holds most of
the engine this needs: Word parsing, clause segmentation, a validated playbook format, a model layer
with structured output and bounded retries, contract text fenced off as data, exact-quote anchoring,
and an evaluation harness with a spend guard. Parol adds what turns a review command into a
supervised workflow: matters and permissions, versioned inputs, an evidence model, a verify stage,
attorney review, invalidation, a DOCX memorandum, and an evaluation suite that compares workflow
versions. **Deviation, closed in week-two part 3.** Until then the spend guard protected the
evaluation runner only and the application's own model calls had none. The application now has a
spend guard of its own: a server that calls a model does not start without limits in US dollars for
one review and for one UTC day and a price file (a decision of the build that the project owner can
overturn: number 4 of the [decisions of part 3](07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn)), and the guard is weaker than the evaluation's in ways
that [document 7](07-delivery-plan.md#known-gaps) lists (gap 5). It has been tested against scripted
wires and has never met a live provider (see [document 7](07-delivery-plan.md#implementation-deviations)).

## Documents

| #   | Document                                                         | What it answers                                                                              | State                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [Product brief and role mapping](01-product-brief.md)            | Problem, users, scope, job requirement to feature mapping, configure versus build, discovery | The product it describes is built for steps 1 to 6 and, for step 7, as feedback capture, a comparison page and a pilot measures page; the role mapping points at files that exist; no discovery interview has been held |
| 2   | [Experience and architecture](02-experience-and-architecture.md) | User journey, screen sketches, architecture, stage graph, state machines, stack              | Built, except one-click re-confirmation after a re-run (journey step 8) and the correction review across matters (step 11); the new screens S5 and S6 are built                                                         |
| 3   | [Data model and contracts](03-data-model-and-contracts.md)       | Entities, invalidation, stage and API schemas, retrieval, verification, escalation           | Built as migrations 001 to 008 and the shared contracts; the evaluation JSON endpoints, the span endpoint and playbook import are not built                                                                             |
| 4   | [Worked example](04-worked-example.md)                           | One finding end to end: passage, rule, finding, evidence, review, memo excerpt               | Run end to end with the simulated reader; its outputs are labelled as such                                                                                                                                              |
| 5   | [Evaluation](05-evaluation.md)                                   | Dataset, answer keys, metrics and denominators, rubric, gates, the improvement cycle         | Scoring, runner (with `--publish` to the comparison page), record and replay, trails in results files, calibration step and exposure suite built; all 26 cases written; never run live                                  |
| 6   | [Access, review and governance](06-access-and-governance.md)     | Authorization, documents as data, logging, retention, provenance, recovery, demo limits      | Controls built and tested; the gaps are listed in the document                                                                                                                                                          |
| 7   | [Delivery plan](07-delivery-plan.md)                             | Week one MVP, week two polish, dependencies, estimates, acceptance criteria, scope cuts      | Status of every work item, and the deviations                                                                                                                                                                           |
| 8   | [Pilot and enablement](08-pilot-and-enablement.md)               | Hypothetical pilot, acceptance criteria, training, feedback, measures, go/no-go, rollback    | Plan, with its tooling built and tested on synthetic data (feedback, timers, measures page and CSV, training matter, quickstart); no pilot has run; the go/no-go memo and the rollback switch are not built             |
| 9   | [Demo, one-pager and postmortem](09-portfolio-materials.md)      | Two-minute demo script, portfolio one-pager outline, honest postmortem template              | Script partly backed by the demo and by the comparison page (simulated runs only); nothing recorded, written or measured                                                                                                |

The improvement cycle is specified in [experiments/EXP-001.md](experiments/EXP-001.md), a
pre-registration draft to freeze before the first baseline run. It has not been frozen and has not
been run: it holds no measured table, and it cannot be frozen until a model, its generation settings
and the price table are chosen, which needs a provider key and an explicit decision to spend. The
held-out set it names now exists.

## Assumptions

These were made before the build began. None of them blocked it, and each is easy to revisit.

1. **Home repository.** Of the three repositories in this workspace, Clausewise is the one whose
   purpose matches: it reviews NDAs against playbooks. PinCite (case citation checking) and
   citation-engine (Rust citation extraction) solve a different problem; NDAs rarely cite
   authority, so neither is used. Clausewise had no `docs/` folder, so this one was created.
2. **Stack.** Parol stays in TypeScript on Node 22 to reuse the Clausewise packages, rather
   than starting a Python application that would reimplement them. The reasoning and the new
   dependencies are in [document 2](02-experience-and-architecture.md#stack-decision).
3. **Synthetic data only.** Every party, document and playbook rule is written for this project.
   The playbook is fictional client policy, not a statement of law, and the companies are invented.
   Clausewise's contribution rules apply: no real contracts, client names or text copied from
   other products.
4. **Our client** is the party receiving most of the information under a mutual NDA, the same
   perspective as `playbooks/nda-mutual.yaml`.
5. **One reviewing attorney** decides each finding. Multi-level approval is deferred.
6. **Model access** uses the existing Clausewise configuration (Anthropic by default, OpenAI or any
   OpenAI-compatible server such as Ollama). No proprietary legal AI product or API is assumed.
   Without a key, everything runs against scripted models, as the Clausewise tests already do. In
   the application, `PAROL_SCRIPTED=1` selects a simulated reader that reads two document sets, the
   worked example and the training matter T01 (the worked example with one instruction paragraph
   added), from a table, and declines every other document, including one changed word of either;
   without a key and without that flag the server does not start, and with a key it also needs spend
   limits and a price file. No live model has been called, so no assumption about how a real model
   behaves here has been tested.
7. **Role references.** The Cravath, Harvey and Latitude Legal postings were read as reference data.
   The Holland & Knight and Thomson Reuters postings could not be retrieved (the Workday pages render
   in the browser and the data endpoint refused the request), and only the Legora posting's title
   was readable. For those, the mapping relies only on the themes stated in the project request and
   is marked unverified. See [document 1](01-product-brief.md#role-mapping).
8. **Identity.** The sign-in is a picker of four seeded demo people with no passwords. It is a
   labelled demo mechanism and not authentication; the server therefore listens on this machine
   only while it is on. See [document 6](06-access-and-governance.md#demo-identity).

## Conventions

- Status words, escalation codes, rule ids and case ids are defined once in
  [document 3](03-data-model-and-contracts.md) and [document 5](05-evaluation.md) and used
  identically everywhere else.
- Rule ids follow the Clausewise playbook format (lowercase, hyphens): `dur-1` is shown to users as
  DUR-1.
- Each document opens with an **Implementation status** paragraph. **Deviation** marks where the
  code departs from the design, with the reason. Text that describes work not yet done is kept and
  marked **Planned**, **Not built** or **Not yet built**; it is never to be read as done.
- Following `CONTRIBUTING.md`, these documents use no em dashes or en dashes.
