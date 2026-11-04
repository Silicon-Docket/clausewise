import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { authorizeMatter } from "../../src/auth/authorize.js";
import type { Principal } from "../../src/auth/types.js";
import { sha256Hex } from "../../src/canonical.js";
import { DEMO_MATTERS, HERONBRIDGE_NDA, textFileBytes } from "../../src/demo/matters.js";
import { createSimulatedModel } from "../../src/demo/simulated-model.js";
import { ConfigError } from "../../src/main.js";
import { SeedError, parseSeedArgs, runSeed, seedDemo } from "../../src/seed.js";
import { createServices } from "../../src/services/index.js";
import {
  DEMO_USER_IDS,
  FileStore,
  NotFoundError,
  createRepository,
  openDatabase,
  type Repository,
} from "../../src/store/index.js";
import { ROOT } from "../integration/pipeline.js";

/**
 * The demonstration seed: it creates two matters through the services, only once, and leaves the
 * first ready to run and not yet run. Everything is synthetic, in memory or in a temporary folder.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "parol-seed-"));
  roots.push(root);
  return root;
}

function newWorld() {
  const root = folder();
  const repo = createRepository(openDatabase(":memory:"));
  const files = new FileStore(join(root, "matters"));
  return { root, repo, files };
}

const principalOf = (repo: Repository, userId: string): Principal => {
  const user = repo.getUser(userId)!;
  return { userId: user.id, displayName: user.displayName, globalRole: user.globalRole };
};

const count = (repo: Repository, table: string): number =>
  (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

/** Every table's row count, so that "creates nothing new" is not only about matters. */
function census(repo: Repository): Record<string, number> {
  const tables = repo.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(tables.map(({ name }) => [name, count(repo, name)]));
}

const FIXTURES = join(ROOT, "fixtures", "parol", "files");

describe("the first seed", () => {
  it("creates the two matters, each owned by the person the seed names", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });

    expect(report.matters.map((m) => [m.key, m.name, m.created, m.documentsAdded])).toEqual([
      ["lanternfish", "Lanternfish / Corvane NDA", true, 2],
      ["heronbridge", "Heronbridge / Tamarind NDA", true, 1],
    ]);
    expect(report.playbook).toEqual({ slug: "parol-nda-recipient", version: "1.0.1" });
    expect(report.runs).toEqual([]);

    const alex = repo.listMattersForUser(DEMO_USER_IDS.associate);
    const lee = repo.listMattersForUser(DEMO_USER_IDS.legalEngineer);
    expect(alex.map((m) => [m.name, m.role])).toEqual([["Lanternfish / Corvane NDA", "associate"]]);
    expect(lee.map((m) => [m.name, m.role])).toEqual([["Heronbridge / Tamarind NDA", "associate"]]);
    expect(count(repo, "matters")).toBe(2);
    expect(alex[0]!.clientLegalName).toBe("Lanternfish Software, Inc.");
    expect(alex[0]!.createdBy).toBe(DEMO_USER_IDS.associate);
    expect(lee[0]!.createdBy).toBe(DEMO_USER_IDS.legalEngineer);
  });

  it("puts the reviewing attorney on the first matter and nobody else on the second", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const [first, second] = report.matters;
    expect(
      repo
        .listMembers(first!.matterId)
        .map((m) => [m.userId, m.role])
        .sort(),
    ).toEqual(
      [
        [DEMO_USER_IDS.associate, "associate"],
        [DEMO_USER_IDS.reviewer, "reviewer"],
      ].sort(),
    );
    expect(repo.listMembers(second!.matterId).map((m) => [m.userId, m.role])).toEqual([
      [DEMO_USER_IDS.legalEngineer, "associate"],
    ]);
    expect(first!.ownerName).toBe("Alex Ruiz (associate)");
    expect(first!.reviewerName).toBe("Dana Whitfield (reviewing attorney)");
    expect(second!.reviewerName).toBeNull();
  });

  it("uploads the NDA and Amendment No. 1 of the worked example, byte for byte, with their stated dates", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const matterId = report.matters[0]!.matterId;
    const documents = repo.listDocuments(matterId);
    expect(documents.map((d) => [d.ordinal, d.kind, d.title])).toEqual([
      [1, "nda", "Mutual NDA"],
      [2, "amendment", "Amendment No. 1"],
    ]);
    const versions = repo.listVersions(matterId);
    expect(versions.map((v) => [v.mediaType, v.statedDate, v.operative, v.versionNo])).toEqual([
      ["docx", "2026-02-02", true, 1],
      ["txt", "2026-09-15", true, 1],
    ]);
    expect(versions[0]!.fileSha256).toBe(
      sha256Hex(readFileSync(join(FIXTURES, "parol-d05-nda.docx"))),
    );
    expect(versions[1]!.fileSha256).toBe(
      sha256Hex(readFileSync(join(FIXTURES, "parol-d05-amendment-1.txt"))),
    );
  });

  it("agrees with the evaluation key about the documents it uploads", async () => {
    // The seed does not read the key; this is the check that its table has not drifted from it.
    const keys = JSON.parse(
      readFileSync(join(ROOT, "fixtures", "parol", "answer-keys.json"), "utf8"),
    );
    const d05 = keys.cases.find((c: { case: string }) => c.case === "PAROL-D05");
    const seeded = DEMO_MATTERS[0]!;
    expect(seeded.clientLegalName).toBe(d05.intake.clientLegalName);
    expect(seeded.documents.map((d) => [d.title, d.kind, d.fileName, d.statedDate])).toEqual(
      d05.documents.map((d: { title: string; kind: string; file: string; statedDate: string }) => [
        d.title,
        d.kind,
        d.file,
        d.statedDate,
      ]),
    );
  });

  it("uploads the second matter's NDA from the text written in the demo folder", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const matterId = report.matters[1]!.matterId;
    const [version] = repo.listVersions(matterId);
    expect(repo.listDocuments(matterId)).toHaveLength(1);
    expect(version!.mediaType).toBe("txt");
    expect(version!.fileSha256).toBe(sha256Hex(textFileBytes(HERONBRIDGE_NDA)));
    expect(version!.statedDate).toBe("2026-04-14");
  });

  it("pins the approved playbook and leaves both matters ready to run and not yet run", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const approved = repo.findPlaybookVersion("parol-nda-recipient", "1.0.1")!;
    expect(approved.status).toBe("approved");
    for (const { matterId } of report.matters) {
      const matter = repo.getMatter(matterId)!;
      expect(matter.playbookVersionId).toBe(approved.id);
      expect(matter.status).toBe("ready");
      expect(matter.synthetic).toBe(true);
      expect(repo.listRunsForMatter(matterId)).toEqual([]);
    }
    expect(count(repo, "runs")).toBe(0);
    expect(count(repo, "model_calls")).toBe(0);
  });

  it("reports what each demo identity can see, as the services list it", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    expect(report.people).toEqual([
      { name: "Alex Ruiz (associate)", matters: ["Lanternfish / Corvane NDA"] },
      { name: "Dana Whitfield (reviewing attorney)", matters: ["Lanternfish / Corvane NDA"] },
      { name: "Lee Okafor (legal engineer)", matters: ["Heronbridge / Tamarind NDA"] },
      { name: "Sam Patel (admin)", matters: [] },
    ]);
  });

  it("registers what a run depends on: the prompts, both workflow versions and the demo users", async () => {
    const { repo, files } = newWorld();
    await seedDemo({ repo, files });
    for (const id of ["extract.p1", "analyze.p1", "support.p1"])
      expect(repo.getPromptVersion(id), id).toBeDefined();
    expect(
      repo
        .listWorkflowVersions()
        .map((w) => w.label)
        .sort(),
    ).toEqual(["v1", "v2"]);
    expect(
      repo
        .listUsers()
        .map((u) => u.id)
        .sort(),
    ).toEqual(Object.values(DEMO_USER_IDS).sort());
  });

  it("goes through the services: every change is audited, and the matters are in the log", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const events = repo.listAuditEvents({ limit: 10_000 });
    for (const { matterId } of report.matters)
      expect(
        events.filter((e) => e.matterId === matterId).map((e) => e.action),
        matterId,
      ).toEqual(expect.arrayContaining(["matter.create", "document.add"]));
  });
});

describe("a second seed", () => {
  it("creates nothing new: not a matter, a document, a version, a file or an audit event", async () => {
    const { repo, files, root } = newWorld();
    const first = await seedDemo({ repo, files });
    const before = census(repo);
    const filesBefore = readFileTree(join(root, "matters"));
    expect(before.matters).toBe(2);

    const second = await seedDemo({ repo, files });
    expect(census(repo)).toEqual(before);
    expect(readFileTree(join(root, "matters"))).toEqual(filesBefore);
    expect(second.matters.map((m) => [m.created, m.documentsAdded])).toEqual([
      [false, 0],
      [false, 0],
    ]);
    expect(second.matters.map((m) => m.matterId)).toEqual(first.matters.map((m) => m.matterId));
  });

  it("is safe to run many times, and the audit chain stays intact", async () => {
    const { repo, files } = newWorld();
    for (let i = 0; i < 3; i++) await seedDemo({ repo, files });
    expect(count(repo, "matters")).toBe(2);
    expect(count(repo, "documents")).toBe(3);
    expect(count(repo, "document_versions")).toBe(3);
    expect(repo.verifyAuditChain().ok).toBe(true);
  });

  it("finishes a seed that stopped half way, adding only what is missing", async () => {
    const { repo, files, root } = newWorld();
    // A copy of the dataset folder without the amendment: the first matter gets its NDA, then the
    // seed stops, as it would if the file were lost or the process were killed.
    const partial = join(root, "partial");
    mkdirSync(partial);
    copyFileSync(join(FIXTURES, "parol-d05-nda.docx"), join(partial, "parol-d05-nda.docx"));
    const error = await seedDemo({ repo, files, fixturesDir: partial }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeedError);
    // The message says what is wrong and not where the folder is.
    expect((error as Error).message).toMatch(/missing from the dataset/);
    expect((error as Error).message).not.toContain(partial);
    expect(count(repo, "matters")).toBe(1);
    expect(count(repo, "document_versions")).toBe(1);

    const report = await seedDemo({ repo, files });
    expect(report.matters.map((m) => [m.created, m.documentsAdded])).toEqual([
      [false, 1],
      [true, 1],
    ]);
    expect(count(repo, "matters")).toBe(2);
    expect(count(repo, "document_versions")).toBe(3);
    expect(repo.getMatter(report.matters[0]!.matterId)!.status).toBe("ready");
  });

  it("sets the playbook on a matter that has none, and leaves one the user chose", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const matterId = report.matters[0]!.matterId;
    repo.db.prepare("UPDATE matters SET playbook_version_id = NULL WHERE id = ?").run(matterId);
    await seedDemo({ repo, files });
    expect(repo.getMatter(matterId)!.playbookVersionId).toBe(
      repo.findPlaybookVersion("parol-nda-recipient", "1.0.1")!.id,
    );
  });

  it("makes a new matter when the old one was deleted", async () => {
    const { repo, files } = newWorld();
    const first = await seedDemo({ repo, files });
    const services = createServices({
      repo,
      files,
      generator: createSimulatedModel(),
      config: { relaxedSegregation: false },
      now: () => new Date(),
      log: () => {},
    });
    const owner = principalOf(repo, DEMO_USER_IDS.associate);
    await services.matters.delete(
      authorizeMatter(repo, owner, first.matters[0]!.matterId, "matter.read"),
    );
    const again = await seedDemo({ repo, files });
    expect(again.matters[0]!.created).toBe(true);
    expect(again.matters[0]!.matterId).not.toBe(first.matters[0]!.matterId);
    expect(again.matters[1]!.created).toBe(false);
  });
});

describe("two people, two matters", () => {
  it("shows each person only their own, and answers a matter that is not theirs as if it were not there", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files });
    const [first, second] = report.matters.map((m) => m.matterId) as [string, string];
    const services = createServices({
      repo,
      files,
      generator: createSimulatedModel(),
      config: { relaxedSegregation: false },
      now: () => new Date(),
      log: () => {},
    });
    const alex = principalOf(repo, DEMO_USER_IDS.associate);
    const dana = principalOf(repo, DEMO_USER_IDS.reviewer);
    const lee = principalOf(repo, DEMO_USER_IDS.legalEngineer);
    const sam = principalOf(repo, DEMO_USER_IDS.admin);

    expect(services.matters.list(alex).map((m) => m.id)).toEqual([first]);
    expect(services.matters.list(dana).map((m) => m.id)).toEqual([first]);
    expect(services.matters.list(lee).map((m) => m.id)).toEqual([second]);
    expect(services.matters.list(sam)).toEqual([]);

    expect(() => authorizeMatter(repo, alex, second, "matter.read")).toThrow(NotFoundError);
    expect(() => authorizeMatter(repo, lee, first, "matter.read")).toThrow(NotFoundError);
    expect(() => authorizeMatter(repo, dana, second, "matter.read")).toThrow(NotFoundError);
    // The error is the same one a matter that does not exist gives.
    const missing = (() => {
      try {
        authorizeMatter(repo, alex, "mat_0000000000000000", "matter.read");
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    const foreign = (() => {
      try {
        authorizeMatter(repo, alex, second, "matter.read");
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(foreign?.message).toBe(missing?.message);
  });
});

describe("asking for reviews", () => {
  it("runs workflow v1 and then v2 on the first matter with the simulated reader, and shows the gap and its fix", async () => {
    const { repo, files } = newWorld();
    const report = await seedDemo({ repo, files, runs: ["v1", "v2"] });
    expect(report.runs.map((r) => [r.workflowLabel, r.started, r.status, r.findingCount])).toEqual([
      ["v1", true, "succeeded", 8],
      ["v2", true, "succeeded", 8],
    ]);

    const matterId = report.matters[0]!.matterId;
    const runs = repo.listRunsForMatter(matterId);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      // The run records what read the documents.
      expect([run.modelProvider, run.modelRequested]).toEqual([
        "simulated",
        "parol-simulated-reader",
      ]);
    }
    const dur = (runId: string) =>
      repo.listFindings(matterId, runId).find((f) => f.ruleKey === "dur-1")!;
    const byLabel = new Map(report.runs.map((r) => [r.workflowLabel, dur(r.runId)] as const));
    expect(byLabel.get("v1")!.status).toBe("compliant");
    expect(byLabel.get("v1")!.verificationState).toBe("verified");
    expect(byLabel.get("v2")!.status).toBe("deviation");
    expect(byLabel.get("v2")!.verificationState).toBe("verified");
    // The second matter is never reviewed.
    expect(repo.listRunsForMatter(report.matters[1]!.matterId)).toEqual([]);
  });

  it("does not run a workflow again when it has already run, and does not touch what is there", async () => {
    const { repo, files } = newWorld();
    const first = await seedDemo({ repo, files, runs: ["v2"] });
    const before = census(repo);
    const second = await seedDemo({ repo, files, runs: ["v2"] });
    expect(second.runs.map((r) => [r.started, r.runId])).toEqual([[false, first.runs[0]!.runId]]);
    expect(census(repo)).toEqual(before);
  });

  it("leaves a matter not run at all when no review is asked for", async () => {
    const { repo, files } = newWorld();
    await seedDemo({ repo, files });
    expect(count(repo, "runs")).toBe(0);
  });
});

describe("the options", () => {
  it("accepts the registered workflow versions, in either spelling, once each", () => {
    expect(parseSeedArgs([])).toEqual({ runs: [] });
    expect(parseSeedArgs(["--run", "v1", "--run=v2", "--run", "v1"])).toEqual({
      runs: ["v1", "v2"],
    });
  });

  it("accepts the lone -- that pnpm passes on when the options are written after it", () => {
    // pnpm parol:seed -- --run v1
    expect(parseSeedArgs(["--", "--run", "v1"])).toEqual({ runs: ["v1"] });
    expect(parseSeedArgs(["--"])).toEqual({ runs: [] });
    expect(parseSeedArgs(["--", "--run=v2", "--run", "v1"])).toEqual({ runs: ["v2", "v1"] });
    // It is a separator and not a way to smuggle in a word: what follows is still checked.
    expect(() => parseSeedArgs(["--", "--nope"])).toThrow(SeedError);
    expect(() => parseSeedArgs(["--", "v1"])).toThrow(SeedError);
  });

  it("refuses an option it does not know and a workflow that is not registered", () => {
    for (const args of [["--nope"], ["--run"], ["--run", "v9"], ["--run=", "x"], ["v1"]])
      expect(() => parseSeedArgs(args), args.join(" ")).toThrow(SeedError);
    // It names the kind of problem and never repeats what was typed.
    try {
      parseSeedArgs(["--run", "QZX-TYPED"]);
    } catch (error) {
      expect((error as Error).message).not.toContain("QZX-TYPED");
    }
  });
});

describe("the command", () => {
  const demo = (dataDir: string, extra: Record<string, string> = {}) => ({
    PAROL_DEMO_IDENTITY: "1",
    PAROL_DATA_DIR: dataDir,
    ...extra,
  });

  it("refuses to run unless the demo identity is on, and opens nothing", async () => {
    const dataDir = join(folder(), "data");
    for (const env of [{}, { PAROL_DEMO_IDENTITY: "0" }, { PAROL_DEMO_IDENTITY: "false" }]) {
      const lines: string[] = [];
      const error = await runSeed({ ...env, PAROL_DATA_DIR: dataDir }, [], (l) =>
        lines.push(l),
      ).catch((e: unknown) => e);
      expect(error, JSON.stringify(env)).toBeInstanceOf(SeedError);
      expect((error as Error).message).toMatch(/PAROL_DEMO_IDENTITY/);
      expect(lines).toEqual([]);
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  it("keeps the rule of the server: the demo identity on an address other machines can reach is refused", async () => {
    const dataDir = join(folder(), "data");
    await expect(
      runSeed(demo(dataDir, { PAROL_HOST: "0.0.0.0" }), [], () => {}),
    ).rejects.toBeInstanceOf(ConfigError);
    expect(existsSync(dataDir)).toBe(false);
  });

  it("seeds the data folder and says what it created and how to sign in", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    const report = await runSeed(demo(dataDir), [], (l) => lines.push(l));
    const text = lines.join("\n");
    expect(report.matters.map((m) => m.created)).toEqual([true, true]);
    expect(existsSync(join(dataDir, "parol.sqlite"))).toBe(true);
    expect(text).toContain(`Data folder: ${dataDir}`);
    expect(text).toContain('Matter "Lanternfish / Corvane NDA": created, 2 documents uploaded');
    expect(text).toContain('Matter "Heronbridge / Tamarind NDA": created, 1 document uploaded');
    expect(text).toContain("Alex Ruiz (associate)");
    expect(text).toContain("Dana Whitfield (reviewing attorney)");
    expect(text).toContain("PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol");
    // How to sign in: who each demo identity is, and the matters that person will see.
    expect(text).toContain('Alex Ruiz (associate): "Lanternfish / Corvane NDA"');
    expect(text).toContain('Dana Whitfield (reviewing attorney): "Lanternfish / Corvane NDA"');
    expect(text).toContain('Lee Okafor (legal engineer): "Heronbridge / Tamarind NDA"');
    expect(text).toContain("Sam Patel (admin): no matters");
    expect(text).toContain("There are no passwords");
    expect(text).toContain("http://127.0.0.1:8787");
    for (const { matterId } of report.matters)
      expect(text).toContain(`http://127.0.0.1:8787/matters/${matterId}`);
    expect(text).toMatch(/Every document, party and person is synthetic/);
    // It names matters, people and ids, and nothing a document says.
    for (const phrase of [
      "shall continue for two",
      "is deleted in its entirety",
      "reseller arrangement",
    ])
      expect(text).not.toContain(phrase);
  });

  it("says that nothing was created the second time", async () => {
    const dataDir = join(folder(), "data");
    await runSeed(demo(dataDir), [], () => {});
    const lines: string[] = [];
    const report = await runSeed(demo(dataDir), [], (l) => lines.push(l));
    expect(report.matters.map((m) => m.created)).toEqual([false, false]);
    expect(lines.join("\n")).toContain(
      'Matter "Lanternfish / Corvane NDA": already there, nothing to add',
    );
    const reopened = createRepository(openDatabase(join(dataDir, "parol.sqlite")));
    expect(count(reopened, "matters")).toBe(2);
    reopened.db.close();
  });

  it("labels a review it ran as the scripted simulation and not a measurement", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    await runSeed(demo(dataDir), ["--run", "v1"], (l) => lines.push(l));
    const text = lines.join("\n");
    expect(text).toContain(
      "Review with workflow v1 on the first matter: run, succeeded, 8 findings",
    );
    expect(text).toContain("scripted simulation");
    expect(text).toContain("not a measurement");
  });

  it("gives the address of each review it ran, and says the later one replaces the earlier as current", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    const report = await runSeed(demo(dataDir), ["--run", "v1", "--run", "v2"], (l) =>
      lines.push(l),
    );
    const text = lines.join("\n");
    for (const run of report.runs)
      expect(text).toContain(`http://127.0.0.1:8787/matters/${run.matterId}/runs/${run.runId}`);
    expect(text).toContain("replaces the one before it as the current review");
    // A single review needs no such note.
    const alone: string[] = [];
    await runSeed(demo(join(folder(), "data")), ["--run", "v2"], (l) => alone.push(l));
    expect(alone.join("\n")).not.toContain("replaces the one before it");
  });

  it("brackets an IPv6 address in the address it prints", async () => {
    const dataDir = join(folder(), "data");
    const lines: string[] = [];
    await runSeed(demo(dataDir, { PAROL_HOST: "::1", PAROL_PORT: "9001" }), [], (l) =>
      lines.push(l),
    );
    expect(lines.join("\n")).toContain("http://[::1]:9001/matters/");
  });
});

describe("pnpm parol:seed, as a process", () => {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const script = join(ROOT, "apps", "parol", "src", "seed.ts");
  const tsconfig = join(ROOT, "apps", "parol", "tsconfig.json");
  const run = (env: Record<string, string>, args: string[] = []) =>
    spawnSync(tsx, ["--tsconfig", tsconfig, script, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      encoding: "utf8",
    });

  it("seeds, then refuses without the demo identity, with exit codes and no stack trace", () => {
    const dataDir = join(folder(), "data");
    const ok = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('Matter "Lanternfish / Corvane NDA": created');

    const again = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir });
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already there, nothing to add");

    // Reviews that an earlier seed ran, and a later one superseded, are not a failure.
    const reviewed = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir }, [
      "--run",
      "v1",
      "--run",
      "v2",
    ]);
    expect(reviewed.status, reviewed.stderr).toBe(0);
    const reviewedAgain = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir }, [
      "--run=v1",
      "--run=v2",
    ]);
    expect(reviewedAgain.status, reviewedAgain.stderr).toBe(0);
    expect(reviewedAgain.stdout).toMatch(
      /workflow v1 on the first matter: already there, superseded/,
    );
    expect(reviewedAgain.stdout).toMatch(
      /workflow v2 on the first matter: already there, succeeded/,
    );

    const refused = run({ PAROL_DATA_DIR: join(folder(), "other") });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Parol seed cannot run");
    expect(refused.stderr).toContain("PAROL_DEMO_IDENTITY");
    expect(refused.stderr).not.toMatch(/\n\s+at /);
  });

  it("takes the options after the lone -- that pnpm passes on", () => {
    const dataDir = join(folder(), "data");
    const result = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: dataDir }, [
      "--",
      "--run",
      "v1",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Review with workflow v1 on the first matter: run, succeeded/);
  });

  it("says what went wrong when the data folder cannot be used, as the server does: the kind of error and its message, no stack", () => {
    // A regular file where the data folder should be.
    const notAFolder = join(folder(), "a-file");
    writeFileSync(notAFolder, "not a folder");
    const result = run({ PAROL_DEMO_IDENTITY: "1", PAROL_DATA_DIR: notAFolder });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Parol seed cannot run: Error: \S.{10,}/);
    expect(result.stderr).toContain(notAFolder);
    expect(result.stderr).not.toMatch(/\n\s+at /);
    expect(result.stdout).toBe("");
  });

  it("is the script the root package.json names, with the same tsconfig as pnpm parol", () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts as Record<
      string,
      string
    >;
    expect(scripts["parol:seed"]).toBe(
      "tsx --tsconfig apps/parol/tsconfig.json apps/parol/src/seed.ts",
    );
    expect(scripts["parol:seed"]!.replace("apps/parol/src/seed.ts", "apps/parol/src/main.ts")).toBe(
      scripts["parol"],
    );
  });
});

/** Every file under a folder, with its hash, so that a second seed can be shown to write none. */
function readFileTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const listing = execFileSync("find", [root, "-type", "f"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "")
    .sort();
  for (const path of listing) out[path.slice(root.length)] = sha256Hex(readFileSync(path));
  return out;
}
