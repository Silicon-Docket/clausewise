# Security

## Reporting a vulnerability

Report it privately through GitHub: open the Security tab of this repository and choose
"Report a vulnerability". Please do not open a public issue. Describe what you did and what
happened. If a file is needed to reproduce it, make one up: never attach a real contract.

## Where your data goes

- The contract text, with the playbook rules and the `--client` text if you give one, goes to the
  model provider you configure: Anthropic, OpenAI or the server at `CLAUSEWISE_BASE_URL`.
  There is no telemetry and no hosted service, so it goes nowhere else.
- Before anything is sent, the command prints the destination. The line warns about plain `http`
  to a host that is not this machine, and about a proxy taken from the environment.
- A redirect from the configured address is refused. `ANTHROPIC_CUSTOM_HEADERS` and similar
  variables that add headers to every request are ignored.
- With Anthropic the contract is marked for prompt caching, so the provider may keep it for a
  short time under its own terms. Read your provider's terms on retention and training.
- Your key is read from the environment, used only to sign in to that provider, and never
  written to a file or printed.
- On disk, the command writes the three output files, each through a temporary file in the same
  folder. They get the permissions of the contract without write access for group and others.

## Threat model

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
- Text hidden by a style, and white or tiny text, is still shown to the model.
- Footnotes, endnotes, headers and footers are counted and reported but not reviewed.
- Counsel's tracked insertions are read as accepted text, and the review says so.
- A rule can propose one edit. Several edits for one rule are not supported yet.
- `CLAUSEWISE_FALLBACK` exists, is off unless set, and has not been tried live.

## Advice

Run the tool on the same machine you trust with the contract. Do not run it on a shared server or
in a pipeline that stores logs and files you do not control. Keep the API key in your environment,
not in a file next to the contracts.
