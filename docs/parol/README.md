# Parol: NDA Review and Workflow Evaluation Pilot

**Status: design only.** Nothing in this folder is implemented yet, no model has been run against
the cases described here, and every number in these documents is a proposed gate, an estimate or a
placeholder. Where a result will exist later, the documents leave an empty cell and say so.

Parol is a portfolio project that demonstrates the work of an internal AI / Legal Workflow
Engineer: discovering a legal workflow, encoding a practice group's playbook, building one bounded
AI-assisted workflow with attorney review, measuring it with a held-out evaluation suite, and
deciding with evidence whether a revision is ready for a pilot. The legal task is NDA review
against a fictional practice-group playbook.

**The name.** Under the parol evidence rule, evidence from outside a written agreement cannot
vary its terms. Parol applies the same discipline to its model: the only sources a finding may
rely on are the documents in the matter, every conclusion must cite them, and text in those
documents is evidence, never instruction.

It is designed as a web application inside Clausewise (`apps/parol`), because Clausewise
already holds most of the engine this needs: Word parsing, clause segmentation, a validated playbook
format, a model layer with structured output and bounded retries, contract text fenced off as data,
exact-quote anchoring, and an evaluation harness with a spend guard. Parol adds what turns a
review command into a supervised workflow: matters and permissions, versioned inputs, an evidence
model, a verify stage, attorney review, invalidation, a DOCX memorandum, and an evaluation suite
that compares workflow versions.

## Documents

| #   | Document                                                         | What it answers                                                                              |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | [Product brief and role mapping](01-product-brief.md)            | Problem, users, scope, job requirement to feature mapping, configure versus build, discovery |
| 2   | [Experience and architecture](02-experience-and-architecture.md) | User journey, screen sketches, architecture, stage graph, state machines, stack              |
| 3   | [Data model and contracts](03-data-model-and-contracts.md)       | Entities, invalidation, stage and API schemas, retrieval, verification, escalation           |
| 4   | [Worked example](04-worked-example.md)                           | One finding end to end: passage, rule, finding, evidence, review, memo excerpt               |
| 5   | [Evaluation](05-evaluation.md)                                   | Dataset, answer keys, metrics and denominators, rubric, gates, the improvement cycle         |
| 6   | [Access, review and governance](06-access-and-governance.md)     | Authorization, documents as data, logging, retention, provenance, recovery, demo limits      |
| 7   | [Delivery plan](07-delivery-plan.md)                             | Week one MVP, week two polish, dependencies, estimates, acceptance criteria, scope cuts      |
| 8   | [Pilot and enablement](08-pilot-and-enablement.md)               | Hypothetical pilot, acceptance criteria, training, feedback, measures, go/no-go, rollback    |
| 9   | [Demo, one-pager and postmortem](09-portfolio-materials.md)      | Two-minute demo script, portfolio one-pager outline, honest postmortem template              |

The improvement cycle is pre-registered in [experiments/EXP-001.md](experiments/EXP-001.md), a draft
to freeze before the first baseline run.

## Assumptions

These were made so the design could proceed. None of them blocks it, and each is easy to revisit.

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
   Without a key, everything runs against scripted models, as the Clausewise tests already do.
7. **Role references.** The Cravath, Harvey and Latitude Legal postings were read as reference data.
   The Holland & Knight and Thomson Reuters postings could not be retrieved (the Workday pages render
   in the browser and the data endpoint refused the request), and only the Legora posting's title
   was readable. For those, the mapping relies only on the themes stated in the project request and
   is marked unverified. See [document 1](01-product-brief.md#role-mapping).

## Conventions

- Status words, escalation codes, rule ids and case ids are defined once in
  [document 3](03-data-model-and-contracts.md) and [document 5](05-evaluation.md) and used
  identically everywhere else.
- Rule ids follow the Clausewise playbook format (lowercase, hyphens): `dur-1` is shown to users as
  DUR-1.
- Following `CONTRIBUTING.md`, these documents use no em dashes or en dashes.
