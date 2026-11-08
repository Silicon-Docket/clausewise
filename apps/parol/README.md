# Parol

Parol is an attorney-supervised NDA review workflow, built to be looked at and tried out on a
laptop. An associate uploads an NDA and its amendments to a matter and picks an approved playbook.
Parol reads the documents against each playbook rule, shows every finding with the exact passages
it rests on, checks in code that those passages really are in the documents, and leaves every
decision to a reviewing attorney. When the documents change, earlier decisions stop counting. The
reviewed findings can be exported as a Word memorandum.

The design is in [docs/parol](../../docs/parol/README.md). This file is about running what exists.

## What this is, and what it is not

Read these four before anything else.

- **Synthetic data only.** Every party, document, playbook rule and person here is invented for this
  project. The playbook is fictional client policy, not a statement of law. Do not put a real
  client's document into it.
- **The demo identity is not authentication.** You pick a person from a list. There are no
  passwords, and anyone at the keyboard can be anyone. That is why the server refuses to listen on
  any address other than this machine while it is on. The real controls (checking membership of a
  matter on the server for every request, forms that carry a token, a strict content security
  policy, upload limits) are on regardless.
- **The scripted simulated model is not a language model.** With `PAROL_SCRIPTED=1` the reviews are
  read by a program in `src/demo` that knows one worked example, the Lanternfish and Corvane NDA
  with Amendment No. 1, and answers it from a table written in advance. It declines every other
  document, and it declines this one if a single word of it is changed: it reads a block of passages
  only when every paragraph in it is a paragraph of the two committed documents, word for word. It
  reads only the passages the workflow shows it, so the workflow's retrieval decides what it
  concludes: that is what lets the demonstration show a retrieval gap and its fix. What it says is
  not a measurement of any model. Its provider is `simulated` and its model is
  `parol-simulated-reader`. The start-up notice and the line on every matter that says where
  document text is sent describe it as a scripted stand-in that is not a language model, and the
  Reviews table of a matter names its provider and model. Every review page, with its issue table
  and finding inspector, opens with a banner that says the same and names the reader in its header,
  and the provenance appendix of the Word memo carries a "Stand-in reader" line. A verified
  `Compliant` for DUR-1 under version v1 is still the scripted gap and not a judgement.
- **No score has been measured.** This repository holds no accuracy, recall, latency or cost figure
  for any workflow or any model, and the answers of the simulated reader are not one. The dataset
  and the scoring code exist; see the table at the end. Any score, rate, latency or cost
  you meet in [docs/parol](../../docs/parol/README.md) is a proposed gate, an estimate or an empty
  cell, not a result.

## Run it

You need Node 22 and pnpm 10, in the Clausewise folder.

```sh
pnpm install
PAROL_DEMO_IDENTITY=1 pnpm parol:seed
PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol
```

Then open <http://127.0.0.1:8787> and choose a demo identity. Without `PAROL_DEMO_IDENTITY=1` the
start page says "Sign-in is switched off" and names that variable, and lists no identity. Stop the
server with Ctrl-C; it waits for a review in progress, and a second Ctrl-C stops it at once.

`pnpm parol:seed` opens the data folder, registers the prompts, the two workflow versions, the
approved playbook (`parol-nda-recipient` 1.0.1) and the demo users, and creates two matters through
the same services the screens use. It prints what it created and where to find it. It refuses to
run unless `PAROL_DEMO_IDENTITY=1`, and running it again creates nothing new.

| Matter                     | Belongs to                  | Holds                                                                                                                                     |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lanternfish / Corvane NDA  | Alex Ruiz (associate)       | The worked example: a Word NDA and a plain text Amendment No. 1. Dana Whitfield (reviewing attorney) is on it. Ready to run, not yet run. |
| Heronbridge / Tamarind NDA | Lee Okafor (legal engineer) | A different, shorter NDA, so that two people can be shown not to see each other's matter. No reviewing attorney.                          |

There is one demo associate, so the second matter belongs to the legal engineer. Sam Patel (admin)
has no matter.

One option changes what the seed does:

```sh
PAROL_DEMO_IDENTITY=1 pnpm parol:seed --run v1 --run v2
```

runs the review on the first matter under workflow version v1 and then v2 with the simulated
reader, and prints the address of each. A later review of the same documents replaces the earlier
one as the current review; the earlier one is kept, marked superseded, at its own address. Nothing
else runs a review unless you do.

## A walk-through of about two minutes

This follows the demo script in [document 9](../../docs/parol/09-portfolio-materials.md), cut down
to what exists now. Sign in with the picker on the first page; use the sign-out button to change
person.

| Time | Do                                                                                                                                                                       | Say                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Sign in as Alex Ruiz. Point at the banner.                                                                                                                               | "Parol is one NDA review workflow with attorney review. Everything here is synthetic: the documents, the playbook, the people. The sign-in has no passwords and is not authentication."                                                                                                      |
| 0:10 | Open Lanternfish / Corvane NDA. Show the two documents and their stated dates, the playbook, and the line "Where document text is sent".                                 | "The associate uploaded the NDA and an amendment and chose an approved playbook version; a review pins all of it. What reads the documents is a scripted simulation, not a language model, and nothing is sent anywhere."                                                                    |
| 0:25 | Under "Start the review" keep workflow version v1 and press Start review. Open the issue table, then Duration of confidentiality obligations (DUR-1).                    | "The banner at the top says the reader is a scripted stand-in, not a language model. Version 1 calls the duration compliant. The quote of Section 6.1 is real and verified. The conclusion is wrong, because the amendment deletes Section 6.1 and retrieval never showed it to the reader." |
| 0:45 | Note Return or destruction of information (RET-1): a deviation.                                                                                                          | "The same gap the other way: the amendment changes the ten day deadline, the reader never saw it, so it flagged a deadline that is already cured. This is the simulation showing the failure the design predicts, not a failure observed in a real model."                                   |
| 0:55 | Back on the matter, choose workflow version v2, press Re-run review, open DUR-1.                                                                                         | "One change, retrieval. Duration is now a deviation. The inspector shows the amendment as governing, Section 6.1 struck through as superseded, and the survival clause as supporting."                                                                                                       |
| 1:10 | Open the checks panel on DUR-1.                                                                                                                                          | "Quotes are checked against the document in code, and the labels of the passages are checked against the rules for which document governs. The model support check is wired but off in both workflow versions, so it says not checked."                                                      |
| 1:20 | Sign out, sign in as Dana Whitfield. Open DUR-1, choose Edit, restore the two year term in the suggested language, give a reason, Save decision.                         | "The attorney decides every finding, and the decision is bound to the exact finding she saw."                                                                                                                                                                                                |
| 1:40 | Sign out, sign in as Alex Ruiz. Change the amendment's stated date on the matter page to a day before the NDA's and press Save date. Then run the review again under v2. | "If the documents change, the decisions stop counting and export is blocked until the review is run again." After the re-run the duration comes out undetermined: the dates no longer show that the amendment governs.                                                                       |
| 1:55 | Sign in as Lee Okafor. Show that only the Heronbridge matter is listed, and that the address of the first matter, pasted into the browser, is not found.                 | "Matters are separate. The server decides that from the database, not from anything in the request."                                                                                                                                                                                         |

What was left out of the script in document 9, and why:

- The evaluation comparison page and the held-out results (1:15 to 1:42 there) are not built. On
  the command line, `pnpm eval:parol --simulate --workflow v1 --out a.json` and the same with
  `--workflow v2 --compare a.json --out b.json` compare the two workflow versions over the
  development cases, and every report and results file says in capitals that the answers are the
  scripted simulated reader's and not a measurement of any model. No run against a real model has
  been made, so every `<...>` in that script stays empty.
- The embedded-instruction warning (0:22 there) is not in the seeded matters. To see it, create a
  matter for the client `Larkspur Freight Systems, Inc.`, add `fixtures/parol/files/parol-d08-nda.docx`
  as its NDA, and the upload shows the warning. The simulated reader declines that document, so
  every rule comes out undetermined and escalated.
- The memo (1:52 there) needs every finding decided. After Dana has decided the eight findings of
  the current review she can press Export memo. The memo is headed as a draft for attorney review
  of synthetic documents. When an upload raised warnings (unread content, an instruction-like
  paragraph), a "Document warnings" section comes before the open items. Its provenance appendix
  says "Model: requested simulated parol-simulated-reader; reported by the provider: not reported."
  A line after it, "Stand-in reader", says that the findings were produced by a scripted program and
  not a language model.
  The explanations in the memo still read as written analysis, so a memo from this demonstration
  should not leave it without that being said aloud.
- Document 9 and the demonstration agree on the playbook at 0:10. The seeded playbook is 1.0.1, and
  the matter page shows that. Three other lines of document 9 are not as written:
  - 0:35 says Duration is a deviation. That is the answer under workflow version v2. The picker
    on the matter page starts on v1, which says `Compliant`, as the walk-through above uses.
  - 0:52 describes a model support check that asks whether the passages establish the
    conclusion. It is off in both workflow versions, so the checks panel says `Support not checked`.
  - 1:02 uploads a new amendment version. The simulated reader knows only the committed Amendment
    No. 1, so a different amendment, or any edited paragraph of either document, makes it decline
    every rule (undetermined, escalated). The walk-through changes a stated date instead, which
    stales the review without changing a word.

## Using a real model

Without `PAROL_SCRIPTED` the server uses the Clausewise model layer, which reads its settings from
the environment, as the `pnpm clausewise` command does:

```sh
export ANTHROPIC_API_KEY=...
PAROL_DEMO_IDENTITY=1 pnpm parol
```

| Variable                                    | Meaning                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CLAUSEWISE_PROVIDER`                       | `anthropic` (the default), `openai` or `openai-compatible`, such as a local Ollama server. |
| `CLAUSEWISE_MODEL`                          | The model name. Required except for `anthropic`, which has a default.                      |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`       | The key for those providers.                                                               |
| `CLAUSEWISE_API_KEY`, `CLAUSEWISE_BASE_URL` | For `openai-compatible`: the key if the server needs one, and its address (required).      |
| `CLAUSEWISE_MAX_OUTPUT_TOKENS`              | The most tokens in one model reply. Default 16000.                                         |
| `CLAUSEWISE_EFFORT`                         | Anthropic only: `low`, `medium`, `high`, `xhigh` or `max`.                                 |
| `CLAUSEWISE_MAX_RETRIES`                    | Retries after a network error or an unusable reply. Default 2.                             |
| `CLAUSEWISE_FALLBACK`                       | Anthropic only: `default` lets the API rerun a declined request on a second model.         |

`CLAUSEWISE_CONCURRENCY` and `CLAUSEWISE_MAX_CONTEXT_TOKENS` belong to the `pnpm clausewise`
command, which runs rules side by side and splits long contracts. Parol does not use them.
`pnpm clausewise --help` lists every `CLAUSEWISE_` setting.

**Where the text goes.** The server prints, before it listens, where document text is sent, and
every matter page shows the same sentence. With a hosted provider, the text of every document you
upload, and the playbook rules, are sent to that provider each time a review runs. Do not do that
with anything but synthetic documents: the demo identity has no passwords, nothing here has had a
security review, and a hosted provider is outside this machine. A local model keeps the text on the
machine. `CLAUSEWISE_FALLBACK` is off unless you set it, and when it is on, a request that the
model declines is sent again to a second model, so the same text goes to a model you did not name.
If there is no key and no `PAROL_SCRIPTED`, the server stops before it opens the database.

If you run a review of the seeded matters with a real model, the worked example's text is what is
sent. What a real model would say about it has not been observed in this repository.

Other settings, all optional:

| Variable                    | Meaning                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `PAROL_DATA_DIR`            | The data folder. Default `./data/parol`.                                                                       |
| `PAROL_PORT`, `PAROL_HOST`  | Default `8787` and `127.0.0.1`. With the demo identity on, the host must be `127.0.0.1`, `::1` or `localhost`. |
| `PAROL_COOKIE_SECRET`       | At least 32 characters. Without it a random one is made at each start, which signs everyone out on a restart.  |
| `PAROL_SECURE_COOKIES`      | Set to `1` behind https.                                                                                       |
| `PAROL_RELAXED_SEGREGATION` | Set to `1` for a one-person demo in which the associate may also decide findings; the memo then says so.       |
| `PAROL_MAX_UPLOAD_BYTES`    | The largest accepted upload. Default 10 MB.                                                                    |

## The data folder, and starting again

Everything Parol stores is in one folder, `./data/parol` unless `PAROL_DATA_DIR` says otherwise,
relative to where you ran the command. Git ignores `data/`.

- `parol.sqlite` is the database: matters, document text, findings, decisions, the audit log.
- `matters/<matter id>/` holds the uploaded files and the exported memos.
- `parol.lock` holds no data. The server keeps an exclusive lock on it for as long as it runs, so
  only one server can use a data folder at a time: a second `pnpm parol` on the same folder exits
  with a message saying so, before it touches anything. The system drops the lock when the first
  server ends, however it ends.

To start again, stop the server, delete the folder, and seed:

```sh
rm -rf data/parol
PAROL_DEMO_IDENTITY=1 pnpm parol:seed
```

The folder holds whatever documents were uploaded. Delete it when you are done with a demonstration.

## Tests

The tests use scripted stand-ins for the model and need no key and no network.

```sh
pnpm exec vitest run apps/parol
pnpm --filter @clausewise/parol typecheck
pnpm test
```

The tests of the demonstration are in `test/demo`. They run the real parser, ingest, extract,
retrieval, analyze and verify stages on the worked example with the simulated reader, seed a
database and walk through the pages on a real socket.

## What is built and what is not

| Part                                                                                       | State                                                                                                                      |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Matters, documents, versions, stale results, audit log, file store                         | Built.                                                                                                                     |
| Word and plain text upload, clause spans, defined terms, cross references, upload warnings | Built.                                                                                                                     |
| Playbook loader and the fictional playbook `parol-nda-recipient` 1.0.1                     | Built.                                                                                                                     |
| Workflow versions v1 (retrieval R1) and v2 (R2), and the check sets C1 and C2              | Built. v1 and v2 use C1. The supersession check C2 is in the verify stage, but no registered workflow version turns it on. |
| Extract, retrieve, analyze and verify stages                                               | Built.                                                                                                                     |
| Model support check                                                                        | Wired but off by default: neither workflow version pins the support prompt, so findings say "not checked".                 |
| Authorization on the server, demo identity, forms with tokens, content security policy     | Built. The demo identity is not authentication.                                                                            |
| Pages and JSON API, reviewing attorney decisions, Word memo export                         | Built.                                                                                                                     |
| Simulated reader and this seed                                                             | Built. A scripted demonstration, not a language model, and no measurement.                                                 |
| Evaluation dataset, scoring and gates (`fixtures/parol`, `evals/src/parol`)                | Built and tested. The cases written so far are in `fixtures/parol`.                                                        |
| Evaluation runner (`pnpm eval:parol`: selftest, simulate, live, compare)                   | Built. `--selftest` and `--simulate` need no key and are labelled as not a measurement of any model. No live run was made. |
| Evaluation comparison page (baseline against candidate, held-out results)                  | Not built. No score of any model has been measured.                                                                        |
| Feedback on findings, a one-question rating                                                | Not built.                                                                                                                 |
| Pilot measures                                                                             | Not built.                                                                                                                 |
| PDF documents                                                                              | Not built. Word and plain text only.                                                                                       |
| Word add-in                                                                                | Not built.                                                                                                                 |
| Single sign-on, encryption at rest, backups, concurrent editing, a penetration test        | Deferred until production; see [document 6](../../docs/parol/06-access-and-governance.md).                                 |

## Where things are

| Folder         | What it holds                                            |
| -------------- | -------------------------------------------------------- |
| `src/ingest`   | Parsing, clause spans, annotations, warnings.            |
| `src/stages`   | Extract, retrieve, analyze, verify.                      |
| `src/prompts`  | The prompts and the workflow versions.                   |
| `src/services` | Matters, runs, reviews: what the routes call.            |
| `src/auth`     | Matter authorization and the demo identity.              |
| `src/server`   | The shell, the routes and the pages.                     |
| `src/store`    | The database, the file store, the audit log.             |
| `src/export`   | The Word memo.                                           |
| `src/demo`     | The simulated reader and the data of the seeded matters. |
| `src/seed.ts`  | The command behind `pnpm parol:seed`.                    |
| `playbooks`    | The fictional playbook.                                  |

Design documents: [overview](../../docs/parol/README.md),
[experience and architecture](../../docs/parol/02-experience-and-architecture.md),
[data model and contracts](../../docs/parol/03-data-model-and-contracts.md),
[worked example](../../docs/parol/04-worked-example.md),
[evaluation](../../docs/parol/05-evaluation.md),
[access and governance](../../docs/parol/06-access-and-governance.md),
[demo script](../../docs/parol/09-portfolio-materials.md).
