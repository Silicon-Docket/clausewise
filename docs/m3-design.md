# M3 design: server, web app and Docker Compose

This is the contract between the pieces of milestone 3. It says what each piece offers and
needs, so the packages can be built side by side. If a detail here turns out to be wrong, change
the document in the same commit as the code and say why.

Rules for every file in this milestone:

- TypeScript, strict, ESM. Relative imports end in `.js`. Match the style of `packages/review`.
- No em dashes and no en dashes anywhere (code, comments, docs, UI text). Use commas, colons or
  full stops.
- Document text is the client's confidential material. It never appears in a log line, an error
  message returned to the browser, a URL, or a stored file name.
- A secret (model API key, access token, database password) never appears in a response, a log
  line, an error message or the web app's bundle.
- Tests are written with the code. A test that passes without the fix proves nothing.

## 1. What the user gets

A lawyer opens `http://localhost:8787`, uploads a .docx, chooses a playbook, and watches the
review run. They read the findings by severity, each with the clause text and an inline diff of
the suggested edit. They accept, reject or edit each suggestion, then download the .docx with
exactly the accepted suggestions as Word tracked changes and comments. They can also edit the
playbooks (YAML, with live validation).

Single user. No accounts. An optional shared access token. The README says plainly not to expose
the port to a network without something in front of it.

## 2. Changes to `packages/review` (needed by the server)

The pipeline already builds a redlined file for the whole report. The server needs to build one
again later from the stored report, with only the findings the lawyer accepted, and with the
replacement text the lawyer edited.

### 2.1 `commentAnchor` on `RuleResult`

Add an optional field to `RuleResult` in `types.ts`:

```ts
/** Where this finding's comment was written, so a redline can be rebuilt without the model. */
commentAnchor?: { paragraphId: string; start?: number; end?: number };
```

It is set by `reviewContract` for every result with status `deviation` or `missing` (the same
value the pipeline passes to the redline writer for the comment). With `start` and `end` the
comment covers that span of the paragraph; without them it covers the paragraph.

### 2.2 `renderRedline`

```ts
export async function renderRedline(input: {
  docx: Uint8Array;
  report: ReviewReport;
  /** Rule ids to include, or "all" for every deviation and missing result. */
  include: ReadonlySet<string> | "all";
  /** Replacement text by rule id, for results whose edit.kind is "applied". Overrides the model's. */
  replacements?: ReadonlyMap<string, string>;
  author?: string;
  date?: Date;
}): Promise<{
  redlined: Uint8Array;
  /** Tracked changes written. */
  edits: number;
  /** Comments written. */
  comments: number;
  /** Things the lawyer should know, such as an edit the engine refused and turned into a comment. */
  warnings: string[];
}>;
```

Behaviour:

- Only results with status `deviation` or `missing` that are in `include` are written. Each gets
  its comment (same text the pipeline writes, built by the same function). A result whose edit is
  `applied` also gets its tracked change at the stored `paragraphId`, `start`, `end`.
- If `replacements` has an entry for a result, that text replaces the model's. The empty string
  is allowed and means delete the span. If the entry equals the original text of the span, no
  edit is written (the comment stays). The text is cleaned for XML the same way as everything
  else; a replacement longer than 20,000 characters is rejected with a `ReviewError`.
- If the engine refuses an edit, the comment moves to the clause and carries the suggested
  wording, exactly as in the pipeline, and a warning says so. The same containment as the
  pipeline applies: a writer failure degrades to comments only, then to the original bytes, with a
  warning. It never throws for a document that opened.
- A stored result without `commentAnchor` (a report from an older version) is anchored at the
  first paragraph and a warning says so.
- The spans of the stored edits must still match the document: check that the text at
  `start..end` of the paragraph equals `edit.original`. If it does not (wrong file, changed
  file), throw `ReviewError("The document does not match the report ...")`. Never write a span
  that does not match.
- **Choices made while building it (all tested):** a refused edit moves its comment to the whole
  paragraph that holds the edit (the report has no clause boundaries). Whitespace at either end of
  a replacement is dropped, as anchoring does for the model's wording, so a trailing newline from
  a text area cannot enter the contract. A replacement counts as "equal to the span" after
  typographic normalisation. A replacement for a result that is included but has no tracked change
  is ignored with a warning. Selecting no result returns a copy of the input bytes without opening
  the file. Spans are checked only for the results that are included.
- **Equality property, tested:** with the same author and date, `renderRedline` with
  `include: "all"` and no replacements produces a file whose XML parts are identical to the
  `redlined` that `reviewContract` returned. The simplest way to guarantee it is to make
  `reviewContract` build its output from the same internal function. All existing tests must
  still pass.

Export it from `packages/review/src/index.ts`. Also export `ReviewReport` JSON schema helpers only
if the server needs them (it should not: it stores the report as JSON it wrote itself).

## 3. `apps/server`

### 3.1 Stack

- Hono on Node 22 (`@hono/node-server`), validation with zod.
- Drizzle ORM. Production: Postgres 17 through `pg`. No `DATABASE_URL`: an embedded PGlite
  database in the data directory, so `pnpm dev` works with nothing else installed. Tests use
  PGlite in memory, and (if the package installs and runs here) `embedded-postgres` for one
  integration test against a real Postgres, skipped when it cannot start.
- Migrations: generated by `drizzle-kit generate`, committed under `apps/server/drizzle/`, applied
  at startup by the server itself (a failed migration stops the start with a clear message).
- Files: uploaded .docx files are stored on disk under `CLAUSEWISE_DATA_DIR/documents/<uuid>`.
  The name is random; the user's file name is only metadata in the database. Writes are atomic
  (write to a temporary name in the same folder, then rename). Mode 0600, folder 0700.
- Entry points: `src/main.ts` (reads env, starts the server), `src/app.ts` (`createApp(deps)`,
  pure, used by tests), `src/start.ts` (`startServer(options)`, used by `main.ts` and by the e2e
  script, which passes its own generator).
- The server never contains a mock model switch. Tests and the e2e script inject an
  `ObjectGenerator` through `createApp({ generator })`.

### 3.2 Configuration (environment)

| Variable                        | Default           | Meaning                                                             |
| ------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `HOST`                          | `127.0.0.1`       | Bind address. In the container image it is set to `0.0.0.0`.        |
| `PORT`                          | `8787`            |                                                                     |
| `DATABASE_URL`                  | unset             | Postgres URL. Unset: embedded PGlite in the data directory.         |
| `CLAUSEWISE_DATA_DIR`           | `./data`          | Documents and the embedded database.                                |
| `CLAUSEWISE_PLAYBOOKS_DIR`      | `./playbooks`     | Built-in, read-only playbooks (`*.yaml`).                           |
| `CLAUSEWISE_WEB_DIR`            | `./apps/web/dist` | The built web app. A missing folder means the API runs alone.       |
| `CLAUSEWISE_ACCESS_TOKEN`       | unset             | If set, every `/api` request must carry it. At least 16 characters. |
| `CLAUSEWISE_ALLOWED_HOSTS`      | unset             | Comma separated extra `Host` values, for a reverse proxy.           |
| `CLAUSEWISE_MAX_UPLOAD_MB`      | `25`              | Upload cap.                                                         |
| `CLAUSEWISE_REVIEW_CONCURRENCY` | `1`               | Reviews running at once. Others wait in the queue.                  |
| `CLAUSEWISE_MAX_QUEUED`         | `20`              | More than this many waiting reviews: 429.                           |
| model variables                 |                   | All the variables `loadLlmConfig` reads.                            |

The model configuration is read when the server starts, but a missing or wrong key must not stop
the server: the web app shows the problem on its start screen and the review endpoints answer
`503 model_not_configured` with the message from `LlmConfigError` (which never echoes a value).

### 3.3 Security requirements

1. **Bind to loopback by default.** If `HOST` is not a loopback address and no access token is
   set, log one clear warning at startup.
2. **DNS rebinding.** When no access token is set, reject a request whose `Host` header is not
   `localhost`, `127.0.0.1`, `[::1]` (with or without the port) or in `CLAUSEWISE_ALLOWED_HOSTS`:
   `421`. (With a token, the token is the defence.) A reverse proxy must pass the original `Host`
   header through, because the origin check in item 3 compares it with `Origin`.
3. **Cross-site requests.** No CORS headers at all. For every request with a method other than
   GET, HEAD or OPTIONS: if an `Origin` header is present and its host differs from the `Host`
   header, answer `403`. `POST` and `PATCH` bodies must be `application/json` or
   `multipart/form-data`.
4. **Access token.** If set, `/api/*` requires `Authorization: Bearer <token>`, compared in
   constant time. `GET /healthz` and the static web files do not need it (the web app asks for
   the token and keeps it in memory plus `sessionStorage`, never in a cookie, so cross-site
   requests cannot ride on it). A wrong or missing token: `401` with no detail about the token.
5. **Upload.** Stream the body and stop at the cap (413) without buffering more. The file must
   start with the ZIP signature and open with `parseDocx` under the docx package's limits;
   otherwise `422` with the docx package's message. The display file name is cleaned: base name
   only, control characters, path separators and bidi override characters removed, at most 200
   characters. A name that ends up empty becomes `contract.docx`.
6. **Download.** `Content-Disposition: attachment` with an ASCII `filename` and a `filename*` for
   the real name, built from the cleaned name; `X-Content-Type-Options: nosniff`;
   `Cache-Control: no-store`.
7. **Headers on everything.** `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `X-Frame-Options: DENY`, and for the web app a CSP of
   `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
   API responses carry `Cache-Control: no-store`.
8. **Playbook YAML.** At most 256 KB, enforced by the server (the parser does not). Parsed by
   `parsePlaybook`, which refuses every alias, every tag and any nesting deeper than 64 levels,
   does not read merge keys, reads the YAML 1.2 core schema whatever a `%YAML` line says, and
   reports a repeated key in one mapping as an error, with a line number, in linear time. Each of
   these has a test in `packages/playbook/test/hardening.test.ts`.
9. **Errors.** Every error is `{ "error": { "code": string, "message": string } }`. Messages are
   written for a person and never contain document text, stack traces, file system paths, SQL or
   secrets. Unexpected errors are `500 internal_error` with a request id; the detail goes to the
   log, still without document text.
10. **Logging.** One JSON line per request: time, request id, method, route pattern (not the URL
    with ids filled in is fine, ids are random), status, duration. Nothing else about the
    request. Startup logs say the provider, model and disclosure sentence.
11. **Limits.** JSON bodies up to 1 MB (playbook routes up to 300 KB). A document may have at most
    200 reviews. The queue cap in 3.2.
12. **Job safety.** A review that the process was running when it stopped is marked `failed`
    with the message "The server restarted while this review was running. Start it again." at the
    next start. A cancel aborts the in-flight model calls through the review's `AbortSignal`.
13. **Deleting** a document deletes its reviews, findings and the stored file. A missing file on
    delete is not an error.

### 3.4 Database

```
documents(id uuid pk, file_name text, size integer, sha256 text, storage_key text,
          paragraphs integer, created_at timestamptz)
playbooks(id text pk, name text, yaml text, created_at timestamptz, updated_at timestamptz)
          -- custom playbooks only. Built-in ones come from the playbooks folder, ids "builtin:<file stem>".
reviews(id uuid pk, document_id uuid fk documents on delete cascade,
        playbook_id text null, playbook_name text, playbook_yaml text,   -- snapshot at start
        client text null, status text, progress_done integer, progress_total integer,
        error text null, report jsonb null, context jsonb null,
        model_provider text null, model_name text null,
        created_at, started_at null, finished_at null)
findings(review_id uuid fk reviews on delete cascade, rule_id text,
         decision text, edited_replacement text null, updated_at timestamptz,
         primary key (review_id, rule_id))
```

`status` is one of `queued`, `running`, `done`, `failed`, `cancelled`. `decision` is one of
`pending`, `accepted`, `rejected`.

When a review finishes, the server stores the `ReviewReport` in `report`, creates a `findings`
row (decision `pending`) for every result with status `deviation` or `missing`, and stores
`context` once: for every result, the cited clauses (`id`, `number`, `heading`, `text` of each
clause in `clauseIds`, found by re-running `parseDocx` and `segment` on the stored file) and, for
an applied edit, the full text of the paragraph that holds it. Storing it means the screen does
not change if the segmenter changes later.

### 3.5 API

The TypeScript in `packages/api/src/index.ts` is the source of truth for every request and
response shape below; the server and the web app both import it. If the prose and the types
disagree, fix the prose.

All paths are under `/api` except `/healthz`. Bodies are JSON unless said. Timestamps are ISO 8601
strings. Ids are UUIDs except playbook ids.

```
GET  /healthz                          -> 200 { ok: true }                 (no auth, no DB work)
GET  /api/config                       -> 200 {
        version: string,
        authRequired: boolean,
        maxUploadBytes: number,
        model: { configured: true, provider, model, disclosure }
             | { configured: false, problem: string }
     }
        (this one needs no token, so the web app can learn whether to ask for one)

GET    /api/playbooks                  -> 200 { playbooks: PlaybookSummary[] }
GET    /api/playbooks/:id              -> 200 { id, source, name, yaml, editable }
POST   /api/playbooks                  { yaml } -> 201 PlaybookSummary & { yaml }       (custom)
PUT    /api/playbooks/:id              { yaml } -> 200 same                              (custom only, else 403)
DELETE /api/playbooks/:id              -> 204                                            (custom only)
POST   /api/playbooks/validate         { yaml } -> 200 { ok: true, name, ruleCount, contractTypes }
                                                 | 200 { ok: false, problems: string[] }
        PlaybookSummary = { id, source: "builtin" | "custom", name, contractTypes: string[],
                            ruleCount: number, updatedAt: string | null }

POST   /api/documents                  multipart, one field "file" -> 201 DocumentSummary
GET    /api/documents                  -> 200 { documents: DocumentSummary[] }   (newest first)
GET    /api/documents/:id/file         -> the original .docx (attachment)
DELETE /api/documents/:id              -> 204
        DocumentSummary = { id, fileName, size, paragraphs, createdAt, reviewCount }

POST   /api/reviews                    { documentId, playbookId, client?: string }
                                         -> 202 ReviewSummary   (status "queued")
GET    /api/reviews                    -> 200 { reviews: ReviewSummary[] }       (newest first)
GET    /api/reviews/:id                -> 200 ReviewDetail
POST   /api/reviews/:id/cancel         -> 200 ReviewSummary                      (queued or running only, else 409)
DELETE /api/reviews/:id                -> 204                                    (not running, else 409)
        ReviewSummary = { id, status, documentId, documentName, playbookName, client: string | null,
                          progress: { done, total }, error: string | null,
                          open: { high, medium, low } | null,
                          createdAt, startedAt: string | null, finishedAt: string | null }
        ReviewDetail  = ReviewSummary & {
                          model: { provider, model, disclosure } | null,
                          warnings: string[],
                          notShown: ReviewReport["notShown"] | null,
                          stats: ReviewReport["stats"] | null,
                          counts: ReviewReport["counts"] | null,
                          findings: Finding[]      // empty until status is "done"
                          results: ResultRow[]     // the rest: compliant, not_applicable, error
                        }
        Finding = {
          ruleId, title, severity, required,
          status: "deviation" | "missing",
          explanation, comment, suggestedClause: string | null,
          clauses: { id, number: string | null, heading: string | null, text }[],
          edit: { kind: "none" }
              | { kind: "applied", original: string, replacement: string,
                  paragraphText: string, start: number, end: number }
              | { kind: "comment-only", proposed: { quote: string, replacement: string }, reason: string },
          decision: "pending" | "accepted" | "rejected",
          editedReplacement: string | null
        }
        ResultRow = { ruleId, title, severity, status, clauseNumbers: string[],
                      explanation, error: string | null }

PATCH  /api/reviews/:id/findings/:ruleId   { decision?, editedReplacement?: string | null }
                                         -> 200 Finding
        editedReplacement is allowed only when edit.kind is "applied" (else 400). null clears it.
        At most 20,000 characters.
PATCH  /api/reviews/:id/findings           { decision, ruleIds?: string[], severities?: Severity[] }
                                         -> 200 { updated: number }     (bulk; both filters optional)

GET    /api/reviews/:id/docx?include=accepted|all
                                         -> the redlined .docx (attachment)
        accepted (default): only findings with decision "accepted".
        all: every finding that is not "rejected".
        409 if the review is not done. Built with renderRedline from the stored file and report,
        the findings' editedReplacement values, author "Clausewise".
GET    /api/reviews/:id/report?format=json|md
                                         -> the stored report (json) or renderMarkdown output (md)
```

Status codes: `400` invalid input (zod issues turned into a short message), `401`, `403`, `404`,
`409`, `413`, `421`, `422`, `429`, `503`. A document or playbook that does not exist for a new
review: `404`. `playbookId` may be a built-in id or a custom one.

Reviews: the job runner takes a review from `queued`, sets `running`, calls `reviewContract`
with the stored file, the playbook snapshot (`parsePlaybook`), the server's generator, `client`,
and `onProgress` (writes `progress_done`/`progress_total`, throttled to one write per 500 ms).
When the generator is not configured, `POST /api/reviews` answers `503 model_not_configured`
before creating anything.

## 4. `apps/web`

### 4.1 Stack

React 19, Vite, TypeScript strict. No UI framework. Plain CSS in files, with design tokens as CSS
variables, a light and a dark theme (`prefers-color-scheme`), and a layout that works at phone
width. A tiny hash router written in the app (no router dependency) unless that proves silly.
Runtime dependencies: `react` and `react-dom` only, unless a very good reason is written down.
The production build is static files in `apps/web/dist`, served by the server.

Component tests: vitest with jsdom and Testing Library, `// @vitest-environment jsdom` at the top
of each file, test files under `apps/web/test/`. The API client takes a `fetch` function so tests
can inject one.

### 4.2 Screens

1. **Start** (`#/`): the model line from `/api/config` ("Reviews are sent to Anthropic API
   (api.anthropic.com)"), or the problem if it is not configured, in plain words with the fix. A
   drop zone and file button for a .docx, a playbook select, an optional "Who are you acting
   for?" field (the `client` option, with the example from the CLI help), and a Start button.
   Starting says again where the text will be sent. Below: recent reviews.
2. **Review** (`#/reviews/:id`): progress while queued or running ("12 of 20 rules checked"),
   with a Cancel button. When done: a summary line (counts, high/medium/low open), the warnings
   and the "not shown to the model" notes if any, then findings grouped by severity (high
   first). Each finding card shows the title, rule status, the explanation, the clause text it
   concerns (with the clause number), and for an applied edit an inline diff: the paragraph
   with the removed words struck through and the added words underlined, via a word-level diff
   written in the app and unit tested. Buttons: Accept, Reject, Edit (opens a text area with the
   replacement, Save stores `editedReplacement`, and the diff updates), Reset. A comment-only
   finding shows the comment and the suggested wording and can be accepted (comment kept) or
   rejected. "Accept all" and "Reject all" per severity and overall. Compliant, not applicable
   and errored rules are listed in a collapsed section, errors visible and in words.
   A **Download** button with a count: "Download redline (3 accepted)". It is disabled with a
   reason when nothing is accepted, and a secondary "Download with everything not rejected"
   link. Also links to the original file and the Markdown report.
3. **Playbooks** (`#/playbooks`): the list (built-in marked read-only, with "Copy to edit"),
   a YAML editor (a plain monospace textarea is fine) with live validation against
   `/api/playbooks/validate` (debounced) showing every problem, Save, Delete. A new playbook
   starts from a built-in one.
4. **Access token** screen when the server says `authRequired` and there is no token or the
   token was refused.

### 4.3 Behaviour rules

- Polling: while a review is queued or running, poll `GET /api/reviews/:id` every second, and
  stop when it ends or the screen closes.
- Never render document text as HTML. React escapes by default; do not use
  `dangerouslySetInnerHTML` anywhere.
- Every button that talks to the server shows pending state and shows the server's error message
  when it fails. No silent failures, no `alert()`.
- Keyboard: every action reachable by keyboard, visible focus, labels on every input, status
  changes announced through an `aria-live` region, colour never the only signal of severity.
- A decision change is optimistic only if it can be rolled back on failure.
- The app must work when the server is on another origin only through the dev proxy. In
  production it is same origin, with relative URLs.

## 5. Docker

- `Dockerfile` at the repository root, multi stage: build (install with the lockfile, build the
  web app, bundle the server with esbuild, with PGlite and other packages that need their own
  files left external) and run. Runtime: `node:22-bookworm-slim` (pin the minor version), user
  `node`, `WORKDIR /app`, production dependencies only, `HOST=0.0.0.0`, `NODE_ENV=production`,
  data in `/data` (a volume), built-in playbooks copied to `/app/playbooks`, a `HEALTHCHECK` that
  calls `/healthz` with `node -e` (no curl in the image), `EXPOSE 8787`, no secrets baked in.
  `.dockerignore` excludes `.git`, `node_modules`, `data`, `.env*`, outputs and `evals/results`.
- `docker-compose.yml`: `app` (builds from the Dockerfile, publishes `127.0.0.1:8787:8787` only,
  `env_file: .env` optional, `depends_on` postgres healthy, volume `clausewise-data:/data`,
  `read_only: true` with `tmpfs: /tmp`, `cap_drop: [ALL]`, `security_opt:
[no-new-privileges:true]`) and `postgres` (`postgres:17-alpine`, not published, volume,
  `POSTGRES_PASSWORD` required with `${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}`,
  healthcheck with `pg_isready`). The plan said a pgvector image; vectors are unused until a later
  milestone, so the plain image is used and the README notes the switch.
  An `ollama` profile adds an `ollama/ollama` service on the internal network only and the
  matching `CLAUSEWISE_PROVIDER=openai-compatible`, `CLAUSEWISE_BASE_URL=http://ollama:11434/v1`
  settings documented in `.env.example` (they are not set by default).
- `.env.example` lists every variable with a comment, with no real values. Real `.env` is
  git-ignored already.
- This environment has no Docker daemon. What can be checked here: `docker compose config`, a
  lint read of the Dockerfile, and running the same install, build and start steps by hand in a
  clean directory. The README must say that the image itself has not been built here until it has.

## 6. Tests and CI

- `pnpm test` (vitest, no network, no browser) covers: the review additions, server routes
  through `app.request()` with PGlite and a scripted generator, the job runner, security
  middleware, the web components and diff.
- `pnpm e2e` runs Playwright (Chromium from `PLAYWRIGHT_BROWSERS_PATH`, never downloaded by the
  scripts here) against a real server started by `e2e/start.ts` (a root folder, not a workspace
  package) with the scripted
  oracle generator from `evals` (built from `fixtures/expected.json`). The scenario: upload
  `fixtures/nda-aggressive.docx`, pick the NDA playbook, wait for the review, accept exactly
  one finding with an applied edit, download, and check with JSZip that the file has exactly one
  tracked change (one `w:del` and one `w:ins`) and the comments of that one finding. A second
  scenario edits the replacement text before downloading. A third checks that a rejected finding
  leaves the file with no change from it. Failures keep screenshots in `test-results/` (ignored).
- CI gets a second job `e2e` that installs Chromium with Playwright and runs `pnpm e2e`. The
  existing job stays quick and offline.
- LibreOffice check (`soffice` exists here): a test converts a downloaded redline to ODT and
  counts `text:changed-region` elements, as the earlier milestones do. Skip it when `soffice` is
  missing.

## 7. Not in this milestone

Accounts and roles, SSO, a Word add-in, a clause library, a document vault with search, chat,
streaming progress (polling is enough), a cost estimate before the run, retention rules. They go
in the README roadmap.
