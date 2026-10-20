# Clausewise

Open source, self-hosted contract review and redlining. Check a Word contract against
a playbook and get risk findings plus suggested edits as real tracked changes and
comments, using any LLM you choose (Claude, OpenAI, or a local model through Ollama).

Clausewise is an open source alternative to commercial legal AI tools. It is
independent and not affiliated with any of them.

> **Status: pre-alpha.** The command line works end to end against scripted models and
> recorded requests, but it has **not yet been run against a live model**, and Word itself was
> never available to check the output. Expect rough edges, and read [Known limits](#known-limits)
> before you point it at a real contract. The web app, Docker image and Word add-in do not
> exist yet.

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

## Running it

The command runs from the TypeScript source with pnpm, from the Clausewise folder. Relative
paths are read from that folder, so give the full path of a contract kept elsewhere. A compiled
build that installs on its own is future work.

```sh
pnpm install
pnpm clausewise --help
```

| Option                           | Meaning                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--playbook <file>`              | The playbook to review against. Required.                                                                                                           |
| `--client <text>`                | The party you act for, such as `"Fabrikam Labs LLC, the Recipient"`. Playbooks say "we"; this says who that is, and the findings are better for it. |
| `--fail-on <level>`              | Exit with code 2 when something at that severity or above is open: `high`, `medium`, `low`.                                                         |
| `--force`                        | Replace output files that exist. The input is never replaced.                                                                                       |
| `--out`, `--report`, `--summary` | Where the three files go.                                                                                                                           |
| `--author <name>`                | The name on tracked changes and comments. Default `Clausewise`.                                                                                     |
| `--quiet`                        | No progress lines.                                                                                                                                  |

Exit codes:

| Code | Meaning                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The review finished. If some rules could not be checked, a warning names them.                                                          |
| 1    | Something went wrong, including a review in which no rule could be checked. Nothing is written.                                         |
| 2    | `--fail-on` was set and an item at that severity or above is open. A rule that could not be checked counts as open at its own severity. |
| 130  | Interrupted with Ctrl-C. Nothing is written.                                                                                            |

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

Long contracts can be reviewed in parts (`CLAUSEWISE_MAX_CONTEXT_TOKENS`). With Anthropic, the
contract is marked for prompt caching so that the rule checks share its cost.

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

Titles, standards and the other texts must contain visible characters. A value of spaces or
invisible characters is refused, because it would show up as an empty heading in the report.

A rule normally describes a clause the contract should have. Add `kind: absence` to describe
something it must not have. A contract that does not contain it passes, so an absence rule is
never `required`, and the model reports a deviation only when it finds the forbidden term:

```yaml
- id: restrictive-covenants
  title: No hidden restrictive covenants
  severity: high
  kind: absence
  standard: The agreement contains no non-solicitation, non-compete or exclusivity term.
```

Check a playbook without calling any model: `pnpm clausewise playbook check my-playbook.yaml`.
It lists the rules and marks the absence rules.

## Configuration

Everything is set through environment variables. `pnpm clausewise --help` lists them all.

| Variable                        | Meaning                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `CLAUSEWISE_PROVIDER`           | `anthropic` (default), `openai` or `openai-compatible`                             |
| `CLAUSEWISE_MODEL`              | Model name. Defaults to `claude-sonnet-5-5` for anthropic only                     |
| `ANTHROPIC_API_KEY`             | Required for anthropic                                                             |
| `OPENAI_API_KEY`                | Required for openai                                                                |
| `CLAUSEWISE_BASE_URL`           | Required for openai-compatible, for example `http://localhost:11434/v1` for Ollama |
| `CLAUSEWISE_MAX_CONTEXT_TOKENS` | Review in parts when the contract is longer than this                              |
| `CLAUSEWISE_CONCURRENCY`        | Rule checks in flight at once. Default 4                                           |
| `CLAUSEWISE_FALLBACK`           | `default` lets the Anthropic API rerun a declined request on a second model        |

Use a model with reliable structured output. Small local models may need a short context and
will give weaker findings. The context limit has to leave room for a clause or two on top of the
roughly 4,800 tokens that the instructions, the rule and the answer take in every call; a smaller
limit is refused before anything is sent.

`CLAUSEWISE_FALLBACK` is off unless you set it, works only against the Anthropic API itself, and
has never been tried against it. It sends the same prompt to a second model, so leave it off if
the contract may go to only one.

## Privacy and data handling

- The contract text goes to the one provider you configure and nowhere else. Before it is sent,
  the command prints where. The line warns when the address is plain `http` to a host that is
  not this machine, and when a proxy from the environment (`HTTPS_PROXY` and the like, which Node
  uses only with `NODE_USE_ENV_PROXY=1`) sits in the path.
- A redirect from the configured address is refused and never followed, so the contract cannot
  be forwarded to a place you did not name.
- `ANTHROPIC_CUSTOM_HEADERS` and similar variables that add headers to every request are
  ignored, so a token meant for another tool is not sent to your provider.
- The three output files get the permissions of the contract, without write access for group and
  others. A contract only you can read gives outputs only you can read.
- Error messages are written not to quote the contract or a key. An error the program did not
  expect is shown by its name alone.
- An incomplete review is not passed off as a whole one. If some rules could not be checked, a
  warning names them and the files are still written. If none could, nothing is written and the
  exit code is 1. With `--fail-on`, every rule that could not be checked counts as open at its
  severity.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and what the threat model is.

## Known limits

- **Never run against a live model.** Everything is verified against scripted models and recorded
  requests only. Prompts and request shapes follow the providers' documentation.
- **Word itself was never available.** Output was checked with LibreOffice and libxml2. Open the
  redline in Word and look at it before you rely on it.
- Findings come from a language model and can be wrong. Review every one.
- Text hidden by a style, and white or tiny text, is still shown to the model. Only text hidden
  directly on a run is counted and held back, and the review says so.
- Footnotes, endnotes, headers and footers are counted and reported but not reviewed. Pictures
  and scanned pages are not read.
- Existing comments and deleted text are not shown to the model. Counsel's tracked insertions
  are read as accepted text, and the review says so.
- A rule can propose one edit. Several edits for one rule are not supported yet.
- Only .docx files are read. An old .doc, a password protected file and Strict Open XML are
  refused with an explanation.

## Development

Requires Node 22 and pnpm 10. See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm fixtures        # regenerate the synthetic contracts in fixtures/
pnpm eval --selftest # run the evaluation harness against a scripted model
```

| Path                | What it is                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| `packages/docx`     | Reads Word files and writes tracked changes and comments               |
| `packages/playbook` | The playbook format and its validation                                 |
| `packages/llm`      | Model access: the Anthropic SDK, plus the AI SDK for OpenAI-style APIs |
| `packages/review`   | Clause splitting, prompts, edit anchoring, the pipeline and the report |
| `apps/cli`          | The `clausewise` command                                               |
| `evals/`            | The evaluation harness, for measuring findings against a live model    |
| `playbooks/`        | Starter playbooks                                                      |
| `fixtures/`         | Synthetic contracts and the findings a correct review should produce   |

Tests use scripted stand-ins for the model (`@clausewise/llm/testing`, `@clausewise/review/testing`),
so the suite needs no network or key. The contracts in `fixtures/` were written for this project.
Do not add real client documents or text copied from other products.

## Roadmap

- [x] Word tracked changes and comments engine
- [x] Playbooks, clause splitting, prompts, edit anchoring, review pipeline, command line
- [x] Evaluation harness, checked against a scripted model
- [ ] First run against live models, with the harness
- [ ] Check the output in Word itself
- [ ] Review footnotes, endnotes, headers and footers; several edits for one rule
- [ ] A compiled build that installs without the source
- [ ] Web app and Docker Compose
- [ ] Word add-in
- [ ] Clause library and drafting
- [ ] Assistant chat with citations, document vault, bulk review, workflows
- [ ] Multi-user auth and SSO

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
