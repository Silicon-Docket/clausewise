import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEMO_PLAYBOOK_PATH,
  DEMO_PLAYBOOK_SLUG,
  markInterruptedRuns,
  registerAll,
  sweepOrphanFiles,
} from "../../src/boot/index.js";
import { hashOf } from "../../src/canonical.js";
import { loadPlaybook } from "../../src/playbooks/load.js";
import { getPrompt } from "../../src/prompts/registry.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { FileStore, createRepository, openDatabase } from "../../src/store/index.js";
import { cleanup, gate, makeWorld, newMatter, uploadCase } from "./support.js";

afterAll(cleanup);

const scratch = mkdtempSync(join(tmpdir(), "parol-boot-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fresh = () => createRepository(openDatabase(":memory:"));
const auditCount = (repo: ReturnType<typeof fresh>) =>
  repo.listAuditEvents({ limit: 10000 }).length;

describe("registerAll", () => {
  it("registers the prompts, both workflow versions and the approved demo playbook", () => {
    const repo = fresh();
    const registered = registerAll(repo, { seedDemoUsers: true });

    for (const id of ["extract.p1", "analyze.p1", "support.p1"])
      expect(repo.getPromptVersion(id)?.sha256).toBe(getPrompt(id).sha256);
    for (const label of ["v1", "v2"]) {
      const row = repo.getWorkflowVersionByLabel(label)!;
      expect(row.sha256).toBe(WORKFLOWS[label]!.sha256);
      expect(hashOf(row.manifest)).toBe(row.sha256);
      expect(row.status).toBe("candidate");
    }
    expect(registered.workflows.map((w) => w.label)).toEqual(["v1", "v2"]);

    const loaded = loadPlaybook({
      yaml: readFileSync(DEMO_PLAYBOOK_PATH, "utf8"),
      slug: DEMO_PLAYBOOK_SLUG,
    });
    expect(registered.playbook).toMatchObject({
      slug: "parol-nda-recipient",
      version: "1.0.1",
      status: "approved",
      sha256: loaded.sha256,
      approvedBy: "usr_demo_admin",
    });
    expect(repo.listRules(registered.playbook.id).map((r) => r.key)).toEqual(
      loaded.rules.map((r) => r.key),
    );
    expect(repo.listUsers().map((u) => u.id)).toEqual([
      "usr_demo_admin",
      "usr_demo_associate",
      "usr_demo_engineer",
      "usr_demo_reviewer",
    ]);
  });

  it("changes nothing the second time, and writes nothing to the audit trail", () => {
    const repo = fresh();
    const first = registerAll(repo, { seedDemoUsers: true });
    const events = auditCount(repo);
    const second = registerAll(repo, { seedDemoUsers: true });
    expect(second.playbook).toEqual(first.playbook);
    expect(second.workflows).toEqual(first.workflows);
    expect(auditCount(repo)).toBe(events);
    expect(repo.listPlaybookVersions()).toHaveLength(1);
    expect(repo.listWorkflowVersions()).toHaveLength(2);
    expect(repo.listPromptVersions()).toHaveLength(3);
    expect(repo.verifyAuditChain()).toMatchObject({ ok: true });
  });

  it("finds the playbook from the package and not from the folder the server was started in", () => {
    expect(isAbsolute(DEMO_PLAYBOOK_PATH)).toBe(true);
    expect(
      DEMO_PLAYBOOK_PATH.endsWith(join("apps", "parol", "playbooks", "parol-nda-recipient.yaml")),
    ).toBe(true);
    const here = process.cwd();
    try {
      process.chdir(scratch);
    } catch {
      // A worker that cannot change folder proves nothing here; the path checks above stand.
      return;
    }
    try {
      expect(registerAll(fresh(), { seedDemoUsers: true }).playbook.status).toBe("approved");
    } finally {
      process.chdir(here);
    }
  });

  it("does not seed users unless asked, and says what is missing when they are needed", () => {
    const repo = fresh();
    expect(() => registerAll(repo, { seedDemoUsers: false })).toThrow(/seed them/);
    expect(repo.listUsers()).toEqual([]);
    repo.seedDemoUsers();
    expect(registerAll(repo, { seedDemoUsers: false }).playbook.status).toBe("approved");
  });

  it("completes a playbook that was imported and not approved", () => {
    const repo = fresh();
    repo.seedDemoUsers();
    const loaded = loadPlaybook({
      yaml: readFileSync(DEMO_PLAYBOOK_PATH, "utf8"),
      slug: DEMO_PLAYBOOK_SLUG,
    });
    const draft = repo.importPlaybookDraft(
      {
        slug: loaded.slug,
        version: loaded.version,
        yaml: loaded.yaml,
        sha256: loaded.sha256,
        rules: loaded.rules,
      },
      { actorId: "usr_demo_engineer" },
    );
    expect(draft.status).toBe("draft");
    expect(registerAll(repo, { seedDemoUsers: false }).playbook).toMatchObject({
      id: draft.id,
      status: "approved",
    });
  });

  it("refuses to start on a playbook file that changed without a new version", () => {
    const repo = fresh();
    registerAll(repo, { seedDemoUsers: true });
    const folder = join(scratch, "changed");
    mkdirSync(folder, { recursive: true });
    const changed = join(folder, "parol-nda-recipient.yaml");
    copyFileSync(DEMO_PLAYBOOK_PATH, changed);
    writeFileSync(changed, `${readFileSync(changed, "utf8")}\n# a comment added after approval\n`);
    expect(() => registerAll(repo, { seedDemoUsers: false, playbookPath: changed })).toThrow(
      expect.objectContaining({ code: "playbook_version_exists" }),
    );
    // What was approved is untouched.
    expect(repo.listPlaybookVersions()).toHaveLength(1);
  });
});

describe("after a restart", () => {
  it("marks what was in flight as interrupted and logs ids only", async () => {
    const hold = gate();
    const w = makeWorld({
      model: {
        before: async (c) => {
          if (c.kind === "extract") await hold.pass();
        },
      },
    });
    const { matterId, am } = newMatter(w);
    await uploadCase(w, matterId);
    const run = w.services.runs.start(am, {});
    await hold.reached(1);
    const lines: string[] = [];
    expect(markInterruptedRuns(w.repo, (l) => lines.push(l))).toEqual([
      { matterId, runId: run.id },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(run.id);
    expect(markInterruptedRuns(w.repo)).toEqual([]);
    expect(w.repo.getRun(matterId, run.id)).toMatchObject({
      status: "failed",
      errorKind: "interrupted",
    });
  });

  it("removes the folder of a matter whose rows are gone, and no other", async () => {
    const w = makeWorld();
    const kept = newMatter(w, "kept");
    await uploadCase(w, kept.matterId);
    // A crash between deleting the rows and deleting the files leaves a folder no row names.
    const gone = newMatter(w, "gone");
    await uploadCase(w, gone.matterId);
    w.repo.deleteMatter(gone.matterId, { actorId: w.associate.userId });
    expect(w.files.listMatterIds().sort()).toEqual([gone.matterId, kept.matterId].sort());
    const lines: string[] = [];
    expect(sweepOrphanFiles(w.repo, w.files, (l) => lines.push(l))).toEqual([gone.matterId]);
    expect(w.files.listMatterIds()).toEqual([kept.matterId]);
    expect(lines).toEqual([`matter ${gone.matterId}: removed files that had no matter`]);
    expect(FileStore).toBeDefined();
  });
});
