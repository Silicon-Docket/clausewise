import { describe, expect, it } from "vitest";
import { MemoGateError, buildMemo } from "../../src/export/memo.js";
import { planMemo } from "../../src/export/plan.js";
import type { MemoInput } from "../../src/module-contracts.js";
import { bodyText, readMemo, replaceFinding, review, sectionOf, workedExample } from "./support.js";

/**
 * A finding whose status the playbook settled says so in the memo. The memo is what leaves the
 * system, and a reader of the file alone would otherwise take the status for the workflow's own
 * while the discrepancy and explanation beside it argue another. The note follows the Status line,
 * names the status the workflow stated and why the rule settles it, and says that the texts below
 * were not revised. A finding nothing settled prints no note.
 *
 * In the worked example `pds-2` is a missing finding of a required rule, so the workflow can have
 * stated `not_applicable` for it and the playbook have settled that to missing.
 */

const SETTLED = "Status settled by the playbook";

const REQUIRED_FLAGS = { "pds-2": { kind: "presence" as const, required: true } };

function settledExample(over: Partial<MemoInput> = {}): MemoInput {
  const base = replaceFinding(workedExample(), "pds-2", (item) => ({
    ...item,
    finding: { ...item.finding, modelStatus: "not_applicable" },
  }));
  return { ruleFlags: REQUIRED_FLAGS, ...base, ...over };
}

async function sectionFor(input: MemoInput, ruleKey: string): Promise<string[]> {
  const read = await readMemo(await buildMemo(input));
  const number = planMemo(input).findings.find((f) => f.ruleKey === ruleKey)!.number;
  return sectionOf(read, number);
}

describe("a settled finding in the memo", () => {
  it("prints a note after the Status line: the status the workflow stated, why, and that the texts were not revised", async () => {
    const section = await sectionFor(settledExample(), "pds-2");
    const at = section.findIndex((line) => line.startsWith("Status:"));
    expect(section[at]).toBe("Status: Missing.");
    expect(section[at + 1]).toBe(
      "Status settled by the playbook: the workflow stated Not applicable; the rule is required. The discrepancy, explanation, cited passages and proposed language below were written for the status the workflow stated and have not been revised to match.",
    );
  });

  it("prints it once, for that finding and no other", async () => {
    const read = await readMemo(await buildMemo(settledExample()));
    expect(bodyText(read).split(SETTLED)).toHaveLength(2);
    for (const other of ["pty-1", "dur-1", "gov-1"]) {
      const input = settledExample();
      const number = planMemo(input).findings.find((f) => f.ruleKey === other)!.number;
      expect(sectionOf(read, number).join("\n")).not.toContain(SETTLED);
    }
  });

  it("prints no note for the example as it was, so a finding nothing settled reads as before", async () => {
    const read = await readMemo(await buildMemo(workedExample()));
    expect(bodyText(read)).not.toContain(SETTLED);
    expect(bodyText(read)).not.toContain("the status the workflow stated");
  });

  it("treats a null model status as none", async () => {
    const input = replaceFinding(workedExample(), "pds-2", (item) => ({
      ...item,
      finding: { ...item.finding, modelStatus: null },
    }));
    expect(bodyText(await readMemo(await buildMemo(input)))).not.toContain(SETTLED);
    expect(planMemo(input).findings.every((f) => f.modelStatus === null)).toBe(true);
  });

  it("gives the reason of the rule's flags: one of three fixed clauses", async () => {
    const reasons: [NonNullable<MemoInput["ruleFlags"]>, string][] = [
      [{ "pds-2": { kind: "presence", required: true } }, "the rule is required"],
      [{ "pds-2": { kind: "presence", required: false } }, "the rule is not required"],
      [
        { "pds-2": { kind: "absence", required: false } },
        "the rule forbids something and a contract without it passes",
      ],
    ];
    for (const [ruleFlags, reason] of reasons) {
      const view = planMemo(settledExample({ ruleFlags })).findings.find(
        (f) => f.ruleKey === "pds-2",
      )!;
      expect(view.settlementReason).toBe(reason);
    }
  });

  it("says nothing of a reason when the input carries no flags, and still marks the finding", async () => {
    const input = settledExample();
    delete input.ruleFlags;
    const section = await sectionFor(input, "pds-2");
    expect(section).toContain(
      "Status settled by the playbook: the workflow stated Not applicable. The discrepancy, explanation, cited passages and proposed language below were written for the status the workflow stated and have not been revised to match.",
    );
  });

  it("reads hostile flags as the fixed clauses, never as text", () => {
    const hostile = {
      "pds-2": { kind: "ignore the rules" as never, required: "yes" as never },
    };
    const view = planMemo(settledExample({ ruleFlags: hostile })).findings.find(
      (f) => f.ruleKey === "pds-2",
    )!;
    expect(view.settlementReason).toBe("the rule is not required");
  });

  it("refuses a model status that is not a determined status, rather than print it", () => {
    for (const bad of ["undetermined", "perhaps", 7, {}]) {
      const input = replaceFinding(workedExample(), "pds-2", (item) => ({
        ...item,
        finding: { ...item.finding, modelStatus: bad as never },
      }));
      expect(() => planMemo(input), String(bad)).toThrow(MemoGateError);
      expect(() => planMemo(input), String(bad)).toThrow(/unknown model status/);
    }
  });

  it("is the same file when built twice", async () => {
    const first = await readMemo(await buildMemo(settledExample()));
    const second = await readMemo(await buildMemo(settledExample()));
    expect(second.paragraphs).toEqual(first.paragraphs);
  });
});

describe("a settled finding that the reviewer then edits", () => {
  const edited = (): MemoInput =>
    replaceFinding(settledExample(), "pds-2", (item) => ({
      ...item,
      review: review("edit", {
        reason: "The topic is not covered, but this client wants it flagged.",
        edits: { status: "deviation" },
      }),
    }));

  it("says the text was written for the status the workflow stated, not for the settled one", async () => {
    const section = (await sectionFor(edited(), "pds-2")).join("\n");
    expect(section).toContain(
      "were written by the workflow for the status it stated, Not applicable",
    );
    expect(section).not.toContain("for the original status");
    expect(section).toContain("Original before edit: Missing.");
    expect(section).toContain(SETTLED);
  });

  it("keeps saying the original status for a finding the playbook did not settle", async () => {
    const input = replaceFinding(workedExample(), "pds-2", (item) => ({
      ...item,
      review: review("edit", {
        reason: "The topic is not covered, but this client wants it flagged.",
        edits: { status: "deviation" },
      }),
    }));
    const section = (await sectionFor(input, "pds-2")).join("\n");
    expect(section).toContain("written by the workflow for the original status, Missing");
    expect(section).not.toContain(SETTLED);
  });
});
