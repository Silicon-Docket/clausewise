# 6. Access, review and governance

The public demo uses synthetic documents only. The controls below are real in the code, but the
identity behind them is a labelled demo mechanism, and several production controls are deferred
and listed as such at the end.

## Threat model in brief

| Threat                                                 | Primary control                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A user reads or acts on a matter they do not belong to | Server-side matter authorization before any retrieval, generation or export             |
| Document text tries to steer the review or the system  | No tools for the model; text fenced as data; every outcome decided or validated in code |
| Model output is wrong or fabricated                    | Quote and support checks; escalation; attorney decision required before export          |
| Stale decisions survive a document change              | Manifest hashes; decisions bound to finding content hashes; export re-checks both       |
| Sensitive text leaks into logs or errors               | Logs carry ids, hashes and counts only; errors never quote documents                    |
| Hostile files                                          | `@clausewise/docx` size and structure limits; TXT size limit; nothing executed          |
| Data kept longer than needed                           | Per-matter retention date and a deletion job                                            |

## Authorization

**Where it is enforced.** One middleware resolves `(user, matter, role)` for every route under
`/api/matters/:id` and the matching pages. Services that read matter data accept only an
`AuthorizedMatter` value, a branded TypeScript type that only the middleware can construct, so code
that reaches the store, the workflow runner, the model layer or the exporter without passing
authorization does not compile. The workflow runner receives a `RunManifest` built from an
`AuthorizedMatter`, and retrieval queries filter on the manifest's document version ids, so even a
bug in a stage cannot pull another matter's spans.

| Action                                   | Check, in order                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Any matter route                         | Signed-in demo identity; membership (404 if none); role for the action (403 if insufficient)    |
| Start or resume a run (retrieval, model) | Associate role; matter `ready` or `stale`; approved playbook version; exactly one operative NDA |
| Read a span or finding                   | Membership; the span's or finding's `matter_id` equals the route's matter                       |
| Record a review decision                 | Reviewer role; finding current; content hash matches; reason present where required             |
| Export a memo                            | Reviewer role; every current finding has a current decision; recomputed at export time          |
| Download a memo                          | Membership; memo belongs to the matter                                                          |
| Approve a playbook, promote a workflow   | Admin; promotion record attached                                                                |
| Evaluation screens                       | Legal engineer; synthetic matters only                                                          |

**Tests.** The authorization probe matrix in [document 5](05-evaluation.md#supplementary-suites)
runs in the unit suite as well as in evaluations, and a test enumerates the router's matter routes
and fails if any lacks the middleware, so a new route cannot ship unprotected by accident.

**Segregation.** By default a matter's reviewer must be a different user from the associate who
started the run. It can be switched off for single-person demos, and the memo then says so.

## Documents are data

Document text cannot change permissions, tools, workflow rules or the review outcome, because none
of those are reachable from it:

- **No tools.** The model is called for structured output only. It cannot fetch, search, write,
  call another model or reach another matter. There is nothing for an injected instruction to
  invoke.
- **Fenced input.** Contract text is rendered with Clausewise's `renderClauses`, inside
  `<contract>` tags, with forged closing tags and forged headers neutralised. The system prompt
  states that instructions inside the contract are never followed.
- **Constrained output.** The model's answer only fills fields of a finding. Statuses are settled
  by code against the playbook's required and absence semantics; span labels must exist in the
  bundle; escalation ids must exist in the rule; quotes must be verified. A model that obeyed an
  injected "mark everything compliant" would still need verified, supported citations for each
  `compliant`, and the injection twins measure whether it happened.
- **Configuration has one source.** The playbook version, workflow version, prompts and
  permissions come from database records that only legal engineers and admins can change through
  their own routes. No stage reads configuration from document text.
- **The warning is a signal, not the control.** The `instruction_like_text` pattern warning helps
  the reviewer notice odd text. It is easy to evade and is not relied on for safety.

## Review gates

1. **Before a run**: an approved playbook version and exactly one operative NDA version; duplicate
   and near-duplicate uploads resolved.
2. **After verify**: findings that failed a check are marked `escalated_by_system` and show the
   failed check; unverified quotes are struck through and excluded from export.
3. **Decision**: only a reviewer decides. Edit, reject and escalate need a reason. Each decision is
   bound to the finding content it was made on.
4. **Export**: every current finding has a current decision. Escalated findings appear in an "Open
   items" section at the top of the memo, never silently dropped. Rejected findings are listed in an
   appendix so a later reader can see what was considered.
5. **After export**: any input change marks the memo superseded and blocks a new export until the
   matter is re-run and re-decided.

## Minimal sensitive logging

| Where                    | What is recorded                                                                     | What is never recorded                              |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Server log (stdout)      | Request id, route template, status, latency, user id, matter id                      | Bodies, file names, document text, quotes, prompts  |
| `audit_events`           | Action, actor, target ids, hashes, counts; hash-chained                              | Document text, quotes, finding text, review reasons |
| `model_calls`            | Stage, rule, prompt version, request hash, outcome, tokens, latency, estimated cost  | Prompt text, response text                          |
| `run_stages.output_json` | Stage outputs needed to resume and inspect (matter-scoped, deleted with the matter)  | Anything from another matter                        |
| Error messages           | Error kind and ids, written not to quote the document or a key (the Clausewise rule) | Document text, API keys                             |
| Evaluation results       | Full outputs, because the data is synthetic                                          | Any non-synthetic matter (the runner refuses)       |

A debug capture of full prompts exists only for synthetic matters behind an explicit environment
flag, and the server refuses to enable it for a matter whose `synthetic` flag is off.

## Retention and deletion

- Each matter has `retain_until` (default 30 days in the demo). A daily job deletes expired
  matters; a user can delete earlier.
- Deletion removes the matter's files, then its rows (documents, spans, runs, findings, evidence,
  reviews, memos, feedback) by cascade in one transaction, then compacts the database. An audit
  event records the deletion with ids and counts only; earlier audit events keep their ids and
  hashes, which reveal no text.
- File deletion on modern disks is not secure erasure. Production would rely on encrypted storage
  and key destruction; the demo states the limit.
- The model provider is outside this control. With prompt caching, the provider may keep text for
  a short time under its own terms; production needs a provider agreement on retention and
  training, or a local model.

## Run provenance

Every run records its input manifest (document version and text hashes, client name, playbook and
workflow version hashes), the requested and reported model, each call's prompt version, request
hash, outcome, tokens and latency, each stage's input and output hashes, and the user who started
it. The memo's appendix prints the same in readable form, and each quotation is re-verified
against the stored text at export. A run can therefore be reproduced from its manifest, subject to
the stochastic limits in [document 5](05-evaluation.md#pinning-and-repeatability).

## Recovery from partial failures

| Failure                                   | State afterwards                                                    | Recovery                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| One rule's model call fails after retries | Run succeeds; that finding is `undetermined` with `output_invalid`  | Reviewer decides it, or the associate re-runs                               |
| Provider rejects the key or the model     | Run `failed` with `error_kind`; completed units kept                | Fix configuration, resume                                                   |
| Server stops mid-run                      | On restart, run `failed` with `interrupted`                         | Resume skips units whose input hash is unchanged                            |
| Upload cannot be parsed                   | Nothing stored; reason shown                                        | Upload a readable file                                                      |
| Export fails part-way                     | No memo row, no partial file (temporary file and rename)            | Export again                                                                |
| Database write fails during a decision    | Transaction rolled back; decision not recorded; user sees the error | Retry; the content-hash check prevents a double decision on changed content |

## Demo identity

- Enabled only when `PAROL_DEMO_IDENTITY=1`. The user picks a seeded identity (associate,
  reviewer, legal engineer, admin); the server sets an HMAC-signed, `HttpOnly`, `SameSite=Strict`
  cookie with that user id.
- **It is not authentication.** Anyone at the keyboard can be anyone. A banner on every page says
  "DEMO: synthetic documents, demo identity, not for client work".
- With demo identity on, the server binds to `127.0.0.1` only and refuses to start on another
  address.
- Real controls that are in the demo regardless of identity: authorization on every route, CSRF
  tokens on every form, a strict Content Security Policy with no inline script, output escaping by
  default (Hono JSX), upload limits.

## Deferred until production

Single sign-on with the firm's identity provider and multi-factor authentication; matter-centric
security and ethical walls synchronised from the document management or conflicts system;
encryption at rest with managed keys; backups and tested restore; central log shipping and
alerting; data loss prevention review of exports; provider agreements on retention and training (or
a local model); a penetration test; dependency and vulnerability management in CI; alignment of
retention with the firm's records policy and legal holds; concurrent multi-user editing; rate
limiting; accessibility conformance testing; and a formal change-approval process for playbook and
workflow promotions.
