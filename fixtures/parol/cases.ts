/**
 * The Parol evaluation cases, written in code: the documents, what a correct review of each
 * should conclude for every rule of the pinned playbook, and the passages that decide it.
 * `pnpm fixtures:parol` builds the DOCX and TXT files and answer-keys.json from this file.
 *
 * Every party, document and passage here was written for this project. Do not paste text from
 * real agreements, other products' templates or playbooks. The expectations follow the table in
 * docs/parol/05-evaluation.md; the worked example PAROL-D05 reproduces the passages of
 * docs/parol/04-worked-example.md as written.
 *
 * Adding a case means adding one entry to `CASES` below (or to a split's list): the builder
 * checks that every anchor occurs exactly once in the clause it names, so a case that drifts
 * from its documents fails the build.
 */
import { D01 } from "./cases/d01.js";
import { D03 } from "./cases/d03.js";
import { D05 } from "./cases/d05.js";
import { D06 } from "./cases/d06.js";
import { D08 } from "./cases/d08.js";
import { D12 } from "./cases/d12.js";
import type { CaseDefinition } from "./types.js";

export const CASES: readonly CaseDefinition[] = [D01, D03, D05, D06, D08, D12];

export const PLAYBOOK_FILE = "apps/parol/playbooks/parol-nda-recipient.yaml";
export const PLAYBOOK_SLUG = "parol-nda-recipient";
