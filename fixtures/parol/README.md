# Parol evaluation dataset

Synthetic NDA matters and what a correct review of each should conclude, for the Parol
evaluation described in [docs/parol/05-evaluation.md](../../docs/parol/05-evaluation.md). Every
party, document and passage was written for this project. Never paste text from a real contract.

| Path                                 | What it is                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `cases.ts`                           | The cases, as code: documents, expectations, warnings. The source of truth.   |
| `types.ts`                           | The case format and the built answer key.                                     |
| `draft.ts`                           | Small constructors for writing a case.                                        |
| `build.ts`, `render.ts`              | The builder, the traceability checks, and the DOCX and TXT writers.           |
| `files/`                             | Generated DOCX and TXT files. Do not edit.                                    |
| `answer-keys.json`                   | Generated. Every expectation, with each anchor resolved to a paragraph index. |
| `splits.json`                        | Generated. Totals and the SHA-256 of each split.                              |
| `../../tools/make-parol-fixtures.ts` | The command: `pnpm fixtures:parol`.                                           |

## Building

```sh
pnpm fixtures:parol           # write files/, answer-keys.json and splits.json
pnpm fixtures:parol --check   # write nothing; exit 1 if what is on disk differs
```

The output is deterministic. The docx library stamps its output with the clock; the builder
replaces the core properties and every zip entry date, so building twice gives the same bytes. A
test builds the dataset again, on another day, and compares it with the committed files.

The build prints the totals table of document 5, recomputed from the keys, and the hash of each
split. A split's hash covers its answer keys as canonical JSON and every file in it by name and
SHA-256, so changing one key entry, one file or the set of files changes it.

## Adding a case

Add an entry to `CASES` in `cases.ts`. Case keys are `PAROL-Dnn` for the development split and
`PAROL-Hnn` for the held-out split, and every file name starts with `parol-<nn>-`. A case lists:

- `documents`: the NDA as `D1` and up to two amendments as `D2` and `D3`. Paragraphs are `title`,
  `heading`, `text` (outside any numbered clause), `clause` (numbered; typed into the text),
  `item` (a lettered sub-paragraph of the clause before it) and `signature`. A `.txt` file name
  makes a plain text document with typed numbers. `numbered()` numbers sections and clauses and
  renumbers around anything a variant leaves out.
- `expect`: one entry for each rule of the pinned playbook, no more and no fewer.
- `warnings`: the ingest warnings the documents should raise.

A paragraph wrapped in `injected()` is the embedded instruction of an injection case. The builder
also writes the same document without it, as `PAROL-Dnn-twin`, and no anchor may point into it.

### Anchors

An expectation names the passages that decide it, each as a document label, a clause number and
words copied from the document:

```ts
dur-1: deviation({
  governing: [at("D2", "2", "Section 6.1 of the Agreement is deleted")],
  superseded: [at("D1", "6.1", "two (2) years from the date of each disclosure")],
  relevant: [at("D1", "9.3", "survive any termination")],
  basis: "dur-1.unacceptable: no stated end for non-trade-secret information",
}),
```

A clause number of `null` names a paragraph outside any numbered clause (the title, a heading, the
preamble, a recital, the signature block).

### What the build refuses

All problems are reported together, and a message names the case, rule, role and position, never
the text.

- An anchor must occur exactly once in the text of the clause it names, overlapping matches
  counted, in the operative document of that label. It must also resolve in the injection twin.
- A basis is `<rule>.<field>: <reason>`. The rule is the slot's own, and the field is one the rule
  has in the pinned playbook: `standard`, `fallback`, `unacceptable`, `guidance`, `required` or
  `escalateWhen.<id>`.
- `compliant` and `deviation` name at least one governing anchor. `missing` and `not_applicable`
  name no passage at all. `undetermined` names no governing anchor (none decides it) and must
  require the escalation that explains it; the passages that disagree are `relevant`.
- `missing` is for a required rule and `not_applicable` for one that is not.
- An `acceptable` alternative needs a `note` saying why the answer is ambiguous, and a split has
  at most two.
- `required` and `allowed` escalations list codes, `not_expected` lists none, and
  `playbook_escalation` needs a rule with an `escalateWhen` entry.
- Text has no en dash, em dash or other dash, no line breaks, and no white space at an end.

## Scoring

`evals/src/parol/` scores observations against `answer-keys.json`. See `score.ts` for the metric
definitions and `gates.ts` for the release gates.
