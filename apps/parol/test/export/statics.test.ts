import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as labels from "../../src/export/labels.js";
import { buildMemo } from "../../src/export/memo.js";
import { readMemo, workedExample } from "./support.js";

const exportDir = join(import.meta.dirname, "..", "..", "src", "export");
const sources = readdirSync(exportDir)
  .filter((name) => name.endsWith(".ts"))
  .map((name) => ({ name, text: readFileSync(join(exportDir, name), "utf8") }));

// Written as escapes so that this file holds no em dash or en dash itself.
const DASHES = new RegExp(
  "[" +
    ["2013", "2014", "2015", "2212"].map((hex) => String.fromCharCode(parseInt(hex, 16))).join("") +
    "]",
);

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) strings(item, out);
  }
  return out;
}

describe("what the memo says itself", () => {
  it("has files to check", () => {
    expect(sources.map((file) => file.name).sort()).toEqual(
      expect.arrayContaining([
        "dates.ts",
        "errors.ts",
        "labels.ts",
        "memo.ts",
        "package.ts",
        "plan.ts",
        "render.ts",
        "sanitize.ts",
      ]),
    );
  });

  it("has no em dash or en dash in any source file, comment or string", () => {
    for (const file of sources) expect(file.text, file.name).not.toMatch(DASHES);
  });

  it("has no em dash or en dash in a static string", () => {
    const all = strings(labels);
    expect(all.length).toBeGreaterThan(30);
    for (const text of all) expect(text).not.toMatch(DASHES);
  });

  it("has no em dash or en dash anywhere in a memo built from dash-free input", async () => {
    const read = await readMemo(await buildMemo(workedExample()));
    for (const [name, entry] of Object.entries(read.zip.files)) {
      if (entry.dir) continue;
      expect(await entry.async("string"), name).not.toMatch(DASHES);
    }
  });

  it("does not read the clock", () => {
    for (const file of sources) {
      expect(file.text, file.name).not.toMatch(
        /Date\.now\s*\(|new Date\s*\(\s*\)|performance\.now/,
      );
    }
  });

  it("does not log", () => {
    for (const file of sources) {
      expect(file.text, file.name).not.toMatch(/console\.|process\.stdout|process\.stderr|logger/);
    }
  });

  it("does not use the file system or the network, because the caller stores the file", () => {
    for (const file of sources) {
      expect(file.text, file.name).not.toMatch(/node:fs|node:http|node:net|fetch\(|writeFile/);
    }
  });
});
