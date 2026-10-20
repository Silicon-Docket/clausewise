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

A Playwright suite (`pnpm e2e`, with its own CI job) is planned and does not exist yet. It will
drive the built web app against a real server with a scripted model. When it exists, it will be
described here.

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
