import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import {
  CATEGORY_IDS,
  DOCUMENT_KINDS,
  ESCALATION_CODES,
  EVIDENCE_ROLES,
  FALLBACK_BASES,
  GLOBAL_ROLES,
  MATTER_ROLES,
  MATTER_STATUSES,
  REVIEW_DECISIONS,
  RUN_STATUSES,
  STATUSES,
  WARNING_CODES,
} from "../../src/contracts.js";
import {
  CATEGORY_LABEL,
  CHECK_IDS,
  CHECK_LABEL,
  CHECK_OUTCOME_LABEL,
  DECISION_HINT,
  DECISION_LABEL,
  DECISION_VERB,
  DOCUMENT_KIND_LABEL,
  ESCALATION_LABEL,
  ESCALATION_MEANING,
  FALLBACK_BASIS_LABEL,
  GLOBAL_ROLE_LABEL,
  MATTER_ROLE_LABEL,
  MATTER_STATUS_LABEL,
  MATTER_STATUS_MEANING,
  PROGRESS_STAGE_LABEL,
  QUOTE_CHECK_LABEL,
  QUOTE_CHECK_MEANING,
  ROLE_LABEL,
  ROLE_MEANING,
  ROLE_ORDER,
  RUN_STATUS_LABEL,
  RUN_STATUS_MEANING,
  SEVERITY_LABEL,
  STATUS_LABEL,
  STATUS_MEANING,
  STATUS_ORDER,
  SUPPORT_CHECK_LABEL,
  SUPPORT_CHECK_MEANING,
  WARNING_LABEL,
  WARNING_MEANING,
  categoryLabel,
  checkLabel,
  escalationLabel,
  escalationMeaning,
  isActiveRun,
  roleLabel,
  runErrorMeaning,
  runStatusLabel,
  statusLabel,
} from "../../src/server/views/labels.js";

const QUOTE_CHECKS = ["verified", "not_found", "ambiguous"] as const;
const SUPPORT_CHECKS = ["supported", "not_supported", "insufficient", "not_run"] as const;
const CHECK_OUTCOMES = ["pass", "fail", "not_applicable"] as const;
const PROGRESS_STAGES = ["ingest", "extract", "retrieve", "analyze", "verify"] as const;

/** Every member of a vocabulary has a label that is a real phrase. */
function expectComplete(
  name: string,
  vocabulary: readonly string[],
  table: Readonly<Record<string, string>>,
): void {
  it(`${name}: every member has a label, and the table has nothing extra`, () => {
    expect(Object.keys(table).sort()).toEqual([...vocabulary].sort());
    for (const member of vocabulary) {
      const label = table[member];
      expect(typeof label).toBe("string");
      expect(label?.trim().length ?? 0).toBeGreaterThan(1);
      // A label is words, not the code in another case.
      expect(label).not.toBe(member);
      expect(label).not.toMatch(/_/);
    }
  });
}

describe("every vocabulary in contracts.ts has plain words", () => {
  expectComplete("statuses", STATUSES, STATUS_LABEL);
  expectComplete("status meanings", STATUSES, STATUS_MEANING);
  expectComplete("severities", SEVERITIES, SEVERITY_LABEL);
  expectComplete("categories", CATEGORY_IDS, CATEGORY_LABEL);
  expectComplete("evidence roles", EVIDENCE_ROLES, ROLE_LABEL);
  expectComplete("evidence role meanings", EVIDENCE_ROLES, ROLE_MEANING);
  expectComplete("escalation codes", ESCALATION_CODES, ESCALATION_LABEL);
  expectComplete("escalation meanings", ESCALATION_CODES, ESCALATION_MEANING);
  expectComplete("warning codes", WARNING_CODES, WARNING_LABEL);
  expectComplete("warning meanings", WARNING_CODES, WARNING_MEANING);
  expectComplete("run statuses", RUN_STATUSES, RUN_STATUS_LABEL);
  expectComplete("run status meanings", RUN_STATUSES, RUN_STATUS_MEANING);
  expectComplete("matter statuses", MATTER_STATUSES, MATTER_STATUS_LABEL);
  expectComplete("matter status meanings", MATTER_STATUSES, MATTER_STATUS_MEANING);
  expectComplete("quote checks", QUOTE_CHECKS, QUOTE_CHECK_LABEL);
  expectComplete("quote check meanings", QUOTE_CHECKS, QUOTE_CHECK_MEANING);
  expectComplete("support checks", SUPPORT_CHECKS, SUPPORT_CHECK_LABEL);
  expectComplete("support check meanings", SUPPORT_CHECKS, SUPPORT_CHECK_MEANING);
  expectComplete("review decisions", REVIEW_DECISIONS, DECISION_LABEL);
  expectComplete("review decision verbs", REVIEW_DECISIONS, DECISION_VERB);
  expectComplete("review decision hints", REVIEW_DECISIONS, DECISION_HINT);
  expectComplete("fallback bases", FALLBACK_BASES, FALLBACK_BASIS_LABEL);
  expectComplete("document kinds", DOCUMENT_KINDS, DOCUMENT_KIND_LABEL);
  expectComplete("matter roles", MATTER_ROLES, MATTER_ROLE_LABEL);
  expectComplete("global roles", GLOBAL_ROLES, GLOBAL_ROLE_LABEL);
  expectComplete("check outcomes", CHECK_OUTCOMES, CHECK_OUTCOME_LABEL);
  expectComplete("progress stages", PROGRESS_STAGES, PROGRESS_STAGE_LABEL);
});

describe("check ids", () => {
  it("covers every check the verify stage can record", () => {
    // contracts.ts does not list check ids, so read them where they are defined. A check added to
    // verify without a label here fails this test instead of reaching a page as a bare code.
    const source = readFileSync(join(import.meta.dirname, "../../src/stages/verify.ts"), "utf8");
    const block = /const CHECK_ORDER = \[([\s\S]*?)\] as const/.exec(source);
    expect(block, "CHECK_ORDER should still be defined in verify.ts").not.toBeNull();
    const ids = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(CHECK_IDS, `check ${id} needs a label`).toContain(id);
    expect([...CHECK_IDS].sort()).toEqual([...ids].sort());
  });

  it("labels are plain phrases", () => {
    for (const id of CHECK_IDS) {
      expect(CHECK_LABEL[id]).not.toMatch(/_/);
      expect(CHECK_LABEL[id].length).toBeGreaterThan(10);
    }
  });
});

describe("lookups for values from the database", () => {
  it("give a fixed phrase for an unknown code and never repeat it", () => {
    const hostile = "<script>alert(1)</script>";
    expect(statusLabel(hostile)).toBe("Unknown status");
    expect(escalationLabel(hostile)).not.toContain("script");
    expect(escalationMeaning(hostile)).not.toContain("script");
    expect(checkLabel(hostile)).toBe("Another check");
    expect(roleLabel(hostile)).not.toContain("script");
    expect(runErrorMeaning(hostile)).not.toContain("script");
    expect(categoryLabel(hostile)).not.toContain("script");
  });

  it("do not read prototype properties", () => {
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(statusLabel(key)).toBe("Unknown status");
      expect(runStatusLabel(key)).toBe("Unknown");
      expect(escalationLabel(key)).toBe("Flag with no wording");
    }
  });

  it("handle values that are not strings", () => {
    expect(statusLabel(undefined)).toBe("Unknown status");
    expect(statusLabel(null)).toBe("Unknown status");
    expect(statusLabel(7)).toBe("Unknown status");
    expect(statusLabel({})).toBe("Unknown status");
  });

  it("tell active runs from finished ones", () => {
    for (const status of RUN_STATUSES) {
      const finished = ["succeeded", "failed", "cancelled", "superseded"].includes(status);
      expect(isActiveRun(status), status).toBe(!finished);
    }
    expect(isActiveRun("constructor")).toBe(false);
    expect(isActiveRun(undefined)).toBe(false);
  });
});

describe("orderings", () => {
  it("list every status and role exactly once", () => {
    expect([...STATUS_ORDER].sort()).toEqual([...STATUSES].sort());
    expect([...ROLE_ORDER].sort()).toEqual([...EVIDENCE_ROLES].sort());
  });

  it("put findings that need action before findings that need none", () => {
    expect(STATUS_ORDER.indexOf("deviation")).toBeLessThan(STATUS_ORDER.indexOf("compliant"));
    expect(STATUS_ORDER.indexOf("missing")).toBeLessThan(STATUS_ORDER.indexOf("undetermined"));
    expect(STATUS_ORDER.indexOf("undetermined")).toBeLessThan(STATUS_ORDER.indexOf("compliant"));
    expect(ROLE_ORDER[0]).toBe("governing");
  });
});

describe("style", () => {
  it("uses no em dash or en dash in any label", () => {
    const tables = [
      STATUS_LABEL,
      STATUS_MEANING,
      ROLE_MEANING,
      ESCALATION_LABEL,
      ESCALATION_MEANING,
      WARNING_MEANING,
      RUN_STATUS_MEANING,
      MATTER_STATUS_MEANING,
      QUOTE_CHECK_MEANING,
      SUPPORT_CHECK_MEANING,
      CHECK_LABEL,
      FALLBACK_BASIS_LABEL,
      DECISION_HINT,
    ];
    for (const table of tables) {
      for (const value of Object.values(table)) expect(value).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
