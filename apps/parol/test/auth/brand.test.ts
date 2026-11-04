import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { findBrandForgeries } from "./brand-scan.js";

const SRC = join(import.meta.dirname, "..", "..", "src");
/** The declaration of the type, and the one function that makes it. */
const ALLOWED = new Set(["auth/types.ts", "auth/authorize.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("only authorizeMatter makes an AuthorizedMatter", () => {
  const files = sourceFiles(SRC).map((path) => ({
    path,
    name: relative(SRC, path).split("\\").join("/"),
  }));

  it("finds no cast, helper or look-alike object in any other file under src", () => {
    expect(files.length).toBeGreaterThan(20);
    const offences = files
      .filter((file) => !ALLOWED.has(file.name))
      .flatMap((file) =>
        findBrandForgeries(file.path, readFileSync(file.path, "utf8")).map(
          (finding) => `${file.name}:${finding.line} ${finding.rule}`,
        ),
      );
    expect(offences).toEqual([]);
  });

  it("does find the construction in authorize.ts, so the scan is not blind", () => {
    const path = join(SRC, "auth", "authorize.ts");
    const rules = findBrandForgeries(path, readFileSync(path, "utf8")).map((f) => f.rule);
    expect(rules).toContain("cast to AuthorizedMatter");
    expect(rules).toContain("object with the shape of an AuthorizedMatter");
  });

  it("is the only file that declares the brand symbol", () => {
    const declaring = files
      .filter((file) => /\bunique symbol\b/.test(readFileSync(file.path, "utf8")))
      .map((file) => file.name);
    expect(declaring).toEqual(["auth/types.ts"]);
  });

  describe("the scan itself", () => {
    const flagged: Record<string, string> = {
      "a cast": `const am = x as AuthorizedMatter;`,
      "a double cast": `const am = x as unknown as AuthorizedMatter;`,
      "an angle-bracket cast": `const am = <AuthorizedMatter>x;`,
      "a cast to a wrapper of it": `const am = x as Promise<AuthorizedMatter>;`,
      "a cast to a qualified name": `const am = x as auth.AuthorizedMatter;`,
      "a cast to an imported type": `const am = x as import("../auth/types.js").AuthorizedMatter;`,
      satisfies: `const am = x satisfies AuthorizedMatter;`,
      "a generic helper": `const am = brand<AuthorizedMatter>({ matterId });`,
      "an object literal in place": `const am: AuthorizedMatter = { matterId: "m", principal, role: "associate" } as any;`,
      "an object literal, no cast": `const am: AuthorizedMatter = { matterId: "m" };`,
      "data from JSON": `const am: AuthorizedMatter = JSON.parse(text);`,
      "the shape of one": `grant({ matterId, principal, role });`,
      "a property keyed by the brand": `const o = { [authorized]: true, matterId };`,
      "a second unique symbol": `declare const mine: unique symbol;`,
    };
    for (const [label, code] of Object.entries(flagged)) {
      it(`reports ${label}`, () => {
        expect(findBrandForgeries("x.ts", code).length, code).toBeGreaterThan(0);
      });
    }

    const clean: Record<string, string> = {
      "taking one as a parameter": `function f(am: AuthorizedMatter): string { return am.matterId; }`,
      "a promise of one": `async function f(): Promise<AuthorizedMatter> { return authorizeMatter(a, b, c, d); }`,
      "the sanctioned call, annotated": `const am: AuthorizedMatter = authorizeMatter(repo, p, id, "matter.read");`,
      "the delete call, awaited": `const am: AuthorizedMatter = await authorizeMatterDelete(repo, p, id);`,
      "a list of them": `const all: AuthorizedMatter[] = [];`,
      "a map of them": `const m = new Map<string, AuthorizedMatter>();`,
      "a comment about a cast": `// do not write x as AuthorizedMatter\nconst a = 1;`,
      "a string about a cast": `const s = "x as AuthorizedMatter";`,
      "an unrelated object": `const o = { matterId, name };`,
      "a cast to something else": `const a = x as MatterSummary;`,
    };
    for (const [label, code] of Object.entries(clean)) {
      it(`accepts ${label}`, () => {
        expect(findBrandForgeries("x.ts", code), code).toEqual([]);
      });
    }

    it("reads TSX files too", () => {
      const code = `export const A = () => { const am = x as AuthorizedMatter; return <p>{am.matterId}</p>; };`;
      expect(findBrandForgeries("x.tsx", code).length).toBeGreaterThan(0);
    });
  });
});
