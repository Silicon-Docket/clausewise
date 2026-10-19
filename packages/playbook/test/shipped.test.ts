import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPlaybookFile } from "../src/node.js";

const root = join(import.meta.dirname, "..", "..", "..");

describe("shipped playbooks", () => {
  it("all parse and validate", async () => {
    const files = (await readdir(join(root, "playbooks"))).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      const pb = await loadPlaybookFile(join(root, "playbooks", file));
      expect(pb.rules.length).toBeGreaterThan(0);
    }
  });

  it("agree with the expected findings recorded for the fixtures", async () => {
    const { default: expected } = (await import("../../../fixtures/expected.json", {
      with: { type: "json" },
    })) as {
      default: Record<string, { playbook: string; rules: Record<string, string> }>;
    };
    for (const [file, entry] of Object.entries(expected)) {
      const pb = await loadPlaybookFile(join(root, entry.playbook));
      const ruleIds = pb.rules.map((r) => r.id).sort();
      expect(Object.keys(entry.rules).sort(), file).toEqual(ruleIds);
      for (const rule of pb.rules) {
        const status = entry.rules[rule.id];
        if (status === "missing") {
          expect(
            rule.required,
            `${file}: ${rule.id} is expected "missing" so must be required`,
          ).toBe(true);
        }
      }
    }
  });
});
