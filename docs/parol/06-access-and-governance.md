# 6. Access, review and governance

**Implementation status.** Built and tested: matter authorization on the server (one 404 for a
stranger, a missing and a deleted matter), the `AuthorizedMatter` brand with forgery scans, route
coverage, CSRF, a strict CSP and a host guard, document text fenced as data, logs that carry no
text, immutable findings, decisions and memos, the export gate, invalidation, matter deletion,
recovery and the demo identity. Added in week-two part 3 and described below: a table of global
actions for the pages that name no matter (the evaluation comparison, the pilot measures, the audit
check and the trainer's key), statuses settled in code, usage and the reported model recorded for
the `anthropic` provider, a spend guard on the application's own model calls, the retention command
and the audit verification command with a page and start-up notices, feedback capture, the pilot
measures, and error pages that say what to do. **Not built:** a scheduler for the retention command
(nothing deletes by itself), a legal hold, administrator-only approval and promotion, the debug
capture. The authorization matrix is also run by the evaluation (`--exposure`), as a test of the
application with a scripted model. **Weaker than the design:** the brand guards the service layer and
not the store; the parties check; the spend guard is the application's own and has never met a live
provider, and for a provider other than `anthropic` it checks only a bound planned before each
review (known gap 5 of [document 7](07-delivery-plan.md#known-gaps)); the global roles are a
demonstration and not access control (known gap 26). **Never run live:** how a real model treats
hostile text is unobserved; the injection tests use scripted models; usage, the reported model and
the spend cap have been read only from scripted wires.

The demo uses synthetic documents only. The controls below are real in the code, except where a
**Not met** or **Not built** note says otherwise, but the identity behind them is a labelled demo
mechanism, and several production controls are deferred and listed as such at the end.

## Threat model in brief

| Threat                                                 | Primary control                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A user reads or acts on a matter they do not belong to | Server-side matter authorization before any retrieval, generation or export                                                                                                                                                                                          |
| Document text tries to steer the review or the system  | No tools for the model; text fenced as data; every model answer validated in code                                                                                                                                                                                    |
| Model output is wrong or fabricated                    | Quote checks and deterministic consistency checks; escalation; attorney decision required before export                                                                                                                                                              |
| Stale decisions survive a document change              | Inputs digest and manifest hashes; decisions bound to finding content hashes; export re-checks both                                                                                                                                                                  |
| Sensitive text leaks into logs or errors               | Logs carry ids, route templates and counts only; errors never quote documents                                                                                                                                                                                        |
| Hostile files                                          | `@clausewise/docx` size and structure limits, including a refusal of a Word package with two parts of one name; TXT size limit; text a reader cannot see in Word (white on the page, tiny, squeezed) left out of the review and reported as hidden; nothing executed |
| Data kept longer than needed                           | Per-matter retention date (1 to 90 days, 30 by default), deletion on request, and deletion of expired matters by a command an operator runs (**Not built:** a scheduler; nothing deletes by itself)                                                                  |

The model support check, which the plan counted as a control against fabricated conclusions, is
built and isolated but off in both workflow versions the application ships, so it is not a control
today (workflow v3, which pins it, exists for the evaluation and is not registered in the
application).

## Authorization

**Where it is enforced.** One guard resolves `(user, matter, role)` for every route under
`/api/matters/:id` and the matching pages. **Deviation.** It is not a middleware but the route
declaration itself: every route is registered through `defineMatterRoute`
(`apps/parol/src/server/matter-route.ts`), which resolves the person, checks the CSRF token on a
write, authorizes against the database and only then calls the handler. A matter route registered
any other way is found by a scan. The shell's own four middleware (request context, host guard,
refusal of an address with a user part, body limit) are registered through `defineMiddleware` in
the same file, which records the function it registers, so that the route list tells them from a
handler that answers; any other route of the shell registered another way, of any method, fails the
test of the route list (`shell-routes.test.ts`, which builds the shell and not the page and API
routes). Services that read matter data accept only an `AuthorizedMatter` value, a branded
TypeScript type that only `authorizeMatter` (`src/auth/authorize.ts`) constructs.

**Not met in full.** The plan said that code reaching the store, the workflow runner, the model
layer or the exporter without passing authorization would not compile. That holds for the service
layer. The repository, the run engine and the memo builder take a matter id, not the brand, so a new
module that imported the store directly would compile without authorization. What contains it is
that every store method that reads or writes by run, finding, span, review or memo takes the matter
id first and checks the row belongs to it, and that database triggers keep every row inside its own
matter. The run reads spans by the matter id and the document versions of its manifest, and a
trigger refuses evidence that cites a span outside the run's manifest, so a bug in a stage cannot
store another matter's spans as evidence.

| Action                                                              | Check, in order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any matter route                                                    | Signed-in demo identity; a CSRF token on a write; membership (404 if none); role for the action (403 if insufficient)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Start or resume a run (retrieval, model)                            | Associate role; no run in flight; an approved playbook version; an NDA and an operative version of every document, with reviewable text; for a live provider, a bound planned from the stored documents that fits the limit for one review and the day's limit (else 409 `spend_refused`, and nothing is created). Resume only for a failed run on unchanged inputs and the same model                                                                                                                                                                                                                                                                                                                                                         |
| Read a finding                                                      | Membership; the finding is looked up in the route's matter only, so a finding of another matter is a 404. There is no route that reads a span                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Record a review decision                                            | Reviewer role; not the person who started the run (unless relaxed); finding current; content hash matches; reason present where required; a reason code for an edit or a reject, and a minor-edit mark for an edit (false unless set, never true if the status changes); no other reviewer's decision is current on the finding (a reviewer can change only their own, else 409 `decision_conflict`)                                                                                                                                                                                                                                                                                                                                           |
| Export a memo                                                       | Reviewer role; every current finding has a current decision; recomputed at export time. Exporting again with the same decisions of the same run returns the memo on record and writes nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Download a memo                                                     | Membership; memo belongs to the matter; the stored file exists (else 409 `memo_file_missing`) and still matches its recorded hash                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Delete a matter                                                     | The matter's creator or an administrator, decided from the database; another member gets 403, anyone else 404 (the plan said a user can delete earlier, not who). An administrator who is not a member can delete but is not shown the matter: a refused deletion by such a person is answered by the shell's page and never the matter's, because the matter's page would be a read beyond the deletion. The retention command deletes through the same function                                                                                                                                                                                                                                                                              |
| Approve a playbook, promote a workflow                              | **Not met.** Admin; promotion record attached. No route or page does either. The demo legal engineer imports and the demo admin approves the playbook at start-up; the store accepts any existing user as actor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Change the retention date                                           | An associate on the matter (`matter.update`): 1 to 90 days counted from now, earlier or later, audited. A reviewer or a viewer gets 403; an administrator who is not a member gets 404 (an administrator may delete a matter but cannot change its date)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Add feedback (a missed-issue report, a note on a finding, a rating) | Membership with any role, a viewer included (`feedback.add`). The item is stored for the signed-in person and for the run or finding in the path; a run or finding of another matter is a 404. A rating needs an exported memo (409 `not_exported`) and is final (409 `already_rated`); a note on a finding that is out of date is 409 `finding_not_current`; one person can report at most 50 missed issues on a run and add at most 20 notes to a finding, and the next is 409 `feedback_limit`. None of the three changes a finding, a decision or a gate of the export, and none is in the memo. A member reads every report and note of the matter and only their own rating (`GET /api/matters/:id/feedback`, which needs `matter.read`) |
| Start or stop a timer                                               | An associate or a reviewer of the matter (`time.record`), for their own timer only: no field names a person. One running timer for a person across all matters (409 `timer_open`); refused on a training matter (409 `timer_training`). The time is the server's clock between Start and Stop, and a stopped entry is final                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Record the reference list                                           | A reviewer of the matter (`reference.write`). It is closed by a database trigger once any review of the matter has started, a cancelled or failed one included (409 `reference_locked`), and refused on a training matter (409 `reference_training`). The list is recorded on the same matter that the shadow review later uses (a decision of the build that the owner may overturn: document 7, decisions of part 3, number 7)                                                                                                                                                                                                                                                                                                               |
| Start the training matter                                           | Any signed-in person, with a CSRF token (`POST /training`); they become its associate. It is made through the services as that person's own actions, so the audit log shows `matter.create` (with the training key), `document.add` and `member.add`. A second start for the same person makes nothing and says so                                                                                                                                                                                                                                                                                                                                                                                                                             |

The approval and promotion row is a gap: the plan said only an admin may approve a playbook or
promote a workflow, and in the code nothing checks the role because nothing exposes the operations.
The database does refuse a promotion without a record, a promoter and a time, and refuses to change an
approved playbook, a prompt or a workflow manifest.

**Matter actions.** The table behind the matter rows is `MATTER_ACTIONS` in
`apps/parol/src/auth/actions.ts`: 15 actions, of which week-two part 3 added two, `time.record`
(an associate or a reviewer) and `reference.write` (a reviewer). Deletion (`matter.delete`) lists no
role because it is decided apart, from the creator and the global role.

**Global actions.** A page that names no matter is gated by a second table, `GLOBAL_ACTIONS`, from
a person's global role (`member`, `legal_engineer` or `admin`). There are five actions. A matter
role says nothing here, and a global role gives no read of any matter. Nothing is allowed by
default: an action that is not in the table, or a role not listed for it, is refused. A route
declares its action when it is registered; the guard runs in this order: the person (a visitor is
sent to sign in), the CSRF token on a write, the global role (403 for a role that is not listed),
then the handler; the service behind the route checks the same action again. The role is read from
the database on each request. **A member gets 403 on all five**, and the navigation shows a link
only to a person who will be let through.

| Global action     | Roles                                                | Routes                                             | What it opens                                                                                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `evaluation.read` | legal engineer, administrator                        | `GET /evaluations`                                 | The comparison page: files that the evaluation command published to `<data folder>/evaluations`, read and shown. The service is given a source of files and no repository, so the page reads no matter. It has no form and writes nothing                                |
| `pilot.read`      | legal engineer, administrator                        | `GET /pilot`, `GET /pilot/measures.csv`            | The pilot measures and their CSV: counts with their denominators and fixed words, computed in one read across all matters (ids, flags, codes and times; no text). No figure for a person. The roster lists the display names and ids of users, which are not matter data |
| `pilot.manage`    | legal engineer, administrator                        | `POST /pilot/calendar`, `POST /pilot/participants` | The two forms of the pilot administration: the first day of the pilot and the roster of people the trainer says were trained. Neither names a matter and neither holds text. Each writes its audit event in the same transaction                                         |
| `audit.read`      | administrator only (the legal engineer too gets 403) | `GET /audit`                                       | The check of the audit log, run each time the page is opened and never stored. It lists counts, the number and fixed reason of a break, and at most 20 ids of matters that the log and the database disagree about: ids of matters the viewer may not be on              |
| `training.key`    | legal engineer, administrator                        | `GET /training/key`                                | The trainer's key to the training exercise: the answers to its seven steps and notes for the trainer, as fixed text. It names no matter                                                                                                                                  |

The first, second, fourth and fifth only read (a GET may be bound to no other action); `pilot.manage`
writes. The pilot page and the audit page are the first reads that go across matters, and both
return counts and fixed text, never a title, a name from an upload or a quote. The exposure suite
holds the same table by hand (`DOCUMENTED_GLOBAL_ROLES`) and states in its sentence the number of
places where the application's table differs from it.

**Decision taken, open to the project owner.** Which global role may open which page was a
question the build put to the owner and the owner did not answer; the recommended answer was
adopted: the legal engineer and the administrator for the evaluation page, the pilot page and the
trainer's key, the administrator alone for the audit check (document 7, decisions of part 3,
number 2). Changing it is one line of `GLOBAL_ACTIONS` and one of the hand-written table.
**These roles are not access control.** The demo identity is not authentication: anyone who opens
the sign-in page can choose to be the administrator, so the roles above are shown to follow their
table by tests, and a person who can sign in is whoever they say they are (known gap 26). The
trainer's key is a courtesy for the same reason, and it keeps the answers off the pages of a
trainee only as far as that choice is honest (known gap 35 of
[document 7](07-delivery-plan.md#known-gaps)).

**Tests.** The authorization probe matrix runs in the unit suite (`test/routes/authorization.test.ts`:
one request for every route, as every kind of caller). The matrix is also run as a step of the
evaluation (`pnpm eval:parol --exposure`), with the ids of one matter named in requests for another
(a route that takes several ids is also sent with all of them from one record of the other matter,
a route added later included), the routes that name no matter read as every caller (those restricted
to a global role among them: a member is expected to get 403, and the suite stops if a route and its
probe row name different global actions), and URLs that no route owns sent with each of GET, POST,
PUT, PATCH and DELETE as a visitor, an outsider and a member (one URL under each wildcard route that
is not the shell's own middleware among them), each of which must get the 404 of a URL that nothing
owns. It feeds gate G1 of
[document 5](05-evaluation.md#supplementary-suites); it tests the application with a scripted
stand-in for the model and not a model. The reviews it starts follow the workflow of the run, and G1
is read only from a record made under the workflow of the run it is reported for. A test enumerates
the application's matter routes and fails if any lacks the guard, if a generic route would answer a
matter URL, or, for the shell as `createApp` builds it, if any route of any method is registered
other than through the declaring functions (`test/server/shell-routes.test.ts`; a wildcard handler
that `registerRoutes` adds with `app.use` or `app.mount` under a path that names no matter
(`/legacy/*`) is found only by the exposure suite, which stops for it, whether it answers or only
hands on, unless it is declared with `defineMiddleware` (and then takes the declaration to mean
that it hands on); one under a matter's path fails the test of the matter routes as well); a
scan fails if any file other than `authorize.ts` makes an `AuthorizedMatter`
(`test/auth/brand.test.ts`, and a type-aware scan in `brand-typed.test.ts`); every route that
changes state is tested to refuse a request without its token (`test/routes/csrf.test.ts`, which
takes the routes that name no matter from the same probe table, the pilot forms and the start of the
training matter among them); a finding, run or memo id from another matter is a 404 in every place
an id can go (`test/routes/forged-ids.test.ts`); and a non-member's 404 is byte for byte the same as a missing or
deleted matter's, status, headers and body (`test/server/shell-matter.test.ts`). A new route cannot
ship unprotected by accident, but the check was shown on routes registered the wrong way inside the
tests and not by removing the guard from a real route.

**Segregation.** By default a matter's reviewer must be a different user from the associate who
started the run: a decision is refused when the person deciding started the run, and a person holds
one role on a matter. `PAROL_RELAXED_SEGREGATION=1` switches it off for single-person demos, and the
memo then says so only when the same person did both.

## Documents are data

Document text cannot reach permissions, tools or workflow rules, because none of those are
reachable from it. It can reach the review outcome, because the model reads it. The controls below
limit what a model's answer can do, and how a real model treats hostile text has not been observed:

- **No tools.** The model is called for structured output only. It cannot fetch, search, write,
  call another model or reach another matter. There is nothing for an injected instruction to
  invoke.
- **Fenced input.** Contract text is rendered with Clausewise's `renderClauses`, inside
  `<contract>` tags, with forged closing tags and forged headers neutralised. The check that finds
  a forged tag or header first folds the line to a plain form: it drops invisible characters and
  accents, reads fullwidth forms as the characters they imitate, and maps the Cyrillic, Greek and
  Armenian look-alikes of the letters of `contract` and of the `c` of a header to Latin ones, and a
  digit of any script counts as a digit. A look-alike for these letters that is not in that short
  table is not caught, and whether a real model is fooled by either kind of forgery is unobserved.
  The system prompt states that instructions inside the contract are never followed. Text that comes from intake
  rather than the file (a document title, the client name, a stated date) is flattened to one line
  with angle brackets replaced, and a value inserted into a template is never expanded as a
  placeholder.
- **Constrained output.** The model's answer only fills fields of a finding. Span labels must exist
  in the bundle; escalation ids must exist in the rule; quotes must be verified; `compliant` and
  `deviation` need a verified quote in a governing or supporting role; `missing` needs the whole
  document in the bundle; `not_applicable` needs the whole document too and is escalated on a rule
  the playbook requires. **Settled in code, for every workflow version.** The first step of verify
  applies the playbook's flags (`settledStatus` of `@clausewise/review`, through
  `apps/parol/src/settlement.ts`) before any check: a rule that forbids something is met by a
  contract without it, so `missing` and `not_applicable` become `compliant`; a rule that asks for a
  clause and is not required is `not_applicable` when no clause covers it, so `missing` becomes
  that; a required rule that no clause covers is `missing`, so `not_applicable` becomes that. The
  status the model stated is kept next to the settled one (`findings.model_status`, a
  `status_settled` row in the trail and the finding's content hash), the finding page and the memo
  say that code changed it, and every check then judges the settled claim. **What stays open:** a
  `not_applicable` that the model states directly on an optional rule is not checked against keyword
  hints, while a `missing` that settlement turns into `not_applicable` is (known gap 6 of
  [document 7](07-delivery-plan.md#known-gaps)). Settlement changed what v1, v2 and v3 do under their
  unchanged labels; that is a decision of the build that the owner may overturn (document 5,
  "Pinning and repeatability", and document 7, decisions of part 3, number 3). A model that obeyed an
  injected "mark everything compliant" would still need a verified quote for each `compliant`, but
  nothing checks in code or by a model that the quote supports the conclusion, because the model
  support check is off in both workflow versions the application ships (the evaluation-only
  workflow v3 turns it on); only durations, percentages, amounts and places in the explanation are
  compared with the quotes. The
  injection twins (cases D08 and D10 in development, H07 and H09 in the held-out set) measure
  whether a status moved, and have only been run against a scripted oracle and a scripted simulated
  reader.
- **Configuration has one source.** The playbook version, workflow version and prompts come from
  database records that no document can reach, and no stage reads configuration from document text.
  **Not built:** the plan had legal engineers and admins change them through their own routes; there
  are none, so they are registered from code and a YAML file at every start, and an approved version
  cannot be changed at the database.
- **The warning is a signal, not the control.** The `instruction_like_text` pattern warning helps
  the reviewer notice odd text. It is easy to evade and is not relied on for safety. It does three
  things: the matter page shows it with words that say the paragraph is given to the model as
  document text and that Parol cannot show a model ignored it (the number after `p` counts the
  file's paragraphs from zero, tables included); the verify check `instruction_like_text`
  escalates a finding that cites a flagged paragraph in any role, so it is `escalated_by_system` and
  an open item in the memo even if accepted; and the memo prints a "Document warnings" section, with
  counts and locations only, before its open items. **What stays open:** a model that follows such a
  paragraph and cites a genuine clause produces a finding with no flag of its own, and only the
  upload warning and the memo's warnings section say the paragraph was there. No page shows a
  flagged paragraph that no finding cites, so the reviewer has to open the file to read it.

**What the tests cover, and what they do not.** `test/stages/analyze-injection.test.ts` and
`extract-injection.test.ts` assert that hostile text stays inside the one `<contract>` block, that
forged tags and headers are defused, that nothing from a document appears outside the block, and
that a status comes only from the model's structured answer. `test/services/hostile-run.test.ts`
reviews the D08 document, which carries an embedded instruction, and shows a warning and a review
equal to its twin's. `test/stages/verify-hostile.test.ts`, `test/export/hostile.test.ts` and
`test/pages/hostile.test.ts` feed hostile strings to the checks, the memo and the pages, and
`test/ingest/hostile.test.ts` and `limits.test.ts` feed hostile files to the parsers. The scripted
models in these tests do not read the prompt, so they cannot show that a language model resists an
injected instruction. That is what the injection twins are for, and no language model has read one.

## What the feedback and pilot pages show, and to whom

- **Feedback inside a matter.** A missed-issue report (the rule it should have applied or "not
  covered by any rule", a place, a note) and a note on a finding are read by every member of the
  matter, a viewer included. A rating (1 to 5, with optional words) is read by the person who gave
  it and by no other member: the service returns the caller's own rating and has no function that
  returns another person's. The reason code and the minor-edit mark of a decision are shown in the
  decision history of the finding, to everyone who can read the finding. None of these changes a
  finding, a decision or the export, and none is in the memo.
- **What the text of feedback can hold.** A note, a report, its place and the words of a rating are
  typed by a person and are not checked against the documents, so they can hold pasted document
  text (known gap 37 of [document 7](07-delivery-plan.md#known-gaps)). They are stored with the
  matter, never written to the audit log or a log line (the log keeps kinds, rating marks, rule keys
  and the flags `hasText` and `hasLocation`), and deleted with the matter. The pilot page and the
  CSV never carry them.
- **The pilot page and the CSV** (the legal engineer and the administrator, `pilot.read`) show
  counts with their denominators and fixed words, and "no data" with a stated reason where a measure
  has none. They show no matter name, title, note, report, reason, quote or file name; no figure for
  a person (the method lines of the page say that with a small group a total can still be
  recognised, and that the file should go to the sponsor and the legal engineer only); and a median
  of ratings with the number behind it, minimum and maximum. Ratings given by viewers are counted
  apart and are not in the median. The pilot scope counts only matters that are not synthetic and
  whose people are not demonstration identities; training matters are in neither scope; the page
  says in fixed words that the pilot scope is empty on this build, that it counts stored events,
  and that it judges no acceptance criterion and recommends neither go nor no go. The roster names
  users (display name and id), which are not matter data. A matter deleted by its creator, an
  administrator or the retention command leaves every measure, and the audit log keeps only ids and
  counts of it.
- **The evaluation page** shows comparisons of results files, the text of the synthetic cases of
  `fixtures/parol` for the passages of an answer key, and a draft of a promotion record as text; it
  shows nothing of any matter.
- **The audit page and the trainer's key** are described in the table above and in "The audit
  check".

## Review gates

All five gates are built and tested.

1. **Before a run**: an approved playbook version and exactly one operative NDA version; duplicate
   and near-duplicate uploads resolved. An identical file is stored once and warned about; a file
   with the same text and a different hash is stored unused, with a warning, until the associate
   chooses it, and does not make the review stale.
2. **After verify**: findings that failed a check are marked `escalated_by_system` and show the
   failed check; unverified quotes are struck through and excluded from export.
3. **Decision**: only a reviewer decides. Edit, reject and escalate need a reason, an edit or a
   reject also needs one of six reason codes, an edit also carries a minor-edit mark (the box on the
   form; false when left unticked, and refused as true when the edit changes the status), and an
   edit must change something. Each decision is bound to the finding content it was made on, and a
   decision on content that has moved on is a 409.
4. **Export**: every current finding has a current decision. Escalated findings appear in an "Open
   items" section at the top of the memo, never silently dropped, and so does an accepted or edited
   finding whose conclusion is `undetermined`. Rejected findings are listed in an appendix so a later
   reader can see what was considered, with the rule, its severity, the reviewer, the date and the
   reviewer's reason, and nothing of the finding's text or of the status the workflow proposed.
5. **After export**: any input change marks the memo superseded and blocks a new export until the
   matter is re-run and re-decided. A re-run on unchanged inputs keeps the earlier memo current until
   the new review is exported, so a page must not read "a memo exists" as "this review was exported".
   The memos page and the matter page label such a memo "Earlier review" and say a newer review has
   been started and not exported; a JSON client sees the memo's status as `current` and has to
   compare the memo's `runId` with the matter's current run. A superseded memo downloads under a
   different file name (`-superseded-` and eight characters of the memo id before `.docx`), because
   the stored file itself is kept as built under its recorded hash and cannot carry the marker.

## Minimal sensitive logging

| Where                    | What is recorded                                                                                                                                                                                                                                                                                                                                                                                                                                                | What is never recorded                                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server log (stdout)      | Request id, method, route template, status, latency, user id, matter id (as the database confirmed it), error class                                                                                                                                                                                                                                                                                                                                             | Bodies, headers, query strings, path values, file names, document text, quotes, prompts, messages                                                       |
| `audit_events`           | Action, actor, target ids, hashes, counts and closed codes; hash-chained and append-only; every string at most 200 characters, two levels deep. A decision records its reason code and minor-edit mark; feedback records its kind, rating, rule key and flags (`hasText`, `hasLocation`); a deletion records row counts, its reason and the retention date; the retention events, the pilot events and the timer events hold ids, dates, counts and short codes | Document text, quotes, finding text, review reasons, titles, client names, and the text of a note, a missed-issue report, its place or a rating comment |
| `model_calls`            | Stage, rule, prompt version, request hash, outcome, latency; for the `anthropic` provider also the four token counts the provider reported, an estimated cost and the hash of the price table (all four counts or none; a stand-in, or another provider, leaves them empty)                                                                                                                                                                                     | Prompt text, response text                                                                                                                              |
| `spend_ledger`           | One row for each UTC day: the number of responses, token totals, a cost total and the number of responses that could not be priced. A trigger lets it only grow, and nothing deletes a row                                                                                                                                                                                                                                                                      | A matter, a run, a person, an id or any text                                                                                                            |
| `run_stages.output_json` | Stage outputs needed to resume and inspect (matter-scoped, deleted with the matter)                                                                                                                                                                                                                                                                                                                                                                             | Anything from another matter                                                                                                                            |
| Error messages           | A fixed message for each kind of error and a short code; each error page and refusal notice carries a fixed, marked "what to do" sentence; a log line names an unexpected error by its class only; a server that cannot start prints one sentence made from the class of the failure and a code of fixed shape                                                                                                                                                  | Document text, API keys, anything the caller typed, a path, a secret, the message of an error nobody wrote a sentence for                               |
| Evaluation results       | A results file under `evals/results/` (counts, ids, hashes, closed codes and the evidence trails of document 5, never a model answer) and, for a live run, a recording of the model's answers beside it, which quotes the synthetic documents; git ignores both. The comparison files that `--publish` writes to `<data folder>/evaluations` hold the same kind of data and the synthetic case text                                                             | Any non-synthetic matter, and any training matter: the runner reads only `fixtures/parol`, and the database refuses both                                |

A request that never reached the application (Node's parser refused it, it had no `Host`, or its
framing could not be trusted) still gets one line, with method `OTHER`, route `(unmatched)`, no
user and no matter, and a fixed error code such as `HPE_INVALID_METHOD` or `MissingHostHeader`
(checked by sending such requests to a running server).

Three messages are not fixed: an upload error (its own words, control characters stripped, capped at
300 characters), the reasons a review cannot start (fixed phrases, at most 20) and the words of a
spend refusal, which are fixed sentences around three or four figures of money (the planned bound,
the limit, and what is used or set aside). None repeats a document, and the spend words name no
matter, run, user or document.

**What the audit log does not record.** It records changes. It does not record who read a page, and
it does not record a request that was refused, by decision. A refusal is a 403 or 404 line in the
access log, which names the user and the route and not the matter, goes to standard output and is
not stored (redirect standard output to keep it). The evidence for "no unauthorized access" is the
probe matrix and the exposure suite, which test the guard; it is not a count of refusals, because a
refusal is the control working. Neither has met a real model or a real pilot. The audit page says the
same in its own words (`test/pages/audit-page.test.ts`).

**Enforced by tests.** `test/e2e/access-log.test.ts` runs the whole story of the worked example with
a marker planted in every field of that story that a person can type or upload (names, titles, file
names, a reason, the path, the query string and the headers), and then finds none of it in the
access log, the service log, the audit trail or any error page. The text of a note, a missed-issue
report, its place and a rating comment is checked against the audit trail, the logs and the errors
by `test/services/feedback-privacy.test.ts`. `test/server/shell-log.test.ts` does the same for a
body, a query string, a header, a file name and a path id. `test/store/no-text-leaks.test.ts` and
`test/services/privacy.test.ts` scan every table and column for a planted marker, and check that the
tables that hold text by design are the only ones that do. `test/stages/verify-hostile.test.ts`
checks that no check detail or escalation holds document text.

**Not built:** the debug capture of full prompts for synthetic matters behind an environment flag.
Nothing in the code records a prompt or a response, so there is nothing to leak, and nothing to
inspect when a model call misbehaves except its hash and outcome.

## Retention and deletion

- **The date.** Each matter has `retain_until`, shown on the matters list, which marks a date that
  has passed with a "Past" chip (a shape and the word). It is set when the matter is created, 30
  days later by default. The new-matter form takes 1 to 90 days, and so does an associate on the
  matter page ("How long this matter is kept"), counted from the moment of the change, earlier or
  later. Each change is audited (`matter.retention`, with the old date, the new date and the days),
  and the date is not an input of any review. There is no legal hold, and an associate can extend
  the date again and again. The ceiling of 90 days is a placeholder for the answer to question 17 of
  [document 1](01-product-brief.md), which nobody has given. A matter's creator or an administrator
  can delete it earlier, from the matter page or `DELETE /api/matters/:id`; a review in flight is
  cancelled first.
- **The command.** `pnpm parol:retain [--apply] [--max-matters N] [--as-of TIME] [--json]` finds the
  matters whose date has come. It is a dry run unless `--apply` is given: it lists the matters (ids,
  statuses, times and counts; never a name or a title), with the number of matters in the database as
  the denominator, and changes nothing. `--apply` refuses to run while the server is up, because it
  takes the same exclusive lock on the data folder (exit 2, with the instruction to stop the server and
  run it again): the deletion
  rewrites the database file, and the server holds parsed document text in memory that only it can
  drop. A matter with a review in flight is skipped. `--max-matters` (25 by default, at most 1000;
  25 is a chosen number, not a measured one) is a guard against a wrong clock: when more matters are
  past their date than the limit, nothing is deleted (exit 3). `--as-of` is for a dry run only.
  Exit codes: 0 it finished and nothing is wrong (a dry run that lists matters is 0); 1 it ran and
  something is wrong (a matter or folder could not be removed, compaction failed, or the audit chain
  does not verify; the deletions that could run did run); 2 it could not run (usage, no database,
  the folder in use); 3 it refused because of `--max-matters`. When more than one holds, 2 wins over 1
  and 1 over 3, so a broken audit chain is never hidden behind a refusal. A dry run opens the
  database read only and leaves an empty `parol.sqlite-wal` and a `parol.sqlite-shm` beside it. Who
  may run it: whoever can run commands against the data folder; it is not a role of the application,
  and the actor of its events is the system. **Nothing runs it by itself**: no scheduler ships, and a
  scheduled run would have to stop and start the server around it (known gap 17 of
  [document 7](07-delivery-plan.md#known-gaps) lists what is left). **Decisions taken, open to the
  owner:** that `--apply` refuses beside a running server, and the 30-day default (document 7,
  decisions of part 3, numbers 5 and 6).
- **Deviation.** Deletion removes the matter's rows in one transaction: `eval_slot_results` for its
  runs, `reviews`, `feedback`, `memos`, `time_entries`, `verification_results`, `finding_evidence`,
  `findings`, `model_calls`, `run_stages`, `runs`, `reference_issues`, `span_annotations`,
  `ingest_warnings`, `source_spans`, `document_versions`, `documents`, `matter_members` and the
  `matters` row itself (19 tables; `deleteMatter` in `apps/parol/src/store/repo-matters.ts`). The
  reference list goes after the runs because a trigger closes it while a review of the matter exists.
  Still inside the transaction, a table that holds a row of the matter and that this list does not
  know undoes the whole deletion (409 `matter_residue`), so a table added later cannot keep a
  matter's rows by being forgotten. Then it removes the matter's files and compacts the database
  (`secure_delete` is on; a checkpoint that empties the log, then `VACUUM`). The plan had the files
  first. A stop between the steps leaves a folder that no row names; the retention command removes
  it, and so does the sweep at start-up. The command compacts once per run, after all its matters,
  then writes one `retention.run` event (an apply run that found nothing is on record too, so a job
  that found nothing and a job that never ran can be told apart) and checks the audit chain. An
  interactive deletion compacts after its own matter; if another connection is reading at that
  moment, compaction fails, the matter is deleted anyway, a fixed line is logged, and the text
  leaves the log at a later checkpoint. An audit event records the deletion with ids, counts, the
  reason (a person's deletion or retention) and the retention date; earlier audit events keep their
  ids and hashes, which reveal no text. `test/store/retention.test.ts` checks that no row of the
  deleted matter remains and that no text of it is left in the database file, and
  `test/services/deletion-leaves-nothing.test.ts` fills every table that holds a matter's rows and
  checks that deletion leaves none.
- **What a deletion does not touch.** The spend ledger is kept, on purpose: it holds a date and
  numbers, and deleting a matter must not lower a limit that was reached. The pilot calendar and the
  roster of trained people name no matter. The comparison files in `<data folder>/evaluations` hold
  no matter data. The audit events keep their ids, codes and counts.
- **The start-up notices.** When the server starts it checks the audit chain and counts the matters
  past their date, and prints a notice on standard error: "N of M matters are past their retention
  date. The server deletes nothing. Run pnpm parol:retain to see them", and a warning when the chain
  does not verify, with the number of the first broken event and a fixed reason. Neither is printed
  when the chain verifies and no matter is past its date. Both are advice: the server deletes
  nothing, a matter past its date stays open and usable, and a check that fails to run is reported
  in a fixed line and never stops the start.
- **Retention against the length of the pilot.** The pilot is five weeks and the default is 30 days,
  so a matter made in week one is deleted before the pilot ends, and with it its feedback, timers,
  reference list and decisions: it leaves every measure computed from stored events. The pilot page
  counts the in-scope matters whose date falls before the end of week 5 and tells the reader to
  download the CSV before then; the CSV, downloaded every week, is the record; the pilot operator can
  choose longer dates (up to 90 days) on the new-matter form. This is stated here once; documents 7
  and 8 refer to it (known gap 31 of [document 7](07-delivery-plan.md#known-gaps)). No pilot has run,
  so no measure has yet lost a matter. A training matter expires like any matter.
- File deletion on modern disks is not secure erasure. Production would rely on encrypted storage
  and key destruction. This document states the limit; the demo itself does not say it anywhere.
- The model provider is outside this control. With prompt caching, the provider may keep text for
  a short time under its own terms; production needs a provider agreement on retention and
  training, or a local model.

## The audit check

The audit log is hash-chained: each event holds the hash of the one before it, and a trigger lets the
table only grow. Four things check it (`verifyAuditChain` and `checkAudit` in
`apps/parol/src/store/audit.ts`): the command `pnpm parol:audit-verify [--json] [--expect-head
SEQ:HASH]`, which opens the database without migrating or writing and so can run beside the server;
the page `GET /audit` for an administrator, which runs the whole check each time it is opened and
stores nothing; the start-up notice above; and the retention command, which checks after its writes.
The check itself only reads.
Exit codes of the command: 0 the chain holds and every matter is accounted for, 1 it is broken (the
chain, the anchor, or the matters against their events), 2 it could not run. The output prints no
column of an audit row: only the number of the first broken event, a fixed reason and its words, the
head hash (only when it has the shape of one) and counts and ids of matters (only when they have the
shape of one), because the command exists for a log that someone else may have written. The matters
are reconciled with their events: matters created and gone with no deletion event, matters present
with no creation event, and matters present although a deletion event names them. **What the check
cannot show**, and the page says so under "What this check does not show": the log is in the same
file as the data; the hash is not keyed, so someone who can write the file and recompute every later
hash makes a log that verifies; the number of the newest event is kept in that file too; a head
recorded somewhere the writer of the database cannot edit (`--expect-head`) closes the last two only
for the history up to the event it names, and nothing runs that habit for the operator. The chain is
checked from its first event, so a break is reported by every later run, and an append-only chain
cannot be repaired (known gap 17 of [document 7](07-delivery-plan.md#known-gaps)).

## Run provenance

Every run records its input manifest (document version and text hashes, client name, playbook and
workflow version hashes), the requested model, each call's prompt version, request hash, outcome and
latency, each stage's input and output hashes, and the user who started it. For the `anthropic`
provider it also records what the provider reported: the four token counts of each call, an estimated
cost with the hash of the price table that priced it, and the model or models the provider named in
its responses (`runs.model_reported`). The review page says which model answered ("Answered by X",
"Answered by X (requested Y)", "Requested Y; the provider did not say which model answered", or
"Read by a scripted stand-in") and has a Usage section. The memo's appendix prints the recorded
fields in readable form, with a `Usage:` line of token counts, from how many of how many recorded
calls, and never a cost: the memo is the document that leaves the system, and a price table is the
operator's configuration and not a fact about the legal work. Each quotation is re-verified against
the stored text at export. A run can be repeated from its manifest, subject to the stochastic limits
in [document 5](05-evaluation.md#pinning-and-repeatability).

**Not met in full.** Built and tested: the manifest (with the requested provider and model, the
stated dates and the document labels), each call's prompt version, request hash, outcome and
latency, each stage's input and output hashes, who started the run, the memo's appendix, and the
quotation re-check at export (`test/export/gates.test.ts`). Usage and the reported model are recorded
for the `anthropic` provider only: the adapters of `openai` and `openai-compatible` report nothing,
so for them the columns stay empty and the pages say that the provider did not report usage (known
gap 11 of [document 7](07-delivery-plan.md#known-gaps)). **Nothing has been read from a live
provider.** The readers were tested against scripted wires whose reply shape is the tests' own
reading of the Messages API, and a streamed reply (`max_tokens` above 21,333) was tested for the
model-name reader but not through the SDK's stream path. A response that arrives after a run has
ended is not recorded in `model_reported`. A call that a spend stop cut short is counted in the
day's total and has no row of its own. A run made by the scripted stand-in has no usage and says so;
the stand-in is not a model, and a record of what it "used" would be false.

## Spend limits

The application has a spend guard of its own, built in week-two part 3 (before it, only the
evaluation runner had one; the application had none). It has never met a live provider.

- **At start-up.** A server that calls a model refuses to start unless it is given both limits in US
  dollars, `PAROL_MAX_REVIEW_COST_USD` (what one review may cost) and `PAROL_MAX_DAILY_COST_USD`
  (what all reviews may cost in one UTC day, at least the first), and a price file,
  `PAROL_PRICES_FILE`, that has a price for the configured model. Parol has no default limit and no
  built-in price: a limit in money is a statement that only whoever runs the server can make. It also
  refuses a price of zero for a hosted provider, a fallback model (`CLAUSEWISE_FALLBACK`) whose price
  the file would not hold, and, unless `PAROL_SPEND_BOUND_ONLY=1`, a provider other than `anthropic`,
  whose responses the application cannot count. `PAROL_ASSUMED_OUTPUT_TOKENS` sets the output length
  assumed for each call in the bound (1500 by default, the evaluation's figure). A scripted stand-in
  needs none of this and, if any spend variable is set, prints a notice naming the ones it ignores. **Decision taken,
  open to the owner** (document 7, decisions of part 3, number 4).
- **Before a review.** Starting a review, and resuming one, plans a bound from the stored documents
  (the calls the stages will make, their input counted high, each output assumed) and refuses, with
  409 `spend_refused` and a sentence that says what to do, when the bound would pass the limit for
  one review or the day's limit (the ledger plus what reviews in progress may still spend). Nothing is
  created, so the matter and any earlier results are as they were. The refusal names the limits, the
  planned bound and one figure for the day, used or set aside: an aggregate over all matters, and
  no matter, run, user or document. It is told in its own words on the page that asked for the review;
  a test scans the four places that start or resume a review and fails for a fifth that could end on
  the shell's page (`test/routes/spend-shell.test.ts`).
- **While a review runs** (`anthropic` only). A request that could take the recorded spend past either
  limit is held back, and the review ends `failed` with the run error kind `spend_review_limit` or
  `spend_daily_limit`. Its finished units are kept and it can be resumed after a limit is raised.
  For `openai` and `openai-compatible`, with `PAROL_SPEND_BOUND_ONLY=1`, nothing is checked while a
  review runs and the day's limit counts nothing.
- **The ledger.** `spend_ledger` holds one row for each UTC day (counts, token totals and a cost
  total, with no id). It only grows, and deleting a matter or running the retention command leaves it
  alone, so a limit that was reached cannot be lowered by deleting the matters that reached it.
- **What the guard does not give.** The bound is an estimate under stated assumptions, not a ceiling;
  a wrong price or a prompt larger than planned can take a review past a limit before a response
  stops it. The prices are the operator's file and are not checked against any price list. A call cut
  short by a stop is in the day's total and not in the run's call rows. Known gap 5 of
  [document 7](07-delivery-plan.md#known-gaps) holds the whole list.

## Recovery from partial failures

All ten rows are built and tested.

| Failure                                            | State afterwards                                                                                                                                                                                                                      | Recovery                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One rule's model call fails after retries          | Run succeeds; that finding is `undetermined` with `output_invalid` (or `context_over_budget`, with no call)                                                                                                                           | Reviewer decides it, or the associate re-runs                                                                                                                                                                             |
| Provider rejects the key or the model              | Run `failed` with an `error_kind` (`provider_auth`, `provider_permission`, `provider_model`, `provider_billing`, `provider_redirect`); completed units kept                                                                           | Fix configuration, resume. Resume is refused if the provider or model changed: start a new review instead                                                                                                                 |
| A spend limit is reached while a review runs       | Run `failed` with `spend_review_limit` or `spend_daily_limit`; completed units kept; the request that would have passed the limit was not sent                                                                                        | Whoever runs the server raises the limit (a setting read at start-up) and restarts it, then the associate resumes: only the units not finished are planned and paid for. Tested against a scripted wire; `anthropic` only |
| Server stops mid-run                               | On restart, run `failed` with `interrupted`; the page offers Resume. The matter returns to `ready`, or to `stale` when it holds findings of an earlier review                                                                         | Resume skips units whose input hash is unchanged                                                                                                                                                                          |
| Database cannot be written when a run ends         | The runner tries the write again, after 100 ms and then at growing intervals up to 5 s, until it works; the run keeps its queue slot, so a shutdown waits (a second signal stops at once). The run then ends `failed` with `internal` | Resume; the finished units are skipped. With no bound on the retries, a database that never recovers keeps the run `analyzing` until the process stops, and the next start marks it `interrupted`                         |
| A second server on the same data folder            | Refused before anything is touched: an exclusive lock on `parol.lock` in the data folder is held for the life of the process, and the OS drops it when the process ends, however it ends                                              | Stop the first server, or use another folder                                                                                                                                                                              |
| Upload cannot be parsed                            | Nothing stored; reason shown                                                                                                                                                                                                          | Upload a readable file                                                                                                                                                                                                    |
| Export fails part-way                              | No memo row, no partial file (temporary file and rename; a file saved before a refused row is taken back)                                                                                                                             | Export again. Exporting the same decisions of the same run a second time returns the memo on record                                                                                                                       |
| Database write fails during a decision             | Transaction rolled back; decision not recorded; user sees the error                                                                                                                                                                   | Retry; the content-hash check prevents a double decision on changed content, and a decision by another reviewer on unchanged content is refused (`decision_conflict`)                                                     |
| The retention command stops between rows and files | The rows of a matter are gone (one transaction per matter) and its folder is not, or a folder that no row names remains                                                                                                               | The next run of the command, or the next start of the server, removes a folder that no row names; the command reports it as an orphan folder and exits 1 if one could not be removed                                      |

Tests: `test/services/runs-failures.test.ts` (the first two rows, the server-stops row, and a run
that is resumed), `test/usage/guard-cap.test.ts` (the spend stop and its resume, over a scripted
wire), `test/retention/job.test.ts` (the retention row), `test/services/runs-settle.test.ts` (the
database row) and `test/server/shell-single-instance.test.ts` (the second server),
`test/store/files-atomic.test.ts` and `test/export/failure.test.ts` (the export row),
`test/services/uploads.test.ts` (the upload row) and `test/store/audit-atomicity.test.ts` (a
rollback takes its audit event with it).

## Demo identity

All of this is built and tested.

- Enabled only when `PAROL_DEMO_IDENTITY=1`. The user picks a seeded identity (associate,
  reviewer, legal engineer, admin: Alex Ruiz, Dana Whitfield, Lee Okafor and Sam Patel); the server
  sets an HMAC-signed, `HttpOnly`, `SameSite=Strict` cookie with that user id, valid for eight hours
  and marked `Secure` when `PAROL_SECURE_COOKIES=1`. Without the flag there is no way to sign in:
  the server says so at start, and the start page is titled "Sign-in is switched off", names
  `PAROL_DEMO_IDENTITY=1` and lists no identity and no form. The demo users exist in the database
  either way, because they import and approve the demo playbook.
- **It is not authentication.** Anyone at the keyboard can be anyone. A banner on every page says
  "DEMO: synthetic documents, demo identity, not for client work", and a test pins its words. The
  global roles of the table above are therefore not access control either: whoever opens the
  sign-in page can choose the administrator, and so can read the evaluation page, the pilot page, the
  audit check and the trainer's key. Every user the database can hold is a demonstration identity
  (`users.demo` is checked to 1), which is why the pilot scope of the measures page is empty on
  every database this build can make (known gap 30 of
  [document 7](07-delivery-plan.md#known-gaps)); demonstration identities and synthetic matters are
  counted in the synthetic scope only, and what that page shows is not a pilot result.
- With demo identity on, the server listens on `127.0.0.1`, `::1` or `localhost` only and refuses to
  start on another address (`PAROL_HOST=0.0.0.0` exits 1 with an explanation; checked by running it).
- **Added: a host guard.** With demo identity on, a request whose address or `Host` header is not one
  of those names is answered 403 (`src/server/middleware/host-guard.ts`). Binding to loopback keeps
  other machines out; it does not stop a web page from reaching the server by a hostile name that
  points at 127.0.0.1 (DNS rebinding), which would let that page read every page and post every form
  of a passwordless demo. The 403 page says what to do: open Parol at `http://localhost` followed by
  the port it was started on.
- **Sign-out** ends the session on the server for that cookie until it would have expired, but the
  record is in memory: after a restart with a fixed `PAROL_COOKIE_SECRET` a cookie copied before
  sign-out works again until its eight hours end. With the default random secret a restart ends every
  session.
- Real controls that are in the demo regardless of identity: authorization on every route, CSRF
  tokens on every form (a visitor with no session gets a short-lived anonymous cookie that the
  sign-in form's token is bound to, so sign-in itself cannot be forged), a strict Content Security
  Policy with no inline script and no grant for images or fonts, `X-Frame-Options`, `no-store` on
  pages, output escaping by default (Hono JSX), upload limits (10 MB by default,
  `PAROL_MAX_UPLOAD_BYTES`). Direction marks and control characters in document text are shown as
  visible markers.
- **Requests refused below the application.** A request that Node's own HTTP parser rejects (a
  malformed request line, a header or a cookie over the size limit, a bad length or chunk size), one
  with no `Host` header, one whose `Transfer-Encoding` does not end in `chunked`, and one whose
  address has a user or password part are answered with a short page that carries the security
  headers and a request id, and each is logged once, with method `OTHER`, route `(unmatched)` and a
  fixed code such as `HPE_HEADER_OVERFLOW` as its error (`src/server/middleware/rejected.ts`; the
  address with a user part is refused inside the application, after the host guard and before the
  body limit, with a 400). The statuses are 400, 408 and 431. **Known limits.** When the application
  has already sent response headers and the parser then fails, the handler only closes the socket
  and logs nothing, because no refusal was sent. HTTP/1.0 without a `Host` is served as before.

## Deferred until production

Single sign-on with the firm's identity provider and multi-factor authentication; matter-centric
security and ethical walls synchronised from the document management or conflicts system;
encryption at rest with managed keys; backups and tested restore; central log shipping and
alerting; data loss prevention review of exports; provider agreements on retention and training (or
a local model); a penetration test; dependency and vulnerability management in CI; alignment of
retention with the firm's records policy and legal holds (none exists: an associate can extend a
matter's date again and again); concurrent multi-user editing; rate limiting; accessibility
conformance testing (keyboard and contrast checks exist; see document 7, known gap 21); and a formal
change-approval process for playbook and workflow promotions.

## Planned here and not built

These are controls this document described for the demo itself, not production extras, and the
code does not have them. Each is also noted where it appears above. Items that part 3 built are no
longer listed; what is left of them is.

- A scheduler for the retention command. The command, the audit check and the start-up notices
  exist; nothing runs the command by itself, so a matter past its date stays open and usable until
  an operator runs it.
- A head of the audit chain kept outside the data folder. The command and the page exist, and
  `--expect-head` takes such a head, but nothing records one: the check is only as good as the
  operator's habit, and without it the hash (which is not keyed) cannot show a log that someone
  rewrote and rehashed.
- Administrator-only approval of a playbook and promotion of a workflow, with a screen for each.
  Today the operations are not reachable, and the store does not check the actor's role.
- Probing the application with a real model behind it: the exposure suite in the evaluation runs
  the application in process with a scripted stand-in, so what a language model does with another
  matter's text is unobserved (gate G1 is evaluated for the application, not for a model).
- Usage, cost and the reported model for providers other than `anthropic`, and any reading of them
  from a live provider; the same for the spend cap while a review runs.
- The debug capture of prompts for synthetic matters.
- Authorization carried by type into the store and the run engine, so that a module that skips the
  service layer would not compile.
- A parties check that looks for the client's name in the parties passage and not anywhere in the
  bundle. (The status settlement that this list once named is built.)
- Any measurement of how a real model treats hostile document text. No model has read a document in
  this project.
