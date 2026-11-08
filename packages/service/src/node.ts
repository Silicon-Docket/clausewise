import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Playbook } from "@clausewise/playbook";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import type { PlaybookSource, PlaybookSummary } from "./types.js";

// An id is a file name without its extension, and it is checked before it touches the file system
// so a request cannot name a file outside the folder.
const PLAYBOOK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The playbooks in one folder, each `<id>.yaml`. This is the playbook library of version 1's
 * first slice; the library the firm edits in the app comes later.
 */
export function directoryPlaybooks(dir: string): PlaybookSource {
  const loaded = new Map<string, Promise<Playbook>>();

  async function ids(): Promise<string[]> {
    const names = await readdir(dir);
    return names
      .filter((name) => name.endsWith(".yaml"))
      .map((name) => name.slice(0, -".yaml".length))
      .filter((id) => PLAYBOOK_ID.test(id))
      .sort();
  }

  function load(id: string): Promise<Playbook> {
    let playbook = loaded.get(id);
    if (playbook === undefined) {
      playbook = loadPlaybookFile(join(dir, `${id}.yaml`));
      // A broken file is read again next time, once someone has fixed it.
      playbook.catch(() => loaded.delete(id));
      loaded.set(id, playbook);
    }
    return playbook;
  }

  return {
    async list(): Promise<PlaybookSummary[]> {
      const summaries: PlaybookSummary[] = [];
      for (const id of await ids()) {
        const playbook = await load(id);
        summaries.push({ id, name: playbook.name, rules: playbook.rules.length });
      }
      return summaries;
    },
    async get(id) {
      if (!PLAYBOOK_ID.test(id) || !(await ids()).includes(id)) return undefined;
      return load(id);
    },
  };
}
