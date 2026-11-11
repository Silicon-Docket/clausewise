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
  policy, upload limits) are on regardless. The global roles that open the evaluation, pilot, audit
  and trainer's-key pages (legal engineer and administrator) follow their table in the tests, but
  with this sign-in they are not access control either (gap 26 of
  [document 7](../../docs/parol/07-delivery-plan.md)).
- **The scripted simulated model is not a language model.** With `PAROL_SCRIPTED=1` the reviews are
  read by a program in `src/demo` that knows two document sets and answers them from a table
  written in advance: the worked example, the Lanternfish and Corvane NDA with Amendment No. 1, and
  the training matter T01, which is the same two documents with one instruction paragraph added to
  the NDA. It declines every other document, and it declines either set if a single word of it is
  changed or a paragraph is added: it reads a block of passages only when every paragraph in it is a
  paragraph of the committed documents (the one added paragraph of T01 included), word for word.
  For T01 and nothing else its script plants one wrong finding, described under Training below. It
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
  cell, not a result. The evaluation comparison page and the pilot measures page are built, and
  today they can show only what a scripted run or a demonstration identity produced: no live model
  has ever been called, no pilot has run, and each page says so in its own words.

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

`pnpm parol:seed` opens the data folder, registers the prompts, the two workflow versions (v1 and v2), the
approved playbook (`parol-nda-recipient` 1.0.1) and the demo users, and creates two matters through
the same services the screens use. It prints what it created and where to find it. It refuses to
run unless `PAROL_DEMO_IDENTITY=1`, and running it again creates nothing new.

| Matter                     | Belongs to                  | Holds                                                                                                                                     |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lanternfish / Corvane NDA  | Alex Ruiz (associate)       | The worked example: a Word NDA and a plain text Amendment No. 1. Dana Whitfield (reviewing attorney) is on it. Ready to run, not yet run. |
| Heronbridge / Tamarind NDA | Lee Okafor (legal engineer) | A different, shorter NDA, so that two people can be shown not to see each other's matter. No reviewing attorney.                          |

There is one demo associate, so the second matter belongs to the legal engineer. Sam Patel (admin)
has no matter.

Three options change what the seed does. They can be given together.

```sh
PAROL_DEMO_IDENTITY=1 pnpm parol:seed --run v1 --run v2
PAROL_DEMO_IDENTITY=1 pnpm parol:seed --training
PAROL_DEMO_IDENTITY=1 pnpm parol:seed --pilot-demo
```

- `--run v1 --run v2` runs the review on the first matter under workflow version v1 and then v2
  with the simulated reader, and prints the address of each. A later review of the same documents
  replaces the earlier one as the current review; the earlier one is kept, marked superseded, at its
  own address.
- `--training` also makes the training matter T01 for Alex Ruiz, with Dana Whitfield as the
  reviewing attorney and Lee Okafor as the trainer, and prints the address of the quickstart page.
  The documents of T01 are the worked example with one instruction paragraph added to the NDA.
  No review is run on it: the exercise starts on the quickstart page. It needs the simulated reader
  (`PAROL_SCRIPTED=1`); with a provider key the finding it teaches about does not appear.
- `--pilot-demo` also builds a backdated scenario for the pilot measures page, through the same
  services, by demonstration identities on synthetic matters: 6 matters (2 baseline, 4 assisted),
  and on them timed sittings, shadow-mode reference lists, reviews by the simulated reader,
  decisions, exported memos, missed-issue reports and ratings. The pilot calendar starts 29 days
  before the day the seed is run, and the rows are dated weeks back, so use a fresh data folder.
  The seed prints how many of each it made, and what it prints counts what it did and measures
  nothing. To read the page, sign in as Lee Okafor (legal engineer) or Sam Patel (admin) and open
  `/pilot?scope=synthetic`. The pilot scope, `/pilot`, stays empty: every person and every matter
  here is a demonstration. Nothing on the synthetic scope is a pilot result. Running the option
  again adds nothing.

Apart from `--run` and `--pilot-demo`, nothing runs a review unless you do.

The navigation has **Quickstart** and **Help**, open to everyone including a visitor who has not
signed in. `/help` explains the words the pages use. `/quickstart` is described under Training
below. **Evaluations**, **Pilot measures** and **Audit log** appear only for the people who may open
them: the legal engineer and the administrator for the first two, the administrator alone for the
third. Anyone else who is signed in and opens one of those addresses is answered with a 403 page,
and a visitor is sent to the sign-in page.

## A walk-through of about two minutes

This follows the demo script in [document 9](../../docs/parol/09-portfolio-materials.md), cut down
to what exists now. Sign in with the picker on the first page; use the sign-out button to change
person.

| Time | Do                                                                                                                                                                                                    | Say                                                                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00 | Sign in as Alex Ruiz. Point at the banner.                                                                                                                                                            | "Parol is one NDA review workflow with attorney review. Everything here is synthetic: the documents, the playbook, the people. The sign-in has no passwords and is not authentication."                                                                                                      |
| 0:10 | Open Lanternfish / Corvane NDA. Show the two documents and their stated dates, the playbook, and the line "Where document text is sent".                                                              | "The associate uploaded the NDA and an amendment and chose an approved playbook version; a review pins all of it. What reads the documents is a scripted simulation, not a language model, and nothing is sent anywhere."                                                                    |
| 0:25 | Under "Start the review" keep workflow version v1 and press Start review. Open the issue table, then Duration of confidentiality obligations (DUR-1).                                                 | "The banner at the top says the reader is a scripted stand-in, not a language model. Version 1 calls the duration compliant. The quote of Section 6.1 is real and verified. The conclusion is wrong, because the amendment deletes Section 6.1 and retrieval never showed it to the reader." |
| 0:45 | Note Return or destruction of information (RET-1): a deviation.                                                                                                                                       | "The same gap the other way: the amendment changes the ten day deadline, the reader never saw it, so it flagged a deadline that is already cured. This is the simulation showing the failure the design predicts, not a failure observed in a real model."                                   |
| 0:55 | Back on the matter, choose workflow version v2, press Re-run review, open DUR-1.                                                                                                                      | "One change, retrieval. Duration is now a deviation. The inspector shows the amendment as governing, Section 6.1 struck through as superseded, and the survival clause as supporting."                                                                                                       |
| 1:10 | Open the checks panel on DUR-1.                                                                                                                                                                       | "Quotes are checked against the document in code, and the labels of the passages are checked against the rules for which document governs. The model support check is wired but off in both workflow versions the application ships, so it says not checked."                                |
| 1:20 | Sign out, sign in as Dana Whitfield. Open DUR-1, choose Edit, restore the two year term in the suggested language, give a reason, choose a reason code (for example Missed context), Save decision.   | "The attorney decides every finding, and the decision is bound to the exact finding she saw."                                                                                                                                                                                                |
| 1:40 | Sign out, sign in as Alex Ruiz. Change the amendment's stated date on the matter page to a day before the NDA's and press Save date. Then, under Start the review, choose v2 and press Re-run review. | "If the documents change, the decisions stop counting and export is blocked until the review is run again." After the re-run the duration comes out undetermined: the dates no longer show that the amendment governs.                                                                       |
| 1:55 | Sign in as Lee Okafor. Show that only the Heronbridge matter is listed, and that the address of the first matter, pasted into the browser, is not found.                                              | "Matters are separate. The server decides that from the database, not from anything in the request."                                                                                                                                                                                         |

What was left out of the script in document 9, and why:

- The evaluation comparison page and the held-out results (1:15 to 1:42 there) are only partly
  there. The page, `/evaluations` (Evaluations in the navigation, for the legal engineer and the
  administrator), shows a comparison that the evaluation command has published into the data
  folder. The seed publishes none, so to have one to look at, run the two simulated runs and
  publish the second, naming the folder that `PAROL_DATA_DIR` names (`./data/parol` by default):

  ```sh
  pnpm eval:parol --simulate --workflow v1 --out evals/results/sim-v1.json
  pnpm eval:parol --simulate --workflow v2 --compare evals/results/sim-v1.json --out evals/results/sim-v2.json --publish ./data/parol
  ```

  Two results files that already exist can be compared, and published, with no run:
  `pnpm eval:parol --baseline <first.json> --candidate <second.json> --publish ./data/parol`. The
  page shows the two versions and what they were run on, the 14 release gates of each (a gate that
  was not evaluated says why), the metrics with their counts, the slots whose answer changed, and
  for each changed slot where each version looked and what it cited. It shows only what the files
  say. A selftest, a simulated run or a replay is named in capitals on every part of it, a scripted
  run has no latency or cost, the decision rule is not applied to one, and the page never
  recommends: it offers draft text for a promotion record, unsigned. The held-out split's changed
  slots are listed, but their answer key, passages and trails are left out unless the comparison
  was published with `--open-heldout-trails`, and then the page says so in capitals. No run against a real model has
  been made and the held-out set has not been run, so every `<...>` in that script stays empty.

- The embedded-instruction warning (0:22 there) is not in the two seeded matters. With
  `pnpm parol:seed --training` it is on the NDA of the training matter T01, which the simulated
  reader reads (see Training). To see it elsewhere, create a matter for the client
  `Larkspur Freight Systems, Inc.`, add `fixtures/parol/files/parol-d08-nda.docx` as its NDA, and
  the upload shows the warning. The simulated reader declines that document, so every rule comes
  out undetermined and escalated.
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
    conclusion. It is off in both workflow versions the application ships (v1 and v2), so the checks panel says `Support not checked`.
  - 1:02 uploads a new amendment version. The simulated reader knows only the committed Amendment
    No. 1, so a different amendment, or any edited paragraph of either document, makes it decline
    every rule (undetermined, escalated). The walk-through changes a stated date instead, which
    stales the review without changing a word.

## Training

`/quickstart` lists the ten steps of a review and a seven-step exercise on a training matter,
T01. A signed-in person starts their own with **Start the training matter**, which makes them its
associate and asks for a reviewing attorney (required, unless the server was started with
`PAROL_RELAXED_SEGREGATION=1`) and an optional trainer; `pnpm parol:seed --training` makes one for
Alex Ruiz. Each person can have one. T01 is the worked example with the instruction paragraph of
evaluation case PAROL-D08 added to the NDA, so its upload carries the instruction-like text
warning. Its two files are in `apps/parol/training`, built from the cases by
`pnpm fixtures:parol:training` (`--check` writes nothing and exits 1 when they differ). The page says
before the steps that everything is synthetic and that the reader is a script, and that the exercise
needs the simulated reader.

**The planted finding.** In every review of T01 the simulated reader's script gives the rule
Disclosure to representatives (PDS-1) the status `Compliant` and cites Section 1.2, which defines
Confidential Information and says nothing about disclosure to representatives. The quote is in the
document, so every automatic check passes, and the support check is off, so the page says `Support
not checked`. The exercise is to find it and reject it with a reason and a reason code: a quote
that is found is not a quote that supports the finding. The answer is the script's. It is not a
seeded row (the store accepts a finding only from the stages) and not a language model's mistake,
it says nothing about how well any model reads an NDA, and with a provider key it does not appear;
nothing stops a trainee from starting a review of T01 on a live provider (gap 35 of
[document 7](../../docs/parol/07-delivery-plan.md)). Step 6 changes a stated date and does not
upload a corrected amendment, because the reader declines any changed document.

For steps 3 to 7 the quickstart shows which the stored events of the person's matter show as done,
out of five. Step 1 is set up by the start, and step 2 and the answer to step 3 are the trainer's to
judge, which Parol does not record. **Trainer's key** (`/training/key`, for the legal engineer and
the administrator, a 403 for anyone else) holds the answer to each step; with the demo identity it
is a courtesy and not a control. T01 is not used in evaluation: its files are outside
`fixtures/parol`, the database refuses an evaluation run on a training matter, and the reader plants
its answer only when the shown paragraphs, the instruction paragraph and the marker in the first
title all match. No person has done the exercise and nobody has timed it; the 20 minutes is the
plan's figure.

## Feedback, timers and pilot measures

Corrections, missed issues, a rating and time are recorded as the work is done, and one page counts
them.

- On the decision form an edit or a reject needs a **Reason code** (Wrong status, Wrong evidence,
  Missed context, Bad fallback language, Unclear, Other) as well as a reason, and an edit can be
  marked **This is a minor edit**. The audit log keeps the code and the mark and never the
  reason's words. The wording of the codes was written for this project and has not been agreed
  with attorneys (gap 37).
- Any member of a matter, a viewer included, can add a note to a current finding (**Add note**; at
  most 20 per person per finding), report a missed issue on a review (**Report missed issue**,
  against a rule or "Not covered by any rule"; at most 50 per person per review) and, once a memo
  has been exported, rate the matter on the memos page (**Save rating**: 1 to 5, "I would use this
  for my next NDA", with an optional comment; one rating per person per matter, and it cannot be
  changed). Notes, reports and rating comments are free text that is not checked against the
  documents and can hold pasted document text; they are stored with the matter, never put in the
  audit log, deleted with the matter, and part of neither a finding nor the memo.
- An associate or a reviewing attorney can time the work on a matter (**Start timer**, **Stop
  timer**; one running timer per person), and a reviewing attorney can record the issues they found
  themselves, before any review has run, as the **Reference list for shadow mode**; the first
  review closes it. The training matter offers neither.
- **Pilot measures** (`/pilot`, for the legal engineer and the administrator, who also set the first
  day of the pilot and record who was trained) works every measure of
  [document 8](../../docs/parol/08-pilot-and-enablement.md) out from these stored events. Each
  shows its numerator, its denominator and what the denominator counts, or "No data" and why. Time
  is a median with its count, minimum and maximum, and never a mean, a difference between phases or
  a saving. `/pilot/measures.csv` holds the same figures as a file, with codes and numbers and no
  names. The **pilot scope** is matters not marked synthetic that people who are not demonstration
  identities made and reviewed. This build has demonstration identities only, so that scope is empty
  on every database it can make (gap 30), and the page says "No pilot data". The synthetic scope
  (`/pilot?scope=synthetic`) counts what demonstration identities did, as `--pilot-demo` does, and
  says in capitals that it is not pilot data, not adoption, not accuracy and not time saved. The
  default retention of 30 days is shorter than the five-week pilot (gap 31, and Retention below).

## Keyboard use and accessibility checks

**Keyboard use.** Every control is a native link, button or field. The first Tab on any page goes to
"Skip to main content". Tab and Shift+Tab move through links, buttons, fields and the folded
sections (press Enter or Space on a heading such as "Upload a new version of ..." or "Delete this
matter" to open one). In a group of choices, such as the four decisions or the versions of a
document, the group is one stop and the arrow keys choose. In the issue table, with focus on the
table or on a row, `j` and `k` move between rows, Enter opens the row, `?` lists these keys and
Escape hides them. Opening a row puts focus on the evidence inspector. The file chooser of the
upload forms is your browser's own dialog. There is no theme switch: the pages follow the light or
dark setting of your system. The one script of the pages adds those shortcuts, scrolls a quote
into view (except on a page that opens on a refusal), stops a double submit and follows a running
review's progress. It takes no other key from the page, never moves focus on Tab or on a timer, and
every page works with it blocked.

**What `pnpm test` checks.** Fifteen rules (`apps/parol/test/a11y/rules.ts`) read the HTML the pages
write. They say that every control is a native control, or one of three known scrolling boxes, and
has a name that contains its visible text; that nothing leaves the tab order or has a positive tab
index; that landmarks and buttons are told apart by name; that a disabled button says why; that
every form has a button that sends it; that every link to a place on the page leads to an element
that is there; that the skip link is first; and that every error page and every refusal carries a
marked "what to do" sentence (a test checks that the sentence is there, not that it is good advice).
The rules are run over every page fixture of the tests (the first sweep found 58 violations in 28
fixtures; all were fixed, and none is left), and over every page the route table serves: a GET route
that is listed neither as a page nor as not a page fails a test until someone decides, and each page
is requested as a visitor and in every role that can reach it, and in the refusal of every role that
cannot. The stylesheet is read as arithmetic: the contrast of each colour pair is worked out from
the colour tokens in both themes, and tests pin that the focus ring and the skip link are drawn,
that nothing is hidden from the eye and left to the keyboard, and that a status never rests on
colour alone. The page script is run in a small stand-in for a browser and pressed with every key in
several combinations of modifiers: it takes only `j`, `k`, `?` and Enter inside the issue table,
moves focus only for those and once when a page opens on a chosen finding, and changes nothing else
on a page. None of this runs a browser, applies the stylesheet or measures a colour as drawn.

**What the real-browser tests check.** `pnpm test:browser` runs the three files in
`apps/parol/test/a11y/browser`, with Playwright driving a headless Chromium against the real server
(the demo identity, the simulated reader, a temporary data folder, the seed with all its options).
They are opt in, because the audit takes several minutes: a plain `pnpm test` skips the two files
that start a browser (`audit.test.ts` and `flows.test.ts`) and prints one line that says how to ask;
`pnpm test:browser` sets `PAROL_BROWSER_TESTS=1` for them, and the server does not read that
setting. Playwright is not a dependency of this repository. The tests look for the package in this
order: the folder named by `PLAYWRIGHT_MODULES_DIR` (a folder that holds a `playwright` folder, for
example the global `node_modules` of the machine); then the normal module lookup from the test file,
which finds a local install and every folder in `NODE_PATH`; then the global folder that `npm root
-g` prints. The browser is the one Playwright finds for itself. When the package or the browser
cannot be loaded, the files say so in one line and skip. `audit.test.ts` audits 109 pages, each in
the roles that can reach it (a visitor, an associate, a reviewing attorney, a viewer, the legal
engineer, an administrator), and shows, from what the browser itself reports, that the skip link is
the first stop and works; that Tab reaches every control once, in the order of the page and in
reading order on the screen, does not trap, and that Shift+Tab goes back; that every stop has a ring
of at least 3:1 against what is behind it and is not under anything; that every control has a name
in the browser's accessibility tree; the contrast of text against the background it really has, in
the light and the dark scheme; that the page does not scroll sideways at 640 CSS pixels, which
stands in for a 1280 pixel window zoomed to twice the size, or at 320; that reduced motion and
forced colours hide nothing; that with scripts off the page has the same controls; and that Escape
and Enter behave in forms. `flows.test.ts` does 15 tasks with key presses alone, no pointer: signing
in, making a matter and adding its documents, timing the work and recording the reference list,
starting a review, the issue table, a refused decision and the way to its reason, a note and a
missed-issue report, deciding and exporting the memo, the rating, deleting a matter, the pilot,
evaluation and audit pages, and starting the training matter. `judge.test.ts` checks the judging
with readings made by hand and needs no browser, so it always runs. They were run once, on 11
November 2026 on one machine, with Playwright 1.63.0 and Chromium 153.0.8010.12 (headless) on Node
22.23.4: the three files, 70 tests, passed in about 7 minutes. The repository's continuous
integration runs `pnpm test` and not these, so a change that breaks them is not found by it (gap 33
of [document 7](../../docs/parol/07-delivery-plan.md)).

**What nobody has checked.** No person has used a screen reader (NVDA, JAWS, VoiceOver) on these
pages, or walked them by keyboard: the keyboard walk is driven by the test. No browser but Chromium
was used, and nothing checks real browser zoom, touch, voice control, text spacing, target size, the
native file dialog, the cancel and resume of a running review, the pages the seed does not reach (a
review's progress, failed and cancelled runs, the 400, 409, 413 and 500 pages) in a browser, or the
Word memo (which was converted by LibreOffice and never opened in Word). This is not a conformance
claim for WCAG or any other standard: it lists what the tests above do (gap 21 of document 7).

## Using a real model

Without `PAROL_SCRIPTED` the server uses the Clausewise model layer, which reads its settings from
the environment, as the `pnpm clausewise` command does:

```sh
export ANTHROPIC_API_KEY=...
export PAROL_MAX_REVIEW_COST_USD=...
export PAROL_MAX_DAILY_COST_USD=...
export PAROL_PRICES_FILE=...
PAROL_DEMO_IDENTITY=1 pnpm parol
```

The three `PAROL_` lines are the spend limits and the price file, which the server needs before it
starts (see below). No review has ever been run this way: the project has no provider key.

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
A server that calls a model does not start with it on, because the price of the second model is not
in the price file (see below). If there is no key and no `PAROL_SCRIPTED`, the server stops before
it opens the database, and its message names `PAROL_SCRIPTED=1` as the way to look at Parol without
a model.

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

A server that calls a real model needs limits on what it may spend and a price file, and does not
start without them. A reader that is a stand-in (`PAROL_SCRIPTED=1`) calls no model, needs none of
this, and ignores these variables with a notice.

| Variable                      | Meaning                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAROL_MAX_REVIEW_COST_USD`   | The most one review may cost, in US dollars. No default: Parol does not guess a limit that is a statement about money.                                     |
| `PAROL_MAX_DAILY_COST_USD`    | The most all reviews may cost in one UTC day, in US dollars, and at least the limit for one review. No default.                                            |
| `PAROL_PRICES_FILE`           | A JSON file of prices, in US dollars per million tokens, in the format of `evals/prices.json`. It must hold a price for the model in use. No default.      |
| `PAROL_ASSUMED_OUTPUT_TOKENS` | The output tokens assumed for each call when the most a review can cost is planned. Default 1500.                                                          |
| `PAROL_SPEND_BOUND_ONLY`      | Set to `1` to accept a provider whose adapter reports no usage (`openai`, `openai-compatible`): only the bound planned before each review is then checked. |

The figures in `evals/prices.json` have not been checked against a live price list, and a price
file is the operator's own input: a wrong price makes every bound and every cost shown wrong in
the same direction.

**What the limits do.** Before a live review starts, Parol plans the most it could cost from the
stored documents and the workflow (the calls it would make, an assumed output length for each, and
the operator's prices) and refuses to start when that bound would pass the limit for one review, or
the day's limit (a UTC day, over all matters, counting reviews still in progress). A refusal is a
409 `spend_refused` on the JSON route, with the figures, and a notice on the page that says what to
do. Nothing is created, so the matter and any earlier results are as they were. While a review runs,
each request is held back when it could take the recorded spend past either limit. A review that
stops at a limit ends as failed with the reason, keeps what it finished and can be resumed, and the
finished work is not paid for again. The day's total is a ledger of dates and numbers that deleting
a matter does not lower. For every call to the `anthropic` provider the application records the
tokens the provider reported, an estimated cost and the model the provider named; the review page
ends with a Usage section that says so, and the memo's provenance appendix carries a `Usage:` line
of counts and no cost.

**What they do not do.** This has never met a live provider: it was tested against scripted wires
whose reply shape is the tests' own reading of the provider's interface (gaps 5 and 11 of [document
7](../../docs/parol/07-delivery-plan.md)). Usage is recorded and requests are capped only for the
`anthropic` provider. `openai` and `openai-compatible` report no usage, so the server starts with
them only when `PAROL_SPEND_BOUND_ONLY=1`, and then nothing but the bound planned before each review
is checked and the day's limit counts nothing for them. The bound is an estimate and not a ceiling:
a wrong price, or a prompt larger than estimated, can take a review past a limit before a response
stops it, and a call cut short by a stop is in the day's total and not in the review's own call
rows. A reader that is a stand-in has none of this: its review page says that no model was called,
so there is no usage to record.

**When the server does not start.** It prints one line that begins `Parol cannot start:` and says
what to do, and quotes no secret, no path and no line of a file. The causes it names are a setting
that is wrong, a missing key or limit or price, a port that is already in use, a data folder that
cannot be used, a damaged database, a database and migrations that disagree (a data folder made by
another version of Parol, see gap 34 of document 7) and a second server on the same data folder.
Before anything is opened, a missing key, a missing limit or an unusable price file stops it. The
terminal commands `pnpm parol:seed`, `pnpm parol:retain` and `pnpm parol:audit-verify` do the same
with `Parol <command> cannot run:`.

## Retention and the audit log

A matter is kept for 30 days from its creation by default. The new-matter form has **Keep for
(days)**, a whole number from 1 to 90, and an associate on the matter can change the date under
**How long this matter is kept** on the matter page: the new date counts from the moment it is saved,
earlier or later, and every change is audited. The ceiling of 90 days is a placeholder for a
question nobody has answered (question 17 of [document 1](../../docs/parol/01-product-brief.md)).
Nothing deletes a matter by itself, and there is no legal hold: a matter past its date stays open and
usable, marked on its page and on the list and in a notice when the server starts, until an
operator runs the retention command. Keep this in mind for a pilot: a five-week pilot with the
30 day default loses its first matters before it ends unless the date is set longer on the form or
the measures are downloaded every week (gap 31 of document 7).

```sh
pnpm parol:retain                 # a dry run: lists the matters past their date, deletes nothing
pnpm parol:retain --apply         # deletes them; stop the server first
pnpm parol:audit-verify           # checks the audit log's hash chain; reads only
```

`pnpm parol:retain` also takes `--max-matters N` (default 25, at most 1000), `--as-of DATE` (a dry
run only) and `--json`. `--apply` refuses to run while a server has the data folder, because the
deletion rewrites the database file and the server holds parsed document text in memory that only
it can drop; so a scheduler that runs it has to stop the server, run it and start the server again,
and no scheduler ships. For each matter past its date that has no review in progress it deletes the
rows in one transaction and then the matter's folder; then it removes folders that no matter names,
compacts the database once, writes one `retention.run` event and checks the audit chain. Exit codes:
0 it finished and nothing is wrong (a dry run that lists matters is 0); 1 it ran and something is
wrong (a matter or a folder could not be removed, compaction failed, or the chain does not verify);
2 it could not run (usage, no database, or the data folder is in use); 3 it refused, because more
matters are past their date than `--max-matters`, and deleted nothing. When more than one applies, 2
wins over 1 and 1 over 3. Its output holds ids, statuses, times and counts and never a name. A dry
run opens the database read only, so no row changes; SQLite may leave `parol.sqlite-wal` and
`parol.sqlite-shm` beside it, which hold no data. Deletion is not secure erasure of a disk.

`pnpm parol:audit-verify` also takes `--json` and `--expect-head SEQ:HASH`. It opens the database
read only, so it can run beside the server. It exits 0 when the chain holds and every matter is
accounted for (each created matter is present or has a deletion event), 1 when something is
broken, and 2 when it could not run. The hash is not keyed, and the number of the newest event is
kept in the same file, so someone who can write that file and recompute every later hash makes a
log that verifies. Keep the `Head:` line the command prints somewhere that nobody who can write the
database can edit, and pass it back with `--expect-head` to close both for the history up to that
event. The same check runs when the administrator opens `/audit`, which stores nothing, and the
server prints a warning when it starts if the chain does not verify and a notice when matters are
past their date; it deletes nothing.

The audit log records changes only, not reads and not refusals. A refusal is a 403 or 404 line in the
access log, which the server writes to standard output and does not store: to keep it, redirect
standard output to a file. Deleting a matter leaves the audit events (ids and codes), the spend
ledger and the pilot calendar and roster, which are not matter data.

## The data folder, and starting again

Everything Parol stores is in one folder, `./data/parol` unless `PAROL_DATA_DIR` says otherwise,
relative to where you ran the command. Git ignores `data/`.

- `parol.sqlite` is the database: matters, document text, findings, decisions, the audit log.
- `matters/<matter id>/` holds the uploaded files and the exported memos.
- `evaluations/` holds the comparison pages that `pnpm eval:parol --publish` writes, one file for
  each (`cmp_` and 16 hexadecimal digits, then `.json`). The application only reads them. They hold
  no matter data, and deleting a matter leaves them alone.
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
pnpm test:browser
```

The tests of the demonstration are in `test/demo`. They run the real parser, ingest, extract,
retrieval, analyze and verify stages on the worked example with the simulated reader, seed a
database and walk through the pages on a real socket. The accessibility rules and the sweeps that
use them are in `test/a11y`, the error wording and start-up failure checks beside them, and the
opt-in browser tests in `test/a11y/browser`: `pnpm test` skips those, and `pnpm test:browser` runs
them (see Keyboard use and accessibility checks).

## Decisions of part 3 that the project owner can overturn

The part 3 plan put nine questions to the project owner. None was answered; the recommended answer
was adopted and built in each case. They are decisions of the build, and the owner may overturn any
of them. What overturning each would cost is in
[document 7](../../docs/parol/07-delivery-plan.md#decisions-of-part-3-that-the-project-owner-can-overturn).

1. Results files record evidence trails: ids, offsets and codes, never text.
2. The evaluation page, the pilot measures and the trainer's key are for the legal engineer and the
   administrator, the audit log for the administrator alone, and anyone else gets a 403.
3. Status settlement applies to every workflow version, v1 and v2 included, so behaviour under the
   labels v1 to v3 changed; the model's own status is kept beside the settled one.
4. A server that calls a model refuses to start without both spend limits and a price file, and
   refuses a provider that reports no usage unless `PAROL_SPEND_BOUND_ONLY=1`.
5. The default retention stays 30 days although the pilot is five weeks; the field allows 1 to 90.
6. `pnpm parol:retain --apply` refuses to run while the server is up.
7. The shadow-mode review is done on the same matter as the manual baseline, and the first review
   closes the reference list.
8. A note on a finding for the reviewer is built.
9. The planted finding of T01 is the simulated reader's script, and step 6 of the exercise changes a
   stated date instead of uploading a corrected amendment.

## What is built and what is not

| Part                                                                                                                                      | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Matters, documents, versions, stale results, audit log, file store                                                                        | Built. A matter has a retention date: 30 days after creation by default, 1 to 90 days on the new-matter form, and an associate can change it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Word and plain text upload, clause spans, defined terms, cross references, upload warnings                                                | Built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Playbook loader and the fictional playbook `parol-nda-recipient` 1.0.1                                                                    | Built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Workflow versions v1 (retrieval R1) and v2 (R2), and the check sets C1 and C2                                                             | Built. v1 and v2 use C1. The supersession check C2 is in the verify stage, but neither version the application ships turns it on. Workflow v3, which only the evaluation runner can select, does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Extract, retrieve, analyze and verify stages                                                                                              | Built. The verify stage first settles the status against the playbook's flags, in every workflow version: a missing clause of a rule that is not required is not applicable, a required rule is never not applicable, and a rule that forbids something is met by its absence. The model's own status is kept beside the settled one, and the finding page and the memo show both and why. A not applicable that the model states directly is not checked against the hints (gap 6 of [document 7](../../docs/parol/07-delivery-plan.md)).                                                                                                                                                                                                                                                                                                                                    |
| Model support check                                                                                                                       | Wired but off by default: neither workflow version the application ships pins the support prompt, so findings say "not checked". Workflow v3 pins it, in the evaluation only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Authorization on the server, demo identity, forms with tokens, content security policy                                                    | Built. The demo identity is not authentication. Four pages that read across matters or hold fixed answers (evaluations, pilot measures with its forms, the trainer's key, the audit log) are gated by one of five global actions, each a row of a table that the tests check, and not access control with this sign-in (gap 26).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Pages and JSON API, reviewing attorney decisions, Word memo export                                                                        | Built. A decision to edit or reject carries a reason code. Error pages and refusals say what to do.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Simulated reader and this seed                                                                                                            | Built. A scripted demonstration, not a language model, and no measurement. It reads the worked example and the training matter T01, and declines everything else. The seed has the options `--run`, `--training` and `--pilot-demo`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Evaluation dataset, scoring and gates (`fixtures/parol`, `evals/src/parol`)                                                               | Built and tested. 26 synthetic cases (14 development, 12 held-out, the held-out hash committed) and a 40-pair calibration set for the support checker are in `fixtures/parol`. None has been run on a model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Evaluation runner (`pnpm eval:parol`: selftest, simulate, live, compare, replay)                                                          | Built. `--selftest` and `--simulate` need no key and are labelled as not a measurement of any model. A live run writes its answers to a recording and `--replay` re-scores a recording with no model; `--calibration` sends the 40 calibration pairs to the support checker (workflow v3, live or replay); `--exposure` runs authorization probes, a canary scan and the replay of upload steps against the application with a scripted stand-in for the model, so it tests the application and not a model. `--compare`, or `--baseline` and `--candidate` for two results files that already exist (nothing is run), compares two runs, and `--publish` writes the comparison into the data folder for the page below. A results file also records the evidence trail of every rule slot: ids, offsets and codes, never text. No live run was made, so no recording exists. |
| Evaluation comparison page (`/evaluations`)                                                                                               | Built and tested on scripted comparisons only. For the legal engineer and the administrator, it shows a comparison published by `--publish`: both versions, the 14 gates, the metrics with their counts, the slots whose answer changed and, for each version, where it looked and what it cited. A selftest, a simulated run or a replay is named in capitals. There is no held-out result, no latency or cost, and no recommendation, because no model has been measured.                                                                                                                                                                                                                                                                                                                                                                                                   |
| Feedback on findings: reason code, minor-edit mark, notes, missed-issue report, post-matter rating                                        | Built. Free text is not checked against the documents, a rating is final, and the wording of the reason codes has not been agreed with attorneys (gap 37).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Timers, shadow-mode reference list, pilot measures page and CSV                                                                           | Built and tested against stored events and a hand-written fixture. The pilot scope is empty on every database this build can make, so the page has no pilot data (gap 30); nothing on it is a pilot result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Pilot go/no-go memo, rollback switch, real participants and identities                                                                    | Not built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Training matter T01, quickstart page, in-app help                                                                                         | Built. Exercised with the simulated reader only; its planted finding is the reader's script, and no person has done or timed the exercise (gap 35).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Deletion of expired matters (`pnpm parol:retain`), audit verification (`pnpm parol:audit-verify`, the audit page)                         | Built. No scheduler ships, there is no legal hold, a matter past its date stays usable until an operator runs the command, `--apply` needs the server stopped, and the audit hash is not keyed (gap 17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Usage and the reported model recorded by the application, a spend guard for its model calls                                               | Built for the `anthropic` provider and tested against scripted wires only. It has never met a live provider, and it is weaker than the evaluation's guard (gaps 5 and 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Keyboard, contrast and error wording checks                                                                                               | Built. The rules run on every `pnpm test`; the real-browser tests are opt in (`pnpm test:browser`), have run once on one machine in Chromium, and are not run by CI. No screen reader, no other browser, no conformance claim (gaps 21 and 33).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A live run, a measured baseline, the improvement cycle, freezing EXP-001, qualified review of the dataset, measured numbers for the pilot | Not done. Each needs a provider key and the project owner's decision to spend (gaps 1 and 2). No document here states a result of any of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PDF documents                                                                                                                             | Not built. Word and plain text only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Word add-in                                                                                                                               | Not built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Single sign-on, encryption at rest, backups, concurrent editing, a penetration test                                                       | Deferred until production; see [document 6](../../docs/parol/06-access-and-governance.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Where things are

| Folder                                                      | What it holds                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/ingest`                                                | Parsing, clause spans, annotations, warnings.                                               |
| `src/stages`                                                | Extract, retrieve, analyze, verify.                                                         |
| `src/prompts`                                               | The prompts and the workflow versions.                                                      |
| `src/services`                                              | Matters, runs, reviews: what the routes call.                                               |
| `src/auth`                                                  | Matter authorization and the demo identity.                                                 |
| `src/server`                                                | The shell, the routes and the pages.                                                        |
| `src/store`                                                 | The database, the file store, the audit log.                                                |
| `src/export`                                                | The Word memo.                                                                              |
| `src/demo`                                                  | The simulated reader and the data of the seeded matters.                                    |
| `src/seed.ts`                                               | The command behind `pnpm parol:seed`.                                                       |
| `src/usage`                                                 | The spend guard, the price file, usage and reported-model recording.                        |
| `src/settlement.ts`                                         | Status settlement against the playbook's flags.                                             |
| `src/evaluations`                                           | The comparison page document and its reader.                                                |
| `src/pilot`                                                 | The pilot measures: the computation, the CSV, the fixed phrases.                            |
| `src/training`                                              | The training matter T01, the quickstart steps and the progress.                             |
| `src/retention`                                             | The retention job and the start-up notices.                                                 |
| `src/retain.ts`, `src/audit-verify.ts`, `src/cli-common.ts` | The commands behind `pnpm parol:retain` and `pnpm parol:audit-verify`, and what they share. |
| `src/demo/pilot-demo.ts`                                    | The scenario behind `--pilot-demo`.                                                         |
| `apps/parol/training`                                       | The two documents of T01.                                                                   |
| `test/a11y`                                                 | The accessibility rules, the sweeps and, in `test/a11y/browser`, the opt-in browser tests.  |
| `playbooks`                                                 | The fictional playbook.                                                                     |

Design documents: [overview](../../docs/parol/README.md),
[experience and architecture](../../docs/parol/02-experience-and-architecture.md),
[data model and contracts](../../docs/parol/03-data-model-and-contracts.md),
[worked example](../../docs/parol/04-worked-example.md),
[evaluation](../../docs/parol/05-evaluation.md),
[access and governance](../../docs/parol/06-access-and-governance.md),
[delivery plan and known gaps](../../docs/parol/07-delivery-plan.md),
[pilot and enablement](../../docs/parol/08-pilot-and-enablement.md),
[demo script](../../docs/parol/09-portfolio-materials.md).
