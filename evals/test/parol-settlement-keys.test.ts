import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlaybook } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import { STATUSES, type Status } from "../../apps/parol/src/contracts.js";
import { settleStatus } from "../../apps/parol/src/settlement.js";

/**
 * Status settlement changes a status only where the model's status disagrees with the playbook's
 * flags (apps/parol/src/settlement.ts). The evaluation scores the status verify returns, which is
 * the settled one, and no answer key changes. That is true only while no key states what
 * settlement would change: a required rule is never keyed or allowed `not_applicable`, and a rule
 * that is not required or that forbids something is never keyed or allowed `missing`. This test
 * reads the keys and the playbook and says so, so that a key written later that breaks it is a
 * conscious change and not a silent move of a score.
 *
 * It reads fixtures only. It runs no stage and calls no model; the oracle's selftest
 * (`pnpm eval:parol --selftest`, 112 of 112 and 96 of 96 under v1, v2 and v3) is what shows that
 * the scores did not move.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Key {
  status: Status;
  acceptable: Status[];
}
interface Keys {
  cases: { case: string; split: "dev" | "heldout"; expect: Record<string, Key> }[];
  twins: { case: string; twinOf: string }[];
}

const keys = JSON.parse(
  readFileSync(join(ROOT, "fixtures", "parol", "answer-keys.json"), "utf8"),
) as Keys;
const playbook = parsePlaybook(
  readFileSync(join(ROOT, "apps", "parol", "playbooks", "parol-nda-recipient.yaml"), "utf8"),
);

const flagsOf = (ruleKey: string) => {
  const rule = playbook.rules.find((r) => r.id === ruleKey);
  if (rule === undefined) throw new Error(`the playbook has no rule ${ruleKey}`);
  return { kind: rule.kind ?? "presence", required: rule.required };
};

/** Every slot the scorer judges: a case and a rule, with the statuses its key accepts. */
const slots = keys.cases.flatMap((c) =>
  Object.entries(c.expect).map(([ruleKey, key]) => ({
    where: `${c.case} ${ruleKey}`,
    split: c.split,
    ruleKey,
    accepted: [key.status, ...key.acceptable],
  })),
);

describe("the answer keys and the settlement of statuses", () => {
  it("cover the 208 slots of 26 cases that the scorer judges, 112 development and 96 held out", () => {
    expect(keys.cases).toHaveLength(26);
    expect(slots).toHaveLength(208);
    expect(slots.filter((s) => s.split === "dev")).toHaveLength(112);
    expect(slots.filter((s) => s.split === "heldout")).toHaveLength(96);
    // The injection twins are judged by their original's key and add no slot.
    expect(keys.twins.length).toBeGreaterThan(0);
    for (const slot of slots) expect(slot.accepted.every((s) => STATUSES.includes(s))).toBe(true);
  });

  it("have no required rule keyed or allowed not_applicable", () => {
    const offending = slots
      .filter((s) => flagsOf(s.ruleKey).required && s.accepted.includes("not_applicable"))
      .map((s) => s.where);
    expect(offending).toEqual([]);
  });

  it("have no rule that is not required, or that forbids something, keyed or allowed missing", () => {
    const offending = slots
      .filter((s) => {
        const flags = flagsOf(s.ruleKey);
        return (!flags.required || flags.kind === "absence") && s.accepted.includes("missing");
      })
      .map((s) => s.where);
    expect(offending).toEqual([]);
  });

  it("are left as they are by settlement: for every slot, every accepted status settles to itself", () => {
    let judged = 0;
    for (const slot of slots) {
      const flags = flagsOf(slot.ruleKey);
      for (const status of slot.accepted) {
        expect(
          settleStatus(
            { key: slot.ruleKey, title: "t", severity: "low", standard: "s", ...flags },
            status,
          ),
          `${slot.where} ${status}`,
        ).toBe(status);
        judged += 1;
      }
    }
    // 208 keyed statuses and the one acceptable alternative.
    expect(judged).toBe(209);
  });

  it("belong to a playbook with no rule that forbids something, so the absence branch changes nothing", () => {
    // A new absence rule is a conscious change: this assertion is where it is noticed.
    expect(playbook.rules.filter((r) => r.kind === "absence")).toEqual([]);
    expect(playbook.rules).toHaveLength(8);
    expect(playbook.rules.filter((r) => !r.required).map((r) => r.id)).toEqual(["ret-1"]);
  });

  it("would notice a key that settlement does change", () => {
    // The check above is not vacuous: a required rule keyed not_applicable, or ret-1 keyed
    // missing, is a status that settlement changes.
    expect(
      settleStatus(
        { key: "pty-1", title: "t", severity: "low", standard: "s", ...flagsOf("pty-1") },
        "not_applicable",
      ),
    ).toBe("missing");
    expect(
      settleStatus(
        { key: "ret-1", title: "t", severity: "low", standard: "s", ...flagsOf("ret-1") },
        "missing",
      ),
    ).toBe("not_applicable");
  });
});
