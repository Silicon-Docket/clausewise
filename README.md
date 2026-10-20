# Clausewise

Open source, self-hosted contract review and redlining. Check a Word contract against
a playbook and get risk findings plus suggested edits as real tracked changes and
comments, using any LLM you choose (Claude, OpenAI, or a local model through Ollama).
Use it in your browser, or from the command line.

Clausewise is an open source alternative to commercial legal AI tools. It is
independent and not affiliated with any of them.

> **Status: pre-alpha.** The command line and the web app work end to end against scripted
> models and recorded requests, but neither has been **run against a live model**, and Word
> itself was never available to check the output. **The Docker image has not been built yet**:
> the machine this was written on had no Docker daemon. The steps the image performs were run
> by hand and the CI job that builds it is written, but that job has not run. See
> [What has been checked](#what-has-been-checked) before you point any of this at a real
> contract.

## What it does

In the browser, you upload a .docx, choose a playbook, and watch the review run. You read the
findings by severity, each with the clause it concerns and, where the model proposed a change,
the paragraph with the removed words struck through and the added words underlined. You accept,
reject or reword each suggestion, then download the contract with exactly the accepted
suggestions as Word tracked changes and margin comments. You can edit the playbooks in the same
app, with live validation.

From the command line the same review looks like this:

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

There are three ways. All of them need a model to review with: see
[Choosing the model, and where your text goes](#choosing-the-model-and-where-your-text-goes).

### With Docker Compose

This starts the server with its own PostgreSQL. Nothing is installed on your machine but Docker.

```sh
cp .env.example .env
# Edit .env: set POSTGRES_PASSWORD (make one with: openssl rand -hex 24) and choose the model.
docker compose up -d --build
```

Then open <http://localhost:8787>. The page tells you which model reviews go to, or what is
missing. To follow the log: `docker compose logs -f app`. To stop: `docker compose down`
(your data stays). To update: pull the new source and run `docker compose up -d --build` again;
the database is migrated when the server starts, so take a backup first.

What compose sets up, and why:

- The web app is published on `127.0.0.1` only, so only this computer can reach it. The
  database and the optional model server are not published at all.
- The app container runs as the unprivileged `node` user, with a read-only file system, a small
  temporary folder, no Linux capabilities and `no-new-privileges`. It writes only to its data
  volume.
- The database password is passed to the app as `PGPASSWORD` and not inside the database
  address, so it can hold any character. It is set when the database volume is first created;
  changing it in `.env` later does not change it inside the database.
- Settings are passed to the app one by one from `.env` (or your shell). Anything you do not set
  stays unset, and a key you do not set stays empty.
- Inside the container the server listens on `0.0.0.0`, which is how a published port reaches
  it, so its log always includes a warning about listening without an access token. With the
  published port on `127.0.0.1` that warning is about a risk you have already closed; set
  `CLAUSEWISE_ACCESS_TOKEN` anyway if anyone else uses this computer.
- Do not paste the output of `docker compose config` into an issue or a chat: it prints the
  values from `.env`, including the password and any key.

To run the whole thing as one container with the embedded database instead of PostgreSQL
(simplest, fine for one person):

```sh
docker build -t clausewise .
export ANTHROPIC_API_KEY=...        # or the settings of another provider
docker run --init --rm -p 127.0.0.1:8787:8787 -v clausewise-data:/data \
  -e ANTHROPIC_API_KEY clausewise
```

Always write the `127.0.0.1:` in front of the port. `-p 8787:8787` publishes the server on every
network interface of the computer. A bind mount on `/data` must be owned by user id 1000.

The base image is pinned by tag and minor version (`node:22.23-bookworm-slim`). For builds that
must be repeatable, pin it by digest as well, and update the digest on purpose:

```sh
docker build --build-arg NODE_IMAGE=node:22.23-bookworm-slim@sha256:<digest> -t clausewise .
```

None of the `docker` commands in this section has been run yet (no Docker daemon was
available). Compose files render with `docker compose config`; see
[What has been checked](#what-has-been-checked) for the rest.

### From source

Requires Node 22 and pnpm 10. Run everything from the Clausewise folder: the defaults for the
data, playbooks and web folders are relative to it.

```sh
pnpm install
pnpm --filter @clausewise/web build    # the server serves the built web app from apps/web/dist
pnpm dev                               # http://127.0.0.1:8787
```

With no `DATABASE_URL`, an embedded PGlite database and the uploaded files live in `./data`.
Set `DATABASE_URL` to a `postgres://` address to use PostgreSQL instead. The model is set with
the variables below, in your shell.

To work on the web app with hot reload, leave `pnpm dev` running and start Vite beside it:

```sh
pnpm --filter @clausewise/web dev      # http://localhost:5173, proxies /api to 127.0.0.1:8787
```

Open the Vite address, not 8787. Requests that change something (upload, accept, delete) only
work through the proxy if it passes on the `Host` header the browser sent, because the server
compares it with `Origin` (see below). Vite's short form of a proxy rule replaces that header; a
rule written as `{ target: ..., changeOrigin: false }` keeps it.

A production-like run from source: `pnpm build`, then `pnpm start` (this runs
`node apps/server/dist/main.mjs`, the same bundle the image contains).

### Command line

The command runs from the TypeScript source with pnpm, from the Clausewise folder. Relative
paths are read from that folder, so give the full path of a contract kept elsewhere. A compiled
build of the command that installs on its own is future work.

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

`pnpm clausewise --version` prints the version. `pnpm clausewise playbook check <file.yaml>`
validates a playbook and lists its rules without calling any model.

Exit codes:

| Code | Meaning                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The review finished. If some rules could not be checked, a warning names them.                                                          |
| 1    | Something went wrong, including a review in which no rule could be checked. Nothing is written.                                         |
| 2    | `--fail-on` was set and an item at that severity or above is open. A rule that could not be checked counts as open at its own severity. |
| 130  | Interrupted with Ctrl-C. Nothing is written.                                                                                            |

## Choosing the model, and where your text goes

Everything is set through environment variables, for the server, the command line and compose
alike (compose reads them from `.env`; `.env.example` explains each one). The contract text goes
to the one model you configure and nowhere else. The command prints where before it sends
anything; the web app shows it on its first screen and again when you start a review. Besides the
contract, the playbook rules and the "who are you acting for" text are sent with each request.

There are three ways to choose a model:

| Way               | Settings                                                                           | Where the contract text goes                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Anthropic         | `ANTHROPIC_API_KEY` (and optionally `CLAUSEWISE_MODEL`)                            | The Anthropic API, `api.anthropic.com`. The contract is marked for prompt caching.                                          |
| OpenAI            | `CLAUSEWISE_PROVIDER=openai`, `OPENAI_API_KEY`, `CLAUSEWISE_MODEL`                 | The OpenAI API, `api.openai.com`.                                                                                           |
| OpenAI-compatible | `CLAUSEWISE_PROVIDER=openai-compatible`, `CLAUSEWISE_BASE_URL`, `CLAUSEWISE_MODEL` | The server at `CLAUSEWISE_BASE_URL`: Ollama, vLLM, llama.cpp, or a gateway. Keep it local to keep the text on your machine. |

With Anthropic, the provider may keep a cached copy of the contract for a short time under its
own terms. Read your provider's terms on retention and training before you send it a contract.

**A local model with Compose.** The `ollama` profile starts an Ollama server that only the app
can reach. In `.env`:

```sh
COMPOSE_PROFILES=ollama
CLAUSEWISE_PROVIDER=openai-compatible
CLAUSEWISE_BASE_URL=http://ollama:11434/v1
CLAUSEWISE_MODEL=<the model name, exactly as you pulled it>
CLAUSEWISE_MAX_CONTEXT_TOKENS=14000
```

Then `docker compose up -d` and, once, `docker compose exec ollama ollama pull <model>` (the
download needs the Ollama container to reach the internet; reviews do not). The web app will
describe this destination as "a remote server you configured, not encrypted: plain http", because
`ollama` is not named `localhost`. The traffic is between two containers of your own computer.

A local model needs `CLAUSEWISE_MAX_CONTEXT_TOKENS`. Its window is small, and without the
setting a long contract is sent in one piece and fails. Set it below the window the model really
has; Clausewise then reviews a longer contract in parts. It has to leave room for about 4,800
tokens of instructions and answer in every call, so a limit below about 5,900 is refused with the
starter playbooks. Compose gives the Ollama service a window of 16,384 tokens
(`OLLAMA_CONTEXT_LENGTH`); both numbers are examples, not tested recommendations. Use a model
with reliable structured output: small local models give weaker findings. The Ollama profile
has not been run: there is no Docker daemon here, and no model.

All the model variables:

| Variable                        | Meaning                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `CLAUSEWISE_PROVIDER`           | `anthropic` (default), `openai` or `openai-compatible`                             |
| `CLAUSEWISE_MODEL`              | Model name. Defaults to `claude-sonnet-5-5` for anthropic only                     |
| `ANTHROPIC_API_KEY`             | Required for anthropic                                                             |
| `OPENAI_API_KEY`                | Required for openai                                                                |
| `CLAUSEWISE_API_KEY`            | Optional key for an openai-compatible server                                       |
| `CLAUSEWISE_BASE_URL`           | Required for openai-compatible, for example `http://localhost:11434/v1` for Ollama |
| `CLAUSEWISE_MAX_CONTEXT_TOKENS` | Review in parts when the contract is longer than this                              |
| `CLAUSEWISE_MAX_OUTPUT_TOKENS`  | Most tokens in one model answer. Default 16000                                     |
| `CLAUSEWISE_EFFORT`             | Anthropic only: `low`, `medium`, `high`, `xhigh` or `max`                          |
| `CLAUSEWISE_CONCURRENCY`        | Rule checks in flight at once. Default 4                                           |
| `CLAUSEWISE_MAX_RETRIES`        | Retries after a network error or an unusable reply. Default 2                      |
| `CLAUSEWISE_FALLBACK`           | `default` lets the Anthropic API rerun a declined request on a second model        |

`CLAUSEWISE_FALLBACK` is off unless you set it, works only against the Anthropic API itself, and
has never been tried against it. It sends the same prompt to a second model, so leave it off if
the contract may go to only one.

The server also reads these (the command line ignores them):

| Variable                        | Default           | Meaning                                                                   |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `HOST`                          | `127.0.0.1`       | Address to listen on. The image sets `0.0.0.0`.                           |
| `PORT`                          | `8787`            |                                                                           |
| `DATABASE_URL`                  | unset             | A `postgres://` address. Unset: the embedded database in the data folder. |
| `CLAUSEWISE_DATA_DIR`           | `./data`          | Uploaded files and the embedded database. The image uses `/data`.         |
| `CLAUSEWISE_PLAYBOOKS_DIR`      | `./playbooks`     | The built-in, read-only playbooks.                                        |
| `CLAUSEWISE_WEB_DIR`            | `./apps/web/dist` | The built web app. If it is missing, only the API runs.                   |
| `CLAUSEWISE_ACCESS_TOKEN`       | unset             | If set, every `/api` request must carry it. At least 16 characters.       |
| `CLAUSEWISE_ALLOWED_HOSTS`      | unset             | Extra names the server answers to, separated by commas, for a proxy.      |
| `CLAUSEWISE_MAX_UPLOAD_MB`      | `25`              | Largest upload, 1 to 1024.                                                |
| `CLAUSEWISE_REVIEW_CONCURRENCY` | `1`               | Reviews that run at once. Others wait in a queue.                         |
| `CLAUSEWISE_MAX_QUEUED`         | `20`              | More waiting reviews than this are refused.                               |

A missing or wrong model setting does not stop the server. The first screen says what is wrong,
and starting a review answers with the same words.

## Security model

Clausewise is for one person, or one small trusted team sharing one token, on a computer or
network you control. It has no accounts and no roles: everyone who can use it sees every
contract in it. [SECURITY.md](SECURITY.md) has the threat model in full; in plain words:

- **It listens on this computer only by default.** From source, `HOST` is `127.0.0.1`. Compose
  publishes the port on `127.0.0.1`. If you make the server listen on any other address without
  an access token, it logs a warning, and you have given everyone who can reach that address the
  right to read and delete every contract. Do not do that. Put a reverse proxy in front.
- **An optional access token.** Set `CLAUSEWISE_ACCESS_TOKEN` (at least 16 characters, for
  example `openssl rand -hex 24`) and every `/api` request must carry it in an `Authorization`
  header. The web app asks for it once and keeps it in memory and in the tab's `sessionStorage`,
  never in a cookie, so another site cannot make your browser send it. It is compared in constant
  time, and a refusal says nothing about why. There is no limit on wrong guesses, which is why it
  must be long and random. Over plain `http` it travels in clear text: use it with TLS.
- **DNS rebinding.** Without a token, a web page you visit could try to reach a server on your
  own computer through a name it controls. The server therefore answers only requests addressed
  to `localhost`, `127.0.0.1`, `[::1]` or a name in `CLAUSEWISE_ALLOWED_HOSTS`, and refuses the
  rest with 421. With a token, the token is the defence and this check is off.
- **Requests from other sites.** There are no CORS headers. A request that changes something and
  carries an `Origin` header must come from the page's own host (the `Origin` host must equal
  the `Host` header), or it is refused with 403, and bodies other than JSON or file uploads are
  refused with 415.
- **Uploads and pages.** Files are read under strict size and structure limits (see
  [SECURITY.md](SECURITY.md)). The web app never renders contract text as HTML and is served
  with a content security policy that allows only its own files.
- **A reverse proxy** (for HTTPS, or a name other than localhost) must keep the original `Host`
  header, because the check above compares it with `Origin`; must add TLS; must allow uploads up
  to `CLAUSEWISE_MAX_UPLOAD_MB` (nginx refuses anything over 1 MB by default); and should be
  paired with an access token and `CLAUSEWISE_ALLOWED_HOSTS` set to the public name. Caddy
  keeps the `Host` header unless told otherwise, so `reverse_proxy 127.0.0.1:8787` under your
  site name is a start. A proxy that rewrites `Host` makes every upload and every decision fail
  with a 403. None of this has been tried with a real proxy.

**What is stored, and where.**

- The uploaded .docx files, under `<data folder>/documents/`, with random names, mode 0600 in a
  0700 folder. The name you gave a file is kept only in the database.
- In the database (PostgreSQL, or the embedded one under `<data folder>/pglite/`): the file name,
  size and checksum; each review with its playbook, the "who are you acting for" text, the model
  name and the whole report, which quotes the contract and the model's explanations; and your
  decisions and reworded suggestions. **The report holds contract text.**
- Nothing is encrypted by Clausewise. Use an encrypted disk. Postgres traffic inside compose is
  not encrypted either, as it never leaves the Docker network.
- The server log has one JSON line per request (time, a random request id, method, route
  pattern, status, duration) and a few lines at start. It holds no contract text, no file name
  and no key. Errors shown to you contain none either.
- The Word files you download land in your browser's download folder: delete them there too.
- There is no telemetry and no call to any service but the model you configured and your
  database. That is the design; it has been checked by reading the code, not by watching the
  network.

**Deleting.** Deleting a document in the app deletes its file, its reviews and its findings.
To delete everything:

- Compose: `docker compose down --volumes` removes the containers and the volumes (the uploaded
  files, the database, and downloaded models). Then `docker image rm clausewise:local`, and
  delete `.env`, which holds your password and keys.
- One container: `docker rm` it and `docker volume rm clausewise-data`.
- From source: stop the server and delete the `data` folder. With `DATABASE_URL`, drop the
  database as well.

Deleted data is not wiped from the disk and stays in backups until they are deleted too.

**Backups.** Back up both the database and the files, together, while nobody is uploading. With
compose (not run yet):

```sh
docker compose exec -T postgres pg_dump --username=clausewise clausewise > clausewise.sql
docker compose cp app:/data/documents ./documents-backup
```

A backup holds the contracts. Keep it as carefully as the contracts themselves. To restore into
a fresh install, start only the database (`docker compose up -d postgres`), load the dump with
`docker compose exec -T postgres psql --username=clausewise clausewise < clausewise.sql`, put the
documents back into `/data/documents` of the `data` volume so that they belong to the user with
id 1000 and keep mode 0600, and then start the app. Restoring has not been rehearsed, the file
step in particular. For the embedded database, copy the whole data folder while the server is
stopped.

## What has been checked

Checked, and how:

- The unit and integration tests (`pnpm test`): Word reading and writing, playbooks, the review
  pipeline, the server's routes and security checks on an in-memory database with a scripted
  model, and the web app's components. They need no network and no key.
- One server test runs against a real PostgreSQL. In CI it uses a PostgreSQL 17 service
  container; locally it can use a cluster from the `embedded-postgres` package or any server named
  by `CLAUSEWISE_TEST_DATABASE_URL`. CI has not run it yet.
- The server bundle (`apps/server/build.mjs`) was built in a clean copy of the repository made
  from the files git tracks, with `pnpm install --frozen-lockfile`. `pnpm deploy` was run, the
  result was cut down to the two run-time packages, and the bundle was started from an empty
  folder with only that tree, as an unprivileged user, on a read-only copy of the application. It
  answered `/healthz`, `/api/config`, the web app (with its content security policy and other
  headers) and the playbook list; refused a request addressed to a stranger's name with 421;
  passed the image's health check command; wrote only to its data folder; and exited with code 0
  on SIGTERM. The same tree ran against a real PostgreSQL (version 18 beta, from
  `embedded-postgres`) with a password containing `@ : / # ? % & =`, passed as `PGPASSWORD`, and
  applied its migrations there.
- The image holds no source, test, fixture, evaluation, `.env` or Word file of the project, and no
  key: this was checked by listing the tree the image is built from. The third-party packages in
  it (`pg`, for one) ship their own test files, which are not removed.
- `docker compose config` renders for the default stack and for the `ollama` profile, and refuses
  to render without `POSTGRES_PASSWORD`.
- The shell steps of the CI job were syntax-checked, and the HTTP checks in it were run against
  the bundle started by hand.

Not checked:

- **The Docker image has not been built**, and compose has not been started. The CI job `docker`
  does both on every push and pull request: it builds the image, starts the stack, waits for the
  health check, calls `/healthz`, `/api/config` and `/`, checks the policy header, and tears it
  down. Until that job has run green, treat the image as untested. The Dockerfile was read against
  the usual linter rules by hand; `hadolint` was not run.
- The `ollama` profile, GPU use, the backup and restore commands above, and any reverse proxy.
- Any live model, and any real contract. Findings come from a language model and can be wrong.
- Word itself (output was checked with LibreOffice and libxml2), and the web app in Safari and
  Firefox. Use of the web app with a screen reader has not been tested with a real one.
- Behaviour under load, and with many people at once. It is not built for that.

## Principles

- **Self-hosted.** You run it. There is no telemetry and no hosted service.
- **Any model.** Pick the provider in the environment. The contract text goes only to the
  provider you configure, and the app says where before it sends anything. Point it at a local
  server and nothing leaves your machine.
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
4. All edits and comments are written in one pass as Word tracked changes and comments. In the
   web app, that last step happens when you download: the server builds the file again from the
   stored report with only the findings you accepted and the wording you chose.

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

In the web app the built-in playbooks are read-only ("Copy to edit" makes your own). A playbook
is refused if it is larger than 256 KB, uses YAML aliases or tags, nests deeper than 64 levels, or
repeats a key; the editor lists the problems it finds, with line numbers where it can.

Check a playbook without calling any model: `pnpm clausewise playbook check my-playbook.yaml`.
It lists the rules and marks the absence rules.

## Privacy of the command line

- A redirect from the configured address is refused and never followed, so the contract cannot
  be forwarded to a place you did not name.
- The line that names the destination warns when the address is plain `http` to a host that is
  not this machine, and when a proxy from the environment (`HTTPS_PROXY` and the like, which Node
  uses only with `NODE_USE_ENV_PROXY=1`) sits in the path.
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
- The server is for one person or a small trusted team: no accounts, no roles, no audit log. A
  review that is running when the server stops is marked as failed, and you start it again.

## Development

Requires Node 22 and pnpm 10. See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
pnpm fixtures        # regenerate the synthetic contracts in fixtures/
pnpm eval --selftest # run the evaluation harness against a scripted model
```

| Path                | What it is                                                              |
| ------------------- | ----------------------------------------------------------------------- |
| `packages/api`      | The types and limits shared by the server and the web app               |
| `packages/docx`     | Reads Word files and writes tracked changes and comments                |
| `packages/playbook` | The playbook format and its validation                                  |
| `packages/llm`      | Model access: the Anthropic SDK, plus the AI SDK for OpenAI-style APIs  |
| `packages/review`   | Clause splitting, prompts, edit anchoring, the pipeline and the redline |
| `apps/server`       | The HTTP server, the database, the job runner and the bundle script     |
| `apps/web`          | The web app (React, built into static files the server serves)          |
| `apps/cli`          | The `clausewise` command                                                |
| `evals/`            | The evaluation harness, for measuring findings against a live model     |
| `playbooks/`        | Starter playbooks                                                       |
| `fixtures/`         | Synthetic contracts and the findings a correct review should produce    |
| `docs/`             | The design notes                                                        |

Tests use scripted stand-ins for the model (`@clausewise/llm/testing`, `@clausewise/review/testing`),
so the suite needs no network or key. The contracts in `fixtures/` were written for this project.
Do not add real client documents or text copied from other products.

## Roadmap

- [x] Word tracked changes and comments engine
- [x] Playbooks, clause splitting, prompts, edit anchoring, review pipeline, command line
- [x] Evaluation harness, checked against a scripted model
- [x] Server and web app, written and tested against scripted models
- [x] Dockerfile and Compose files, written
- [ ] First run against live models, with the harness
- [ ] Check the output in Word itself
- [ ] The Docker image built and run (CI job `docker` green)
- [ ] Browser end-to-end tests (Playwright)
- [ ] Review footnotes, endnotes, headers and footers; several edits for one rule
- [ ] A compiled build of the command line that installs without the source
- [ ] A pgvector image, once vectors are used
- [ ] Word add-in
- [ ] Clause library and drafting
- [ ] Assistant chat with citations, document vault with search, bulk review, workflows
- [ ] Retention rules, a cost estimate before a review, live progress instead of polling
- [ ] Multi-user auth and SSO

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The server bundle in the image contains
other open source packages; their licence notices are in `THIRD-PARTY-LICENSES.txt` next to
`main.mjs` in the image.
