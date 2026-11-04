import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findingContentSha256, hashOf, sha256Hex } from "../../src/canonical.js";
import type { VerifiedFinding } from "../../src/contracts.js";
import { buildMemo } from "../../src/export/memo.js";
import { documentTextSha256 } from "../../src/ingest/text-hash.js";
import { parseDocument } from "../../src/ingest/parse.js";
import { formatLocation } from "../../src/location.js";
import type { MemoFinding, MemoInput } from "../../src/module-contracts.js";
import { loadPlaybook } from "../../src/playbooks/load.js";
import { getPrompt, promptRecord } from "../../src/prompts/registry.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { buildBundles } from "../../src/stages/retrieve.js";
import { makeUndetermined } from "../../src/stages/verify.js";
import {
  ConflictError,
  DEMO_USER_IDS,
  ExportBlockedError,
  FileStore,
  createRepository,
  openDatabase,
  toSourceSpans,
  type FindingRecord,
  type Repository,
  type RunRow,
} from "../../src/store/index.js";
import { readMemo } from "../export/support.js";
import {
  PLAYBOOK_PATH,
  WORDS,
  baselineAnswer,
  buildCaseWorld,
  revisedAnswer,
  runWorkflow,
  supportChecker,
  withVersionIds,
  type CaseWorld,
  type RunResult,
} from "./pipeline.js";
import { readFileSync } from "node:fs";

/**
 * The store holding what the stages produce and the memo reading what the store holds. Each
 * assertion is that nothing is lost on the way: the verified finding saved through the repository
 * and read back is the finding that was saved (its content hash recomputes from the stored
 * record), the spans and annotations come back as ingest made them, and a memo built from store
 * reads says what a memo built from the stage outputs says.
 */

const base = await buildCaseWorld("PAROL-D05");
const ACTORS = DEMO_USER_IDS;
const scratch = mkdtempSync(join(tmpdir(), "parol-store-fit-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface StoredMatter {
  repo: Repository;
  files: FileStore;
  matterId: string;
  world: CaseWorld;
  versionIds: string[];
  workflowVersionId: string;
  playbookVersionId: string;
}

/** A repository with the demo playbook approved and the prompts and workflows registered. */
function openRepository() {
  const repo = createRepository(openDatabase(":memory:"));
  repo.seedDemoUsers();
  const yaml = readFileSync(PLAYBOOK_PATH, "utf8");
  const loaded = loadPlaybook({ yaml, slug: "parol-nda-recipient" });
  const draft = repo.importPlaybookDraft(
    {
      slug: loaded.slug,
      version: loaded.version,
      yaml: loaded.yaml,
      sha256: loaded.sha256,
      rules: loaded.rules,
    },
    { actorId: ACTORS.legalEngineer },
  );
  const playbook = repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin });
  for (const id of ["extract.p1", "analyze.p1", "support.p1"]) {
    repo.upsertPromptVersion(promptRecord(id), { actorId: ACTORS.legalEngineer });
  }
  const v1 = repo.upsertWorkflowVersion(WORKFLOWS["v1"]!, { actorId: ACTORS.legalEngineer });
  const v2 = repo.upsertWorkflowVersion(WORKFLOWS["v2"]!, { actorId: ACTORS.legalEngineer });
  return { repo, playbook, v1, v2 };
}

/** The documents of the case uploaded to a new matter, ingested, and the playbook pinned. */
async function uploadCase(
  registry: ReturnType<typeof openRepository>,
  workflow: "v1" | "v2",
): Promise<StoredMatter> {
  const { repo } = registry;
  const files = new FileStore(join(scratch, `files-${Math.random().toString(36).slice(2)}`));
  const matter = repo.createMatter({
    name: "Lanternfish / Corvane NDA",
    clientLegalName: base.manifest.clientLegalName,
    createdBy: ACTORS.associate,
  });
  repo.addMember(matter.id, ACTORS.reviewer, "reviewer", { actorId: ACTORS.associate });

  const ids: Record<string, string> = {};
  for (const file of base.files) {
    const document = base.documents.find((d) => d.label === file.label)!;
    const storagePath = files.save(matter.id, file.bytes);
    const added = repo.addDocument(
      matter.id,
      {
        kind: document.kind,
        title: document.title,
        version: {
          mediaType: file.mediaType,
          fileSha256: sha256Hex(file.bytes),
          textSha256: documentTextSha256(document.paragraphs),
          byteSize: file.bytes.byteLength,
          statedDate: document.statedDate,
          storagePath,
          operative: true,
        },
      },
      { actorId: ACTORS.associate },
    );
    expect(added.document.label).toBe(file.label);
    ids[file.label] = added.version.id;
  }
  const stored = withVersionIds(base, ids);
  repo.insertSpans(matter.id, stored.ingest.spans, stored.ingest.annotations);
  repo.setPlaybookVersion(matter.id, registry.playbook.id, { actorId: ACTORS.associate });
  const workflowRow = workflow === "v1" ? registry.v1 : registry.v2;
  const manifest = repo.buildRunManifest(matter.id, {
    workflowVersionId: workflowRow.id,
    modelProvider: "scripted",
    model: "scripted-oracle",
  });
  return {
    repo,
    files,
    matterId: matter.id,
    world: { ...stored, manifest },
    versionIds: Object.values(ids),
    workflowVersionId: workflowRow.id,
    playbookVersionId: registry.playbook.id,
  };
}

/** The run as the runner will drive it: every state in order, stage results and calls recorded. */
function startRun(m: StoredMatter, run: RunResult): RunRow {
  const { repo, matterId } = m;
  const created = repo.createRun(matterId, {
    manifest: m.world.manifest,
    startedBy: ACTORS.associate,
  });
  repo.updateRunStatus(matterId, created.id, "ingesting");
  repo.updateRunStatus(matterId, created.id, "extracting");
  const input = hashOf({ spans: m.world.ingest.spans.map((s) => s.textSha256) });
  const started = repo.recordStageStart(matterId, created.id, {
    stage: "extract",
    inputSha256: input,
  });
  repo.recordStageResult(matterId, created.id, {
    stage: "extract",
    attempt: started.attempt,
    status: "succeeded",
    output: run.extract,
  });
  repo.updateRunStatus(matterId, created.id, "retrieving");
  repo.updateRunStatus(matterId, created.id, "analyzing");
  repo.insertModelCalls(matterId, created.id, run.calls);
  repo.updateRunStatus(matterId, created.id, "verifying");
  return repo.getRun(matterId, created.id)!;
}

const findingsOf = (run: RunResult, world: CaseWorld): VerifiedFinding[] =>
  world.playbook.rules.map((rule) => run.results.get(rule.key)!.finding);

/** What a VerifiedFinding is, with what the store adds to it taken away. */
const bare = (record: FindingRecord): VerifiedFinding => ({
  ruleKey: record.ruleKey,
  category: record.category,
  severity: record.severity,
  status: record.status,
  evidence: record.evidence.map(({ id: _id, ...rest }) => rest),
  discrepancy: record.discrepancy,
  explanation: record.explanation,
  fallbackLanguage: record.fallbackLanguage,
  fallbackBasis: record.fallbackBasis,
  conflict: record.conflict,
  abstainReason: record.abstainReason,
  checks: record.checks,
  escalations: record.escalations,
  verificationState: record.verificationState,
  contentSha256: record.contentSha256,
});

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

describe("prompts, workflows and the playbook in the store", () => {
  const registry = openRepository();

  it("stores each prompt under the hash the registry computed, with every text that reaches the model", () => {
    for (const id of ["extract.p1", "analyze.p1", "support.p1"]) {
      const row = registry.repo.getPromptVersion(id)!;
      const prompt = getPrompt(id);
      expect(row.sha256).toBe(prompt.sha256);
      expect(row.stage).toBe(prompt.definition.stage);
      const template = JSON.parse(row.template) as { system: string; userTemplate: string };
      expect(template.system).toBe(prompt.definition.system);
      expect(template.userTemplate).toBe(prompt.definition.userTemplate);
      expect(JSON.parse(row.schemaJson)).toHaveProperty("type", "object");
      // Registering it again changes nothing.
      expect(registry.repo.upsertPromptVersion(promptRecord(id))).toEqual(row);
    }
    expect(
      registry.repo
        .listPromptVersions()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["analyze.p1", "extract.p1", "support.p1"]);
  });

  it("stores each workflow as the manifest the registry hashed", () => {
    for (const label of ["v1", "v2"]) {
      const row = registry.repo.getWorkflowVersionByLabel(label)!;
      expect(row.manifest).toEqual(WORKFLOWS[label]!.manifest);
      expect(row.sha256).toBe(WORKFLOWS[label]!.sha256);
      expect(hashOf(row.manifest)).toBe(row.sha256);
    }
  });

  it("stores the playbook's rules as the stages read them, in playbook order", () => {
    const rules = registry.repo.listRules(registry.playbook.id);
    expect(rules.map((r) => r.key)).toEqual(base.playbook.rules.map((r) => r.key));
    for (const [index, stored] of rules.entries()) {
      const { id: _id, playbookVersionId: _v, ordinal, ruleSha256: _s, ...rule } = stored;
      expect(ordinal).toBe(index);
      expect(rule).toEqual(base.playbook.rules[index]);
    }
    expect(registry.playbook.sha256).toBe(base.playbook.sha256);
    // The store keeps the YAML, from which the memo's playbook name is read; it has no name column.
    expect(loadPlaybook({ yaml: registry.playbook.yaml, slug: registry.playbook.slug }).name).toBe(
      base.playbook.name,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Ingest through the store
// ---------------------------------------------------------------------------------------------

describe("ingest output through the store", async () => {
  const registry = openRepository();
  const m = await uploadCase(registry, "v2");

  it("reads the spans back with the labels ingest assigned, and the annotations in their order", () => {
    const spans = toSourceSpans(m.repo.listSpans(m.matterId, m.versionIds));
    expect(spans).toEqual(m.world.ingest.spans);
    expect(m.repo.listAnnotations(m.matterId, m.versionIds)).toEqual(m.world.ingest.annotations);
  });

  it("gives retrieval the same bundles from what it reads back as from what ingest made", async () => {
    const run = await runWorkflow(m.world, { policy: "R2", checks: ["C1"] });
    const rebuilt = {
      spans: toSourceSpans(m.repo.listSpans(m.matterId, m.versionIds)),
      annotations: m.repo.listAnnotations(m.matterId, m.versionIds),
      warnings: [],
    };
    const again = buildBundles({
      ingest: rebuilt,
      extract: run.extract,
      rules: m.repo.listRules(m.playbookVersionId),
      policy: "R2",
      budgetTokens: WORKFLOWS["v2"]!.manifest.budgetTokens,
    });
    expect(hashOf(again.map((b) => ({ ...b, rule: b.rule.key })))).toBe(
      hashOf(run.bundles.map((b) => ({ ...b, rule: b.rule.key }))),
    );
  });

  it("reads the manifest the stages need from the store: documents, dates, client, hashes", () => {
    expect(m.world.manifest.clientLegalName).toBe("Lanternfish Software, Inc.");
    expect(m.world.manifest.documents.map((d) => [d.label, d.kind, d.title, d.statedDate])).toEqual(
      [
        ["D1", "nda", "Mutual NDA", "2026-02-02"],
        ["D2", "amendment", "Amendment No. 1", "2026-09-15"],
      ],
    );
    expect(m.world.manifest.documents.map((d) => d.textSha256)).toEqual(
      base.documents.map((d) => documentTextSha256(d.paragraphs)),
    );
    expect(m.world.manifest.playbook.sha256).toBe(base.playbook.sha256);
    expect(m.world.manifest.workflow.sha256).toBe(WORKFLOWS["v2"]!.sha256);
  });

  it("holds the files it was given, byte for byte, and parses them again to the same text", async () => {
    for (const { document, version } of m.repo.listOperativeDocuments(m.matterId)) {
      const bytes = m.files.read(version.storagePath);
      expect(sha256Hex(bytes)).toBe(version.fileSha256);
      const parsed = await parseDocument({ bytes, mediaType: version.mediaType });
      expect(documentTextSha256(parsed.paragraphs)).toBe(version.textSha256);
      expect(document.label).toBe(version.documentId === document.id ? document.label : "");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Findings through the store, and the memo from store reads
// ---------------------------------------------------------------------------------------------

describe("a verified finding saved and read back", async () => {
  const registry = openRepository();
  const m = await uploadCase(registry, "v2");
  // The support check is run too, so that its calls and its verdicts go through the store.
  const support = supportChecker("supported");
  const run = await runWorkflow(m.world, {
    policy: "R2",
    checks: ["C1", "C2"],
    script: { answers: { "dur-1": revisedAnswer(m.world) } },
    supportChecker: support.checker,
  });
  const started = startRun(m, run);
  const saved = m.repo.saveFindings(m.matterId, started.id, findingsOf(run, m.world), {
    actorId: ACTORS.associate,
  });

  it("returns the findings in playbook order, each equal to the one saved", () => {
    expect(saved.map((f) => f.ruleKey)).toEqual(m.world.playbook.rules.map((r) => r.key));
    for (const [index, record] of saved.entries()) {
      expect(bare(record), record.ruleKey).toEqual(findingsOf(run, m.world)[index]);
    }
    const reread = m.repo.listFindings(m.matterId, started.id);
    expect(reread.map(bare)).toEqual(saved.map(bare));
  });

  it("recomputes the content hash verify computed, from nothing but the stored record", () => {
    for (const record of m.repo.listFindings(m.matterId, started.id)) {
      expect(findingContentSha256(record), record.ruleKey).toBe(record.contentSha256);
      expect(findingContentSha256(record)).toBe(
        run.results.get(record.ruleKey)!.finding.contentSha256,
      );
    }
  });

  it("keeps the duration finding whole: roles, offsets, checks, fallback and its basis", () => {
    const record = m.repo.listFindings(m.matterId, started.id).find((f) => f.ruleKey === "dur-1")!;
    expect(record.status).toBe("deviation");
    expect(record.evidence.map((e) => [e.role, e.quote, e.quoteCheck, e.offsets])).toEqual([
      ["governing", WORDS.deletionQuote, "verified", { start: 3, end: 58 }],
      ["superseded", WORDS.termQuote, "verified", { start: 60, end: 125 }],
      ["supporting", WORDS.survivalQuote, "verified", { start: 4, end: 79 }],
    ]);
    expect(record.fallbackLanguage).toBe(WORDS.revisedFallback);
    expect(record.fallbackBasis).toBe("approved_adapted");
    expect(record.checks.map((c) => c.id)).toContain("superseded_evidence");
    expect(record.rule.key).toBe("dur-1");
    // The offsets slice the stored span to the quote.
    for (const item of record.evidence) {
      const span = m.repo.getSpan(m.matterId, item.spanId)!;
      expect(span.text.slice(item.offsets!.start, item.offsets!.end)).toBe(item.quote);
    }
  });

  it("keeps the verdict of the support check on each cited passage and the call that made it", () => {
    const record = m.repo.listFindings(m.matterId, started.id).find((f) => f.ruleKey === "dur-1")!;
    expect(record.evidence.map((e) => e.supportCheck)).toEqual([
      "supported",
      "supported",
      "supported",
    ]);
    expect(record.checks.find((c) => c.id === "support")).toMatchObject({
      kind: "model",
      outcome: "pass",
    });
    const calls = m.repo.listModelCalls(m.matterId, started.id);
    expect(calls.filter((c) => c.stage === "support")).toHaveLength(
      run.calls.filter((c) => c.stage === "support").length,
    );
    expect(calls.filter((c) => c.stage === "support").length).toBeGreaterThan(0);
  });

  it("holds the stage results and the calls the stages recorded", () => {
    const stages = m.repo.listStages(m.matterId, started.id);
    expect(stages.map((s) => [s.stage, s.status])).toEqual([["extract", "succeeded"]]);
    expect(stages[0]!.output).toEqual(JSON.parse(JSON.stringify(run.extract)));
    const calls = m.repo.listModelCalls(m.matterId, started.id);
    expect(calls).toHaveLength(run.calls.length);
    expect(
      calls.map((c) => [c.stage, c.ruleKey, c.promptVersionId, c.requestSha256, c.outcome]),
    ).toEqual(
      run.calls.map((c) => [c.stage, c.ruleKey, c.promptVersionId, c.requestSha256, c.outcome]),
    );
  });

  it("saves the same findings again as a no-op, and refuses different content for a rule it holds", () => {
    const again = m.repo.saveFindings(m.matterId, started.id, findingsOf(run, m.world), {
      actorId: ACTORS.associate,
    });
    expect(again.map((f) => f.id)).toEqual(saved.map((f) => f.id));
    const changed = { ...findingsOf(run, m.world)[0]!, explanation: "A different explanation." };
    changed.contentSha256 = findingContentSha256(changed);
    expect(() =>
      m.repo.saveFindings(m.matterId, started.id, [changed], { actorId: ACTORS.associate }),
    ).toThrow(ConflictError);
  });

  it("builds the memo from store reads and records it", async () => {
    m.repo.updateRunStatus(m.matterId, started.id, "succeeded");
    const records = m.repo.listFindings(m.matterId, started.id);
    const dur = records.find((f) => f.ruleKey === "dur-1")!;
    const edited =
      "6.1 The obligations of each Receiving Party under Section 4 shall continue for two (2) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.";

    // Not ready until every finding is decided.
    expect(m.repo.getExportReadiness(m.matterId, started.id).ready).toBe(false);
    expect(
      m.repo.getExportReadiness(m.matterId, started.id).blockers.map((b) => b.reason),
    ).toContain("no_review");

    const supporting = dur.evidence.find((e) => e.role === "supporting")!;
    for (const record of records) {
      if (record.ruleKey === "dur-1") {
        m.repo.recordReview(m.matterId, record.id, {
          reviewerId: ACTORS.reviewer,
          decision: "edit",
          findingContentSha256: record.contentSha256,
          edits: {
            fallbackLanguage: edited,
            evidenceRoles: [{ evidenceId: supporting.id, role: "definition" }],
          },
          reason: "The parties agreed two years in February. Propose reinstating it.",
        });
      } else {
        m.repo.recordReview(m.matterId, record.id, {
          reviewerId: ACTORS.reviewer,
          decision: "accept",
          findingContentSha256: record.contentSha256,
        });
      }
    }
    expect(m.repo.getExportReadiness(m.matterId, started.id)).toEqual({
      ready: true,
      blockers: [],
    });

    const input = memoInputFromStore(m, started.id);
    const bytes = await buildMemo(input);
    const read = await readMemo(bytes);
    const text = read.paragraphs.join("\n");
    expect(text).toContain("Location: Amendment No. 1 (v1), Section 2, paragraph 3");
    expect(text).toContain(edited);
    expect(text).toContain("The parties agreed two years in February.");
    // The reviewer's change of a role is in the file, marked as the reviewer's.
    expect(text).toContain("(role changed by the reviewer; the workflow labelled it Supporting)");
    expect(text).toContain("Definition. (role changed");
    expect(text).toContain(`Run: ${started.id}, started`);
    expect(text).toContain("Workflow: v2, hash");

    const path = m.files.save(m.matterId, bytes);
    const memo = m.repo.recordMemo(m.matterId, {
      runId: started.id,
      reviewIds: records.map(
        (f) =>
          m.repo.listFindings(m.matterId, started.id).find((x) => x.id === f.id)!.currentReview!.id,
      ),
      fileSha256: sha256Hex(bytes),
      storagePath: path,
      exportedBy: ACTORS.reviewer,
    });
    expect(memo.status).toBe("current");
    expect(sha256Hex(m.files.read(memo.storagePath))).toBe(memo.fileSha256);
    expect(m.repo.getMatter(m.matterId)!.status).toBe("exported");
    // The same reads build the same file again.
    expect(sha256Hex(await buildMemo(memoInputFromStore(m, started.id)))).toBe(sha256Hex(bytes));
  });
});

/** Everything the memo needs, read from the store the way the export route will read it. */
function memoInputFromStore(m: StoredMatter, runId: string): MemoInput {
  const { repo, matterId } = m;
  const matter = repo.getMatter(matterId)!;
  const run = repo.getRun(matterId, runId)!;
  const playbook = repo.getPlaybookVersion(run.playbookVersionId)!;
  const rules = repo.listRules(run.playbookVersionId);
  const operative = repo.listOperativeDocuments(matterId);
  const spans = repo.listSpans(
    matterId,
    operative.map((d) => d.version.id),
  );
  const spanById = new Map(spans.map((s) => [s.id, s]));
  const findings: MemoFinding[] = repo.listFindings(matterId, runId).map((record) => {
    const review = record.currentReview;
    return {
      finding: record,
      locations: record.evidence.map((e) => formatLocation(spanById.get(e.spanId)!)),
      evidenceIds: record.evidence.map((e) => e.id),
      review:
        review === null
          ? null
          : {
              decision: review.decision,
              reviewerName: review.reviewerName,
              decidedAt: review.createdAt,
              reason: review.reason,
              edits: review.edits,
            },
    };
  });
  return {
    matter: { id: matter.id, name: matter.name, clientLegalName: matter.clientLegalName },
    playbook: {
      name: loadPlaybook({ yaml: playbook.yaml, slug: playbook.slug }).name,
      slug: playbook.slug,
      version: playbook.version,
      sha256: playbook.sha256,
    },
    run: {
      id: run.id,
      workflowLabel: run.manifest.workflow.label,
      workflowSha256: run.manifest.workflow.sha256,
      modelProvider: run.modelProvider,
      modelRequested: run.modelRequested,
      modelReported: run.modelReported,
      manifestSha256: run.inputManifestSha256,
      startedAt: run.startedAt,
    },
    documents: operative.map(({ document, version }) => ({
      label: document.label,
      title: document.title,
      versionNo: version.versionNo,
      statedDate: version.statedDate,
      fileSha256: version.fileSha256,
    })),
    spanTexts: Object.fromEntries(spans.map((s) => [s.id, s.text])),
    findings,
    ruleSeverities: Object.fromEntries(rules.map((r) => [r.key, r.severity])),
    ruleTitles: Object.fromEntries(rules.map((r) => [r.key, r.title])),
    exportedBy: repo.getUser(ACTORS.reviewer)!.displayName,
    exportedAt: "2026-11-04T09:00:00.000Z",
    segregationRelaxed: false,
  };
}

describe("findings the verifier flagged, and rules it could not analyse", async () => {
  const registry = openRepository();
  const m = await uploadCase(registry, "v1");
  const run = await runWorkflow(m.world, {
    policy: "R1",
    checks: ["C1", "C2"],
    script: { answers: { "dur-1": baselineAnswer(m.world) } },
  });
  const started = startRun(m, run);
  const findings = findingsOf(run, m.world);
  const index = (key: string) => m.world.playbook.rules.findIndex((r) => r.key === key);
  const over = makeUndetermined({
    rule: m.world.playbook.rules[index("gov-1")]!,
    code: "context_over_budget",
    detail: "context_over_budget: about 20000 tokens against a budget of 12000",
  });
  const invalid = makeUndetermined({
    rule: m.world.playbook.rules[index("pds-2")]!,
    code: "output_invalid",
    detail: "output_invalid: the reply did not fit the answer schema",
  });
  findings[index("gov-1")] = over;
  findings[index("pds-2")] = invalid;
  const saved = m.repo.saveFindings(m.matterId, started.id, findings, {
    actorId: ACTORS.associate,
  });

  it("keeps a flagged baseline finding with its escalation and its failed check", () => {
    const record = saved.find((f) => f.ruleKey === "dur-1")!;
    expect(record.status).toBe("compliant");
    expect(record.verificationState).toBe("escalated_by_system");
    expect(record.escalations.map((e) => e.code)).toEqual(["superseded_evidence"]);
    expect(record.checks.find((c) => c.id === "superseded_evidence")!.outcome).toBe("fail");
    expect(bare(record)).toEqual(findings[index("dur-1")]);
  });

  it("keeps the undetermined findings makeUndetermined builds, and their hash", () => {
    for (const [key, original] of [
      ["gov-1", over],
      ["pds-2", invalid],
    ] as const) {
      const record = saved.find((f) => f.ruleKey === key)!;
      expect(bare(record)).toEqual(original);
      expect(record.evidence).toEqual([]);
      expect(findingContentSha256(record)).toBe(original.contentSha256);
    }
  });

  it("will not export while a determined finding the system flagged is undecided, and names it", () => {
    m.repo.updateRunStatus(m.matterId, started.id, "succeeded");
    const readiness = m.repo.getExportReadiness(m.matterId, started.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.every((b) => b.reason === "no_review")).toBe(true);
    expect(readiness.blockers.map((b) => b.ruleKey).sort()).toEqual(
      m.world.playbook.rules.map((r) => r.key).sort(),
    );
    expect(() =>
      m.repo.recordMemo(m.matterId, {
        runId: started.id,
        reviewIds: [],
        fileSha256: sha256Hex("x"),
        storagePath: m.files.save(m.matterId, new TextEncoder().encode("x")),
        exportedBy: ACTORS.reviewer,
      }),
    ).toThrow(ExportBlockedError);
  });

  it("exports once every one is decided, whatever its state, and the memo carries the flags", async () => {
    const records = m.repo.listFindings(m.matterId, started.id);
    for (const record of records) {
      m.repo.recordReview(m.matterId, record.id, {
        reviewerId: ACTORS.reviewer,
        decision: record.verificationState === "verified" ? "accept" : "escalate",
        findingContentSha256: record.contentSha256,
        reason:
          record.verificationState === "verified" ? null : "The workflow could not settle it.",
      });
    }
    const bytes = await buildMemo(memoInputFromStore(m, started.id));
    const text = (await readMemo(bytes)).paragraphs.join("\n");
    expect(text).toContain(
      "The finding relies on a clause that an amendment replaces, without citing the amendment.",
    );
    expect(text).toContain(
      "The text for this rule was too long to analyse, so it was not analysed.",
    );
    expect(text).toContain("The workflow produced no valid answer for this rule.");
  });
});

describe("what the store refuses that the stages must not produce", async () => {
  const registry = openRepository();
  const m = await uploadCase(registry, "v2");
  const run = await runWorkflow(m.world, {
    policy: "R2",
    checks: ["C1"],
    script: { answers: { "dur-1": revisedAnswer(m.world) } },
  });

  it("accepts a finding for a rule of the run's playbook only", () => {
    const started = startRun(m, run);
    const stranger = { ...findingsOf(run, m.world)[0]!, ruleKey: "zzz-9" };
    stranger.contentSha256 = findingContentSha256(stranger);
    expect(() =>
      m.repo.saveFindings(m.matterId, started.id, [stranger], { actorId: ACTORS.associate }),
    ).toThrow();
  });

  it("refuses a second upload of the same bytes, which the upload service reports as a duplicate", () => {
    const file = base.files[1]!;
    const path = m.files.save(m.matterId, file.bytes);
    expect(() =>
      m.repo.addVersion(
        m.matterId,
        m.repo.listOperativeDocuments(m.matterId)[1]!.document.id,
        {
          mediaType: file.mediaType,
          fileSha256: sha256Hex(file.bytes),
          textSha256: documentTextSha256(base.documents[1]!.paragraphs),
          byteSize: file.bytes.byteLength,
          statedDate: "2026-09-15",
          storagePath: path,
        },
        { actorId: ACTORS.associate },
      ),
    ).toThrow(ConflictError);
  });
});

describe("a repaired analysis in the store", async () => {
  const registry = openRepository();
  const m = await uploadCase(registry, "v2");
  const run = await runWorkflow(m.world, {
    policy: "R2",
    checks: ["C1", "C2"],
    script: {
      answers: { "dur-1": revisedAnswer(m.world) },
      firstAnswerCitesUnknownClause: ["dur-1"],
    },
  });
  const started = startRun(m, run);

  it("records the failed first attempt and the repair that followed, in order", () => {
    const attempts = m.repo
      .listModelCalls(m.matterId, started.id)
      .filter((c) => c.ruleKey === "dur-1")
      .map((c) => [c.stage, c.attempt, c.outcome]);
    expect(attempts).toEqual([
      ["analyze", 1, "semantic_error"],
      ["analyze", 2, "ok"],
    ]);
    // The repair call sent a different request: the note about the label was added to it.
    const hashes = m.repo
      .listModelCalls(m.matterId, started.id)
      .filter((c) => c.ruleKey === "dur-1")
      .map((c) => c.requestSha256);
    expect(new Set(hashes).size).toBe(2);
  });

  it("still ends in the verified deviation of the document", () => {
    const finding = run.results.get("dur-1")!.finding;
    expect(finding.status).toBe("deviation");
    expect(finding.verificationState).toBe("verified");
    const saved = m.repo.saveFindings(m.matterId, started.id, findingsOf(run, m.world), {
      actorId: ACTORS.associate,
    });
    expect(saved.find((f) => f.ruleKey === "dur-1")!.status).toBe("deviation");
  });
});
