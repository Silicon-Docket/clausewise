# Contributing

Requirements: Node 22 and pnpm 10.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## Tests

- `pnpm test` runs everything. `pnpm exec vitest run apps/server` runs one folder, and
  `pnpm --filter @clausewise/server typecheck` checks one package.
- Tests use scripted stand-ins for the model (`@clausewise/llm/testing`,
  `@clausewise/review/testing`). They need no network and no key, and must never call a real
  model. The server has no switch that fakes a model: a test hands `createApp` or `startServer`
  its own generator.
- A fix comes with a test that fails without it. Check that by running the new test against a
  copy of the repository outside your working tree.
- Format with `pnpm exec prettier --write <files>`. Write comments that explain why, not what,
  and do not use em dashes or en dashes in code, comments or docs.
- Tests listen on port 0 and use temporary folders, never a fixed port or a path in the
  repository, so that several test runs can share one machine.

### Server tests

`apps/server/test` runs the routes through `app.request()` and the whole server through
`startServer`, on an in-memory PGlite database and a scripted model. Starting a database takes a
couple of seconds, so a test file starts few. `apps/server/test/support.ts` has the helpers.
Run them with `pnpm exec vitest run apps/server`.

### Web tests

`apps/web/test` uses vitest with jsdom and Testing Library; each file begins with
`// @vitest-environment jsdom`. The API client takes a `fetch` function, so tests hand it a fake.
Run them with `pnpm exec vitest run apps/web`. `pnpm --filter @clausewise/web build` makes the
static files the server serves from `apps/web/dist`.

### The test against a real PostgreSQL

`apps/server/test/postgres.test.ts` is the one test that does not run on PGlite, because the two
differ in drivers and in how JSON and timestamps come back. It looks for a database in this
order:

1. The server named by `CLAUSEWISE_TEST_DATABASE_URL`, if that is set. The test makes a database
   of its own on that server and drops it at the end, so the role in the address must be allowed
   to create and drop databases. CI sets it to a PostgreSQL 17 service container. A server that is
   named and cannot be used fails the test.
2. Otherwise a cluster started from the `embedded-postgres` package, in a folder of its own that
   is removed afterwards. As root, PostgreSQL refuses to run, and the package then runs it as a
   user called `postgres`, which has to exist.
3. If neither works, the test is skipped and the skip says why.

```sh
CLAUSEWISE_TEST_DATABASE_URL=postgres://postgres:<password>@localhost:5432/postgres \
  pnpm exec vitest run apps/server/test/postgres.test.ts
```

The workspace allows no build scripts of third-party packages (`pnpm-workspace.yaml` stays as it
is; pnpm reports the skipped ones after an install). The `embedded-postgres` binary package has
such a script, and the cluster started without it on the machine this was written on, so the
test needed no change. If it does not start on yours, use `CLAUSEWISE_TEST_DATABASE_URL`; do not
enable the script for everyone.

### End to end tests

`pnpm e2e` drives the built web app in Chromium against real Clausewise servers, the way a lawyer
uses it: upload a contract, run a review, accept, reject and reword findings, download the redline
and open it. It needs no key and calls no model.

```sh
pnpm install
pnpm exec playwright install chromium   # once; CI uses --with-deps. The scripts never download a browser.
pnpm e2e
```

What it does:

- The script builds the web app first (`pnpm --filter @clausewise/web build`). The global setup
  checks again: it builds if `apps/web/dist` is missing or older than the source, so a run
  never tests a stale build. `CLAUSEWISE_E2E_SKIP_BUILD=1` trusts an existing build (a missing one
  is an error).
- `e2e/global-setup.ts` starts four servers with `startServer` (through `e2e/start.ts`), each on a
  free port, with the embedded database, a fresh data folder under your temporary folder and the
  repository's own `playbooks/`: `main`, one with an access token, one whose model answers every
  call with HTTP 401, and one with no model set up. They are closed at the end. The run then
  fails if a server left its lock file behind, or if a log holds text of a contract or the token.
  `CLAUSEWISE_E2E_KEEP=1` keeps the data folders and logs and prints where they are.
- The model is the scripted oracle of the evaluation harness (`oracleScripts`, built from
  `fixtures/expected.json`), in `e2e/oracle.ts`. It answers for whichever fixture the prompt holds.
  Two words in the "Who are you acting for?" field change how it answers, so a scenario can ask
  for them without any switch in the server: `e2e-slow` makes it take about a second over each
  rule, so that progress can be watched, and `e2e-unanchored` makes it misquote the words of one
  rule, which gives a finding that only has a comment.
- The main flows are in `e2e/tests/flow.spec.ts`. They find everything by role and accessible
  name, never by CSS selector, so they also check the labels. They wait for a state or for the
  request they caused, never for a fixed time. They run one after the other in one worker, because
  the servers are shared and one scenario looks at the data folder. The downloaded files are read
  with JSZip by `e2e/docx-reader.ts`, which shares no code with the writer.
- `e2e/tests/browser.spec.ts` holds what only a real browser can show, and `e2e/tests/token.spec.ts`
  the access token as the browser handles it. Together they take about three minutes. They check:
  - the content security policy (no violation, no console error, no request to another site on any
    screen, and a control that the browser does block an inline script, a remote address, an inline
    style and a form that posts elsewhere), the headers of a page, an asset and the API, and that a
    second visit does not fetch the files again;
  - who may talk to the server: a request addressed to another name (421), one that names another
    site as its origin (403), a body a form could send (415), a name that points at this machine
    resolved by the browser itself (`--host-resolver-rules`), and a page served from another port
    that tries every request a hostile page can make while the server's state is compared before and
    after;
  - the whole happy path with the keyboard alone, and where the focus is after each step;
  - layout and colour on every screen (`e2e/support/screens.ts` lists them) at 360, 768 and 1280
    pixels in a light and a dark scheme: no sideways scroll, targets of 24 by 24 pixels, text of 4.5
    to 1, measured from computed styles by `e2e/support/audit.ts`. That file has scenarios of its
    own that feed it pages with known answers, so that a measurement that cannot say "too low" is
    noticed. A new screen or state goes into `screens.ts`. Pictures of the main screens are saved in
    `test-results/screenshots/` for a person to look at; nothing asserts on pixels;
  - reflow at 320 pixels wide with the root font size at 200 percent (not the browser's own zoom
    command, which Playwright cannot press: the window is narrowed and the size is set through the
    style object of the root element, which the policy allows);
  - a contract of 200 paragraphs with one clause of 3,000 words (built by
    `e2e/support/contracts.ts`), file names and contract text that are full of markup, a server that
    stops and comes back on the same port, double presses, refused files, dropped files, polling
    that stops, two tabs, and other small things a tester tries.
- Helpers a scenario of its own may need are in `e2e/support/`: servers owned by one test, with a
  model scripted for one contract (`servers.ts`), a watcher for a page's violations and errors
  (`watch.ts`), the API called directly (`api.ts`), keyboard helpers (`keyboard.ts`), and a page on
  another site (`evil-site.ts`). The specs of this folder delete the contracts they uploaded to the
  shared servers when a test ends.
- A test fails if its page throws an uncaught error or logs a console error, which is how a content
  security policy that blocks something is noticed.

Running part of it:

```sh
pnpm exec playwright test --config e2e/playwright.config.ts -g "happy path"
pnpm exec playwright test --config e2e/playwright.config.ts --headed --debug
```

A failed test leaves a screenshot in `test-results/`, and a trace there too when it is retried
(CI retries once; a local run does not). CI uploads `test-results/` and `playwright-report/` for
seven days when the job fails. Open a trace with `pnpm exec playwright show-trace <trace.zip>`.
Both folders are ignored by git.

**A machine whose browser is not the one Playwright expects.** Playwright 1.64 launches one exact
Chromium revision, which `playwright install` puts in its cache. If that revision is not there but
another Chromium is, `e2e/browser.ts` uses the newest one it finds in `PLAYWRIGHT_BROWSERS_PATH`
(or in Playwright's default cache folder), preferring the headless shell. To choose a browser
yourself, give the path of a Chromium or Chrome executable:

```sh
CLAUSEWISE_E2E_CHROMIUM=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell pnpm e2e
```

On the machine this was written on, the full Chromium in `/opt/pw-browsers` crashed at start
(SIGTRAP) and the headless shell next to it worked. Playwright supports only the revision it was
built for. With another one the suite may run, as it did there (Chromium 141 under Playwright
1.64), or fail in ways that are not bugs in Clausewise; CI installs the right one.

**LibreOffice.** One scenario converts a downloaded redline to ODT with `soffice`, in a profile
folder of its own, and counts the tracked changes and comments LibreOffice sees. It skips itself
with the reason when `soffice` is not installed, as it is not on the CI runner.

**Downloads with accents in the name.** Chromium writes a download under the name the page gave it
only if the machine's locale can hold the characters. In the C locale of a container it saves a
name with accents in it as "download", with no extension. That is the machine and not the app, so
the scenario that checks saved names starts its own browser with `LC_ALL=C.UTF-8`.

**A key that opens the file chooser.** Start listening for the chooser (`listenForFileChooser` in
`e2e/support/keyboard.ts`) well before the key is pressed. Waiting for the event right before the key
races with the message that switches the interception on, and the test then waits for a chooser that
Playwright never saw.

**Adding a scenario.** Check that it can fail: break what it guards in a copy of the repository
(never the working tree) and watch it fail. Give the scenario its own contract and review, and do
not rely on what another scenario left behind. Anything else it creates, such as a playbook, gets a
name that says it belongs to a test and is removed again, even when the scenario fails half way.

## The server bundle and the image

`pnpm build` builds the web app and bundles the server into `apps/server/dist` with
`apps/server/build.mjs`. `pnpm start` runs that bundle. The bundle contains the workspace
packages and nearly every dependency; `pg` and `@electric-sql/pglite` stay outside because they
load files of their own, and the image installs just those two.

- **A new dependency of the server** (or of a package it imports) is bundled automatically. If it
  reads files next to its own code at run time, or loads an optional native add-on, it cannot be
  bundled: add it to `EXTERNAL` in `apps/server/build.mjs`. The build fails with a clear message if
  the bundle imports a package that is not on that list.
- **A new workspace package** needs its own folder under `packages/` or `apps/`. Add its
  manifest to the `COPY` lines near the top of the `Dockerfile`: the install in the image uses
  the lock file, which names every project of the workspace, and fails without them.
- **Without a Docker daemon**, check a change to the Dockerfile by doing its steps by hand in a
  clean copy of the repository, made from `git ls-files -co --exclude-standard` so that ignored
  files are not in it. In that copy:

  ```sh
  pnpm install --frozen-lockfile
  pnpm --filter @clausewise/web build
  pnpm --filter @clausewise/server build
  pnpm --filter @clausewise/server deploy --legacy --prod <deploy folder>
  node apps/server/build.mjs prune <deploy folder>
  ```

  Then make a new folder (the `/app` of the image) holding `<deploy folder>/node_modules` as
  `node_modules`, `apps/server/dist` as `dist`, `apps/web/dist` as `web` and `playbooks`, and run
  `node apps/server/build.mjs check <that folder>`. The Dockerfile runs the same `check` as the last
  step of its build stage. `docker compose config` renders the compose file with any
  `POSTGRES_PASSWORD`, and `docker compose --profile ollama config` renders the Ollama profile.

- `pnpm deploy` needs `--legacy` because the workspace does not inject its packages. Injecting
  them would replace the links between the packages with copies that have to be refreshed after
  every change.
- CI builds the image and starts the stack (job `docker`). Keep the image free of source, tests,
  fixtures, evaluations and `.env` files: the `.dockerignore` and the `COPY` lines of the final
  stage are what keeps them out.

## Adding a package

1. Make `packages/<name>/` with a `package.json` (`"name": "@clausewise/<name>"`, `"private": true`,
   `"type": "module"`, `"license": "Apache-2.0"`, `"exports": { ".": "./src/index.ts" }`, a
   `"typecheck": "tsc -p ."` script), a `tsconfig.json` that extends `../../tsconfig.base.json`,
   `src/index.ts`, and `test/*.test.ts`. Relative imports end in `.js`.
2. Depend on other packages with `"workspace:*"`, then run `pnpm install` so the lock file is
   updated, and commit it.
3. Tests under `packages/*/test` and `apps/*/test` are found by the root `vitest.config.ts`
   without any change. Typecheck runs for every package that has the script.
4. If the server uses it, add its manifest to the `COPY` lines of the `Dockerfile` and a row to
   the table in the README.

## Fixtures

`fixtures/` holds synthetic contracts and what a correct review of each should find.

- `fixtures/contracts.ts` is the text of the contracts and `fixtures/expected.json` is the status
  of every rule for each one. `pnpm fixtures` builds the `.docx` files from the first.
- Change a contract and its expected findings together, run `pnpm fixtures`, and commit the
  regenerated files.
- Never commit a real contract, client name or text copied from another product's templates or
  playbooks. Write the text yourself.

## Evaluation harness

After a change to prompts, the pipeline, the fixtures or the scoring, run

```sh
pnpm eval --selftest
```

It runs the whole harness against a scripted model that gives every rule its expected status. It
needs no key and must show 100 percent accuracy and an integrity pass. Running it against a real
model spends money and needs `--yes`; see `evals/README.md`.

By contributing you agree your work is licensed under Apache-2.0.
