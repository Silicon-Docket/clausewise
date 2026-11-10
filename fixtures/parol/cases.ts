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
import { D02 } from "./cases/d02.js";
import { D03 } from "./cases/d03.js";
import { D04 } from "./cases/d04.js";
import { D05 } from "./cases/d05.js";
import { D06 } from "./cases/d06.js";
import { D07 } from "./cases/d07.js";
import { D08 } from "./cases/d08.js";
import { D09 } from "./cases/d09.js";
import { D10 } from "./cases/d10.js";
import { D11 } from "./cases/d11.js";
import { D12 } from "./cases/d12.js";
import { D13 } from "./cases/d13.js";
import { D14 } from "./cases/d14.js";
import { H01 } from "./cases/h01.js";
import { H02 } from "./cases/h02.js";
import { H03 } from "./cases/h03.js";
import { H04 } from "./cases/h04.js";
import { H05 } from "./cases/h05.js";
import { H06 } from "./cases/h06.js";
import { H07 } from "./cases/h07.js";
import { H08 } from "./cases/h08.js";
import { H09 } from "./cases/h09.js";
import { H10 } from "./cases/h10.js";
import { H11 } from "./cases/h11.js";
import { H12 } from "./cases/h12.js";
import type { CaseDefinition } from "./types.js";

export const CASES: readonly CaseDefinition[] = [
  // development split
  D01,
  D02,
  D03,
  D04,
  D05,
  D06,
  D07,
  D08,
  D09,
  D10,
  D11,
  D12,
  D13,
  D14,
  // held-out split
  H01,
  H02,
  H03,
  H04,
  H05,
  H06,
  H07,
  H08,
  H09,
  H10,
  H11,
  H12,
];

export const PLAYBOOK_FILE = "apps/parol/playbooks/parol-nda-recipient.yaml";
export const PLAYBOOK_SLUG = "parol-nda-recipient";
