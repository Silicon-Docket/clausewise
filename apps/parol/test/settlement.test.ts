import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { settledStatus } from "@clausewise/review";
import { describe, expect, it } from "vitest";
import { STATUSES, type PlaybookRuleRecord, type Status } from "../src/contracts.js";
import { SETTLEMENT_VERSION, settleStatus, settlementReason } from "../src/settlement.js";
import { rule } from "./stages/support-verify.js";

const SRC = join(import.meta.dirname, "../src");

const KINDS = ["presence", "absence"] as const;
const REQUIRED = [true, false] as const;
const DETERMINED = STATUSES.filter(
  (s): s is Exclude<Status, "undetermined"> => s !== "undetermined",
);

describe("settleStatus", () => {
  it("equals settledStatus of the review package for every kind, flag and determined status", () => {
    let cases = 0;
    for (const kind of KINDS)
      for (const required of REQUIRED)
        for (const status of DETERMINED) {
          const r = rule({ kind, required });
          const expected = settledStatus(
            {
              id: r.key,
              title: r.title,
              severity: r.severity,
              kind,
              required,
              standard: r.standard,
            },
            status,
          );
          expect(settleStatus(r, status), `${kind} required=${required} ${status}`).toBe(expected);
          cases += 1;
        }
    expect(cases).toBe(16);
  });

  it("passes undetermined through, whatever the rule", () => {
    for (const kind of KINDS)
      for (const required of REQUIRED)
        expect(settleStatus(rule({ kind, required }), "undetermined")).toBe("undetermined");
  });

  it("is the table of the design, row by row", () => {
    const presenceRequired = rule({ kind: "presence", required: true });
    const presenceOptional = rule({ kind: "presence", required: false });
    const absence = rule({ kind: "absence", required: false });
    expect(settleStatus(presenceRequired, "not_applicable")).toBe("missing");
    expect(settleStatus(presenceRequired, "missing")).toBe("missing");
    expect(settleStatus(presenceOptional, "missing")).toBe("not_applicable");
    expect(settleStatus(presenceOptional, "not_applicable")).toBe("not_applicable");
    expect(settleStatus(absence, "missing")).toBe("compliant");
    expect(settleStatus(absence, "not_applicable")).toBe("compliant");
    for (const r of [presenceRequired, presenceOptional, absence]) {
      expect(settleStatus(r, "compliant")).toBe("compliant");
      expect(settleStatus(r, "deviation")).toBe("deviation");
    }
  });

  it("reads only the kind and the required flag of the rule", () => {
    const base = rule({ kind: "presence", required: false });
    const other = rule({
      kind: "presence",
      required: false,
      key: "zzz-9",
      title: "Another title",
      severity: "low",
      standard: "A different standard.",
    });
    for (const status of DETERMINED)
      expect(settleStatus(other, status)).toBe(settleStatus(base, status));
  });
});

describe("settlementReason", () => {
  const reasons = (flags: Pick<PlaybookRuleRecord, "kind" | "required">) => settlementReason(flags);

  it("is one of three fixed clauses, chosen by the flags", () => {
    expect(reasons({ kind: "presence", required: true })).toBe("the rule is required");
    expect(reasons({ kind: "presence", required: false })).toBe("the rule is not required");
    expect(reasons({ kind: "absence", required: false })).toBe(
      "the rule forbids something and a contract without it passes",
    );
    // A rule that forbids something is never required (the playbook format refuses it), but the
    // reason must not depend on a flag that cannot be set.
    expect(reasons({ kind: "absence", required: true })).toBe(
      reasons({ kind: "absence", required: false }),
    );
  });

  it("holds no dash, no digit and nothing a document could put there", () => {
    for (const kind of KINDS)
      for (const required of REQUIRED) expect(reasons({ kind, required })).toMatch(/^[a-z ]+$/);
  });
});

describe("the version of the rule", () => {
  it("is a short fixed marker that the verify input hash carries", () => {
    expect(SETTLEMENT_VERSION).toBe("s1");
    const runner = readFileSync(join(SRC, "services/runner.ts"), "utf8");
    expect(runner).toContain("settle: SETTLEMENT_VERSION");
  });
});

describe("no second copy of the rule", () => {
  /** Every .ts and .tsx file under src. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("settlement.ts takes the rule from the review package and src has no other expression of it", () => {
    const own = readFileSync(join(SRC, "settlement.ts"), "utf8");
    expect(own).toMatch(/import \{ settledStatus \} from "@clausewise\/review"/);
    expect(own).toContain("return settledStatus(");

    for (const path of sources(SRC)) {
      const where = relative(SRC, path);
      const text = readFileSync(path, "utf8");
      // The only other file that may name the review package's function is the one that wraps it.
      if (where !== "settlement.ts") expect(text, where).not.toContain("settledStatus");
      // A second copy would test a rule's flag against a status; the checks that read a status
      // beside a flag are named here so that a new one is a conscious change.
      const mentionsBoth =
        /status === "(?:missing|not_applicable)"[^\n]*\.required|\.required[^\n]*status === "(?:missing|not_applicable)"/.test(
          text,
        );
      expect(mentionsBoth, `${where} reads a status and the required flag in one expression`).toBe(
        false,
      );
    }
  });

  it("verify.ts is the one stage that calls it", () => {
    const callers = sources(SRC)
      .filter((path) => /\bsettleStatus\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path))
      .sort();
    expect(callers).toEqual(["settlement.ts", "stages/verify.ts", "store/repo-findings.ts"].sort());
  });
});
