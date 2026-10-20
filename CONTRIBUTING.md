# Contributing

Requirements: Node 22 and pnpm 10.

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

## Tests

- `pnpm test` runs everything. `pnpm vitest run apps/cli` runs one folder, and
  `pnpm --filter @clausewise/cli typecheck` checks one package.
- Tests use scripted stand-ins for the model (`@clausewise/llm/testing`,
  `@clausewise/review/testing`). They need no network and no key, and must never call a real
  model.
- A fix comes with a test that fails without it. Check that by running the new test against a
  copy of the repository outside your working tree.
- Format with `pnpm exec prettier --write <files>`. Write comments that explain why, not what,
  and do not use em dashes or en dashes in code, comments or docs.

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
