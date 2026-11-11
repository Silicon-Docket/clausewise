import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The pilot module is a pure computation. It stays testable with fixtures only if it reads nothing
 * but its own files and the types of the contracts, and asks nothing of the machine.
 */

const DIR = fileURLToPath(new URL("../../src/pilot/", import.meta.url));
const FILES = readdirSync(DIR)
  .filter((name) => name.endsWith(".ts"))
  .sort();

/** Every module specifier a file imports or re-exports, with whether the statement is type-only. */
export function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  const statement = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/gu;
  for (const m of source.matchAll(statement)) {
    out.push({ specifier: m[4] ?? "", typeOnly: m[2] !== undefined });
  }
  const bare = /(?:^|\n)\s*import\s*["']([^"']+)["']/gu;
  for (const m of source.matchAll(bare)) out.push({ specifier: m[1] ?? "", typeOnly: false });
  const dynamic = /\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu;
  for (const m of source.matchAll(dynamic)) out.push({ specifier: m[1] ?? "", typeOnly: false });
  return out;
}

describe("src/pilot is pure", () => {
  it("holds the seven files of the slice, and no others", () => {
    expect(FILES).toEqual([
      "calendar.ts",
      "compute.ts",
      "csv.ts",
      "index.ts",
      "phrases.ts",
      "types.ts",
      "views.ts",
    ]);
  });

  it("imports only its own files and the types of the contracts", () => {
    for (const file of FILES) {
      const source = readFileSync(join(DIR, file), "utf8");
      for (const { specifier, typeOnly } of importsOf(source)) {
        if (specifier.startsWith("./") && specifier.endsWith(".js")) continue;
        expect(specifier, `${file} imports ${specifier}`).toBe("../contracts.js");
        expect(typeOnly, `${file} imports ${specifier} as a value`).toBe(true);
      }
    }
  });

  it("asks nothing of the machine: no clock, no randomness, no file, no process, no network, no log", () => {
    const forbidden = [
      /\bDate\.now\s*\(/u,
      /\bnew Date\s*\(\s*\)/u,
      /\bMath\.random\s*\(/u,
      /\bprocess\./u,
      /\bperformance\./u,
      /\bfetch\s*\(/u,
      /\bconsole\./u,
      /\bsetTimeout\s*\(/u,
      /\bnode:/u,
      /\bfs\./u,
    ];
    for (const file of FILES) {
      const source = readFileSync(join(DIR, file), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
        .join("\n");
      for (const pattern of forbidden) {
        expect(pattern.test(source), `${file} matches ${String(pattern)}`).toBe(false);
      }
    }
  });

  it("holds no em dash and no en dash, in the module or in its tests", () => {
    const dashes = [String.fromCharCode(0x2013), String.fromCharCode(0x2014)];
    const tests = fileURLToPath(new URL("./", import.meta.url));
    for (const dir of [DIR, tests]) {
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
        const source = readFileSync(join(dir, name), "utf8");
        for (const dash of dashes) expect(source.includes(dash), name).toBe(false);
      }
    }
  });

  it("is not reached from the store: nothing under src/store imports it, but its types and one value", () => {
    const store = fileURLToPath(new URL("../../src/store/", import.meta.url));
    for (const name of readdirSync(store).filter((n) => n.endsWith(".ts"))) {
      const source = readFileSync(join(store, name), "utf8");
      for (const { specifier, typeOnly } of importsOf(source)) {
        if (specifier.includes("/pilot/")) {
          // Two places only: the record types, and the definition of a start date, which the store
          // takes from the calendar so that it cannot accept a date the measures then refuse.
          const startDateRule = name === "repo-pilot.ts" && specifier === "../pilot/calendar.js";
          expect(typeOnly || startDateRule, `${name} imports ${specifier} as a value`).toBe(true);
        }
      }
    }
  });

  it("is the only place a start date is defined: the store imports the rule and writes none of its own", () => {
    const store = readFileSync(
      fileURLToPath(new URL("../../src/store/repo-pilot.ts", import.meta.url)),
      "utf8",
    );
    expect(store).toMatch(/import \{ isUsableStartDate \} from "\.\.\/pilot\/calendar\.js";/u);
    expect(store).toContain("isUsableStartDate(value)");
    // The check that used to stand here, a round trip through Date, accepted years 0000 to 0099.
    expect(store).not.toMatch(/new Date\(`\$\{value\}/u);
  });

  it("finds an import of the store, of node and of a value from the contracts when one is planted", () => {
    const planted = [
      'import { createRepository } from "../store/index.js";',
      'import { readFileSync } from "node:fs";',
      'import { REASON_CODES } from "../contracts.js";',
      'export { x } from "hono";',
      'const later = await import("../store/db.js");',
    ].join("\n");
    const found = importsOf(planted).map((i) => `${i.specifier}:${i.typeOnly}`);
    expect(found).toEqual([
      "../store/index.js:false",
      "node:fs:false",
      "../contracts.js:false",
      "hono:false",
      "../store/db.js:false",
    ]);
  });
});
