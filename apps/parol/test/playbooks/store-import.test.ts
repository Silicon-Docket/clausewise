import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PlaybookError } from "@clausewise/playbook";
import { loadPlaybook } from "../../src/playbooks/load.js";
import {
  DEMO_USER_IDS,
  ValidationError,
  createRepository,
  openDatabase,
} from "../../src/store/index.js";
import { loadObject, playbookOf, ruleFor, rulesWith, yamlOf } from "./support.js";

// The loader exists to feed the store, so this checks the two against each other: what the loader
// returns must be accepted as it is, and what the store hands back must be what the loader read.
const yaml = readFileSync(
  join(import.meta.dirname, "..", "..", "playbooks", "parol-nda-recipient.yaml"),
  "utf8",
);
const demo = loadPlaybook({ yaml, slug: "parol-nda-recipient" });

const sha256Of = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

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
    const version = repo.importPlaybookDraft(asImport(demo), {
      actorId: DEMO_USER_IDS.legalEngineer,
    });
    expect(version).toMatchObject({
      slug: "parol-nda-recipient",
      version: "1.0.0",
      sha256: demo.sha256,
    });
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

// The loader's limits are copies of the store's, so these tests hold the two together: whatever
// the loader accepts at the edge of a limit the store imports, and one step past it both refuse.
describe("the loader and the store agree on the limits", () => {
  const importOf = (loaded: typeof demo) =>
    freshRepo().importPlaybookDraft(asImport(loaded), { actorId: DEMO_USER_IDS.legalEngineer });

  it("on the length of a rule id: 64 characters import, 65 are refused by both", () => {
    const withId = (id: string) =>
      playbookOf({ rules: rulesWith("parties", ruleFor("parties", { id })) });
    const id = "x".repeat(64);
    expect(importOf(loadObject(withId(id))).sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(() => loadObject(withId("x".repeat(65)))).toThrow(PlaybookError);
    // What the loader refuses is what the store would have refused had the loader let it through.
    const atLimit = loadObject(withId(id));
    const forged = { ...asImport(atLimit), rules: [{ ...atLimit.rules[0]!, key: "x".repeat(65) }] };
    expect(() =>
      freshRepo().importPlaybookDraft(forged, { actorId: DEMO_USER_IDS.legalEngineer }),
    ).toThrow(ValidationError);
  });

  it("on the length of a version: 32 characters import, 33 are refused by both", () => {
    const longest = "1234567890.1234567890.1234567890";
    expect(importOf(loadObject(playbookOf({ version: longest }))).version).toBe(longest);

    const tooLong = "1234567890.1234567890.12345678901";
    expect(() => loadObject(playbookOf({ version: tooLong }))).toThrow(PlaybookError);
    const ok = loadObject(playbookOf());
    expect(() =>
      freshRepo().importPlaybookDraft(
        { ...asImport(ok), version: tooLong },
        { actorId: DEMO_USER_IDS.legalEngineer },
      ),
    ).toThrow(ValidationError);
  });

  it("on the size of the YAML: 1,000,000 characters import, 1,000,001 are refused by both", () => {
    const head = `${yamlOf(playbookOf())}\n#`;
    const padded = (length: number) => head + "x".repeat(length - head.length);
    const atLimit = loadPlaybook({ yaml: padded(1_000_000), slug: "big-playbook" });
    expect(importOf(atLimit).sha256).toBe(atLimit.sha256);

    expect(() => loadPlaybook({ yaml: padded(1_000_001), slug: "big-playbook" })).toThrow(
      PlaybookError,
    );
    const yaml = padded(1_000_001);
    const forged = { ...asImport(atLimit), yaml, sha256: sha256Of(yaml) };
    expect(() =>
      freshRepo().importPlaybookDraft(forged, { actorId: DEMO_USER_IDS.legalEngineer }),
    ).toThrow(ValidationError);
  });

  it("on the form of a version: what the loader returns is always a version the store accepts", () => {
    for (const version of ["0.0.0", "1.0.0", "10.20.30", "1.2.3"]) {
      const loaded = loadObject(playbookOf({ version }));
      expect(importOf(loaded).version).toBe(version);
    }
  });
});
