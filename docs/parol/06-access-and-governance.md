# 6. Access, review and governance

**Implementation status.** Built and tested: matter authorization on the server (one 404 for a
stranger, a missing and a deleted matter), the `AuthorizedMatter` brand with forgery scans, route
coverage, CSRF, a strict CSP and a host guard, document text fenced as data, logs that carry no
text, immutable findings, decisions and memos, the export gate, invalidation, matter deletion,
recovery and the demo identity. **Not built:** the job that deletes expired matters, an audit
verification command, administrator-only approval and promotion, evaluation screens, token and cost
records, the debug capture. The authorization matrix is also run by the evaluation (`--exposure`),
as a test of the application with a scripted model. **Weaker than the design:** the brand guards the service layer and not
the store; statuses are not settled in code; the parties check; no spend guard. **Never run live:**
how a real model treats hostile text is unobserved; the injection tests use scripted models.

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
| Data kept longer than needed                           | Per-matter retention date and deletion on request (**Not built:** the scheduled job that deletes expired matters)                                                                                                                                                    |

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

| Action                                   | Check, in order                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any matter route                         | Signed-in demo identity; a CSRF token on a write; membership (404 if none); role for the action (403 if insufficient)                                                                                                                                                 |
| Start or resume a run (retrieval, model) | Associate role; no run in flight; an approved playbook version; an NDA and an operative version of every document, with reviewable text. Resume only for a failed run on unchanged inputs and the same model                                                          |
| Read a finding                           | Membership; the finding is looked up in the route's matter only, so a finding of another matter is a 404. There is no route that reads a span                                                                                                                         |
| Record a review decision                 | Reviewer role; not the person who started the run (unless relaxed); finding current; content hash matches; reason present where required; no other reviewer's decision is current on the finding (a reviewer can change only their own, else 409 `decision_conflict`) |
| Export a memo                            | Reviewer role; every current finding has a current decision; recomputed at export time. Exporting again with the same decisions of the same run returns the memo on record and writes nothing                                                                         |
| Download a memo                          | Membership; memo belongs to the matter; the stored file exists (else 409 `memo_file_missing`) and still matches its recorded hash                                                                                                                                     |
| Delete a matter                          | The matter's creator or an administrator, decided from the database; another member gets 403, anyone else 404 (the plan said a user can delete earlier, not who)                                                                                                      |
| Approve a playbook, promote a workflow   | **Not met.** Admin; promotion record attached. No route or page does either. The demo legal engineer imports and the demo admin approves the playbook at start-up; the store accepts any existing user as actor                                                       |
| Evaluation screens                       | **Not built.** Legal engineer; synthetic matters only. The database refuses evaluation results for a matter that is not synthetic                                                                                                                                     |

The approval and promotion row is a gap: the plan said only an admin may approve a playbook or
promote a workflow, and in the code nothing checks the role because nothing exposes the operations.
The database does refuse a promotion without a record, a promoter and a time, and refuses to change an
approved playbook, a prompt or a workflow manifest.

**Tests.** The authorization probe matrix runs in the unit suite (`test/routes/authorization.test.ts`:
one request for every route, as every kind of caller). The matrix is also run as a step of the
evaluation (`pnpm eval:parol --exposure`), with the ids of one matter named in requests for another
(a route that takes several ids is also sent with all of them from one record of the other matter,
a route added later included), the routes that name no matter read as every caller, and URLs that no
route owns sent with each of GET, POST, PUT, PATCH and DELETE as a visitor, an outsider and a member
(one URL under each wildcard route that is not the shell's own middleware among them), each of which
must get the 404 of a URL that nothing owns. It feeds gate G1 of
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
changes state is tested to refuse a request without its token (`test/routes/csrf.test.ts`); a
finding, run or memo id from another matter is a 404 in every place an id can go
(`test/routes/forged-ids.test.ts`); and a non-member's 404 is byte for byte the same as a missing or
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
  the playbook requires. **Not met:** the plan also said statuses are settled by code against the
  playbook's required and absence semantics. The helper exists (`settledStatus` in
  `@clausewise/review`) and no Parol stage calls it, so the status is the model's, and only the
  checks around it are code. The one place `rule.required` is read is that `not_applicable` check;
  a `missing` answer for the optional rule `ret-1` is not corrected. A model that obeyed an injected "mark everything compliant" would still
  need a verified quote for each `compliant`, but nothing checks in code or by a model that the quote
  supports the conclusion, because the model support check is off in both workflow versions the
  application ships (the evaluation-only workflow v3 turns it on); only
  durations, percentages, amounts and places in the explanation are compared with the quotes. The
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

## Review gates

All five gates are built and tested.

1. **Before a run**: an approved playbook version and exactly one operative NDA version; duplicate
   and near-duplicate uploads resolved. An identical file is stored once and warned about; a file
   with the same text and a different hash is stored unused, with a warning, until the associate
   chooses it, and does not make the review stale.
2. **After verify**: findings that failed a check are marked `escalated_by_system` and show the
   failed check; unverified quotes are struck through and excluded from export.
3. **Decision**: only a reviewer decides. Edit, reject and escalate need a reason, and an edit must
   change something. Each decision is bound to the finding content it was made on, and a decision on
   content that has moved on is a 409.
4. **Export**: every current finding has a current decision. Escalated findings appear in an "Open
   items" section at the top of the memo, never silently dropped, and so does an accepted or edited
   finding whose conclusion is `undetermined`. Rejected findings are listed in an appendix so a later
   reader can see what was considered, with the reviewer's reason and the status the workflow
   proposed, and nothing of their text.
5. **After export**: any input change marks the memo superseded and blocks a new export until the
   matter is re-run and re-decided. A re-run on unchanged inputs keeps the earlier memo current until
   the new review is exported, so a page must not read "a memo exists" as "this review was exported".
   The memos page and the matter page label such a memo "Earlier review" and say a newer review has
   been started and not exported; a JSON client sees the memo's status as `current` and has to
   compare the memo's `runId` with the matter's current run. A superseded memo downloads under a
   different file name (`-superseded-` and eight characters of the memo id before `.docx`), because
   the stored file itself is kept as built under its recorded hash and cannot carry the marker.

## Minimal sensitive logging

| Where                    | What is recorded                                                                                                                                 | What is never recorded                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Server log (stdout)      | Request id, method, route template, status, latency, user id, matter id (as the database confirmed it), error class                              | Bodies, headers, query strings, path values, file names, document text, quotes, prompts, messages |
| `audit_events`           | Action, actor, target ids, hashes, counts; hash-chained and append-only; every string at most 200 characters, two levels deep                    | Document text, quotes, finding text, review reasons, titles, client names                         |
| `model_calls`            | Stage, rule, prompt version, request hash, outcome, latency. **Not built:** tokens and estimated cost (the columns exist and nothing fills them) | Prompt text, response text                                                                        |
| `run_stages.output_json` | Stage outputs needed to resume and inspect (matter-scoped, deleted with the matter)                                                              | Anything from another matter                                                                      |
| Error messages           | A fixed message for each kind of error and a short code; a log line names an unexpected error by its class only                                  | Document text, API keys, anything the caller typed                                                |
| Evaluation results       | Full outputs in a JSON file under `evals/results/` (ignored by git), because the data is synthetic                                               | Any non-synthetic matter: the runner reads only `fixtures/parol`, and the database refuses it     |

A request that never reached the application (Node's parser refused it, it had no `Host`, or its
framing could not be trusted) still gets one line, with method `OTHER`, route `(unmatched)`, no
user and no matter, and a fixed error code such as `HPE_INVALID_METHOD` or `MissingHostHeader`
(checked by sending such requests to a running server).

Two messages are not fixed: an upload error (its own words, control characters stripped, capped at
300 characters) and the reasons a review cannot start (fixed phrases, at most 20). Neither repeats a
document.

**Enforced by tests.** `test/e2e/access-log.test.ts` runs the whole story of the worked example with a
marker planted in every field a person can type or upload, and then finds none of it in the access
log, the service log, the audit trail or any error page. `test/server/shell-log.test.ts` does the
same for a body, a query string, a header, a file name and a path id.
`test/store/no-text-leaks.test.ts` and `test/services/privacy.test.ts` scan every table and column
for a planted marker, and check that the tables that hold text by design are the only ones that do.
`test/stages/verify-hostile.test.ts` checks that no check detail or escalation holds document text.

**Not built:** the debug capture of full prompts for synthetic matters behind an environment flag.
Nothing in the code records a prompt or a response, so there is nothing to leak, and nothing to
inspect when a model call misbehaves except its hash and outcome.

## Retention and deletion

- Each matter has `retain_until` (default 30 days in the demo), shown on the matters list.
  **Not built:** the daily job that deletes expired matters. The store can list expired matters
  (`listExpiredMatters`) and a test shows the job in four lines, but nothing in the application calls
  it, so an expired matter stays until someone deletes it. A matter's creator or an administrator can
  delete it earlier, from the matter page or `DELETE /api/matters/:id`; a review in flight is
  cancelled first.
- **Deviation.** Deletion removes the matter's rows (documents, spans, runs, findings, evidence,
  reviews, memos, feedback) in one transaction, then its files, then compacts the database
  (`secure_delete` is on, then `VACUUM`). The plan had the files first. A stop between the two steps
  now leaves a folder that no row names, and the sweep at start-up removes it. An audit event records
  the deletion with ids and counts only; earlier audit events keep their ids and hashes, which reveal
  no text. `test/store/retention.test.ts` checks that no row of the deleted matter remains and that
  no text of it is left in the database file.
- File deletion on modern disks is not secure erasure. Production would rely on encrypted storage
  and key destruction. This document states the limit; the demo itself does not say it anywhere.
- The model provider is outside this control. With prompt caching, the provider may keep text for
  a short time under its own terms; production needs a provider agreement on retention and
  training, or a local model.

## Run provenance

Every run records its input manifest (document version and text hashes, client name, playbook and
workflow version hashes), the requested model, each call's prompt version, request hash, outcome and
latency, each stage's input and output hashes, and the user who started it. It does not record the
model the provider reports or the tokens used (see below). The memo's appendix prints the recorded
fields in readable form, and each quotation is re-verified against the stored text at export. A run
can be repeated from its manifest, subject to the stochastic limits in
[document 5](05-evaluation.md#pinning-and-repeatability), but its record does not show which model
snapshot answered.

**Not met in full.** Built and tested: the manifest (with the requested provider and model, the
stated dates and the document labels), each call's prompt version, request hash, outcome and
latency, each stage's input and output hashes, who started the run, and the memo's appendix. The
quotation re-check at export is built (`test/export/gates.test.ts`). **Not built:** the model the
provider reports as having answered is never recorded (the run's `model_reported` stays empty, and
the memo says "reported by the provider: not reported"), and the token counts and the cost of each
call are never recorded, because the generator interface returns only the parsed object. A run's
provenance therefore does not show which model snapshot answered, which matters for any provider
that moves an alias, and the application cannot report what a review cost. The evaluation runner
reads the reported model and the usage itself, for evaluation runs only, and has never met a real
provider.

## Recovery from partial failures

All eight rows are built and tested.

| Failure                                    | State afterwards                                                                                                                                                                                                                      | Recovery                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One rule's model call fails after retries  | Run succeeds; that finding is `undetermined` with `output_invalid` (or `context_over_budget`, with no call)                                                                                                                           | Reviewer decides it, or the associate re-runs                                                                                                                                                     |
| Provider rejects the key or the model      | Run `failed` with an `error_kind` (`provider_auth`, `provider_permission`, `provider_model`, `provider_billing`, `provider_redirect`); completed units kept                                                                           | Fix configuration, resume. Resume is refused if the provider or model changed: start a new review instead                                                                                         |
| Server stops mid-run                       | On restart, run `failed` with `interrupted`; the page offers Resume. The matter returns to `ready`, or to `stale` when it holds findings of an earlier review                                                                         | Resume skips units whose input hash is unchanged                                                                                                                                                  |
| Database cannot be written when a run ends | The runner tries the write again, after 100 ms and then at growing intervals up to 5 s, until it works; the run keeps its queue slot, so a shutdown waits (a second signal stops at once). The run then ends `failed` with `internal` | Resume; the finished units are skipped. With no bound on the retries, a database that never recovers keeps the run `analyzing` until the process stops, and the next start marks it `interrupted` |
| A second server on the same data folder    | Refused before anything is touched: an exclusive lock on `parol.lock` in the data folder is held for the life of the process, and the OS drops it when the process ends, however it ends                                              | Stop the first server, or use another folder                                                                                                                                                      |
| Upload cannot be parsed                    | Nothing stored; reason shown                                                                                                                                                                                                          | Upload a readable file                                                                                                                                                                            |
| Export fails part-way                      | No memo row, no partial file (temporary file and rename; a file saved before a refused row is taken back)                                                                                                                             | Export again. Exporting the same decisions of the same run a second time returns the memo on record                                                                                               |
| Database write fails during a decision     | Transaction rolled back; decision not recorded; user sees the error                                                                                                                                                                   | Retry; the content-hash check prevents a double decision on changed content, and a decision by another reviewer on unchanged content is refused (`decision_conflict`)                             |

Tests: `test/services/runs-failures.test.ts` (the first three rows, and a run that is resumed),
`test/services/runs-settle.test.ts` (the database row) and `test/server/shell-single-instance.test.ts`
(the second server),
`test/store/files-atomic.test.ts` and `test/export/failure.test.ts` (the export row),
`test/services/uploads.test.ts` (the upload row) and `test/store/audit-atomicity.test.ts` (a rollback
takes its audit event with it).

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
  "DEMO: synthetic documents, demo identity, not for client work", and a test pins its words.
- With demo identity on, the server listens on `127.0.0.1`, `::1` or `localhost` only and refuses to
  start on another address (`PAROL_HOST=0.0.0.0` exits 1 with an explanation; checked by running it).
- **Added: a host guard.** With demo identity on, a request whose address or `Host` header is not one
  of those names is answered 403 (`src/server/middleware/host-guard.ts`). Binding to loopback keeps
  other machines out; it does not stop a web page from reaching the server by a hostile name that
  points at 127.0.0.1 (DNS rebinding), which would let that page read every page and post every form
  of a passwordless demo.
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
retention with the firm's records policy and legal holds; concurrent multi-user editing; rate
limiting; accessibility conformance testing; and a formal change-approval process for playbook and
workflow promotions.

## Planned here and not built

These are controls this document described for the demo itself, not production extras, and the
code does not have them. Each is also noted where it appears above.

- The scheduled job that deletes expired matters. The functions exist and nothing calls them.
- A command or page that verifies the audit hash chain. `verifyAuditChain` exists in the store and
  is tested; only tests call it, so tampering would not be noticed by anyone running the application.
- Administrator-only approval of a playbook and promotion of a workflow, with a screen for each.
  Today the operations are not reachable, and the store does not check the actor's role.
- The evaluation screens and the legal-engineer role check on them.
- Probing the application with a real model behind it: the exposure suite in the evaluation runs
  the application in process with a scripted stand-in, so what a language model does with another
  matter's text is unobserved (gate G1 is evaluated for the application, not for a model).
- Token counts, cost and the provider-reported model in each run's provenance.
- A spend guard on the application's own model calls. Only `pnpm eval:parol` has one.
- The debug capture of prompts for synthetic matters.
- Authorization carried by type into the store and the run engine, so that a module that skips the
  service layer would not compile.
- Status settlement in code against `required` and absence rules, and a parties check that looks for
  the client's name in the parties passage and not anywhere in the bundle.
- Any measurement of how a real model treats hostile document text. No model has read a document in
  this project.
