import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlaybook } from "../../src/playbooks/load.js";
import {
  DEMO_USER_IDS,
  ValidationError,
  createRepository,
  openDatabase,
} from "../../src/store/index.js";

// The loader exists to feed the store, so this checks the two against each other: what the loader
// returns must be accepted as it is, and what the store hands back must be what the loader read.
const yaml = readFileSync(
  join(import.meta.dirname, "..", "..", "playbooks", "parol-nda-recipient.yaml"),
  "utf8",
);
const demo = loadPlaybook({ yaml, slug: "parol-nda-recipient" });

const freshRepo = () => {
  const repo = createRepository(openDatabase(":memory:"), {
    now: () => new Date("2026-11-01T09:00:00.000Z"),
  });
  repo.seedDemoUsers();
  return repo;
};

const asImport = (loaded: typeof demo) => ({
  slug: loaded.slug,
  version: loaded.version,
  yaml: loaded.yaml,
  sha256: loaded.sha256,
  rules: loaded.rules,
});

describe("importing a loaded playbook into the store", () => {
  it("is accepted as returned, and every rule reads back as the loader mapped it", () => {
    const repo = freshRepo();
    const version = repo.importPlaybookDraft(asImport(demo), { actorId: DEMO_USER_IDS.legalEngineer });
    expect(version).toMatchObject({ slug: "parol-nda-recipient", version: "1.0.0", sha256: demo.sha256 });
    const stored = repo.listRules(version.id);
    expect(stored).toHaveLength(8);
    stored.forEach((rule, i) => expect(rule).toMatchObject(demo.rules[i] as object));
  });

  it("takes the loader's hash as the hash of the YAML, and a hash of anything else is refused", () => {
    const repo = freshRepo();
    const wrong = { ...asImport(demo), yaml: `${demo.yaml}# edited\n` };
    expect(() => repo.importPlaybookDraft(wrong, { actorId: DEMO_USER_IDS.legalEngineer })).toThrow(
      ValidationError,
    );
  });

  it("can be imported twice without a second row, because the hash is of the text", () => {
    const repo = freshRepo();
    const a = repo.importPlaybookDraft(asImport(demo), { actorId: DEMO_USER_IDS.legalEngineer });
    const again = loadPlaybook({ yaml, slug: "parol-nda-recipient" });
    const b = repo.importPlaybookDraft(asImport(again), { actorId: DEMO_USER_IDS.legalEngineer });
    expect(b.id).toBe(a.id);
    expect(repo.listPlaybookVersions("parol-nda-recipient")).toHaveLength(1);
  });
});
