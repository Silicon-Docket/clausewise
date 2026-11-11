import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authorizeMatter } from "../../src/auth/authorize.js";
import { sha256Hex } from "../../src/canonical.js";
import type { DocLabel, IngestDocumentInput, RunManifest } from "../../src/contracts.js";
import { viewOfPrompt } from "../../src/demo/prompt-view.js";
import { isTrainingBlock, isTrainingMatter } from "../../src/demo/reader.js";
import { TRAINING_TITLE_MARKER } from "../../src/demo/training-example.js";
import { buildIngest } from "../../src/ingest/ingest.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { DEMO_USER_IDS, NOT_TRAINING_SQL } from "../../src/store/index.js";
import { seedDemo } from "../../src/seed.js";
import { readTrainingFile } from "../../src/training/files.js";
import { T01 } from "../../src/training/t01.js";
import { CASES } from "../../../../fixtures/parol/cases.js";
import { review, type Subject } from "../demo/support.js";
import { ROOT, buildCaseWorld, loadFixtures, versionIdOf } from "../integration/pipeline.js";
import { cleanupWorlds, simulatedWorld, trainingSubject } from "./support.js";

/**
 * Evaluation never uses the training matter. Four things keep it apart, and each is tested:
 * where the files are (outside the dataset, and no evaluation source names them), what the
 * database accepts (a training matter has no evaluation run and no evaluation result), what the
 * reader does (it plants its answer only for T01, so no case of the dataset is ever read as T01),
 * and what a measure counts (`NOT_TRAINING_SQL`).
 */

afterAll(cleanupWorlds);

const FIXTURES = join(ROOT, "fixtures", "parol");

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory())
      return name === "files" || name === "node_modules" ? [] : sourcesUnder(path);
    return /\.(ts|tsx|mjs|js|cjs)$/.test(name) ? [path] : [];
  });
}

/**
 * What names the training matter: its folder, its files, its module, its key, its marker. A route
 * called `/training` is not in the list: the exposure suite probes the routes of the application.
 */
const NAMES_T01: readonly RegExp[] = [
  /apps\/parol\/training/,
  /\bt01-(nda|amendment)/i,
  /src\/training/,
  /training-example/,
  /training_key|trainingKey|TRAINING_KEY|NOT_TRAINING_SQL/,
  /TRAINING_TITLE_MARKER|TRAINING_NOTE_DIGEST|PLANTED_/,
  /\(training T01\)/,
  /\bT01\b/,
];

describe("where the files are", () => {
  it("keeps the training files outside the dataset: not in the files folder, the keys or the splits", () => {
    const names = readdirSync(join(FIXTURES, "files"));
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => /^t01-/i.test(n))).toEqual([]);
    // The NDA of T01 is a file of its own. The amendment is the amendment of PAROL-D05 byte for
    // byte (files.test.ts), so the dataset holds a copy of it by design and only the NDA is looked for.
    const nda = sha256Hex(readTrainingFile("t01-nda.docx"));
    for (const file of ["answer-keys.json", "splits.json", "calibration.json"]) {
      const text = readFileSync(join(FIXTURES, file), "utf8");
      for (const pattern of NAMES_T01) expect(text, `${file} ${pattern}`).not.toMatch(pattern);
      expect(text, file).not.toContain(nda);
    }
    // No dataset file is a copy of the training NDA, whatever it is called.
    for (const name of names)
      expect(sha256Hex(readFileSync(join(FIXTURES, "files", name))), name).not.toBe(nda);
  });

  it("has no evaluation, dataset or builder source that names the training folder, module, key or matter", () => {
    const sources = [
      ...sourcesUnder(join(ROOT, "evals", "src")),
      ...sourcesUnder(FIXTURES),
      join(ROOT, "tools", "make-parol-fixtures.ts"),
    ];
    expect(sources.length).toBeGreaterThan(40);
    const hits: string[] = [];
    for (const path of sources) {
      const text = readFileSync(path, "utf8");
      for (const pattern of NAMES_T01)
        if (pattern.test(text)) hits.push(`${relative(ROOT, path)} ${pattern}`);
    }
    expect(hits).toEqual([]);
  });

  it("can see a name when there is one: the scan matches the training module's own source", () => {
    const own = readFileSync(join(ROOT, "apps", "parol", "src", "training", "t01.ts"), "utf8");
    expect(NAMES_T01.some((pattern) => pattern.test(own))).toBe(true);
    expect(NAMES_T01.some((pattern) => pattern.test("const x = 1;"))).toBe(false);
  });

  it("has no case, twin or canary matter built from the training files or titled with the marker", async () => {
    const { keys } = await loadFixtures();
    const documents = [
      ...keys.cases.flatMap((c) => c.documents),
      ...keys.twins.flatMap((c) => c.documents),
      ...(keys.canary?.matters ?? []).map((m) => m.document),
    ];
    expect(documents.length).toBeGreaterThan(30);
    for (const document of documents) {
      expect(document.title, document.file).not.toContain(TRAINING_TITLE_MARKER);
      expect(document.file, document.file).not.toMatch(/^t01-/i);
    }
    // The runner's case list is the dataset's: its keys are those of answer-keys.json.
    expect(CASES.map((c) => c.case).sort()).toEqual(keys.cases.map((c) => c.case).sort());
    for (const definition of CASES)
      for (const document of definition.documents)
        expect(document.title, definition.case).not.toContain(TRAINING_TITLE_MARKER);
  });
});

describe("what the reader does", () => {
  /** Every prompt of a review under both versions, with the support check on. */
  async function promptsOf(subject: Subject): Promise<string[]> {
    const prompts: string[] = [];
    for (const workflow of ["v1", "v2"] as const) {
      const run = await review(subject, { workflow, support: true });
      prompts.push(...run.generator.requests.map((r) => r.prompt));
    }
    return prompts;
  }

  /** The canary matters: one NDA each, built from the dataset's file as the exposure suite loads it. */
  async function canarySubject(file: string, title: string, statedDate: string | null) {
    const base = await buildCaseWorld("PAROL-D05");
    const { file: bytesOf } = await loadFixtures();
    const parsed = await parseDocument({ bytes: bytesOf(file), mediaType: "docx" });
    const document: IngestDocumentInput = {
      documentVersionId: versionIdOf("D1"),
      label: "D1" as DocLabel,
      kind: "nda",
      title,
      versionNo: 1,
      statedDate,
      paragraphs: parsed.paragraphs,
      inspection: parsed.inspection,
    };
    const manifest: RunManifest = {
      ...base.manifest,
      documents: [
        {
          documentVersionId: document.documentVersionId,
          label: document.label,
          kind: "nda",
          title,
          versionNo: 1,
          statedDate,
          textSha256: documentTextSha256(document.paragraphs),
        },
      ],
    };
    return { ingest: buildIngest({ documents: [document] }), manifest, playbook: base.playbook };
  }

  it("does not read a prompt of any case of either split, any twin or any canary matter as the training block", async () => {
    const { keys } = await loadFixtures();
    let prompts = 0;
    let withNote = 0;
    const subjects: [string, Subject][] = [];
    for (const key of keys.cases) subjects.push([key.case, await buildCaseWorld(key.case)]);
    for (const twin of keys.twins)
      subjects.push([`${twin.twinOf} twin`, await buildCaseWorld(twin.twinOf, { twin: true })]);
    for (const matter of keys.canary?.matters ?? [])
      subjects.push([
        `canary ${matter.id}`,
        await canarySubject(
          matter.document.file,
          matter.document.title,
          matter.document.statedDate,
        ),
      ]);
    expect(subjects.length).toBe(keys.cases.length + keys.twins.length + 2);
    for (const [name, subject] of subjects) {
      for (const prompt of await promptsOf(subject)) {
        const view = viewOfPrompt(prompt);
        prompts += 1;
        if (view.clauses.some((c) => /Note to automated reviewers/.test(c.text))) withNote += 1;
        expect(isTrainingBlock(view), name).toBe(false);
        expect(isTrainingMatter(view), name).toBe(false);
      }
    }
    expect(prompts).toBeGreaterThan(500);
    // The paragraph of the training matter is in the dataset (PAROL-D08 and its twin carry it or
    // its sibling), so this test meets a block that holds it and shows the rule did not accept it.
    expect(withNote).toBeGreaterThan(0);
  });

  it("does read the prompts of T01 as the training block, so the scan above is not vacuous", async () => {
    const subject = await trainingSubject();
    for (const workflow of ["v1", "v2"] as const) {
      const run = await review(subject, { workflow });
      // The request that locates passages and the one that reads the planted rule both show the
      // whole document, so both are the training block; the other requests show a selection.
      const extract = run.generator.requests.find((r) => r.schemaName === "locate_passages")!;
      expect(isTrainingBlock(viewOfPrompt(extract.prompt))).toBe(true);
      expect(isTrainingMatter(viewOfPrompt(run.prompts.get("pds-1")!))).toBe(true);
    }
  });
});

describe("what the database accepts", () => {
  it("refuses a run for evaluation on a training matter and a result stored for a run of one, and accepts both for another matter", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const alex = w.principal(DEMO_USER_IDS.associate);
    const trainingId = report.training!.matterId;
    const workedId = report.matters[0]!.matterId;
    const ordinaryId = report.matters[1]!.matterId;
    const workflow = w.repo.listWorkflowVersions()[0]!;
    const manifestOf = (matterId: string) =>
      w.repo.buildRunManifest(matterId, {
        workflowVersionId: workflow.id,
        modelProvider: "simulated",
        model: "parol-simulated-reader",
      });

    // A run for evaluation: refused on T01, made on a matter that is not.
    const lee = w.principal(DEMO_USER_IDS.legalEngineer);
    expect(() =>
      w.repo.createRun(trainingId, {
        manifest: manifestOf(trainingId),
        startedBy: alex.userId,
        purpose: "eval",
      }),
    ).toThrow(/training matters are never used in evaluation/);
    expect(
      w.repo.createRun(ordinaryId, {
        manifest: manifestOf(ordinaryId),
        startedBy: lee.userId,
        purpose: "eval",
      }).purpose,
    ).toBe("eval");

    // A result stored for the run of a matter: refused on T01's, accepted on another's.
    const am = authorizeMatter(w.repo, alex, trainingId, "run.start");
    const ordinary = w.services.runs.start(authorizeMatter(w.repo, alex, workedId, "run.start"), {
      workflowLabel: "v1",
    });
    const training = w.services.runs.start(am, { workflowLabel: "v1" });
    await w.services.runs.idle();
    const dataset = w.repo.createEvalDataset({
      label: "set",
      devSha256: "a".repeat(64),
      heldoutSha256: "b".repeat(64),
    });
    const evalRun = w.repo.createEvalRun(
      {
        datasetId: dataset.id,
        split: "dev",
        workflowVersionId: workflow.id,
        playbookVersionId: w.repo.findPlaybookVersion("parol-nda-recipient", "1.0.1")!.id,
        model: "m",
        repeats: 1,
        priceTableSha256: "c".repeat(64),
        resultsPath: "r.json",
      },
      { actorId: lee.userId },
    );
    const slot = (runId: string) => () =>
      w.repo.db
        .prepare(
          "INSERT INTO eval_slot_results (eval_run_id, case_key, rule_key, repeat, run_id, expected_status, got_status, scores_json) VALUES (?, 'C1', 'dur-1', 0, ?, 'compliant', 'compliant', '{}')",
        )
        .run(evalRun.id, runId);
    expect(slot(training.id)).toThrow(/training matters are never used in evaluation/);
    expect(slot(ordinary.id)).not.toThrow();
  });
});

describe("what a measure counts", () => {
  it("leaves the training matter out of a query that adds the condition, and takes the others", async () => {
    const w = simulatedWorld();
    const report = await seedDemo({ repo: w.repo, files: w.files, training: true });
    const all = (
      w.repo.db.prepare("SELECT id FROM matters ORDER BY id").all() as { id: string }[]
    ).map((r) => r.id);
    const counted = (
      w.repo.db
        .prepare(`SELECT matters.id FROM matters WHERE ${NOT_TRAINING_SQL} ORDER BY matters.id`)
        .all() as { id: string }[]
    ).map((r) => r.id);
    expect(all).toContain(report.training!.matterId);
    expect(counted).toEqual(all.filter((id) => id !== report.training!.matterId));
    expect(counted).toHaveLength(2);
    // The same condition reaches through a join, as a measure over runs or decisions would use it.
    const viaRuns = w.repo.db
      .prepare(
        `SELECT count(*) AS n FROM runs JOIN matters ON matters.id = runs.matter_id WHERE ${NOT_TRAINING_SQL}`,
      )
      .get() as { n: number };
    expect(viaRuns.n).toBe(0);
    expect(w.repo.getMatter(report.training!.matterId)?.trainingKey).toBe("T01");
    expect(w.repo.getMatter(report.matters[0]!.matterId)?.trainingKey).toBeNull();
  });
});
