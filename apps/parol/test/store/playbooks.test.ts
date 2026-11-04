import { beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import type { PlaybookRuleRecord } from "../../src/contracts.js";
import {
  ConflictError,
  InvalidTransitionError,
  NotFoundError,
  ValidationError,
} from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  makeWorld,
  startRun,
  type World,
} from "./fixtures.js";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const draftInput = (over: Partial<{ version: string; yaml: string; rules: PlaybookRuleRecord[] }> = {}) => {
  const yaml = over.yaml ?? `${PLAYBOOK_YAML}# ${over.version ?? "2.0.0"}\n`;
  return {
    slug: "test-playbook",
    version: over.version ?? "2.0.0",
    yaml,
    sha256: sha256Hex(yaml),
    rules: over.rules ?? RULES,
  };
};

describe("importing a playbook draft", () => {
  it("stores a draft and its rules in playbook order, losing nothing", () => {
    const v = w.repo.importPlaybookDraft(draftInput(), { actorId: ACTORS.legalEngineer });
    expect(v).toMatchObject({ slug: "test-playbook", version: "2.0.0", status: "draft", approvedBy: null, approvedAt: null });
    const rules = w.repo.listRules(v.id);
    expect(rules.map((r) => r.key)).toEqual(["pty-1", "dur-1", "gov-1"]);
    expect(rules.map((r) => r.ordinal)).toEqual([0, 1, 2]);
    // Every field of the rule survives the JSON column and the columns, including nulls and lists.
    for (const [i, rule] of rules.entries()) expect(rule).toMatchObject(RULES[i] as object);
    expect(new Set(rules.map((r) => r.ruleSha256)).size).toBe(3);
    expect(w.repo.getRuleByKey(v.id, "dur-1")?.escalateWhen).toEqual([{ id: "no-end", text: "The agreement states no end at all." }]);
    expect(w.repo.getRuleByKey(v.id, "nope-1")).toBeUndefined();
  });

  it("gives a rule the same hash when it is unchanged between versions, so a later version can tell which rules moved", () => {
    const a = w.repo.importPlaybookDraft(draftInput({ version: "2.0.0" }), { actorId: ACTORS.legalEngineer });
    const changed = RULES.map((r) => (r.key === "dur-1" ? { ...r, standard: "Two years or less." } : r));
    const b = w.repo.importPlaybookDraft(draftInput({ version: "2.1.0", rules: changed }), { actorId: ACTORS.legalEngineer });
    const hashes = (id: string) => Object.fromEntries(w.repo.listRules(id).map((r) => [r.key, r.ruleSha256]));
    expect(hashes(a.id)["pty-1"]).toBe(hashes(b.id)["pty-1"]);
    expect(hashes(a.id)["dur-1"]).not.toBe(hashes(b.id)["dur-1"]);
  });

  it("is idempotent for the same text and refuses different text under the same version", () => {
    const input = draftInput();
    const first = w.repo.importPlaybookDraft(input, { actorId: ACTORS.legalEngineer });
    const again = w.repo.importPlaybookDraft(input, { actorId: ACTORS.legalEngineer });
    expect(again.id).toBe(first.id);
    expect(w.repo.listAuditEvents({ action: "playbook.import" })).toHaveLength(2); // the fixture's and this one
    const other = draftInput({ yaml: `${PLAYBOOK_YAML}# different\n` });
    expect(() => w.repo.importPlaybookDraft(other, { actorId: ACTORS.legalEngineer })).toThrow(ConflictError);
    expect(w.repo.listRules(first.id)).toHaveLength(3);
  });

  it("checks the hash against the YAML instead of trusting it", () => {
    expect(() => w.repo.importPlaybookDraft({ ...draftInput(), sha256: sha256Hex("something else") }, { actorId: ACTORS.legalEngineer })).toThrow(/not the hash/);
  });

  it("refuses malformed input", () => {
    const go = (input: object) => w.repo.importPlaybookDraft({ ...draftInput(), ...input } as never, { actorId: ACTORS.legalEngineer });
    expect(() => go({ slug: "Bad Slug" })).toThrow(ValidationError);
    expect(() => go({ version: "" })).toThrow(ValidationError);
    expect(() => go({ yaml: "", sha256: sha256Hex("") })).toThrow(ValidationError);
    expect(() => go({ rules: [] })).toThrow(/at least one rule/);
    expect(() => go({ rules: [RULES[0], RULES[0]] })).toThrow(/unique/);
    expect(() => go({ rules: [{ ...RULES[0], category: "pricing" }] })).toThrow(ValidationError);
    expect(() => go({ rules: [{ ...RULES[0], severity: "extreme" }] })).toThrow(ValidationError);
    expect(() => w.repo.importPlaybookDraft(draftInput(), { actorId: "usr_nobody" })).toThrow(NotFoundError);
    expect(w.repo.listPlaybookVersions().map((v) => v.version)).toEqual(["1.0.0"]);
  });
});

describe("approving a playbook", () => {
  it("records who and when, audits it, and the version is then frozen", () => {
    const draft = w.repo.importPlaybookDraft(draftInput(), { actorId: ACTORS.legalEngineer });
    w.clock.tick(5000);
    const approved = w.repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin });
    expect(approved).toMatchObject({ status: "approved", approvedBy: ACTORS.admin, approvedAt: w.clock.iso() });
    const event = w.repo.listAuditEvents({ action: "playbook.approve" }).at(-1);
    expect(event?.detail).toMatchObject({ slug: "test-playbook", version: "2.0.0" });
    expect(event?.actorId).toBe(ACTORS.admin);
    expect(() => w.repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin })).toThrow(/already approved/);
    // Importing the same text again returns the frozen version; different text is refused.
    expect(w.repo.importPlaybookDraft(draftInput(), { actorId: ACTORS.legalEngineer }).status).toBe("approved");
    expect(() => w.repo.importPlaybookDraft(draftInput({ yaml: "x: 1\n" }), { actorId: ACTORS.legalEngineer })).toThrow(ConflictError);
  });

  it("refuses an unknown version, an unknown approver and a retired version", () => {
    expect(() => w.repo.approvePlaybookVersion("pbv_nope", { actorId: ACTORS.admin })).toThrow(NotFoundError);
    const draft = w.repo.importPlaybookDraft(draftInput(), { actorId: ACTORS.legalEngineer });
    expect(() => w.repo.approvePlaybookVersion(draft.id, { actorId: "usr_nobody" })).toThrow(NotFoundError);
    w.db.prepare("UPDATE playbook_versions SET status = 'retired' WHERE id = ?").run(draft.id);
    expect(() => w.repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin })).toThrow(InvalidTransitionError);
  });

  it("is what lets a matter select it: a draft cannot be pinned", () => {
    const draft = w.repo.importPlaybookDraft(draftInput(), { actorId: ACTORS.legalEngineer });
    const m = addMatter(w, { pinPlaybook: false });
    expect(() => w.repo.setPlaybookVersion(m.id, draft.id, { actorId: ACTORS.associate })).toThrow(/approved/);
    expect(() => w.repo.setPlaybookVersion(m.id, "pbv_nope", { actorId: ACTORS.associate })).toThrow(NotFoundError);
    w.repo.approvePlaybookVersion(draft.id, { actorId: ACTORS.admin });
    expect(w.repo.setPlaybookVersion(m.id, draft.id, { actorId: ACTORS.associate }).playbookVersionId).toBe(draft.id);
  });

  it("finds versions by slug and version, and lists them", () => {
    expect(w.repo.findPlaybookVersion("test-playbook", "1.0.0")?.id).toBe(w.playbook.id);
    expect(w.repo.findPlaybookVersion("test-playbook", "9.9.9")).toBeUndefined();
    expect(w.repo.getPlaybookVersion(w.playbook.id)?.sha256).toBe(sha256Hex(PLAYBOOK_YAML));
    expect(w.repo.listPlaybookVersions("other-slug")).toEqual([]);
  });
});

describe("prompt versions", () => {
  const prompt = { id: "analyze.p2", stage: "analyze" as const, template: "T2", schemaJson: "{}", sha256: sha256Hex("analyze.p2\nT2") };

  it("registers a prompt once and returns the stored row on repeat", () => {
    const first = w.repo.upsertPromptVersion(prompt);
    w.clock.tick();
    const again = w.repo.upsertPromptVersion(prompt);
    expect(again).toEqual(first);
    expect(w.repo.getPromptVersion("analyze.p2")?.template).toBe("T2");
    expect(w.repo.listPromptVersions().map((p) => p.id)).toContain("analyze.p2");
    expect(w.repo.getPromptVersion("nope.p1")).toBeUndefined();
  });

  it("will not let an id name two texts, or one text carry two ids", () => {
    w.repo.upsertPromptVersion(prompt);
    expect(() => w.repo.upsertPromptVersion({ ...prompt, template: "T3", sha256: sha256Hex("changed") })).toThrow(/different text/);
    expect(() => w.repo.upsertPromptVersion({ ...prompt, id: "analyze.p3" })).toThrow(/already registered as analyze.p2/);
    expect(w.repo.getPromptVersion("analyze.p2")?.template).toBe("T2");
  });

  it("validates", () => {
    expect(() => w.repo.upsertPromptVersion({ ...prompt, id: "Analyze P2" })).toThrow(ValidationError);
    expect(() => w.repo.upsertPromptVersion({ ...prompt, stage: "other" as never })).toThrow(ValidationError);
    expect(() => w.repo.upsertPromptVersion({ ...prompt, sha256: "abc" })).toThrow(ValidationError);
  });
});

describe("workflow versions", () => {
  const manifest = { ...WORKFLOW_MANIFEST, label: "v2", retrieval: "R2" as const };

  it("registers a candidate identified by its hash, and is idempotent", () => {
    const wf = w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
    expect(wf).toMatchObject({ label: "v2", status: "candidate", promotedBy: null, promotionRecord: null });
    expect(wf.id).toBe(`wfv_${hashOf(manifest).slice(0, 16)}`);
    expect(wf.manifest).toEqual(manifest);
    expect(w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) }).id).toBe(wf.id);
    expect(w.repo.getWorkflowVersionByLabel("v2")?.id).toBe(wf.id);
    expect(w.repo.listWorkflowVersions().map((x) => x.label)).toEqual(["v1", "v2"]);
  });

  it("checks the hash against the manifest and the prompts it pins", () => {
    expect(() => w.repo.upsertWorkflowVersion({ manifest, sha256: sha256Hex("not it") })).toThrow(/not the hash/);
    const pinsUnknown = { ...manifest, prompts: { ...manifest.prompts, analyze: "analyze.p9" } };
    expect(() => w.repo.upsertWorkflowVersion({ manifest: pinsUnknown, sha256: hashOf(pinsUnknown) })).toThrow(/analyze.p9/);
    expect(() => w.repo.upsertWorkflowVersion({ manifest: { ...manifest, retrieval: "R9" as never }, sha256: hashOf(manifest) })).toThrow(ValidationError);
    expect(w.repo.listWorkflowVersions()).toHaveLength(1);
  });

  it("refuses a label that already names another manifest", () => {
    const other = { ...WORKFLOW_MANIFEST, budgetTokens: 9000 };
    expect(() => w.repo.upsertWorkflowVersion({ manifest: other, sha256: hashOf(other) })).toThrow(/label v1/);
  });

  it("promotes to pilot only with a promotion record, and audits it", () => {
    const wf = w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
    for (const bad of ["", "   ", "x".repeat(201), "line\nbreak"])
      expect(() => w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: bad })).toThrow(ValidationError);
    expect(w.repo.getWorkflowVersion(wf.id)?.status).toBe("candidate");
    w.clock.tick();
    const promoted = w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: "docs/parol/promotions/v2.md" });
    expect(promoted).toMatchObject({ status: "pilot", promotedBy: ACTORS.admin, promotionRecord: "docs/parol/promotions/v2.md", promotedAt: w.clock.iso() });
    expect(w.repo.listAuditEvents({ action: "workflow.promote" })[0]?.detail).toMatchObject({ label: "v2", promotionRecord: "docs/parol/promotions/v2.md" });
    expect(() => w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: "again.md" })).toThrow(/already a pilot/);
    expect(() => w.repo.promoteWorkflowVersion("wfv_nope", { actorId: ACTORS.admin, promotionRecord: "x.md" })).toThrow(NotFoundError);
    expect(() => w.repo.promoteWorkflowVersion(wf.id, { actorId: "usr_nobody", promotionRecord: "x.md" })).toThrow();
  });

  it("does not touch runs that already used another workflow version", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const wf = w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
    w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: "x.md" });
    const after = w.repo.getRun(m.id, run.id);
    expect(after?.workflowVersionId).toBe(w.workflow.id);
    expect(after?.status).toBe("analyzing");
    expect(w.repo.getMatter(m.id)?.status).toBe("running");
  });

  it("will not promote a retired version", () => {
    const wf = w.repo.upsertWorkflowVersion({ manifest, sha256: hashOf(manifest) });
    w.db.prepare("UPDATE workflow_versions SET status = 'retired' WHERE id = ?").run(wf.id);
    expect(() => w.repo.promoteWorkflowVersion(wf.id, { actorId: ACTORS.admin, promotionRecord: "x.md" })).toThrow(InvalidTransitionError);
  });
});
