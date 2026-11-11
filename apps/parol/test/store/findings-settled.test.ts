import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findingContentSha256, hashOf, sha256Hex } from "../../src/canonical.js";
import type { CheckResult, Escalation, VerifiedFinding } from "../../src/contracts.js";
import { createRepository, openDatabase, ValidationError } from "../../src/store/index.js";
import {
  ACTORS,
  PLAYBOOK_YAML,
  RULES,
  WORKFLOW_MANIFEST,
  addMatter,
  findingFor,
  makeClock,
  makeWorld,
  rehash,
  seedPrompts,
  startRun,
  type World,
} from "./fixtures.js";

/**
 * Settled statuses in the store. A finding may keep the status the workflow stated (`modelStatus`)
 * only when the rule's flags settle that status to the one the finding states (or a forcing flag
 * then made it undetermined); the store checks it against the stored rule, the content hash covers
 * it, a trigger keeps the column immutable, and the save is audited with a count.
 *
 * The three fixture rules are all required presence rules, so the model's `not_applicable` settles
 * to `missing` and nothing the model can say settles to `not_applicable`.
 */

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const span = (m: ReturnType<typeof addMatter>, i: number) => ({
  id: m.nda.spanIds[i] as string,
  text: m.nda.texts[i] as string,
});

const SETTLED_CHECK: CheckResult = {
  id: "status_settled",
  kind: "deterministic",
  outcome: "pass",
  detail:
    "the workflow stated not_applicable and the playbook settles it to missing: the rule is required",
};
const QUOTE_CHECK: CheckResult = {
  id: "quote_exists",
  kind: "deterministic",
  outcome: "pass",
  detail: "1 of 1 found",
};
const FORCING: Escalation = { code: "conflicting_sources", detail: "two passages disagree" };

/**
 * A finding the stages would produce for a required rule whose model answered not_applicable:
 * settled to missing, no evidence, the model's status kept, the settlement row in the trail.
 */
function settledFinding(
  m: ReturnType<typeof addMatter>,
  over: Partial<VerifiedFinding> = {},
): VerifiedFinding {
  return rehash({
    ...findingFor("pty-1", span(m, 1)),
    status: "missing",
    evidence: [],
    modelStatus: "not_applicable",
    checks: [QUOTE_CHECK, SETTLED_CHECK],
    ...over,
  });
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).code;
  }
  return undefined;
};

const modelStatusColumn = (ruleKey: string): unknown =>
  (
    w.db.prepare("SELECT model_status FROM findings WHERE rule_key = ?").get(ruleKey) as {
      model_status: unknown;
    }
  ).model_status;

describe("saveFindings: a settled finding", () => {
  it("is stored with the status the workflow stated, read back, and hashed with it", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const settled = settledFinding(m);
    const [saved] = w.repo.saveFindings(m.id, run.id, [settled]);

    expect(saved?.status).toBe("missing");
    expect(saved?.modelStatus).toBe("not_applicable");
    expect(modelStatusColumn("pty-1")).toBe("not_applicable");
    // The record carries what the hash covers, so export readiness recomputes the same hash.
    expect(findingContentSha256(saved as never)).toBe(saved?.contentSha256);
    expect(saved?.contentSha256).toBe(settled.contentSha256);
    expect(saved?.checks.map((c) => c.id)).toContain("status_settled");
  });

  it("gives a finding nothing settled a null model status", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const [saved] = w.repo.saveFindings(m.id, run.id, [findingFor("dur-1", span(m, 2))]);
    expect(saved?.modelStatus).toBeNull();
    expect(modelStatusColumn("dur-1")).toBeNull();
    // Null, absent and undefined are the same thing to the hash, so older findings keep theirs.
    expect(findingContentSha256(saved as never)).toBe(saved?.contentSha256);
  });

  it("accepts a settled status that a forcing flag then made undetermined, and keeps the model's", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const forced = settledFinding(m, {
      status: "undetermined",
      escalations: [FORCING],
      verificationState: "escalated_by_system",
      checks: [
        QUOTE_CHECK,
        SETTLED_CHECK,
        {
          id: "status_forced",
          kind: "deterministic",
          outcome: "fail",
          detail: "status missing was changed to undetermined because of conflicting_sources",
        },
      ],
    });
    const [saved] = w.repo.saveFindings(m.id, run.id, [forced]);
    expect(saved?.status).toBe("undetermined");
    expect(saved?.modelStatus).toBe("not_applicable");
  });

  it("is counted in the audit event of the save, with rule keys and counts only", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    w.repo.saveFindings(m.id, run.id, [
      settledFinding(m),
      findingFor("dur-1", span(m, 2)),
      findingFor("gov-1", span(m, 3)),
    ]);
    const event = w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })[0];
    expect(event?.detail).toEqual({
      saved: 3,
      skipped: 0,
      settled: 1,
      ruleKeys: ["pty-1", "dur-1", "gov-1"],
    });
  });

  it("is saved once: saving it again is a no-op and does not count it again", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const settled = settledFinding(m);
    const first = w.repo.saveFindings(m.id, run.id, [settled]);
    const again = w.repo.saveFindings(m.id, run.id, [settled]);
    expect(again.map((f) => f.id)).toEqual(first.map((f) => f.id));
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })).toHaveLength(1);
  });
});

describe("saveFindings: a finding that disagrees with its settlement is refused", () => {
  const refuse = (over: Partial<VerifiedFinding>): string | undefined => {
    const m = addMatter(w);
    const run = startRun(w, m);
    return code(() => w.repo.saveFindings(m.id, run.id, [settledFinding(m, over)]));
  };

  it("model_status_same: the model status is the status", () => {
    expect(refuse({ status: "not_applicable", modelStatus: "not_applicable" })).toBe(
      "model_status_same",
    );
  });

  it("model_status_not_settled: the rule does not change that status", () => {
    // A required rule answered missing stays missing; nothing settles it.
    expect(refuse({ status: "not_applicable", modelStatus: "missing" })).toBe(
      "model_status_not_settled",
    );
    // Neither does a compliant answer.
    expect(refuse({ status: "deviation", modelStatus: "compliant" })).toBe(
      "model_status_not_settled",
    );
  });

  it("model_status_mismatch: the status is not what the rule settles the model status to", () => {
    // The rule settles not_applicable to missing. A compliant finding is not that, and not undetermined.
    expect(refuse({ status: "compliant", modelStatus: "not_applicable" })).toBe(
      "model_status_mismatch",
    );
    expect(refuse({ status: "deviation", modelStatus: "not_applicable" })).toBe(
      "model_status_mismatch",
    );
  });

  it("model_status_mismatch: a status_settled row without a model status", () => {
    expect(refuse({ modelStatus: null })).toBe("model_status_mismatch");
    const m = addMatter(w);
    const run = startRun(w, m);
    // The member is absent altogether, as a finding built before settlement existed has it.
    const { modelStatus: _kept, ...withoutMember } = settledFinding(m);
    const noField = rehash(withoutMember);
    expect(code(() => w.repo.saveFindings(m.id, run.id, [noField]))).toBe("model_status_mismatch");
  });

  it("model_status_unexplained: a model status with no status_settled row", () => {
    expect(refuse({ checks: [QUOTE_CHECK] })).toBe("model_status_unexplained");
  });

  it("content_hash_mismatch: the hash does not cover the model status", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const settled = settledFinding(m);
    const hashedWithout = findingContentSha256({ ...settled, modelStatus: null });
    expect(hashedWithout).not.toBe(settled.contentSha256);
    expect(
      code(() => w.repo.saveFindings(m.id, run.id, [{ ...settled, contentSha256: hashedWithout }])),
    ).toBe("content_hash_mismatch");
  });

  it("an unknown model status never reaches the store", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    for (const bad of ["undetermined", "perhaps", ""]) {
      expect(() =>
        w.repo.saveFindings(m.id, run.id, [{ ...settledFinding(m), modelStatus: bad as never }]),
      ).toThrow();
    }
    expect(w.repo.listFindings(m.id, run.id)).toEqual([]);
  });

  it("refuses all of them without writing a row", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    expect(
      code(() =>
        w.repo.saveFindings(m.id, run.id, [
          findingFor("dur-1", span(m, 2)),
          settledFinding(m, { checks: [QUOTE_CHECK] }),
        ]),
      ),
    ).toBe("model_status_unexplained");
    expect(w.repo.listFindings(m.id, run.id)).toEqual([]);
    expect(w.repo.listAuditEvents({ matterId: m.id, action: "finding.save" })).toEqual([]);
  });
});

describe("the database keeps the model status", () => {
  /** Saves a settled finding and an ordinary one, and returns the ids. */
  function saved() {
    const m = addMatter(w);
    const run = startRun(w, m);
    const [a, b] = w.repo.saveFindings(m.id, run.id, [
      settledFinding(m),
      findingFor("dur-1", span(m, 2)),
    ]);
    return { m, run, settled: a?.id as string, plain: b?.id as string };
  }
  const update = (id: string, column: string, value: SQLInputValue) => () =>
    w.db.prepare(`UPDATE findings SET ${column} = ? WHERE id = ?`).run(value, id);

  it("never lets the column change: not to another status, not to null, not from null", () => {
    const { settled, plain } = saved();
    for (const value of ["missing", "compliant", null])
      expect(update(settled, "model_status", value)).toThrow(/finding content is immutable/);
    expect(update(plain, "model_status", "missing")).toThrow(/finding content is immutable/);
  });

  it("still lets a finding go stale, which is the one update a finding takes", () => {
    const { settled } = saved();
    expect(update(settled, "validity", "stale")).toThrow(/stays stale, and says why/);
    expect(() =>
      w.db
        .prepare(
          "UPDATE findings SET validity = 'stale', stale_reason = 'document_changed' WHERE id = ?",
        )
        .run(settled),
    ).not.toThrow();
    expect(modelStatusColumn("pty-1")).toBe("not_applicable");
  });

  it("refuses a model status equal to the status, and one that is not a determined status", () => {
    const m = addMatter(w);
    const run = startRun(w, m);
    const base = w.db.prepare("SELECT id FROM playbook_rules WHERE rule_key = 'pty-1'").get() as {
      id: string;
    };
    const insert = (status: string, modelStatus: string | null) => () =>
      w.db
        .prepare(
          `INSERT INTO findings
             (id, run_id, matter_id, playbook_rule_id, rule_key, category, severity, status, discrepancy,
              explanation, fallback_language, fallback_basis, escalations_json, verification_state,
              content_sha256, validity, stale_reason, conflict, abstain_reason, model_status)
           VALUES ('fnd_raw', ?, ?, ?, 'pty-1', 'parties', 'medium', ?, '', 'x', NULL, 'none', '[]',
                   'verified', ?, 'current', NULL, NULL, NULL, ?)`,
        )
        .run(run.id, m.id, base.id, status, sha256Hex("raw"), modelStatus);
    expect(insert("missing", "missing")).toThrow(/kept only when code changed the status/);
    expect(insert("missing", "undetermined")).toThrow(/CHECK constraint failed/);
    expect(insert("missing", "perhaps")).toThrow(/CHECK constraint failed/);
    expect(insert("missing", "not_applicable")).not.toThrow();
  });
});

describe("migration 004, settled part", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "parol-settled-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("upgrades a database made at version 3: its findings stay as they were, with no model status", () => {
    const old = join(dir, "migrations-to-3");
    mkdirSync(old);
    for (const name of ["001_init.sql", "002_integrity.sql", "003_ingest_warnings.sql"])
      copyFileSync(
        fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)),
        join(old, name),
      );
    const location = join(dir, "old.sqlite");

    // A database as the code before this migration left it: matter, run, and one finding row.
    const atThree = openDatabase(location, { migrationsDir: old });
    const clock = makeClock();
    const repo = createRepository(atThree, { now: clock.now });
    repo.seedDemoUsers();
    const playbook = repo.approvePlaybookVersion(
      repo.importPlaybookDraft(
        {
          slug: "test-playbook",
          version: "1.0.0",
          yaml: PLAYBOOK_YAML,
          sha256: sha256Hex(PLAYBOOK_YAML),
          rules: RULES,
        },
        { actorId: ACTORS.legalEngineer },
      ).id,
      { actorId: ACTORS.admin },
    );
    seedPrompts(repo);
    const workflow = repo.upsertWorkflowVersion({
      manifest: WORKFLOW_MANIFEST,
      sha256: hashOf(WORKFLOW_MANIFEST),
    });
    const world = { db: atThree, repo, clock, playbook, workflow } as unknown as World;
    const m = addMatter(world);
    const run = startRun(world, m);
    const rule = atThree
      .prepare("SELECT id FROM playbook_rules WHERE rule_key = 'dur-1'")
      .get() as {
      id: string;
    };
    // No evidence rows are written by hand, so the finding cites nothing.
    const original = findingFor("dur-1", span(m, 2), { status: "missing", evidence: [] });
    atThree
      .prepare(
        `INSERT INTO findings
           (id, run_id, matter_id, playbook_rule_id, rule_key, category, severity, status, discrepancy,
            explanation, fallback_language, fallback_basis, escalations_json, verification_state,
            content_sha256, validity, stale_reason, conflict, abstain_reason)
         VALUES ('fnd_old', ?, ?, ?, 'dur-1', 'duration', 'high', ?, '', ?, NULL, 'none', '[]',
                 'verified', ?, 'current', NULL, NULL, NULL)`,
      )
      .run(run.id, m.id, rule.id, original.status, original.explanation, original.contentSha256);
    atThree.close();

    // Opened by the current code: the new column and triggers are applied, the row is untouched.
    const upgraded = openDatabase(location);
    const columns = upgraded.prepare("PRAGMA table_info(findings)").all() as { name: string }[];
    expect(columns.map((c) => c.name)).toContain("model_status");
    const triggers = (
      upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(triggers).toContain("findings_model_status_differs");
    expect(triggers).toContain("findings_content_immutable");

    const after = createRepository(upgraded, { now: clock.now });
    const found = after.getFinding(m.id, "fnd_old");
    expect(found?.modelStatus).toBeNull();
    expect(found?.status).toBe("missing");
    // A finding stored before settlement existed still hashes to the hash it was stored with.
    expect(findingContentSha256(found as never)).toBe(original.contentSha256);
    expect(
      upgraded.prepare("SELECT model_status FROM findings WHERE id = 'fnd_old'").get(),
    ).toEqual({ model_status: null });
    // The replaced trigger still holds the content of the old row.
    expect(() =>
      upgraded.prepare("UPDATE findings SET explanation = 'edited' WHERE id = 'fnd_old'").run(),
    ).toThrow(/finding content is immutable/);
    expect(() =>
      upgraded.prepare("UPDATE findings SET model_status = 'missing' WHERE id = 'fnd_old'").run(),
    ).toThrow(/finding content is immutable/);
    upgraded.close();
  });

  it("replaces the content trigger under its own name, once", () => {
    const rows = w.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'findings'")
      .all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names.filter((n) => n === "findings_content_immutable")).toHaveLength(1);
    expect(names).toContain("findings_model_status_differs");
  });
});
