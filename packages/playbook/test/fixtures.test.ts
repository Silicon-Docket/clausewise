import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contracts } from "../../../fixtures/contracts.js";
import { parseDocx } from "../../docx/src/index.js";

const root = join(import.meta.dirname, "..", "..", "..");

describe("the fixture contracts", () => {
  it("record in expected.json exactly what contracts.ts says, so pnpm fixtures was run", async () => {
    const recorded = JSON.parse(await readFile(join(root, "fixtures", "expected.json"), "utf8"));
    const written = Object.fromEntries(
      contracts.map((c) => [c.file, { playbook: c.playbook, rules: c.expected }]),
    );
    expect(recorded).toEqual(written);
  });

  it("are the Word files in fixtures/, so pnpm fixtures was run after the last edit", async () => {
    for (const c of contracts) {
      const { paragraphs } = await parseDocx(
        new Uint8Array(await readFile(join(root, "fixtures", c.file))),
      );
      const body = paragraphs.filter((p) => !p.inTable && p.text !== "").map((p) => p.text);
      const written = [
        c.title,
        ...c.intro,
        ...c.sections.flatMap((s) => [s.heading, ...s.clauses]),
      ];
      expect(body, c.file).toEqual(written);
    }
  });

  it("type every clause number, which the review tests and the eval harness refer to", () => {
    for (const c of contracts) {
      const numbers: string[] = [];
      for (const [i, section] of c.sections.entries()) {
        expect(section.heading, c.file).toMatch(new RegExp(`^${i + 1}\\. \\S`));
        for (const clause of section.clauses) {
          const number = /^(\d+\.\d+) \S/.exec(clause)?.[1];
          expect(number, `${c.file}: ${clause.slice(0, 40)}`).toBeDefined();
          expect(number?.startsWith(`${i + 1}.`), `${c.file}: ${number}`).toBe(true);
          numbers.push(number ?? "");
        }
      }
      expect(new Set(numbers).size, `${c.file} repeats a clause number`).toBe(numbers.length);
    }
  });

  it("are written in plain ASCII, with no dash that is not a hyphen", () => {
    for (const c of contracts) {
      const text = JSON.stringify(c);
      expect(/[^\x20-\x7e]/.test(text), c.file).toBe(false);
    }
  });

  it("rest no finding on a lettered schedule that is not in the document", () => {
    for (const c of contracts) {
      const text = [...c.intro, ...c.sections.flatMap((s) => s.clauses)].join("\n");
      expect(text, c.file).not.toMatch(/\b(Schedule|Annex|Appendix|Exhibit) [A-Z0-9]\b/);
    }
  });
});
