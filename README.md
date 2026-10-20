# Clausewise

Open source, self-hosted contract review and redlining. Check a Word contract against
a playbook and get risk findings plus suggested edits as real tracked changes and
comments, using any LLM you choose (Claude, OpenAI, or a local model through Ollama).

Clausewise is an open source alternative to commercial legal AI tools. It is
independent and not affiliated with any of them.

> **Status: pre-alpha.** The command line works end to end against scripted models and is
> covered by about 1,300 tests, but it has **not yet been run against a live model**. Expect
> rough edges, and read [Known limits](#known-limits) before you point it at a real contract.
> The web app, Docker image and Word add-in do not exist yet.

## What it does

```sh
export ANTHROPIC_API_KEY=...
pnpm clausewise review nda.docx --playbook playbooks/nda-mutual.yaml
```

```
Sending the contract text to: Anthropic API (api.anthropic.com)
Checking 16 clauses against 10 rules.
[1/10] mutuality: deviation
...
Open items by severity: 4 high, 4 medium, 2 low
Tracked changes applied: 1
```

You get three files next to the input:

- `nda.redlined.docx`: your contract with the model's suggestions as Word tracked changes and
  margin comments. Reject all changes and you have your original text back.
- `nda.report.json`: every rule, its status, the clauses it points at and what happened to
  each proposed edit.
- `nda.summary.md`: the same as a readable summary, worst findings first.

## Principles

- **Self-hosted.** You run it. There is no telemetry and no hosted service.
- **Any model.** Pick the provider in the environment. The contract text goes only to the
  provider you configure, and the command prints where before it sends anything. Point it at a
  local server and nothing leaves your machine.
- **Never trust the model with your document.** The model proposes; the code decides. An edit
  becomes a tracked change only if the words it quotes occur exactly once, as whole words, in
  the clause it names. Otherwise you get a comment, never a redline. Statuses, clause ids and
  required clauses are checked against the document and the playbook, not taken on trust.
- **Contract text is data.** It is fenced off in the prompt and the model is told to ignore any
  instructions inside it.
- **Not legal advice.** Findings are suggestions for a lawyer to review.

## How it works

1. The .docx is read into paragraphs and split into clauses.
2. For each rule in the playbook, the model is asked, with the whole contract in view, whether
   the contract meets the rule, and for a minimal edit if it does not.
3. Each proposed edit is anchored: the quoted words must match the document text exactly (after
   normalising quotes, dashes and spacing) and occur once. Anything else becomes a comment.
4. All edits and comments are written in one pass as Word tracked changes and comments.

Long contracts can be reviewed in overlapping windows (`CLAUSEWISE_MAX_CONTEXT_TOKENS`). With
Anthropic, the contract is marked for prompt caching so that the rule checks share its cost.

## Playbooks

A playbook is a YAML file of rules. Two starters are included: `playbooks/nda-mutual.yaml` and
`playbooks/saas-customer.yaml`. Each rule says what you want, what you can live with and what
you cannot accept:

```yaml
- id: term
  title: Duration of confidentiality obligations
  severity: high
  required: true
  standard: Obligations end no more than three years after disclosure.
  fallback: Up to five years from the end of the agreement.
  unacceptable: Obligations that last forever, including for non-trade-secret information.
  guidance: Replace "perpetual" wording with a fixed number of years.
```

Check a playbook without calling any model: `pnpm clausewise playbook check my-playbook.yaml`.

## Configuration

Everything is set through environment variables. `pnpm clausewise --help` lists them all.

| Variable                        | Meaning                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `CLAUSEWISE_PROVIDER`           | `anthropic` (default), `openai` or `openai-compatible`                             |
| `CLAUSEWISE_MODEL`              | Model name. Defaults to `claude-sonnet-5-5` for anthropic only                     |
| `ANTHROPIC_API_KEY`             | Required for anthropic                                                             |
| `OPENAI_API_KEY`                | Required for openai                                                                |
| `CLAUSEWISE_BASE_URL`           | Required for openai-compatible, for example `http://localhost:11434/v1` for Ollama |
| `CLAUSEWISE_MAX_CONTEXT_TOKENS` | Review in windows when the contract is longer than this                            |
| `CLAUSEWISE_CONCURRENCY`        | Rule checks in flight at once. Default 4                                           |

Use a model with reliable structured output. Small local models may need a short context and
will give weaker findings.

## Known limits

- Never run against a live model yet. Prompts and request shapes are verified against recorded
  requests and documentation only.
- Findings come from a language model and can be wrong. Review every one.

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm fixtures        # regenerate the synthetic contracts in fixtures/
```

| Path                | What it is                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| `packages/docx`     | Reads Word files and writes tracked changes and comments               |
| `packages/playbook` | The playbook format and its validation                                 |
| `packages/llm`      | Model access: the Anthropic SDK, plus the AI SDK for OpenAI-style APIs |
| `packages/review`   | Clause splitting, prompts, edit anchoring, the pipeline and the report |
| `apps/cli`          | The `clausewise` command                                               |
| `playbooks/`        | Starter playbooks                                                      |
| `fixtures/`         | Synthetic contracts and the findings a correct review should produce   |

Tests use scripted stand-ins for the model (`@clausewise/llm/testing`, `@clausewise/review/testing`),
so the suite needs no network or key. The contracts in `fixtures/` were written for this project.
Do not add real client documents or text copied from other products.

## Roadmap

- [x] Word tracked changes and comments engine
- [x] Playbooks, clause splitting, prompts, edit anchoring, review pipeline, command line
- [ ] First run against live models, and an evaluation harness for measuring findings
- [ ] Web app and Docker Compose
- [ ] Word add-in
- [ ] Clause library and drafting
- [ ] Assistant chat with citations, document vault, bulk review, workflows
- [ ] Multi-user auth and SSO

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
