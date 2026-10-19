# Clausewise

Open source, self-hosted contract review and redlining. Check a Word contract against
a playbook and get risk findings plus suggested edits as real tracked changes and
comments, using any LLM you choose (Claude, OpenAI, or a local model through Ollama).

Clausewise is an open source alternative to commercial legal AI tools. It is
independent and not affiliated with any of them.

> **Status: pre-alpha.** Nothing here is ready to use yet. The roadmap below says
> what exists and what does not.

## Principles

- **Self-hosted.** You run it. There is no telemetry and no hosted service.
- **Any model.** Pick the provider in config. Document text goes only to the provider
  you configure, and the README for each release says exactly which.
- **Never trust the model with your document.** A suggested edit is applied only if the
  text it quotes appears exactly once in the clause it names. Otherwise you get a
  comment, never a redline.
- **Not legal advice.** Findings are suggestions for a lawyer to review.

## What exists today

- `packages/docx`: reads a .docx into addressable paragraphs and writes edits back as real Word
  tracked changes and comments, leaving everything else in the file untouched. Tested against
  LibreOffice.
- `packages/playbook`: the YAML playbook format, with validation that names every problem.
- `playbooks/`: starter playbooks for a mutual NDA and for a SaaS subscription (customer side).
- `fixtures/`: three synthetic contracts and the findings a correct review should produce.

There is no model integration, CLI or UI yet.

## Roadmap

- [ ] v0.1: review a .docx against a YAML playbook from the CLI, web UI, Docker Compose
- [ ] Word add-in
- [ ] Clause library and drafting
- [ ] Assistant chat with citations, document vault, bulk review, workflows
- [ ] Multi-user auth and SSO

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
