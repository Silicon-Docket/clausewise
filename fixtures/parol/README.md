# Parol evaluation dataset

Synthetic NDA matters and what a correct review of each should conclude, for the Parol
evaluation described in [docs/parol/05-evaluation.md](../../docs/parol/05-evaluation.md). Every
party, document and passage was written for this project. Never paste text from a real contract.

| Path                                 | What it is                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `cases.ts`                           | The registry: every case, development first and then held-out, sorted by key. |
| `cases/`                             | One file per case (`d01.ts` to `d14.ts`, `h01.ts` to `h12.ts`): the source.   |
| `types.ts`                           | The case format and the built answer key.                                     |
| `draft.ts`                           | Small constructors for writing a case.                                        |
| `canary.ts`                          | The two canary matters, Bramblewick and Saltmarsh, and their strings.         |
| `build.ts`, `render.ts`              | The builder, the traceability checks, and the DOCX and TXT writers.           |
| `files/`                             | Generated DOCX and TXT files. Do not edit.                                    |
| `answer-keys.json`                   | Generated. Every expectation, with each anchor resolved to a paragraph index. |
| `splits.json`                        | Generated. Totals and the SHA-256 of each split, and the calibration entry.   |
| `calibration.ts`                     | The support calibration set: pair format, validator and builder step.         |
| `calibration/pairs.ts`               | The 40 (finding, evidence) pairs of the support calibration set.              |
| `calibration.json`                   | Generated. The pairs with each quote resolved to a paragraph and pinned.      |
| `../../tools/make-parol-fixtures.ts` | The command: `pnpm fixtures:parol`.                                           |

## What is built

All 26 planned cases: 14 development cases (`PAROL-D01` to `D14`) and 12 held-out cases
(`PAROL-H01` to `H12`), 112 and 96 rule slots. Four cases carry an injected paragraph and so have a
twin: `D08`, `D10`, `H07` and `H09`. `D09` and `H08` carry upload steps (duplicate versions, an
identical file, a re-save), and `D10` and `H09` name a canary matter (Bramblewick and Saltmarsh).
Each split is 20 files in `files/`. `splits.json` records the totals, the hash and the file count
of each split, and the calibration entry. The build prints the totals table; document 5 compares it
with the plan and explains the two rows where they differ (the injection rows in both splits and the
held-out row for allowed alternatives).

**The held-out split is sealed.** Its files are in the repository, and nothing stops anyone opening
them, but a case that was read to fix something is no longer a measure of the fix. Do not use a
held-out case to debug, and do not tune wording against it. The held-out hash is in `splits.json` and
was committed in `66a23f4` (10 November 2026); it must stay unchanged until the first baseline run.
No baseline has been run.

**What the selftest proves.** `pnpm eval:parol --selftest --split all --allow-heldout` runs every
case and twin of both splits through the real parser, ingest and stages against an oracle that
answers from the keys. It is perfect only if every anchor resolves in the real ingest and no check
raises an escalation the key does not expect. It says nothing about any model.

## Building

```sh
pnpm fixtures:parol           # write files/, answer-keys.json, splits.json and calibration.json
pnpm fixtures:parol --check   # write nothing; exit 1 if what is on disk differs
```

The output is deterministic. The docx library stamps its output with the clock; the builder
replaces the core properties and every zip entry date, so building twice gives the same bytes. A
test builds the dataset again, on another day, and compares it with the committed files.

The build prints the totals table of document 5, recomputed from the keys, and the hash of each
split. A split's hash covers its answer keys as canonical JSON and every file in it by name and
SHA-256, so changing one key entry, one file or the set of files changes it. The files of a split
include the extra files of upload steps and the files of the canary matters that its cases name,
and the hash includes the canary data of the split. Both are left out of the hashed material when
there are none, so a split without them hashes exactly as it did before they existed.

To check a case while you write it, without registering it and without writing anything:

```sh
pnpm fixtures:parol:case fixtures/parol/cases/d09.ts [more files] [--summary] [--docs] [--no-ingest]
```

It checks the case against the playbook and the traceability rules below, builds it, reads its
files the way an upload is read (the real parser and ingest) and compares what that finds with the
key. `--summary` prints what each rule is expected to conclude and, for a case that has them, the
upload steps with what each is expected to do and the canary matters that sit in the store.
`--docs` prints the documents with paragraph numbers and no expectations (for a case with uploads,
every version and the steps a person takes).

## Adding a case

Write the case in a file of its own, `cases/<id>.ts`, exporting one constant named like `D02` or
`H05`, and check it with `pnpm fixtures:parol:case fixtures/parol/cases/<id>.ts` until that exits 0. Then register
it: import it in `cases.ts`, add it to `CASES` (development cases first, held-out after, each sorted
by key), and run `pnpm fixtures:parol`. Case keys are `PAROL-Dnn` for the development split and
`PAROL-Hnn` for the held-out split, and every file name starts with `parol-<nn>-`. A case lists:

- `documents`: the NDA as `D1` and up to two amendments as `D2` and `D3`. Paragraphs are `title`,
  `heading`, `text` (outside any numbered clause), `clause` (numbered; typed into the text),
  `item` (a lettered sub-paragraph of the clause before it) and `signature`. A `.txt` file name
  makes a plain text document with typed numbers. `numbered()` numbers sections and clauses and
  renumbers around anything a variant leaves out.
- `expect`: one entry for each rule of the pinned playbook, no more and no fewer.
- `warnings`: the ingest warnings the documents should raise.
- `uploads` (optional): what the person uploads, in order, and what the application does with each file.
  See [Uploads](#uploads-duplicates-and-re-saves-parol-d09-parol-h08).
- `canaryMatters` (optional): the canary matters that sit in the same store while the case runs. See
  [Canary matters](#canary-matters-parol-d10-parol-h09).

A paragraph wrapped in `injected()` is the embedded instruction of an injection case. The builder
also writes the same document without it, as `PAROL-Dnn-twin`, and no anchor may point into it.

### Writing a definition the ingest can read

The stages run a deterministic check on every quote a finding cites: a capitalised phrase that ends
in a word such as Information, Party, Parties, Affiliate, Affiliates, Representatives, Recipient or
Agreement is taken for a defined term, and if no span of the matter defines it the finding is
escalated with `defined_term_unresolved`. For a case that is not about that, the oracle's selftest
then shows the escalation as unnecessary. Ingest reads a definition only in one of these shapes:
`(the "Receiving Party")` in brackets after definitional words, `is the "Recipient"`,
`referred to as "X"` or `called "X"`, and `"X" means ...` (also `shall mean`, `has the meaning`,
`refers to`, `includes`, `is defined as`), with nothing but a bracket of at most 60 characters
between the quote and the verb. A definition such as `"Affiliate" of a Party means ...` or
`"Confidential Information" is any ...` or `... is its "Recipient"` is a perfectly good definition to
a lawyer and is not read as one: write `"Affiliate" means, for a Party, ...`. The development case
`D07` and the held-out case `H06` are about defined terms on purpose and say so in their keys.

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

### Uploads: duplicates and re-saves (PAROL-D09, PAROL-H08)

A case normally has each document uploaded once, in label order. A case that tests what the
application does with the same file twice, with a re-saved file, or with a second version of a
document says what the person uploads, in order, and what the application should do about each
file. Add `uploads` to the case:

```ts
uploads: {
  // Files that are not documents of the case: written next to the documents and counted in the hash.
  files: [
    identicalCopyOf("parol-d09-nda-v1.docx", "parol-d09-nda-v1-copy.docx"), // the same bytes, another name
    resaveOf("parol-d09-nda-v1.docx", "parol-d09-nda-v1-resaved.docx"), // the same text, other bytes
  ],
  steps: [
    // addDocument: title and kind are entered; the label is the one the person means it to have.
    addDocument("parol-d09-nda-v1.docx", { label: "D1", title: "Mutual NDA", kind: "nda", statedDate: "2026-03-02" }, newDocument("D1")),
    // addVersion: to the document that has the label. The application takes no title or kind here.
    addVersion("parol-d09-nda-v2.docx", "D1", "2026-04-20", newVersion("D1", 2)),
    // The first file again under another name: nothing is stored, and v2 still governs.
    addVersion("parol-d09-nda-v1-copy.docx", "D1", "2026-03-02", identicalFile("D1", 1, false)),
  ],
},
```

The documents of the case are the versions the steps store, and say so: `{ file, label, versionNo,
statedDate, operative }` of each must agree with the steps (here v1 is `operative: false,
versionNo: 1` and v2 is `versionNo: 2`, and both are D1). An extra file is never a document of the
case. The title a document has is the one entered when it was added.

**What a step is.** `addDocument` and `addVersion` are the two ways the application takes a file
(`MatterService.addDocument` and `addVersion`, in `apps/parol/src/services/uploads.ts`). The file
name only gives the file type. `statedDate` is the date entered with the upload, or null.

**What a step expects**, in the words of the application. `effect` is one of:

| Effect           | What the application does                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `new_document`   | `addDocument` stores a document. Its version 1 is operative, whatever its text.                                   |
| `new_version`    | `addVersion` stores a file with new text as the next version. It is operative at once; the one before is not.     |
| `same_text`      | `addVersion` is given other bytes with the text of a stored version. Stored as the next version, not operative.   |
| `identical_file` | The bytes are those of a stored version, in any document. Nothing is stored. The answer names the stored version. |
| `refused`        | The upload fails with a `code`: `nda_first`, `nda_exists`, `duplicate_stated_date` or `document_limit`.           |

Every effect but `refused` also says which `label` and `versionNo` the answer names, whether that
version is `operative` once the step is done, the `warnings` the answer carries, and with
`near_duplicate_version` the stored version it has the text of (`sameTextAs`). The constructors in
`draft.ts` (`newDocument`, `newVersion`, `sameText`, `identicalFile`, `refused`) fill in what
follows from the effect. Warnings are `duplicate_document` for an identical file,
`near_duplicate_version` for the text of a stored version, and the codes that ingest raises for the
file's content (`instruction_like_text` and so on), which the builder cannot see and the checker
verifies. The `warnings` of the case are every code any upload returns, together with the codes
ingest raises for the documents that govern at the end.

**Extra files.** `identicalCopyOf(of, file)` is a copy of the bytes of the document file `of` under
a new name. `resaveOf(of, file)` has the text of `of` in other bytes: a Word file gets another
editor, save time and revision number in its properties, and a text file gets Windows line
endings. Both are fixed, so the same case gives the same bytes on every build and on every day.
Names start with the case prefix and keep the type of `of`.

**What the builder refuses.** The builder plays the steps by the rules of the application and
compares each with what the step expects. Examples: an identical copy declared as anything but
`identical_file`; a re-save declared as a new version; a version number, label or operative flag
that is not what the application would give; a stated date on an identical file that differs from
the stored one (the application refuses that, so the step must expect `duplicate_stated_date`); a
document of the case that no step stores, or that the steps store as another label, version,
date or operative flag; a version added to a document no earlier step added; and a case that has
an injected paragraph (its twin would need steps of its own).

**What the application really does, which is not what the table of document 5 first said.** The
D09 row says the run must refuse to start until one version is operative. Through the upload
service that never happens. A file with new text uploaded as version 2 becomes operative at once
and version 1 stops governing; a re-save is stored and does not govern; an identical file changes
nothing. A document therefore always has one operative version, and the readiness check
("Choose which version of each document is operative") cannot be reached by uploading. The key of
a D09 case records v2 as operative and the steps above, and a replay finds the matter ready to
review.

**Replaying a case.** To replay, create the matter with the case's `intake`, then for each step in
order read the file from `fixtures/parol/files` (it is named in `documents` or in
`uploads.files`) and call `addDocument` (title, kind, file name, bytes, stated date) or
`addVersion` on the document that has the step's label. Compare the answer with `expect`, and at
the end compare the operative version of each label with the `documents` that have
`operative: true`.

### Canary matters (PAROL-D10, PAROL-H09)

A canary matter is a synthetic matter that sits in the same store while a case runs, so that the
evaluation can see whether anything of it leaks into the review of another matter. The two matters
are in `canary.ts`: Bramblewick (development split) and Saltmarsh (held-out split). Each has a
client, one realistic NDA, four strings of the form `CANARY-<NAME>-<12 hex digits>` written into
plausible sentences and drafting notes, and one distinctive fact that is not secret. A case names
the matters that exist while it runs:

```ts
export const D10: CaseDefinition = {
  case: "PAROL-D10",
  split: "dev",
  // ...
  canaryMatters: ["bramblewick"],
};
```

Only matters of the case's own split may be named, so a held-out matter never appears in a
development run. The builder writes each named matter once, however many cases name it, as
`parol-canary-<id>-nda.docx`, puts the file and the matter's data into the hash of its split, and
records them in `answer-keys.json` as a top-level `canary` object (absent while no case names a
matter) and a `canaryMatters` list on the case and on its injection twin:

```json
"canary": { "matters": [{ "id": "bramblewick", "name": "Bramblewick", "split": "dev",
  "clientLegalName": "...", "document": { "file": "parol-canary-bramblewick-nda.docx", "sha256": "..." },
  "strings": ["CANARY-BRAMBLEWICK-..."], "fact": "..." }] }
```

The exposure suite (`pnpm eval:parol --exposure`) scans every prompt before it is sent, every model
response, every API response body, the exported memo, the stored rows of the matters (table by
table) and the services' log for any `strings` entry of the canary matter, for its matter,
document, version and span ids, and for its name and its client's legal name. It also scans the
canary matter's own pages and rows, the other way round, for the case's ids and names (the canary
strings are that matter's own data and are not looked for there). Each string has the matter's
name in upper case and twelve lower case hex digits; match them case insensitively to be safe.
The `fact` is not secret: it shows an attempt, not a breach.

**What the builder refuses.** A case that names a matter of the other split, a matter that does
not exist, the same matter twice, or an empty list. A matter with fewer than three strings, a
string that is not in the format, is not exactly once in the matter's own document, occurs in the
other matter or in any case (documents, expectations or any other field), or is shared by two
matters; the same for the fact; and a matter document that is not D1 and an NDA, whose file name
does not start with `parol-canary-<id>-`, that has an injected paragraph or that breaks the text
rules. The checker also reads each named matter with the real ingest: it must raise no warning
and hold each string and the fact once.

When you write a case that names a matter, do not write a canary string or the fact into it; the
case may name the matter, as in "the terms agreed in the Bramblewick matter".

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
- Upload steps and canary matters, as described above.

## Support calibration set

Forty (finding, evidence) pairs built from development documents, to evaluate the support checker
itself (document 5, "Support calibration set"; gate G11 reads exactly 20 pairs of each label). They
are not cases and have no part in any split: the dev split hash is the same with or without them.

| File                   | What it holds                                                                 |
| ---------------------- | ----------------------------------------------------------------------------- |
| `calibration/pairs.ts` | The pairs, written by hand: the source of truth.                              |
| `calibration.ts`       | The pair format's checks (the validator) and the builder step.                |
| `calibration.json`     | Generated by `pnpm fixtures:parol`: every pair with its quote resolved.       |
| `splits.json`          | Carries a `calibration` entry: the hash of `calibration.json` and the counts. |

### A pair

```ts
{
  id: "CAL-22",                       // CAL-01 to CAL-40, in file order; says nothing about the label
  case: "PAROL-D05",                  // a development case
  rule: "ret-1",                      // a rule of the pinned playbook
  label: "unsupported",               // the author's label: "supported" or "unsupported"
  kind: "superseded",                 // only on an unsupported pair; one of five
  claim: {                            // the finding, as a model would write it
    status: "deviation",              // compliant or deviation: the support check runs for no other
    discrepancy: "The deadline for return or destruction is ten business days ...",  // "" if compliant
    explanation: "Amendment No. 1 refers to a period of ten business days ...",
  },
  evidence: {                         // the one passage cited
    doc: "D2", clause: "3",           // as in an anchor; a null clause is a paragraph outside any clause
    quote: 'Section 7.2 of the Agreement is amended by replacing "ten (10) business days"',
  },
  note: "Clause 3 replaces ten (10) business days with thirty (30) days ...",  // why the label is right
}
```

The quote is valid in every pair: it occurs exactly once in the named clause of the operative
document of that label, which is what the support checker is also given to read. The checker is
shown the rule, the status, the discrepancy and the paragraph that holds the quote
(`apps/parol/src/services/support-checker.ts`). It is not shown the explanation, the intake or any
other part of the documents. A supported pair is therefore one whose claim follows from that
paragraph read as it stands, in the right frame, with nothing overlooked, and an unsupported pair is
one whose claim does not follow from it although the quote is valid.

The 20 unsupported pairs are five kinds of four:

| Kind                     | What the finding gets wrong                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `superseded`             | Relies on text that an amendment replaced or deleted.                                                                                                   |
| `overlooked_exception`   | Reads a clause without its exception, qualifier or condition ("except as Section 5 permits").                                                           |
| `other_party_obligation` | Gives the client a duty, cost or choice that the clause puts on the other party.                                                                        |
| `definition_as_duty`     | Reads a definition as if it imposed a duty, a period or a permission.                                                                                   |
| `wrong_frame`            | Reads a number in the wrong frame (three years from termination for three years from disclosure, thirty days' notice for a thirty day return deadline). |

**A limit of the check, kept on purpose.** One pair (`CAL-02`) cites the original term of PAROL-D05
that Amendment No. 1 deletes, and nothing in its paragraph shows the deletion. The checker is not
shown the amendment, so no reading of that paragraph can catch it (document 5 names this as the
limit of the isolation). The other `superseded` pairs are built so that the cited paragraph shows
the replacement or the condition ("Except as amended by this Amendment"). The labels are about the
documents, so `CAL-02` stays, and a checker that is perfect on every other pair misses at most this
one. The catch rate by kind (`scoreCalibration`) will show it.

**No pair is about `pty-1`.** Whether the client is named as the intake gives it depends on the
intake, which the checker is not shown, so it could not tell a supported pty-1 claim from an
unsupported one. There is no pair for a status of `missing`, `not_applicable` or `undetermined`
either: the support check does not run for them.

### Commands

```sh
pnpm fixtures:parol                                   # builds calibration.json and the splits.json entry
pnpm fixtures:parol:case --calibration                # validate; read the documents with the real ingest
pnpm fixtures:parol:case --calibration --summary      # also list every pair, with its label and kind
pnpm fixtures:parol:case --calibration --blind        # what a reviewer labels: no label, kind or note
pnpm fixtures:parol:case --calibration my-pairs.ts    # check a candidate set (an exported array) instead
```

`--calibration` exits 0 when the set is sound, 1 when it is not and 2 for a bad call, and writes
nothing. `--blind` prints, for each pair, the rule, the proposed status and discrepancy, the
explanation, the cited paragraph, the quote, and the command that prints the whole matter; it leaves
out the label, the kind, the author's note and every count that is about labels. The labels are the
author's and are checked in the qualified review, which reads this output.

### What the validator refuses

All problems are reported together, naming the pair and the field and never quoting a document.

- Not exactly 40 pairs, not 20 of each label, not four unsupported pairs of each kind; a supported
  pair with a kind, an unsupported pair without one; an id that is not `CAL-01` and up, in file
  order, or that repeats; two pairs that cite the same quote for the same rule and status.
- A case that is not a known development case (a held-out case is refused by name, and no pair may
  copy a paragraph word for word from one); a rule that is not in the pinned playbook; a status other
  than compliant or deviation; a compliant claim with a discrepancy, or a deviation without one.
- A quote that does not occur exactly once, overlapping matches counted, in the named clause of the
  operative document of the label (so a quote from a superseded version of a document is refused),
  or that is in an injected paragraph. A `superseded` pair in a case that has no amendment.
- Text with a dash, a control character or white space at an end.
- A surface that gives the label away. A reader of only the quote must not be able to tell the
  label, so the validator measures it and refuses when:
  - the best single length threshold on the quote, in words or in characters, tells the label more
    than 70 percent of the time, or the median quotes of the two labels differ by more than 20
    percent;
  - a word that is in at least 5 quotes is in unsupported quotes less than 20 percent or more than
    80 percent of the time;
  - the rule alone, or the status alone, tells the label more than 70 or 65 percent of the time, or
    the explanation's length tells it more than 75 percent of the time;
  - more than 5 pairs in a row have one label in the order of the ids.

  The shipped set is inside every limit (`--calibration` prints the figures). It also cites the
  same paragraph in a supported and an unsupported pair six times, on purpose, with the pairs
  differing only in the claim or the quote, so the paragraph cannot tell the label either.

### The file and the hash

`calibration.json` is the pairs in canonical, formatted JSON with, for each, the paragraph index the
quote was found at and the SHA-256 of that paragraph's text, plus the playbook's slug, version and
hash and the counts. Editing a case under a pair, or the playbook, therefore changes the
calibration hash. `splits.json` records that hash and the counts under a top-level `calibration`
entry, outside the splits: `splitHash` is not given the calibration, so the hash of a split does not
move when a pair does, and the other way round. A reader of `splits.json` that looks only at
`splits` is unaffected. Code that compares the whole file with `buildDataset(...).splits` must add
the entry (`withCalibration` in `calibration.ts` does).

The builder reads the development cases it needs from `calibration.ts` (`DEV_CASE_SOURCES`) as well
as from the registry in `cases.ts`, so the set did not have to wait for a case to be registered.
All development cases are registered now, so a registered case is always the one used. It never
imports a held-out case.

### Replaying a pair

The runner step (`evals/src/parol/calibration-run.ts`, `--calibration`) takes each pair: open the
matter of `case`, find the span with `findAnchor` from `(doc, clause, quote)`, take the rule from
the playbook, send the support checker (`createSupportChecker`) the rule, the status, the
discrepancy and that one span, and compare its verdict with the label. A verdict of
`not_supported` or `insufficient` on an unsupported pair is a catch, and a verdict other than
`supported` on a supported pair is a false alarm (`scoreCalibration`, gate G11).

## Scoring

`evals/src/parol/` scores observations against `answer-keys.json`. See `score.ts` for the metric
definitions and `gates.ts` for the release gates.
