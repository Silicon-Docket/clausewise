import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  LIMITS,
  type PlaybookDetail,
  type PlaybookSummary,
  type PlaybookValidateResponse,
} from "@clausewise/api";
import { PlaybookError, parsePlaybook, type Playbook } from "@clausewise/playbook";
import { eq } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { playbooks } from "./db/schema.js";
import type { Clock, IdSource } from "./deps.js";
import { badRequest, forbidden, notFound, tooLarge } from "./errors.js";
import type { Logger } from "./log.js";

export interface ResolvedPlaybook {
  id: string;
  name: string;
  yaml: string;
  playbook: Playbook;
}

export interface PlaybookStore {
  list(): Promise<PlaybookSummary[]>;
  get(id: string): Promise<PlaybookDetail | undefined>;
  /** The playbook, parsed, for a review to snapshot. */
  resolve(id: string): Promise<ResolvedPlaybook | undefined>;
  validate(yaml: string): PlaybookValidateResponse;
  create(yaml: string): Promise<PlaybookDetail>;
  update(id: string, yaml: string): Promise<PlaybookDetail>;
  remove(id: string): Promise<void>;
}

const BUILTIN_PREFIX = "builtin:";
const STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CUSTOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

const summaryOf = (
  id: string,
  source: PlaybookSummary["source"],
  playbook: Playbook,
  updatedAt: Date | null,
): PlaybookSummary => ({
  id,
  source,
  name: playbook.name,
  contractTypes: [...playbook.contractTypes],
  ruleCount: playbook.rules.length,
  updatedAt: updatedAt === null ? null : updatedAt.toISOString(),
});

// YAML can write a NUL character as the escape \0 in a quoted name, and the database cannot store
// one in text. The name is kept in a column of its own, so it is the one value that has to be
// looked at here; every other text of a playbook is stored as YAML, where the escape is two
// ordinary characters, and the texts of a report are cleaned when the report is saved.
const NUL_IN_NAME =
  "The playbook name contains a NUL character (written \\0 in YAML), which cannot be stored. Take it out of the name.";

/**
 * Playbook YAML as the server accepts it: no larger than the limit, and valid. `parsePlaybook`
 * reads it with the YAML library's own protection against alias bombs, and then checks the
 * shape, listing every problem.
 */
function parseChecked(yaml: string): Playbook {
  if (Buffer.byteLength(yaml, "utf8") > LIMITS.maxPlaybookBytes) {
    throw tooLarge(`The playbook is larger than ${LIMITS.maxPlaybookBytes / 1024} KB.`);
  }
  let playbook: Playbook;
  try {
    playbook = parsePlaybook(yaml, "The playbook");
  } catch (error) {
    if (error instanceof PlaybookError) throw badRequest(error.message);
    throw error;
  }
  if (playbook.name.includes("\u0000")) throw badRequest(NUL_IN_NAME);
  return playbook;
}

export function createPlaybookStore(args: {
  db: Db;
  dir: string;
  clock: Clock;
  ids: IdSource;
  log: Logger;
}): PlaybookStore {
  const { db, dir, clock, ids, log } = args;

  // Read from the folder each time: there are a handful of small files, and an owner who adds a
  // playbook to the folder sees it without restarting. A file that is not a valid playbook is
  // left out and named in the log, so one bad file does not hide the others.
  async function builtin(): Promise<Map<string, { yaml: string; playbook: Playbook }>> {
    const found = new Map<string, { yaml: string; playbook: Playbook }>();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return found;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".yaml")) continue;
      const stem = name.slice(0, -".yaml".length);
      if (!STEM.test(stem)) continue;
      try {
        const path = join(dir, name);
        const info = await stat(path);
        if (!info.isFile() || info.size > LIMITS.maxPlaybookBytes) continue;
        const yaml = await readFile(path, "utf8");
        const playbook = parsePlaybook(yaml, name);
        if (playbook.name.includes("\u0000")) throw new Error(NUL_IN_NAME);
        found.set(`${BUILTIN_PREFIX}${stem}`, { yaml, playbook });
      } catch {
        log.warn("a built-in playbook file is not valid and was left out", { file: name });
      }
    }
    return found;
  }

  async function custom(id: string) {
    if (!CUSTOM_ID.test(id)) return undefined;
    const [row] = await db.select().from(playbooks).where(eq(playbooks.id, id));
    return row;
  }

  const detailOf = (summary: PlaybookSummary, yaml: string, editable: boolean): PlaybookDetail => ({
    ...summary,
    yaml,
    editable,
  });

  return {
    async list() {
      const result: PlaybookSummary[] = [];
      for (const [id, { playbook }] of await builtin()) {
        result.push(summaryOf(id, "builtin", playbook, null));
      }
      const rows = await db.select().from(playbooks);
      rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      for (const row of rows) {
        try {
          result.push(summaryOf(row.id, "custom", parsePlaybook(row.yaml), row.updatedAt));
        } catch {
          // Saved after validation, so this is not expected. It stays in the list, so that the
          // person can open it and fix it.
          result.push({
            id: row.id,
            source: "custom",
            name: row.name,
            contractTypes: [],
            ruleCount: 0,
            updatedAt: row.updatedAt.toISOString(),
          });
        }
      }
      return result;
    },

    async get(id) {
      if (id.startsWith(BUILTIN_PREFIX)) {
        const entry = (await builtin()).get(id);
        return entry === undefined
          ? undefined
          : detailOf(summaryOf(id, "builtin", entry.playbook, null), entry.yaml, false);
      }
      const row = await custom(id);
      if (row === undefined) return undefined;
      let summary: PlaybookSummary;
      try {
        summary = summaryOf(row.id, "custom", parsePlaybook(row.yaml), row.updatedAt);
      } catch {
        summary = {
          id: row.id,
          source: "custom",
          name: row.name,
          contractTypes: [],
          ruleCount: 0,
          updatedAt: row.updatedAt.toISOString(),
        };
      }
      return detailOf(summary, row.yaml, true);
    },

    async resolve(id) {
      if (id.startsWith(BUILTIN_PREFIX)) {
        const entry = (await builtin()).get(id);
        return entry === undefined
          ? undefined
          : { id, name: entry.playbook.name, yaml: entry.yaml, playbook: entry.playbook };
      }
      const row = await custom(id);
      if (row === undefined) return undefined;
      return { id: row.id, name: row.name, yaml: row.yaml, playbook: parseChecked(row.yaml) };
    },

    validate(yaml) {
      if (Buffer.byteLength(yaml, "utf8") > LIMITS.maxPlaybookBytes) {
        throw tooLarge(`The playbook is larger than ${LIMITS.maxPlaybookBytes / 1024} KB.`);
      }
      try {
        const playbook = parsePlaybook(yaml, "The playbook");
        if (playbook.name.includes("\u0000")) return { ok: false, problems: [NUL_IN_NAME] };
        return {
          ok: true,
          name: playbook.name,
          ruleCount: playbook.rules.length,
          contractTypes: [...playbook.contractTypes],
        };
      } catch (error) {
        if (error instanceof PlaybookError) {
          return {
            ok: false,
            problems: error.problems.length > 0 ? error.problems : [error.message],
          };
        }
        throw error;
      }
    },

    async create(yaml) {
      const playbook = parseChecked(yaml);
      const now = clock.now();
      const id = ids.shortId();
      await db.insert(playbooks).values({
        id,
        name: playbook.name,
        yaml,
        createdAt: now,
        updatedAt: now,
      });
      return detailOf(summaryOf(id, "custom", playbook, now), yaml, true);
    },

    async update(id, yaml) {
      if (id.startsWith(BUILTIN_PREFIX)) {
        throw forbidden("The built-in playbooks cannot be changed. Copy it to edit your own.");
      }
      if ((await custom(id)) === undefined) throw notFound("There is no such playbook.");
      const playbook = parseChecked(yaml);
      const now = clock.now();
      await db
        .update(playbooks)
        .set({ name: playbook.name, yaml, updatedAt: now })
        .where(eq(playbooks.id, id));
      return detailOf(summaryOf(id, "custom", playbook, now), yaml, true);
    },

    async remove(id) {
      if (id.startsWith(BUILTIN_PREFIX)) {
        throw forbidden("The built-in playbooks cannot be deleted.");
      }
      if ((await custom(id)) === undefined) throw notFound("There is no such playbook.");
      await db.delete(playbooks).where(eq(playbooks.id, id));
    },
  };
}
