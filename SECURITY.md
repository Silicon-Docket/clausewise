# Security

## Reporting a vulnerability

Report it privately through GitHub: open the Security tab of this repository and choose
"Report a vulnerability". Please do not open a public issue. Describe what you did and what
happened. If a file is needed to reproduce it, make one up: never attach a real contract.

## Where your data goes

- The contract text, with the playbook rules and the "who are you acting for" text if you give
  one, goes to the model provider you configure: Anthropic, OpenAI or the server at
  `CLAUSEWISE_BASE_URL`. There is no telemetry and no hosted service, so it goes nowhere else.
  That is the design; it has been checked by reading the code and not by watching the network.
- Before anything is sent, the command prints the destination, and the web app shows it on its
  first screen. The line warns about plain `http` to a host that is not this machine, and about a
  proxy taken from the environment.
- A redirect from the configured address is refused. `ANTHROPIC_CUSTOM_HEADERS` and similar
  variables that add headers to every request are ignored.
- With Anthropic the contract is marked for prompt caching, so the provider may keep it for a
  short time under its own terms. Read your provider's terms on retention and training.
- Your key is read from the environment, used only to sign in to that provider, and never
  written to a file, printed, logged, or sent to the web app. The page that shows the model
  names the provider and the model and never the key.
- On disk, the command writes the three output files, each through a temporary file in the same
  folder. They get the permissions of the contract without write access for group and others.
- The server keeps what you upload and what a review finds, in its data folder and its database:
  the .docx files (random names, mode 0600, in a 0700 folder), and in the database the file name,
  each review's report (which quotes the contract), and your decisions. Nothing is encrypted by
  Clausewise: use an encrypted disk, and protect backups as you protect the contracts.

## What the server defends against

The server (`apps/server`) and the web app (`apps/web`) are for one person, or a small trusted
team sharing one access token. It is meant to listen on this computer only, or behind a reverse
proxy you run. Against these it has tests:

- **A web page on another site that tries to reach a server on your computer.**
  - DNS rebinding: without an access token, a request whose `Host` header is not `localhost`,
    `127.0.0.1`, `[::1]` or a name in `CLAUSEWISE_ALLOWED_HOSTS` is refused with 421.
  - Cross-site requests: there are no CORS headers, so another site cannot read an answer. A
    request that changes something and carries an `Origin` whose host differs from the `Host`
    header is refused with 403. Request bodies must be JSON or a file upload (415 otherwise), so
    a plain HTML form from another site cannot send one.
  - The access token travels in an `Authorization` header, never in a cookie, so a request from
    another site cannot carry it. The web app keeps it in memory and in the tab's
    `sessionStorage`, and never in `localStorage`.
- **Anyone who cannot reach the port.** The default address is `127.0.0.1`. The compose file
  publishes the port on `127.0.0.1` and does not publish the database or the model server.
  Starting on any other address without a token logs a warning.
- **A wrong or missing token.** The token is compared in constant time. A refusal (401) does not
  say whether a token is needed or how the one given differed.
- **A hostile contract file.** An upload is read as a stream and stops at the size cap (413,
  default 25 MB) without being held in memory; it must start with the ZIP signature and open
  with the Word reader under its limits on size, number of entries, uncompressed size and the
  size and nesting of the XML, or it is refused with 422. At most four uploads are read at once. The name you gave the
  file is cleaned (base name only, control and bidirectional override characters removed, at most
  200 characters), kept only as display text in the database, and never used as a path: stored
  files have random names. Downloads are sent as attachments with `nosniff` and `no-store`.
- **A hostile playbook.** The YAML is refused above 256 KB, and by the parser if it has an alias
  or a tag, nests deeper than 64 levels, or repeats a key. The checks run in linear time, so a
  small file cannot make the server work for long.
- **A hostile or mistaken model.** Model answers are validated against a schema, and an edit
  becomes a tracked change only if the words it quotes occur exactly once, as whole words, in the
  clause it names. The model cannot write files or run anything. Your own replacement wording is
  limited to 20,000 characters and is cleaned for XML like everything else.
- **Script injection into the web app.** Contract text is rendered as text, never as HTML, and
  the code has no `dangerouslySetInnerHTML`. Every page carries a content security policy that
  allows only the app's own scripts and styles and no framing, and the headers `nosniff`,
  `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.
- **Leaks through errors and logs.** Every error is a short sentence written for a person. It
  holds no contract text, stack trace, file system path, SQL, key or database password. The log
  has one JSON line per request (time, random request id, method, route pattern, status,
  duration) and holds no contract text or file name. An error the code did not expect is logged
  by its class and call stack, never its message, because a message can quote the contract.
- **Overload and mistakes in running it.** JSON bodies are limited to 1 MB (300 KB for
  playbooks), waiting reviews to 20 by default, and a document to 200 reviews. A second server
  started on the same data folder is refused. Files are written to a temporary name and renamed,
  so a crash leaves a whole file or none. A review that was running when the server stopped is
  marked failed at the next start. A stop signal ends the running model calls and exits with
  code 0.
- **A compromised container.** The image runs as the unprivileged `node` user. The compose file
  also gives it a read-only file system, a small temporary folder, no Linux capabilities and
  `no-new-privileges`.

## What the server does not defend against

- **Anyone who can use it.** There are no accounts, no roles and no audit log. Everyone who
  reaches the server and has the token (or, with no token, anyone who can reach it at all) can
  read, change and delete every contract in it. Do not put it on a network without a token and a
  reverse proxy with TLS.
- **Guessing the token.** There is no limit on wrong guesses. A long random token (at least 16
  characters is enforced; use `openssl rand -hex 24`) makes guessing impractical, a short or
  reused one does not.
- **Eavesdropping.** The server speaks plain HTTP. Without TLS in front, the token and the
  contracts cross the network in clear text. A reverse proxy must add TLS, keep the original
  `Host` header (the origin check compares it with `Origin`), and be set up by you: none of that
  has been tried here with a real proxy.
- **Someone with access to the machine.** Root, other users who can read the data folder or the
  database, members of the `docker` group, and anyone with a backup can read every contract.
  Nothing is encrypted at rest by Clausewise, and deleting a document does not wipe the disk.
- **The model provider.** It sees everything that is sent. A local model server sees it too.
- **A contract that tries to steer the model.** The contract is fenced off in the prompt as data
  and the model is told to ignore instructions in it, and the answer is checked structurally, but
  a model can still be talked into a wrong status or a wrong suggestion. The findings are for a
  lawyer to review, always.
- **A signed-in user who wants to slow it down.** The caps above limit the damage; they do not
  make the server a fair multi-user service.
- **The supply chain.** The lock file is committed and the image installs from it, but nothing is
  signed, no list of materials is produced, and the image is not scanned. The base image is
  pinned by tag and minor version, not by digest, unless you pass a digest at build time.
- **Browsers on shared computers.** A downloaded redline sits in the download folder, and a
  browser extension can read the page.

## Threat model of the command line

- **Untrusted contracts.** A counterparty's file can be hostile: a zip bomb, huge or deeply
  nested XML, hidden text, wording that tries to instruct the model. The reader enforces limits
  on size and structure, and the contract is fenced off in the prompt as data.
- **Untrusted model output.** Statuses, clause ids and quotes are checked against the document
  and the playbook. An edit becomes a tracked change only if the words it quotes occur exactly
  once, as whole words, in the clause it names. The model cannot write files or run anything.
- **The provider.** It sees everything that is sent. Choose it as you would any service that
  handles confidential papers, or use a local server so that the text stays on your machine.
- **Local files and the terminal.** The command reads the files you name and writes only its
  outputs. It never replaces the input, refuses symbolic links for outputs, and shows control
  characters in names, titles and messages as escapes. It starts through a launcher that loads
  `tsx` from the project and not from the current folder.
- **Dependencies.** It runs from source with npm packages. The lock file is committed and CI
  installs from it. Keep your install up to date.

## Known limits

- Never run against a live model: all checks use scripted models and recorded requests.
- Word itself was never available. Output was checked with LibreOffice and libxml2.
- The Docker image has not been built yet (no Docker daemon was available), so its hardening
  settings have been read and rendered with `docker compose config` but not exercised. The CI job
  `docker` is written to do that.
- Text hidden by a style, and white or tiny text, is still shown to the model.
- Footnotes, endnotes, headers and footers are counted and reported but not reviewed.
- Counsel's tracked insertions are read as accepted text, and the review says so.
- A rule can propose one edit. Several edits for one rule are not supported yet.
- `CLAUSEWISE_FALLBACK` exists, is off unless set, and has not been tried live.
- The server and the web app have had no outside security review.

## Advice

Run the tool on a computer you trust with the contract. Do not run it on a shared server or in a
pipeline that stores logs and files you do not control. Keep the API key in your environment or
your `.env` (which is ignored by git and by the image build), not in a file next to the
contracts. If you share the server, set an access token, put TLS in front of it, and keep the
database and the data volume on an encrypted disk. Do not paste the output of
`docker compose config` anywhere: it prints your password and keys.
