import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Playbook } from "../src/index.js";
import { loadPlaybookFile } from "../src/node.js";

const root = join(import.meta.dirname, "..", "..", "..");

type Status = "compliant" | "deviation" | "missing" | "n/a";
const STATUSES: readonly Status[] = ["compliant", "deviation", "missing", "n/a"];

interface ExpectedFile {
  [fixture: string]: { playbook: string; rules: Record<string, Status> };
}

async function shipped(): Promise<Map<string, Playbook>> {
  const files = (await readdir(join(root, "playbooks"))).filter((f) => f.endsWith(".yaml")).sort();
  const playbooks = new Map<string, Playbook>();
  for (const file of files) {
    playbooks.set(`playbooks/${file}`, await loadPlaybookFile(join(root, "playbooks", file)));
  }
  return playbooks;
}

async function expectedFile(): Promise<ExpectedFile> {
  return JSON.parse(
    await readFile(join(root, "fixtures", "expected.json"), "utf8"),
  ) as ExpectedFile;
}

describe("shipped playbooks", () => {
  it("all parse and validate", async () => {
    const playbooks = await shipped();
    expect(playbooks.size).toBeGreaterThanOrEqual(2);
    for (const [path, pb] of playbooks) {
      expect(pb.rules.length, path).toBeGreaterThan(0);
    }
  });

  it("tell a reader of the contract who we are", async () => {
    for (const [path, pb] of await shipped()) {
      expect(pb.perspective, path).toMatch(/^We are the party [^.]+, usually called the [^.]+\./);
    }
  });

  it("are plain ASCII, so no dash or invisible character slips into a prompt", async () => {
    for (const file of await readdir(join(root, "playbooks"))) {
      const text = await readFile(join(root, "playbooks", file), "utf8");
      expect(/[^\n\x20-\x7e]/.test(text), file).toBe(false);
    }
  });

  it("make restrictive-covenants an absence rule, because the standard is that nothing appears", async () => {
    const nda = (await shipped()).get("playbooks/nda-mutual.yaml");
    const rule = nda?.rules.find((r) => r.id === "restrictive-covenants");
    expect(rule?.kind).toBe("absence");
    expect(rule?.required).toBe(false);
  });

  it("never describe a standard of 'contains no ...' as a presence rule", async () => {
    for (const [path, pb] of await shipped()) {
      for (const rule of pb.rules) {
        if (rule.kind === "absence") continue;
        expect(rule.standard, `${path}: ${rule.id}`).not.toMatch(
          /\b(contains|has|includes|gives|grants) no\b/i,
        );
      }
    }
  });

  it("never require an absence rule", async () => {
    for (const [path, pb] of await shipped()) {
      for (const rule of pb.rules) {
        if (rule.kind === "absence") expect(rule.required, `${path}: ${rule.id}`).toBe(false);
      }
    }
  });
});

describe("the expected findings recorded for the fixtures", () => {
  it("name an existing playbook and give every rule of it exactly one valid status", async () => {
    const playbooks = await shipped();
    for (const [file, entry] of Object.entries(await expectedFile())) {
      const pb = playbooks.get(entry.playbook);
      expect(pb, `${file}: ${entry.playbook} is not a shipped playbook`).toBeDefined();
      const ruleIds = (pb?.rules ?? []).map((r) => r.id).sort();
      expect(Object.keys(entry.rules).sort(), file).toEqual(ruleIds);
      for (const [id, status] of Object.entries(entry.rules)) {
        expect(STATUSES, `${file}: ${id}`).toContain(status);
      }
    }
  });

  it("expect missing only for a required presence rule", async () => {
    const playbooks = await shipped();
    for (const [file, entry] of Object.entries(await expectedFile())) {
      for (const rule of playbooks.get(entry.playbook)?.rules ?? []) {
        if (entry.rules[rule.id] !== "missing") continue;
        expect(rule.kind ?? "presence", `${file}: ${rule.id}`).toBe("presence");
        expect(rule.required, `${file}: ${rule.id} is expected "missing" so must be required`).toBe(
          true,
        );
      }
    }
  });

  it("expect n/a only for a presence rule that is not required", async () => {
    const playbooks = await shipped();
    for (const [file, entry] of Object.entries(await expectedFile())) {
      for (const rule of playbooks.get(entry.playbook)?.rules ?? []) {
        if (entry.rules[rule.id] !== "n/a") continue;
        expect(rule.kind ?? "presence", `${file}: ${rule.id}`).toBe("presence");
        expect(rule.required, `${file}: ${rule.id} is required, so absent would be missing`).toBe(
          false,
        );
      }
    }
  });

  it("never expect missing or n/a for an absence rule, which a contract without the clause passes", async () => {
    const playbooks = await shipped();
    let absenceRules = 0;
    for (const [file, entry] of Object.entries(await expectedFile())) {
      for (const rule of playbooks.get(entry.playbook)?.rules ?? []) {
        if (rule.kind !== "absence") continue;
        absenceRules += 1;
        expect(["compliant", "deviation"], `${file}: ${rule.id}`).toContain(entry.rules[rule.id]);
      }
    }
    expect(absenceRules).toBeGreaterThan(0);
  });

  it("expect compliant for an absence rule in the contract that has none of the forbidden terms", async () => {
    const balanced = (await expectedFile())["nda-balanced.docx"];
    expect(balanced?.rules["restrictive-covenants"]).toBe("compliant");
    expect(balanced?.rules["remedies"]).toBe("compliant");
  });

  it("cover every rule of every shipped playbook in at least one fixture", async () => {
    const entries = Object.values(await expectedFile());
    for (const [path, pb] of await shipped()) {
      for (const rule of pb.rules) {
        const covered = entries.some((e) => e.playbook === path && rule.id in e.rules);
        expect(covered, `${path}: ${rule.id} has no expected finding in any fixture`).toBe(true);
      }
    }
  });

  it("keep a mix of compliant, deviating, missing and not-applicable cases", async () => {
    const counts = new Map<string, number>();
    for (const entry of Object.values(await expectedFile())) {
      for (const status of Object.values(entry.rules)) {
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    }
    for (const status of STATUSES) expect(counts.get(status), status).toBeGreaterThan(0);
  });

  it("keep the balanced NDA mostly compliant", async () => {
    const rules = Object.values((await expectedFile())["nda-balanced.docx"]?.rules ?? {});
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter((status) => status === "compliant").length / rules.length).toBeGreaterThan(
      0.7,
    );
  });
});
