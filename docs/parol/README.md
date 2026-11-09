# Parol: NDA Review and Workflow Evaluation Pilot

**Implementation status.** The design is implemented as a working application: `apps/parol` (run
steps in its [README](../../apps/parol/README.md)), the dataset in `fixtures/parol` and the evaluation
code in `evals/src/parol`. Built and tested: matters and permissions, Word and plain text upload,
the review workflow with its checks, attorney decisions, invalidation, the Word memorandum, and the
evaluation scoring and runner. Not built, and marked **Not built** or **Planned** where each document
describes it: the evaluation comparison page, feedback on findings, the pilot measures, the training
matter, 20 of the 26 planned evaluation cases, and the held-out set. **Never run live:** no real model
has been called. The demonstration uses a scripted simulated reader, which is not a language model, so
no score, latency or cost of any model exists. No number in these documents is a measurement of a
model. Each is a proposed gate or target, an estimate, a count (of code, tests, cases or findings),
an observation from a test or an attack review, or output from the selftest oracle (a program that
answers from the answer key, so it scores perfectly by design) or the simulated reader, and the text
says which.

Parol is a portfolio project that sets out the work of an internal AI / Legal Workflow Engineer:
discovering a legal workflow, encoding a practice group's playbook, building one bounded
AI-assisted workflow with attorney review, and measuring it with a held-out evaluation suite so
that a revision can be judged on evidence before a pilot. The playbook and the workflow are built.
Discovery has not been held, the held-out suite is not written and no revision has been judged. The
legal task is NDA review against a fictional practice-group playbook.

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
versions. **Deviation.** In Parol the spend guard protects the evaluation runner only; the
application's own model calls have none (see
[document 7](07-delivery-plan.md#implementation-deviations)).

## Documents

| #   | Document                                                         | What it answers                                                                              | State                                                                                                                                 |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [Product brief and role mapping](01-product-brief.md)            | Problem, users, scope, job requirement to feature mapping, configure versus build, discovery | The product it describes is built for steps 1 to 6; the role mapping points at files that exist; no discovery interview has been held |
| 2   | [Experience and architecture](02-experience-and-architecture.md) | User journey, screen sketches, architecture, stage graph, state machines, stack              | Built, except journey steps 5, 8, 10 and 11 and the screen S4                                                                         |
| 3   | [Data model and contracts](03-data-model-and-contracts.md)       | Entities, invalidation, stage and API schemas, retrieval, verification, escalation           | Built as migrations 001 to 003 and the shared contracts; feedback and the evaluation endpoints are not built                          |
| 4   | [Worked example](04-worked-example.md)                           | One finding end to end: passage, rule, finding, evidence, review, memo excerpt               | Run end to end with the simulated reader; its outputs are labelled as such                                                            |
| 5   | [Evaluation](05-evaluation.md)                                   | Dataset, answer keys, metrics and denominators, rubric, gates, the improvement cycle         | Scoring and runner built; 6 of 26 cases written; never run live                                                                       |
| 6   | [Access, review and governance](06-access-and-governance.md)     | Authorization, documents as data, logging, retention, provenance, recovery, demo limits      | Controls built and tested; the gaps are listed in the document                                                                        |
| 7   | [Delivery plan](07-delivery-plan.md)                             | Week one MVP, week two polish, dependencies, estimates, acceptance criteria, scope cuts      | Status of every work item, and the deviations                                                                                         |
| 8   | [Pilot and enablement](08-pilot-and-enablement.md)               | Hypothetical pilot, acceptance criteria, training, feedback, measures, go/no-go, rollback    | Plan only; the training matter, feedback and measures are not built                                                                   |
| 9   | [Demo, one-pager and postmortem](09-portfolio-materials.md)      | Two-minute demo script, portfolio one-pager outline, honest postmortem template              | Script partly backed by the demo; nothing recorded, written or measured                                                               |

The improvement cycle is specified in [experiments/EXP-001.md](experiments/EXP-001.md), a
pre-registration draft to freeze before the first baseline run. It has not been frozen and has not
been run: it holds no measured table, and it cannot be frozen until the held-out set exists.

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
   the application, `PAROL_SCRIPTED=1` selects a simulated reader that answers one worked example
   from a table and declines every other document; without a key and without that flag the server
   does not start. No live model has been called, so no assumption about how a real model behaves
   here has been tested.
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
