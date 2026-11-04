import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashOf, sha256Hex } from "../../src/canonical.js";
import { openDatabase, runMigrations } from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  exported,
  fakePath,
  makeWorld,
  reviewable,
  startRun,
  type World,
} from "./fixtures.js";

/**
 * Raw SQL against the schema, the way a bug or an attacker with the database file would write it.
 * Each case says what the database must refuse, and the message proves it was a trigger of ours and
 * not some other constraint that happened to fire first.
 */

let w: World;
let ids: ReturnType<typeof gather>;

const q = <T = Record<string, SQLInputValue>>(sql: string, ...params: SQLInputValue[]): T =>
  w.db.prepare(sql).get(...params) as T;
const run = (sql: string, ...params: SQLInputValue[]) => () => w.db.prepare(sql).run(...params);

/** A copy of an existing row with some columns changed, as one statement. */
function clone(
  table: string,
  idColumn: string,
  id: string,
  overrides: Record<string, SQLInputValue>,
  verb = "INSERT",
  suffix = "",
) {
  const row = q<Record<string, SQLInputValue>>(`SELECT * FROM ${table} WHERE ${idColumn} = ?`, id);
  const next = { ...row, ...overrides };
  const cols = Object.keys(next);
  return run(
    `${verb} INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) ${suffix}`,
    ...cols.map((c) => next[c] as SQLInputValue),
  );
}

const count = (table: string, where = "1 = 1", ...params: SQLInputValue[]): number =>
  q<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, ...params).n;

function gather(world: World) {
  const a = exported(world, { amendment: true });
  const b = reviewable(world, { name: "other matter" });
  const c = addMatter(world, { name: "with an active run" });
  const activeRun = startRun(world, c);
  const one = <T>(sql: string, ...p: SQLInputValue[]) => world.db.prepare(sql).get(...p) as T;
  const feedback = world.repo.addFeedback(a.m.id, { userId: ACTORS.reviewer, kind: "comment", text: "fine" });
  const otherFeedbackRun = b.run.id;
  const draft = world.repo.importPlaybookDraft(
    { slug: "test-playbook", version: "3.0.0", yaml: `${PLAYBOOK_YAML}# draft\n`, sha256: sha256Hex(`${PLAYBOOK_YAML}# draft\n`), rules: RULES },
    { actorId: ACTORS.legalEngineer },
  );
  const next = { ...WORKFLOW_MANIFEST, label: "v2" };
  const workflow2 = world.repo.upsertWorkflowVersion({ manifest: next, sha256: hashOf(next) });
  const rules = world.repo.listRules(world.playbook.id);
  const draftRules = world.repo.listRules(draft.id);
  const ndaDoc = one<{ id: string }>("SELECT id FROM documents WHERE matter_id = ? AND kind = 'nda'", a.m.id).id;
  const amendDoc = one<{ id: string }>("SELECT id FROM documents WHERE matter_id = ? AND kind = 'amendment'", a.m.id).id;
  const nonOperative = (() => {
    // A second version of the NDA that is not operative, written without the repository (which would
    // have cleared the operative flag and made the matter stale).
    world.db
      .prepare(
        `INSERT INTO document_versions
           (id, document_id, matter_id, version_no, media_type, file_sha256, text_sha256, byte_size, stated_date, operative, storage_path, uploaded_by, uploaded_at)
         VALUES ('ver_off', ?, ?, 2, 'txt', ?, ?, 1, NULL, 0, ?, ?, 't')`,
      )
      .run(ndaDoc, a.m.id, sha256Hex("off file"), sha256Hex("off text"), fakePath(a.m.id), ACTORS.associate);
    world.db
      .prepare(
        `INSERT INTO source_spans (id, document_version_id, matter_id, paragraph_index, clause_id, clause_number, heading, text, text_sha256)
         VALUES ('ver_off:p0', 'ver_off', ?, 0, 'c1', NULL, NULL, 'off-manifest text', ?)`,
      )
      .run(a.m.id, sha256Hex("off-manifest text"));
    return "ver_off";
  })();
  const nonSynthetic = addMatter(world, { synthetic: false, name: "real" });
  const nonSyntheticRun = startRun(world, nonSynthetic);
  return {
    a,
    b,
    c,
    activeRun,
    feedback,
    otherFeedbackRun,
    draft,
    workflow2,
    rules,
    draftRules,
    ndaDoc,
    amendDoc,
    nonOperative,
    nonSyntheticRun,
    ndaVersion: a.m.nda.versionId,
    amendVersion: a.m.amendment?.versionId as string,
    spanA: a.m.nda.spanIds[2] as string,
    spanB: b.m.nda.spanIds[2] as string,
    findingA: a.findings[0]?.id as string,
    findingA2: a.findings[1]?.id as string,
    findingB: b.findings[0]?.id as string,
    evidenceA: a.findings[0]?.evidence[0]?.id as string,
    reviewA: a.reviews[0]?.id as string,
    reviewA2: a.reviews[1]?.id as string,
    memoA: a.memo.id,
  };
}

beforeEach(() => {
  w = makeWorld();
  ids = gather(w);
});

describe("matters", () => {
  it("keep their identity columns", () => {
    for (const [column, value] of [
      ["id", "mat_ffffffffffffffff"],
      ["created_by", ACTORS.reviewer],
      ["created_at", "2000-01-01T00:00:00.000Z"],
      ["synthetic", 0],
    ] as const)
      expect(run(`UPDATE matters SET ${column} = ? WHERE id = ?`, value, ids.a.m.id), column).toThrow(/identity is immutable/);
  });

  it("can pin only an approved playbook version", () => {
    expect(run("UPDATE matters SET playbook_version_id = ? WHERE id = ?", ids.draft.id, ids.a.m.id)).toThrow(/approved playbook/);
    expect(clone("matters", "id", ids.a.m.id, { id: "mat_aaaaaaaaaaaaaaaa", playbook_version_id: ids.draft.id })).toThrow(/approved playbook/);
  });

  it("still allow the columns the repository changes", () => {
    expect(run("UPDATE matters SET name = 'renamed', retain_until = '2030-01-01T00:00:00.000Z', status = 'stale' WHERE id = ?", ids.a.m.id)).not.toThrow();
  });
});

describe("documents", () => {
  it("are never replaced, by id, by label, or by a second NDA", () => {
    const row = (over: Record<string, SQLInputValue>) => clone("documents", "id", ids.ndaDoc, over, "INSERT OR REPLACE");
    expect(row({ title: "replaced" })).toThrow(/never replaced/);
    expect(row({ id: "doc_new", kind: "amendment" })).toThrow(/never replaced/);
    expect(row({ id: "doc_new", ordinal: 3 })).toThrow(/never replaced/);
    expect(clone("documents", "id", ids.ndaDoc, { title: "x" }, "INSERT", "ON CONFLICT(id) DO UPDATE SET title = excluded.title")).toThrow(/never replaced/);
    expect(q<{ title: string }>("SELECT title FROM documents WHERE id = ?", ids.ndaDoc).title).toBe("Mutual NDA");
  });

  it("hold one NDA, at most two amendments, labelled 1 to 3", () => {
    expect(clone("documents", "id", ids.ndaDoc, { id: "doc_nda2", ordinal: 3 })).toThrow(/never replaced/);
    expect(clone("documents", "id", ids.ndaDoc, { id: "doc_x", ordinal: 4, kind: "amendment" })).toThrow(/at most two amendments/);
    expect(clone("documents", "id", ids.ndaDoc, { id: "doc_x", ordinal: 0, kind: "amendment" })).toThrow(/at most two amendments/);
    // Without an NDA the count of amendments is what stops a third.
    const empty = w.repo.createMatter({ name: "n", clientLegalName: "c", createdBy: ACTORS.associate });
    const insert = (n: number) => run("INSERT INTO documents (id, matter_id, kind, title, ordinal) VALUES (?, ?, 'amendment', 't', ?)", `doc_e${n}`, empty.id, n);
    expect(insert(1)).not.toThrow();
    expect(insert(2)).not.toThrow();
    expect(insert(3)).toThrow(/at most two amendments/);
  });

  it("keep matter, kind and label", () => {
    expect(run("UPDATE documents SET kind = 'amendment' WHERE id = ?", ids.ndaDoc)).toThrow(/identity is immutable/);
    expect(run("UPDATE documents SET ordinal = 3 WHERE id = ?", ids.ndaDoc)).toThrow(/identity is immutable/);
    expect(run("UPDATE documents SET matter_id = ? WHERE id = ?", ids.b.m.id, ids.ndaDoc)).toThrow(/identity is immutable/);
    expect(run("UPDATE documents SET title = 'renamed' WHERE id = ?", ids.ndaDoc)).not.toThrow();
  });
});

describe("document versions", () => {
  const version = (over: Record<string, SQLInputValue>, verb = "INSERT", suffix = "") =>
    clone("document_versions", "id", ids.ndaVersion, over, verb, suffix);

  it("are never replaced, by id, by number, or by an upsert", () => {
    // operative is 0 in each, so it is the replace guard that has to refuse and not the operative one.
    expect(version({ file_sha256: "f".repeat(64), operative: 0 }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(version({ id: "ver_new", file_sha256: "f".repeat(64), operative: 0 }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(version({ file_sha256: "f".repeat(64), operative: 0 }, "INSERT", "ON CONFLICT(id) DO UPDATE SET file_sha256 = excluded.file_sha256")).toThrow(/never replaced/);
    expect(q<{ file_sha256: string }>("SELECT file_sha256 FROM document_versions WHERE id = ?", ids.ndaVersion).file_sha256).not.toBe("f".repeat(64));
  });

  it("belong to the matter of their document and keep their file in that matter's folder", () => {
    expect(version({ id: "ver_x", version_no: 9, operative: 0, matter_id: ids.b.m.id, storage_path: fakePath(ids.b.m.id) })).toThrow(/matter of its document/);
    expect(version({ id: "ver_x", version_no: 9, operative: 0, storage_path: fakePath(ids.b.m.id) })).toThrow(/own matter folder/);
    expect(version({ id: "ver_x", version_no: 9, operative: 0, storage_path: `${ids.a.m.id}x/f_1` })).toThrow(/own matter folder/);
    expect(version({ id: "ver_ok", version_no: 9, operative: 0, storage_path: fakePath(ids.a.m.id) })).not.toThrow();
  });

  it("have at most one operative version per document, however it is attempted", () => {
    expect(version({ id: "ver_y", version_no: 9, operative: 1, storage_path: fakePath(ids.a.m.id) })).toThrow(/at most one operative/);
    expect(run("UPDATE document_versions SET operative = 1 WHERE id = ?", ids.nonOperative)).toThrow(/at most one operative/);
    // OR REPLACE would delete the operative version to make room, and must be stopped before it does.
    expect(run("UPDATE OR REPLACE document_versions SET operative = 1 WHERE id = ?", ids.nonOperative)).toThrow(/at most one operative/);
    expect(q<{ operative: number }>("SELECT operative FROM document_versions WHERE id = ?", ids.ndaVersion).operative).toBe(1);
    expect(run("UPDATE document_versions SET operative = 2 WHERE id = ?", ids.nonOperative)).toThrow(/at most one operative/);
    // Clearing the old one first is the way.
    w.db.prepare("UPDATE document_versions SET operative = 0 WHERE id = ?").run(ids.ndaVersion);
    expect(run("UPDATE document_versions SET operative = 1 WHERE id = ?", ids.nonOperative)).not.toThrow();
  });

  it("are backed by a unique index that holds even if the triggers are gone", () => {
    for (const name of ["document_versions_operative_flag_insert", "document_versions_operative_flag_update"])
      w.db.exec(`DROP TRIGGER ${name}`);
    expect(run("UPDATE document_versions SET operative = 1 WHERE id = ?", ids.nonOperative)).toThrow(/UNIQUE constraint failed/);
  });

  const alternatives: Record<string, SQLInputValue> = {
    id: "ver_zzz",
    document_id: "doc_other",
    matter_id: "mat_ffffffffffffffff",
    version_no: 9,
    media_type: "docx",
    file_sha256: "f".repeat(64),
    text_sha256: "e".repeat(64),
    byte_size: 99999,
    storage_path: "mat_ffffffffffffffff/f_zzz",
    uploaded_by: ACTORS.reviewer,
    uploaded_at: "2000-01-01T00:00:00.000Z",
  };
  for (const [column, value] of Object.entries(alternatives))
    it(`never change ${column}`, () => {
      expect(run(`UPDATE document_versions SET ${column} = ? WHERE id = ?`, value, ids.nonOperative)).toThrow(/content is immutable/);
    });

  it("may change stated_date and operative, and nothing else", () => {
    expect(run("UPDATE document_versions SET stated_date = '2026-05-05' WHERE id = ?", ids.nonOperative)).not.toThrow();
    expect(run("UPDATE document_versions SET stated_date = NULL, operative = 0 WHERE id = ?", ids.ndaVersion)).not.toThrow();
    expect(run("UPDATE document_versions SET stated_date = '2026-05-05', file_sha256 = ? WHERE id = ?", "a".repeat(64), ids.nonOperative)).toThrow(/content is immutable/);
  });
});

describe("source spans", () => {
  const span = (over: Record<string, SQLInputValue>, verb = "INSERT", suffix = "") =>
    clone("source_spans", "id", ids.spanA, over, verb, suffix);

  it("are never replaced, by id, by position, or by an upsert", () => {
    expect(span({ text: "rewritten" }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(span({ text: "rewritten" }, "INSERT", "ON CONFLICT(id) DO UPDATE SET text = excluded.text")).toThrow(/never replaced/);
    expect(span({ id: `${ids.ndaVersion}:p2x`, text: "rewritten" }, "INSERT OR REPLACE")).toThrow(/parol:/);
    expect(q<{ text: string }>("SELECT text FROM source_spans WHERE id = ?", ids.spanA).text).toContain("two (2) years");
  });

  it("belong to the matter of their document version, and carry the id their position implies", () => {
    expect(span({ id: `${ids.ndaVersion}:p9`, paragraph_index: 9, matter_id: ids.b.m.id })).toThrow(/matter of its document version/);
    expect(span({ id: "ver_made_up:p9", paragraph_index: 9 })).toThrow(/<documentVersionId>:p<paragraphIndex>|matter of its document version/);
    expect(span({ id: `${ids.ndaVersion}:p77`, paragraph_index: 9 })).toThrow(/span id must be/);
    expect(span({ id: `${ids.ndaVersion}:p9`, paragraph_index: 9 })).not.toThrow();
  });

  it("cannot be updated at all, not even to the same value", () => {
    expect(run("UPDATE source_spans SET text = 'changed' WHERE id = ?", ids.spanA)).toThrow(/immutable/);
    expect(run("UPDATE source_spans SET text_sha256 = text_sha256 WHERE id = ?", ids.spanA)).toThrow(/immutable/);
    expect(run("UPDATE source_spans SET heading = 'h' WHERE matter_id = ?", ids.a.m.id)).toThrow(/immutable/);
    expect(run("UPDATE OR REPLACE source_spans SET clause_id = 'c99' WHERE id = ?", ids.spanA)).toThrow(/immutable/);
  });

  it("have annotations that cannot be updated either", () => {
    expect(count("span_annotations")).toBeGreaterThan(0);
    expect(run("UPDATE span_annotations SET value = '{}'")).toThrow(/immutable/);
    expect(run("UPDATE span_annotations SET kind = 'uses_term'")).toThrow(/immutable/);
  });
});

describe("playbook versions", () => {
  it("are created as drafts", () => {
    const row = (over: Record<string, SQLInputValue>) => clone("playbook_versions", "id", ids.draft.id, { id: "pbv_new", version: "9.0.0", ...over });
    expect(row({ status: "approved", approved_by: ACTORS.admin, approved_at: "t" })).toThrow(/created as a draft/);
    expect(row({ status: "retired" })).toThrow(/created as a draft/);
    expect(row({ approved_by: ACTORS.admin })).toThrow(/created as a draft/);
    expect(row({})).not.toThrow();
  });

  const approved = () => ids.rules[0]?.playbookVersionId as string;
  for (const [column, value] of [
    ["yaml", "name: changed\n"],
    ["sha256", "0".repeat(64)],
    ["version", "9.9.9"],
    ["playbook_slug", "other"],
    ["id", "pbv_other"],
    ["approved_by", ACTORS.reviewer],
    ["approved_at", "2000-01-01T00:00:00.000Z"],
    ["status", "draft"],
  ] as const)
    it(`an approved version never changes its ${column}`, () => {
      expect(run(`UPDATE playbook_versions SET ${column} = ? WHERE id = ?`, value, approved())).toThrow(/immutable/);
    });

  it("an approved version can only be retired, and a retired one is final", () => {
    expect(run("UPDATE playbook_versions SET status = 'retired' WHERE id = ?", approved())).not.toThrow();
    expect(run("UPDATE playbook_versions SET status = 'approved' WHERE id = ?", approved())).toThrow(/immutable|final/);
    expect(run("UPDATE playbook_versions SET yaml = 'x' WHERE id = ?", approved())).toThrow(/immutable|final/);
  });

  it("are never replaced once approved, whether by id, by version, or by an upsert", () => {
    const row = (over: Record<string, SQLInputValue>, verb = "INSERT OR REPLACE", suffix = "") => clone("playbook_versions", "id", approved(), { status: "draft", approved_by: null, approved_at: null, ...over }, verb, suffix);
    expect(row({ yaml: "x" })).toThrow(/immutable/);
    expect(row({ id: "pbv_new", yaml: "x" })).toThrow(/immutable/);
    expect(row({ yaml: "x" }, "INSERT", "ON CONFLICT(id) DO UPDATE SET yaml = excluded.yaml")).toThrow(/immutable/);
    expect(q<{ yaml: string }>("SELECT yaml FROM playbook_versions WHERE id = ?", approved()).yaml).toBe(PLAYBOOK_YAML);
  });

  it("are not deleted once approved, but a draft can be", () => {
    expect(run("DELETE FROM playbook_versions WHERE id = ?", approved())).toThrow(/immutable/);
    w.db.prepare("DELETE FROM playbook_rules WHERE playbook_version_id = ?").run(ids.draft.id);
    expect(run("DELETE FROM playbook_versions WHERE id = ?", ids.draft.id)).not.toThrow();
  });

  it("record who approved when they are approved", () => {
    expect(run("UPDATE playbook_versions SET status = 'approved' WHERE id = ?", ids.draft.id)).toThrow(/records who approved/);
    expect(run("UPDATE playbook_versions SET status = 'approved', approved_by = ? WHERE id = ?", ACTORS.admin, ids.draft.id)).toThrow(/records who approved/);
    expect(run("UPDATE playbook_versions SET status = 'approved', approved_by = ?, approved_at = 't' WHERE id = ?", ACTORS.admin, ids.draft.id)).not.toThrow();
  });

  it("freeze their rules: no insert, update, delete or replace once approved", () => {
    const rule = ids.rules[0];
    expect(clone("playbook_rules", "id", rule?.id as string, { id: "pbr_new", rule_key: "new-1" })).toThrow(/rules of an approved/);
    expect(run("UPDATE playbook_rules SET severity = 'low' WHERE id = ?", rule?.id as string)).toThrow(/rules of an approved/);
    expect(run("UPDATE playbook_rules SET rule_json = '{}' WHERE id = ?", rule?.id as string)).toThrow(/rules of an approved/);
    expect(run("DELETE FROM playbook_rules WHERE id = ?", rule?.id as string)).toThrow(/rules of an approved/);
    expect(clone("playbook_rules", "id", rule?.id as string, { rule_json: "{}" }, "INSERT OR REPLACE")).toThrow(/rules of an approved/);
    // Moving a rule of the draft into an approved version, or replacing an approved rule from the draft.
    const drafted = ids.draftRules[0]?.id as string;
    expect(run("UPDATE playbook_rules SET playbook_version_id = ? WHERE id = ?", approved(), drafted)).toThrow(/rules of an approved/);
    expect(clone("playbook_rules", "id", drafted, { id: rule?.id as string }, "INSERT OR REPLACE")).toThrow(/rules of an approved/);
    expect(clone("playbook_rules", "id", rule?.id as string, {}, "INSERT", "ON CONFLICT(id) DO UPDATE SET severity = 'low'")).toThrow(/rules of an approved/);
    expect(q<{ severity: string }>("SELECT severity FROM playbook_rules WHERE id = ?", rule?.id as string).severity).toBe("medium");
  });

  it("leave the rules of a draft editable", () => {
    const drafted = ids.draftRules[0]?.id as string;
    expect(run("UPDATE playbook_rules SET severity = 'low' WHERE id = ?", drafted)).not.toThrow();
    expect(clone("playbook_rules", "id", drafted, { id: "pbr_extra", rule_key: "extra-1" })).not.toThrow();
    expect(run("DELETE FROM playbook_rules WHERE id = 'pbr_extra'")).not.toThrow();
  });
});

describe("prompt versions", () => {
  const id = "analyze.p1";
  it("are immutable: no update, delete, replace or upsert", () => {
    expect(run("UPDATE prompt_versions SET template = 'x' WHERE id = ?", id)).toThrow(/immutable/);
    expect(run("DELETE FROM prompt_versions WHERE id = ?", id)).toThrow(/immutable/);
    expect(clone("prompt_versions", "id", id, { template: "x" }, "INSERT OR REPLACE")).toThrow(/immutable/);
    // The same hash under a new id is a replace too, through the unique hash.
    expect(clone("prompt_versions", "id", id, { id: "analyze.p9" }, "INSERT OR REPLACE")).toThrow(/immutable/);
    expect(clone("prompt_versions", "id", id, { template: "x" }, "INSERT", "ON CONFLICT(id) DO UPDATE SET template = excluded.template")).toThrow(/immutable/);
    expect(clone("prompt_versions", "id", id, {}, "INSERT", "ON CONFLICT(id) DO NOTHING")).toThrow(/immutable/);
    expect(q<{ template: string }>("SELECT template FROM prompt_versions WHERE id = ?", id).template).toBe("template for analyze.p1");
  });
});

describe("workflow versions", () => {
  const wf = () => w.workflow.id;
  it("are created as candidates", () => {
    expect(clone("workflow_versions", "id", ids.workflow2.id, { id: "wfv_n", label: "n", sha256: "a".repeat(64), status: "pilot" })).toThrow(/created as a candidate/);
    expect(clone("workflow_versions", "id", ids.workflow2.id, { id: "wfv_n", label: "n", sha256: "a".repeat(64), promoted_by: ACTORS.admin })).toThrow(/created as a candidate/);
  });

  for (const [column, value] of [
    ["manifest_json", "{}"],
    ["sha256", "0".repeat(64)],
    ["label", "renamed"],
    ["id", "wfv_other"],
  ] as const)
    it(`never change their ${column}`, () => {
      expect(run(`UPDATE workflow_versions SET ${column} = ? WHERE id = ?`, value, wf())).toThrow(/manifests are immutable/);
    });

  it("are not replaced or deleted", () => {
    expect(clone("workflow_versions", "id", wf(), { manifest_json: "{}" }, "INSERT OR REPLACE")).toThrow(/manifests are immutable/);
    expect(clone("workflow_versions", "id", wf(), { id: "wfv_n" }, "INSERT OR REPLACE")).toThrow(/manifests are immutable/);
    expect(run("DELETE FROM workflow_versions WHERE id = ?", wf())).toThrow(/manifests are immutable/);
  });

  it("move forward only, and reach pilot only with a promotion record, a promoter and a time", () => {
    const id = ids.workflow2.id;
    expect(run("UPDATE workflow_versions SET status = 'pilot', promoted_by = ?, promoted_at = 't' WHERE id = ?", ACTORS.admin, id)).toThrow(/promotion record/);
    expect(run("UPDATE workflow_versions SET status = 'pilot', promoted_by = ?, promoted_at = 't', promotion_record = '   ' WHERE id = ?", ACTORS.admin, id)).toThrow(/promotion record/);
    expect(run("UPDATE workflow_versions SET status = 'pilot', promotion_record = 'r.md', promoted_at = 't' WHERE id = ?", id)).toThrow(/promotion record/);
    expect(run("UPDATE workflow_versions SET status = 'pilot', promoted_by = ?, promoted_at = 't', promotion_record = 'r.md' WHERE id = ?", ACTORS.admin, id)).not.toThrow();
    expect(run("UPDATE workflow_versions SET status = 'candidate' WHERE id = ?", id)).toThrow(/only moves/);
    expect(run("UPDATE workflow_versions SET status = 'retired' WHERE id = ?", id)).not.toThrow();
    expect(run("UPDATE workflow_versions SET status = 'pilot' WHERE id = ?", id)).toThrow(/only moves/);
  });
});

describe("runs", () => {
  const runRow = (over: Record<string, SQLInputValue>, verb = "INSERT") => clone("runs", "id", ids.a.run.id, { id: "run_new", ...over }, verb);

  it("record the inputs digest they were started on", () => {
    expect(runRow({ inputs_sha256: null, matter_id: ids.b.m.id })).toThrow(/inputs digest/);
    expect(runRow({ inputs_sha256: "short", matter_id: ids.b.m.id })).toThrow(/inputs digest/);
  });

  it("have one active run per matter, by insert, by replace, and by moving one back to active", () => {
    const active = ids.activeRun.id;
    const cStatus = () => q<{ status: string }>("SELECT status FROM runs WHERE id = ?", active).status;
    const second = (over: Record<string, SQLInputValue>, verb = "INSERT") =>
      clone("runs", "id", active, { id: "run_second", status: "queued", ...over }, verb);
    expect(second({})).toThrow(/one active run/);
    expect(second({}, "INSERT OR REPLACE")).toThrow(/one active run/);
    expect(second({ id: active, status: "queued" }, "INSERT OR REPLACE")).toThrow(/never replaced|one active run/);
    expect(cStatus()).toBe("analyzing");
    // A finished run can be inserted beside it, and moving a finished one back to active is refused.
    expect(second({ status: "failed" })).not.toThrow();
    expect(run("UPDATE runs SET status = 'queued' WHERE id = 'run_second'")).toThrow(/one active run/);
  });

  it("are backed by a unique index that holds even if the triggers are gone", () => {
    for (const name of ["runs_no_replace", "runs_active_slot_update"]) w.db.exec(`DROP TRIGGER ${name}`);
    expect(clone("runs", "id", ids.activeRun.id, { id: "run_second", status: "queued" })).toThrow(/UNIQUE constraint failed/);
    expect(run("UPDATE runs SET status = 'queued' WHERE id = ?", ids.a.run.id)).not.toThrow();
  });

  const alternatives: Record<string, () => SQLInputValue> = {
    id: () => "run_zzz",
    matter_id: () => ids.b.m.id,
    workflow_version_id: () => ids.workflow2.id,
    playbook_version_id: () => ids.draft.id,
    model_provider: () => "other",
    model_requested: () => "other",
    input_manifest_json: () => "{}",
    input_manifest_sha256: () => "0".repeat(64),
    inputs_sha256: () => "1".repeat(64),
    purpose: () => "eval",
    started_by: () => ACTORS.reviewer,
    started_at: () => "2000-01-01T00:00:00.000Z",
  };
  for (const [column, value] of Object.entries(alternatives))
    it(`never change ${column}`, () => {
      expect(run(`UPDATE runs SET ${column} = ? WHERE id = ?`, value(), ids.a.run.id)).toThrow(/provenance is immutable/);
    });

  it("may change only their progress", () => {
    expect(run("UPDATE runs SET model_reported = 'served-model', error_kind = 'x', finished_at = 't', status = 'superseded' WHERE id = ?", ids.a.run.id)).not.toThrow();
  });
});

describe("findings", () => {
  const finding = (over: Record<string, SQLInputValue>, verb = "INSERT", suffix = "") => clone("findings", "id", ids.findingA, { id: "fnd_new", ...over }, verb, suffix);

  it("are never replaced, by id, by rule, or by an upsert", () => {
    expect(finding({ id: ids.findingA, explanation: "x" }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(finding({}, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(finding({ id: ids.findingA }, "INSERT", "ON CONFLICT(id) DO UPDATE SET explanation = excluded.explanation")).toThrow(/never replaced/);
    expect(q<{ explanation: string }>("SELECT explanation FROM findings WHERE id = ?", ids.findingA).explanation).toContain("meets rule");
  });

  it("must match their run, matter and playbook rule", () => {
    expect(finding({ rule_key: "x-1", matter_id: ids.b.m.id })).toThrow(/match its run, matter and playbook rule/);
    const dur = ids.rules.find((r) => r.key === "dur-1");
    // A second finding for a rule the run already has is a replace, even with a consistent rule row.
    expect(finding({ rule_key: "dur-1", playbook_rule_id: dur?.id as string, category: "duration", severity: "high" })).toThrow(/never replaced/);
    // A rule row that says something else about itself than the finding does.
    expect(finding({ rule_key: "x-1", category: "parties" })).toThrow(/match its run, matter and playbook rule/);
    expect(finding({ rule_key: "x-1", severity: "low" })).toThrow(/match its run, matter and playbook rule/);
    expect(finding({ rule_key: "x-1", playbook_rule_id: ids.draftRules[0]?.id as string })).toThrow(/match its run, matter and playbook rule/);
  });

  it("start current", () => {
    expect(finding({ rule_key: "x-1", validity: "stale", stale_reason: "r" })).toThrow(/match its run|created current/);
    const fresh = ids.rules[0];
    const onBActive = (over: Record<string, SQLInputValue>) =>
      clone("findings", "id", ids.findingB, { id: "fnd_new", rule_key: "pty-1", ...over });
    expect(fresh).toBeDefined();
    expect(onBActive({ validity: "stale", stale_reason: "r" })).toThrow(/never replaced|created current/);
  });

  const alternatives: Record<string, SQLInputValue> = {
    id: "fnd_zzz",
    run_id: "run_other",
    matter_id: "mat_ffffffffffffffff",
    playbook_rule_id: "pbr_other",
    rule_key: "zzz-1",
    category: "duration",
    severity: "low",
    status: "deviation",
    discrepancy: "changed",
    explanation: "changed",
    fallback_language: "changed",
    fallback_basis: "generated",
    escalations_json: '[{"code":"model_abstained","detail":"x"}]',
    verification_state: "escalated_by_system",
    content_sha256: "0".repeat(64),
    conflict: "changed",
    abstain_reason: "changed",
  };
  for (const [column, value] of Object.entries(alternatives))
    it(`never change ${column}`, () => {
      expect(run(`UPDATE findings SET ${column} = ? WHERE id = ?`, value, ids.findingA)).toThrow(/content is immutable/);
    });

  it("may only go from current to stale, with a reason, and never back", () => {
    const id = ids.findingA;
    expect(run("UPDATE findings SET validity = 'stale' WHERE id = ?", id)).toThrow(/stays stale, and says why/);
    expect(run("UPDATE findings SET validity = 'stale', stale_reason = '  ' WHERE id = ?", id)).toThrow(/stays stale, and says why/);
    expect(run("UPDATE findings SET stale_reason = 'because' WHERE id = ?", id)).toThrow(/stays stale, and says why/);
    expect(run("UPDATE findings SET validity = 'stale', stale_reason = 'document_changed' WHERE id = ?", id)).not.toThrow();
    expect(run("UPDATE findings SET validity = 'current', stale_reason = NULL WHERE id = ?", id)).toThrow(/stays stale/);
    expect(run("UPDATE findings SET validity = 'current' WHERE id = ?", id)).toThrow(/stays stale/);
    expect(run("UPDATE findings SET stale_reason = 'another reason' WHERE id = ?", id)).toThrow(/stays stale/);
    expect(q<{ validity: string }>("SELECT validity FROM findings WHERE id = ?", id).validity).toBe("stale");
  });
});

describe("finding evidence and checks", () => {
  const evidence = (over: Record<string, SQLInputValue>, verb = "INSERT") => clone("finding_evidence", "id", ids.evidenceA, { id: "evd_new", ...over }, verb);

  it("is never replaced", () => {
    expect(evidence({ id: ids.evidenceA, quote: "x" }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(clone("finding_evidence", "id", ids.evidenceA, { quote: "x" }, "INSERT", "ON CONFLICT(id) DO UPDATE SET quote = excluded.quote")).toThrow(/never replaced/);
  });

  it("may cite only spans of the run's manifest, in the finding's own matter", () => {
    expect(evidence({ span_id: ids.spanB })).toThrow(/span in the run manifest/);
    expect(evidence({ span_id: `${ids.nonOperative}:p0` })).toThrow(/span in the run manifest/);
    expect(evidence({ span_id: "ver_none:p0" })).toThrow(/span in the run manifest/);
    expect(evidence({ span_id: ids.a.m.nda.spanIds[3] as string })).not.toThrow();
  });

  it("cannot be updated", () => {
    for (const [column, value] of [["quote", "x"], ["role", "supporting"], ["span_id", ids.a.m.nda.spanIds[3] as string], ["quote_check", "not_found"], ["support_check", "not_run"], ["start_offset", 1], ["ordinal", 9]] as const)
      expect(run(`UPDATE finding_evidence SET ${column} = ? WHERE id = ?`, value, ids.evidenceA), column).toThrow(/immutable/);
  });

  it("keeps its check results unreplaced and unedited", () => {
    const check = q<{ check_id: string }>("SELECT check_id FROM verification_results WHERE finding_id = ?", ids.findingA);
    expect(clone("verification_results", "finding_id", ids.findingA, { detail: "changed" }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(run("UPDATE verification_results SET outcome = 'fail' WHERE finding_id = ?", ids.findingA)).toThrow(/immutable/);
    expect(run("UPDATE verification_results SET detail = 'x' WHERE check_id = ?", check.check_id)).toThrow(/immutable/);
  });
});

describe("reviews", () => {
  const review = (over: Record<string, SQLInputValue>, verb = "INSERT", suffix = "") => clone("reviews", "id", ids.reviewA, { id: "rev_new", ...over }, verb, suffix);

  it("are never replaced", () => {
    expect(review({ id: ids.reviewA, decision: "reject" }, "INSERT OR REPLACE")).toThrow(/never replaced/);
    expect(review({ id: ids.reviewA }, "INSERT", "ON CONFLICT(id) DO UPDATE SET decision = 'reject'")).toThrow(/never replaced/);
    expect(q<{ decision: string }>("SELECT decision FROM reviews WHERE id = ?", ids.reviewA).decision).toBe("accept");
  });

  it("belong to the matter of their finding, and supersede only a decision on the same finding", () => {
    expect(review({ matter_id: ids.b.m.id })).toThrow(/matter of its finding/);
    expect(review({ finding_id: ids.findingB })).toThrow(/matter of its finding/);
    expect(review({ supersedes_review_id: ids.reviewA2 })).toThrow(/matter of its finding/);
  });

  it("start current, and only one is current per finding", () => {
    expect(review({ validity: "stale" })).toThrow(/created current/);
    expect(review({})).toThrow(/UNIQUE constraint failed/);
    w.db.prepare("UPDATE reviews SET validity = 'stale' WHERE id = ?").run(ids.reviewA);
    expect(review({ validity: "current" })).not.toThrow();
  });

  const alternatives: Record<string, SQLInputValue> = {
    id: "rev_zzz",
    finding_id: "fnd_other",
    matter_id: "mat_ffffffffffffffff",
    reviewer_id: ACTORS.associate,
    decision: "reject",
    edited_json: '{"status":"deviation"}',
    reason: "changed",
    finding_content_sha256: "0".repeat(64),
    supersedes_review_id: "rev_other",
    created_at: "2000-01-01T00:00:00.000Z",
  };
  for (const [column, value] of Object.entries(alternatives))
    it(`never change ${column}`, () => {
      expect(run(`UPDATE reviews SET ${column} = ? WHERE id = ?`, value, ids.reviewA)).toThrow(/immutable except for validity/);
    });

  it("may only go from current to stale, never back", () => {
    expect(run("UPDATE reviews SET validity = 'stale' WHERE id = ?", ids.reviewA)).not.toThrow();
    expect(run("UPDATE reviews SET validity = 'current' WHERE id = ?", ids.reviewA)).toThrow(/stale review stays stale/);
    expect(run("UPDATE OR REPLACE reviews SET validity = 'current' WHERE id = ?", ids.reviewA)).toThrow(/stale review stays stale/);
  });
});

describe("memos", () => {
  const memo = (over: Record<string, SQLInputValue>, verb = "INSERT") => clone("memos", "id", ids.memoA, { id: "memo_new", ...over }, verb);

  it("are never replaced", () => {
    expect(memo({ id: ids.memoA, file_sha256: "f".repeat(64) }, "INSERT OR REPLACE")).toThrow(/never replaced/);
  });

  it("belong to the matter of their run and keep their file in its folder", () => {
    expect(memo({ status: "superseded", run_id: ids.b.run.id })).toThrow(/matter of its run/);
    expect(memo({ status: "superseded", storage_path: fakePath(ids.b.m.id) })).toThrow(/matter of its run/);
    expect(memo({ status: "superseded" })).not.toThrow();
  });

  it("has one current memo per matter", () => {
    expect(memo({})).toThrow(/UNIQUE constraint failed/);
  });

  const alternatives: Record<string, SQLInputValue> = {
    id: "memo_zzz",
    matter_id: "mat_ffffffffffffffff",
    run_id: "run_other",
    review_ids_json: "[]",
    file_sha256: "0".repeat(64),
    storage_path: "x/y",
    exported_by: ACTORS.associate,
    exported_at: "2000-01-01T00:00:00.000Z",
  };
  for (const [column, value] of Object.entries(alternatives))
    it(`never change ${column}`, () => {
      expect(run(`UPDATE memos SET ${column} = ? WHERE id = ?`, value, ids.memoA)).toThrow(/immutable except for being superseded/);
    });

  it("may be superseded, and then stay superseded", () => {
    expect(run("UPDATE memos SET status = 'superseded' WHERE id = ?", ids.memoA)).not.toThrow();
    expect(run("UPDATE memos SET status = 'current' WHERE id = ?", ids.memoA)).toThrow(/immutable except for being superseded/);
  });
});

describe("feedback and evaluation results", () => {
  it("feedback may refer only to its own matter's run and finding", () => {
    const feedback = (over: Record<string, SQLInputValue>) => clone("feedback", "id", ids.feedback.id, { id: "fbk_new", ...over });
    expect(feedback({ run_id: ids.otherFeedbackRun })).toThrow(/own matter/);
    expect(feedback({ finding_id: ids.findingB })).toThrow(/own matter/);
    expect(feedback({ run_id: ids.a.run.id, finding_id: ids.findingA })).not.toThrow();
  });

  it("evaluation results come from synthetic matters only", () => {
    const dataset = w.repo.createEvalDataset({ label: "set", devSha256: "a".repeat(64), heldoutSha256: "b".repeat(64) });
    const evalRun = w.repo.createEvalRun(
      { datasetId: dataset.id, split: "dev", workflowVersionId: w.workflow.id, playbookVersionId: w.playbook.id, model: "m", repeats: 1, priceTableSha256: "c".repeat(64), resultsPath: "r.json" },
      { actorId: ACTORS.legalEngineer },
    );
    const slot = (runId: string) =>
      run(
        "INSERT INTO eval_slot_results (eval_run_id, case_key, rule_key, repeat, run_id, expected_status, got_status, scores_json) VALUES (?, 'C1', 'dur-1', 0, ?, 'compliant', 'compliant', '{}')",
        evalRun.id,
        runId,
      );
    expect(slot(ids.nonSyntheticRun.id)).toThrow(/synthetic matters only/);
    expect(slot(ids.a.run.id)).not.toThrow();
  });
});

describe("the protections do not depend on the connection's settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-triggers-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a plain connection, with recursive triggers off, is still refused INSERT OR REPLACE", () => {
    const file = join(dir, "p.db");
    const owner = openDatabase(file);
    owner.close();
    const raw = new DatabaseSync(file);
    runMigrations(raw);
    expect((raw.prepare("PRAGMA recursive_triggers").get() as { recursive_triggers: number }).recursive_triggers).toBe(0);
    expect((raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);
    raw.exec("INSERT INTO users (id, display_name, global_role, demo) VALUES ('u', 'U', 'admin', 1)");
    raw.exec("INSERT INTO prompt_versions (id, stage, template, schema_json, sha256, created_at) VALUES ('p.p1', 'analyze', 't', '{}', '" + "a".repeat(64) + "', 'now')");
    expect(() => raw.exec("INSERT OR REPLACE INTO prompt_versions (id, stage, template, schema_json, sha256, created_at) VALUES ('p.p1', 'analyze', 'CHANGED', '{}', '" + "b".repeat(64) + "', 'now')")).toThrow(/immutable/);
    raw.exec("INSERT INTO audit_events (at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES ('t', NULL, NULL, 'a.b', 'x', 'y', '{}', '" + "0".repeat(64) + "', '" + "9".repeat(64) + "')");
    expect(() => raw.exec("INSERT OR REPLACE INTO audit_events (seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES (1, 't', NULL, NULL, 'a.b', 'x', 'y', '{\"forged\":1}', '" + "9".repeat(64) + "', 'f')")).toThrow(/append-only/);
    expect(count("prompt_versions")).toBeDefined();
    raw.close();
  });

  it("with the guard triggers gone, recursive triggers make the delete half of a replace fail", () => {
    w.db.exec("DROP TRIGGER audit_events_no_replace");
    w.db.exec("DROP TRIGGER audit_events_linked");
    const first = q<{ seq: number; prev_hash: string; hash: string }>("SELECT * FROM audit_events WHERE seq = 1");
    expect(run("INSERT OR REPLACE INTO audit_events (seq, at, actor_id, matter_id, action, target_type, target_id, detail_json, prev_hash, hash) VALUES (1, 't', NULL, NULL, 'a.b', 'x', 'y', '{}', ?, 'f')", first.prev_hash)).toThrow(/append-only/);
    expect(count("audit_events", "seq = 1")).toBe(1);
  });
});
