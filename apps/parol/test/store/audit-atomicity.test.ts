import { describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { AUDIT_ACTIONS, type NewVersionInput } from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  decideAll,
  exported,
  fakePath,
  makeWorld,
  reviewable,
  saveAll,
  startRun,
  type World,
} from "./fixtures.js";

/**
 * A change and its audit event commit together or not at all. For every method that writes an
 * event, the audit insert is made to fail for that one action, and the whole database (every table
 * and the autoincrement counter) must be exactly as it was before the call. A method that wrote its
 * event in a transaction of its own, or after committing, would leave its change behind and fail
 * this.
 */

const actor = { actorId: ACTORS.associate };

const newVersion = (matterId: string, seed: string): NewVersionInput => ({
  mediaType: "txt",
  fileSha256: sha256Hex(`file-${seed}`),
  textSha256: sha256Hex(`text-${seed}`),
  byteSize: 1,
  statedDate: null,
  storagePath: fakePath(matterId),
});

function dump(db: World["db"]): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return tables
    .map(
      ({ name }) =>
        `${name}: ${JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())}`,
    )
    .join("\n");
}

// One trigger per action, written out, so that no SQL here is assembled from a value either.
const FAIL_ON: Record<string, string> = Object.fromEntries(
  AUDIT_ACTIONS.map((action) => [
    action,
    `CREATE TRIGGER zz_refuse_audit BEFORE INSERT ON audit_events
     WHEN NEW.action = '${action}'
     BEGIN SELECT RAISE(ABORT, 'parol-test: audit event refused'); END`,
  ]),
);

interface Scenario {
  action: (typeof AUDIT_ACTIONS)[number];
  /** What the call does, for the test's name. */
  call: string;
  prepare: (w: World) => () => unknown;
}

const scenarios: Scenario[] = [
  {
    action: "matter.create",
    call: "createMatter",
    prepare: (w) => () =>
      w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate }),
  },
  {
    // createMatter writes two events; the second failing must take the first, and the matter, with it.
    action: "member.add",
    call: "createMatter (its second event)",
    prepare: (w) => () =>
      w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate }),
  },
  {
    action: "member.add",
    call: "addMember",
    prepare: (w) => {
      const m = addMatter(w);
      return () => w.repo.addMember(m.id, ACTORS.reviewer, "reviewer", actor);
    },
  },
  {
    action: "matter.update",
    call: "updateClientName",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () => w.repo.updateClientName(m.id, "A New Name, Inc.", actor);
    },
  },
  {
    action: "inputs.changed",
    call: "updateClientName (the invalidation it triggers)",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () => w.repo.updateClientName(m.id, "A New Name, Inc.", actor);
    },
  },
  {
    action: "matter.update",
    call: "setPlaybookVersion",
    prepare: (w) => {
      const m = addMatter(w, { pinPlaybook: false });
      return () => w.repo.setPlaybookVersion(m.id, w.playbook.id, actor);
    },
  },
  {
    action: "document.add",
    call: "addDocument",
    prepare: (w) => {
      const m = w.repo.createMatter({
        name: "n",
        clientLegalName: "c",
        createdBy: ACTORS.associate,
      });
      return () =>
        w.repo.addDocument(
          m.id,
          { kind: "nda", title: "NDA", version: newVersion(m.id, "d") },
          actor,
        );
    },
  },
  {
    action: "version.add",
    call: "addVersion",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () => w.repo.addVersion(m.id, m.nda.documentId, newVersion(m.id, "v2"), actor);
    },
  },
  {
    action: "inputs.changed",
    call: "addVersion (the invalidation it triggers)",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () => w.repo.addVersion(m.id, m.nda.documentId, newVersion(m.id, "v2"), actor);
    },
  },
  {
    action: "version.operative",
    call: "setOperativeVersion",
    prepare: (w) => {
      const m = addMatter(w);
      const v2 = w.repo.addVersion(m.id, m.nda.documentId, newVersion(m.id, "v2"), actor);
      return () => w.repo.setOperativeVersion(m.id, v2.id, actor);
    },
  },
  {
    action: "version.stated_date",
    call: "setStatedDate",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () => w.repo.setStatedDate(m.id, m.nda.versionId, "2026-03-03", actor);
    },
  },
  {
    action: "document.remove",
    call: "removeDocument",
    prepare: (w) => {
      const m = addMatter(w, { amendment: true });
      const amendment = m.amendment as NonNullable<typeof m.amendment>;
      return () => w.repo.removeDocument(m.id, amendment.documentId, actor);
    },
  },
  {
    action: "inputs.changed",
    call: "applyInputChange",
    prepare: (w) => {
      const m = reviewable(w).m;
      return () =>
        w.repo.applyInputChange(m.id, { reason: "rerun_requested", actorId: ACTORS.associate });
    },
  },
  {
    action: "run.create",
    call: "createRun",
    prepare: (w) => {
      const m = addMatter(w);
      const manifest = w.repo.buildRunManifest(m.id, {
        workflowVersionId: w.workflow.id,
        modelProvider: "p",
        model: "m",
      });
      return () => w.repo.createRun(m.id, { manifest, startedBy: ACTORS.associate });
    },
  },
  {
    action: "run.status",
    call: "updateRunStatus",
    prepare: (w) => {
      const m = addMatter(w);
      const run = startRun(w, m, "queued");
      return () => w.repo.updateRunStatus(m.id, run.id, "ingesting");
    },
  },
  {
    action: "run.status",
    call: "updateRunStatus to failed (the matter and the open stages it moves)",
    prepare: (w) => {
      const m = addMatter(w);
      const run = startRun(w, m, "analyzing");
      w.repo.recordStageStart(m.id, run.id, {
        stage: "analyze",
        unit: "dur-1",
        inputSha256: sha256Hex("in"),
      });
      return () => w.repo.updateRunStatus(m.id, run.id, "failed", { errorKind: "provider_auth" });
    },
  },
  {
    action: "run.status",
    call: "markInterruptedOnBoot",
    prepare: (w) => {
      const m = addMatter(w);
      startRun(w, m, "analyzing");
      return () => w.repo.markInterruptedOnBoot();
    },
  },
  {
    action: "finding.save",
    call: "saveFindings",
    prepare: (w) => {
      const m = addMatter(w);
      const run = startRun(w, m);
      return () => saveAll(w, m, run);
    },
  },
  {
    action: "review.decide",
    call: "recordReview",
    prepare: (w) => {
      const r = reviewable(w);
      const f = r.findings[0]!;
      return () =>
        w.repo.recordReview(r.m.id, f.id, {
          reviewerId: ACTORS.reviewer,
          decision: "accept",
          findingContentSha256: f.contentSha256,
        });
    },
  },
  {
    // The last decision moves the matter to review_complete; that move must be undone with the decision.
    action: "review.decide",
    call: "recordReview (the last decision, which moves the matter on)",
    prepare: (w) => {
      const r = reviewable(w);
      decideAll(w, r.m.id, r.findings.slice(0, 2));
      const f = r.findings[2]!;
      return () =>
        w.repo.recordReview(r.m.id, f.id, {
          reviewerId: ACTORS.reviewer,
          decision: "accept",
          findingContentSha256: f.contentSha256,
        });
    },
  },
  {
    action: "memo.export",
    call: "recordMemo",
    prepare: (w) => {
      const r = reviewable(w);
      const reviews = decideAll(w, r.m.id, r.findings);
      return () =>
        w.repo.recordMemo(r.m.id, {
          runId: r.run.id,
          reviewIds: reviews.map((x) => x.id),
          fileSha256: sha256Hex("memo"),
          storagePath: fakePath(r.m.id),
          exportedBy: ACTORS.reviewer,
        });
    },
  },
  {
    action: "matter.status",
    call: "setMatterStatus",
    prepare: (w) => {
      // Reopening a finished review is a status change that setMatterStatus makes itself.
      const r = reviewable(w);
      decideAll(w, r.m.id, r.findings);
      return () => w.repo.setMatterStatus(r.m.id, "in_review", actor);
    },
  },
  {
    action: "matter.delete",
    call: "deleteMatter",
    prepare: (w) => {
      const e = exported(w, { amendment: true });
      return () => w.repo.deleteMatter(e.m.id, actor);
    },
  },
  {
    action: "playbook.import",
    call: "importPlaybookDraft",
    prepare: (w) => () =>
      w.repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "2.0.0",
          yaml: `${PLAYBOOK_YAML}# 2`,
          sha256: sha256Hex(`${PLAYBOOK_YAML}# 2`),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      ),
  },
  {
    action: "playbook.approve",
    call: "approvePlaybookVersion",
    prepare: (w) => {
      const draft = w.repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "2.0.0",
          yaml: `${PLAYBOOK_YAML}# 2`,
          sha256: sha256Hex(`${PLAYBOOK_YAML}# 2`),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      );
      return () => w.repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin });
    },
  },
  {
    action: "prompt.register",
    call: "upsertPromptVersion",
    prepare: (w) => () =>
      w.repo.upsertPromptVersion({
        id: "analyze.p2",
        stage: "analyze",
        template: "T2",
        schemaJson: "{}",
        sha256: sha256Hex("analyze.p2"),
      }),
  },
  {
    action: "workflow.register",
    call: "upsertWorkflowVersion",
    prepare: (w) => {
      const manifest = { ...WORKFLOW_MANIFEST, label: "v2", retrieval: "R2" as const };
      return () => w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
    },
  },
  {
    action: "workflow.promote",
    call: "promoteWorkflowVersion",
    prepare: (w) => () =>
      w.repo.promoteWorkflowVersion(w.workflow.id, {
        actorId: ACTORS.admin,
        promotionRecord: "docs/parol/promotion.md",
      }),
  },
  {
    action: "feedback.add",
    call: "addFeedback",
    prepare: (w) => {
      const m = addMatter(w);
      return () =>
        w.repo.addFeedback(m.id, { userId: ACTORS.reviewer, kind: "comment", text: "A comment." });
    },
  },
  {
    action: "eval.record",
    call: "createEvalDataset",
    prepare: (w) => () =>
      w.repo.createEvalDataset({
        label: "set",
        devSha256: "a".repeat(64),
        heldoutSha256: "b".repeat(64),
      }),
  },
  {
    action: "eval.record",
    call: "createEvalRun",
    prepare: (w) => {
      const dataset = w.repo.createEvalDataset({
        label: "set",
        devSha256: "a".repeat(64),
        heldoutSha256: "b".repeat(64),
      });
      return () =>
        w.repo.createEvalRun(
          {
            datasetId: dataset.id,
            split: "dev",
            workflowVersionId: w.workflow.id,
            playbookVersionId: w.playbook.id,
            model: "m",
            repeats: 1,
            priceTableSha256: "c".repeat(64),
            resultsPath: "r.json",
          },
          { actorId: null },
        );
    },
  },
  {
    action: "eval.record",
    call: "finishEvalRun",
    prepare: (w) => {
      const dataset = w.repo.createEvalDataset({
        label: "set",
        devSha256: "a".repeat(64),
        heldoutSha256: "b".repeat(64),
      });
      const run = w.repo.createEvalRun(
        {
          datasetId: dataset.id,
          split: "dev",
          workflowVersionId: w.workflow.id,
          playbookVersionId: w.playbook.id,
          model: "m",
          repeats: 1,
          priceTableSha256: "c".repeat(64),
          resultsPath: "r.json",
        },
        { actorId: null },
      );
      return () => w.repo.finishEvalRun(run.id, { actorId: null });
    },
  },
  {
    action: "eval.record",
    call: "recordEvalSlotResult",
    prepare: (w) => {
      const e = exported(w);
      const dataset = w.repo.createEvalDataset({
        label: "set",
        devSha256: "a".repeat(64),
        heldoutSha256: "b".repeat(64),
      });
      const run = w.repo.createEvalRun(
        {
          datasetId: dataset.id,
          split: "dev",
          workflowVersionId: w.workflow.id,
          playbookVersionId: w.playbook.id,
          model: "m",
          repeats: 1,
          priceTableSha256: "c".repeat(64),
          resultsPath: "r.json",
        },
        { actorId: null },
      );
      return () =>
        w.repo.recordEvalSlotResult(
          e.m.id,
          {
            evalRunId: run.id,
            caseKey: "C1",
            ruleKey: "dur-1",
            repeat: 0,
            runId: e.run.id,
            expectedStatus: "compliant",
            gotStatus: "compliant",
            scores: {},
          },
          { actorId: null },
        );
    },
  },
];

describe("a change and its audit event commit together", () => {
  for (const scenario of scenarios)
    it(`${scenario.action}: ${scenario.call} leaves nothing behind when the event cannot be written`, () => {
      const w = makeWorld();
      const call = scenario.prepare(w);
      const before = dump(w.db);

      w.db.exec(FAIL_ON[scenario.action] as string);
      expect(call, "the call must reach the audit insert for this action").toThrow(
        /audit event refused/,
      );
      expect(dump(w.db) === before, "the database changed although the call failed").toBe(true);

      // With the refusal lifted the same call goes through and writes that event, and the chain holds.
      w.db.exec("DROP TRIGGER zz_refuse_audit");
      const events = w.repo.listAuditEvents({ action: scenario.action }).length;
      call();
      expect(w.repo.listAuditEvents({ action: scenario.action }).length).toBeGreaterThan(events);
      expect(w.repo.verifyAuditChain().ok).toBe(true);
    });

  it("covers every action the store writes", () => {
    const covered = new Set(scenarios.map((s) => s.action));
    // `matter.delete` is covered above; every action in the list must have a scenario.
    expect(AUDIT_ACTIONS.filter((a) => !covered.has(a))).toEqual([]);
  });
});
