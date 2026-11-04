import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SRC_ROOT,
  createParolProgram,
  findTypedBrandForgeries,
  type TypedBrandFinding,
} from "./brand-types.js";

/**
 * The scan in brand.test.ts reads the words `AuthorizedMatter`. These tests use the compiler, so
 * they also catch a forgery that never writes the word at the place it happens: an alias, a renamed
 * import, `ReturnType<typeof authorizeMatter>`, a spread, `Object.assign`, a value that is `any`,
 * and a generic helper. Each of those compiles, so the brand alone does not stop it.
 */

/** The declaration of the type, and the one function that makes it. */
const ALLOWED = new Set(["auth/types.ts", "auth/authorize.ts"]);
const SNIPPET_DIR = join(SRC_ROOT, "__snippets__");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** A file that imports the real modules and gives the snippet its inputs as parameters. */
const wrap = (body: string, imports = "", top = ""): string =>
  [
    `import type { AuthorizedMatter } from "../auth/types.js";`,
    `import { authorizeMatter } from "../auth/authorize.js";`,
    `import type { Repository } from "../store/index.js";`,
    `import type { Principal } from "../auth/types.js";`,
    imports,
    top,
    `declare function use(am: AuthorizedMatter): void;`,
    `export async function snippet(`,
    `  am: AuthorizedMatter, x: unknown, anyValue: any, other: string, repo: Repository,`,
    `  who: Principal, response: Response,`,
    `): Promise<void> {`,
    body,
    `}`,
  ].join("\n");

const FORGED: Record<string, string> = {
  "a cast through a type alias": wrap(`type AM = AuthorizedMatter; use(x as AM);`),
  "a cast through a renamed import": wrap(
    `use(x as Renamed);`,
    `import type { AuthorizedMatter as Renamed } from "../auth/types.js";`,
  ),
  "a cast to ReturnType of the maker": wrap(`use(x as ReturnType<typeof authorizeMatter>);`),
  "a cast to a Parameters element": wrap(`use(x as Parameters<typeof use>[0]);`),
  "a cast to a promise of one": wrap(`use(await (x as Promise<AuthorizedMatter>));`),
  "a cast to a record that holds one": wrap(
    `const held = x as { am: AuthorizedMatter }; use(held.am);`,
  ),
  "an angle-bracket cast through an alias": wrap(`type AM = AuthorizedMatter; use(<AM>x);`),
  "a spread of a real one with another matter id": wrap(`use({ ...am, matterId: other });`),
  "a spread that overrides the role": wrap(
    `const stronger = { ...am, role: "associate" as const }; use(stronger);`,
  ),
  "Object.assign over a real one": wrap(`use(Object.assign({}, am, { matterId: other }));`),
  "a function that returns any as one": wrap(
    `function f(v: any): AuthorizedMatter { return v; } use(f(1));`,
  ),
  "an arrow that returns any as one": wrap(`const f = (v: any): AuthorizedMatter => v; use(f(1));`),
  "a variable taken from a parsed body": wrap(
    `const am2: AuthorizedMatter = await response.json(); use(am2);`,
  ),
  "JSON.parse into a variable": wrap(`const am2: AuthorizedMatter = JSON.parse(other); use(am2);`),
  "an any value passed as an argument": wrap(`use(anyValue);`),
  "an any value assigned to a variable": wrap(`let am2 = am; am2 = anyValue; use(am2);`),
  "an any value in an object that holds one": wrap(
    `const held: { am: AuthorizedMatter } = { am: anyValue }; use(held.am);`,
  ),
  "an any value destructured into one": wrap(
    `const { am: am2 }: { am: AuthorizedMatter } = anyValue; use(am2);`,
  ),
  "a generic helper that returns its type argument": wrap(
    `function pick<T>(v: unknown): T { return v as T } const am2: AuthorizedMatter = pick({}); use(am2);`,
  ),
  "a generic helper with the type spelled out": wrap(
    `function pick<T>(v: unknown): T { return v as T } use(pick<AuthorizedMatter>(x));`,
  ),
  "structuredClone of untyped data": wrap(`use(structuredClone<AuthorizedMatter>(anyValue));`),
  "an object literal asserted to any": wrap(
    `use({ matterId: other, principal: who, role: "associate" } as any);`,
  ),
  "a declared constant": wrap(`use(forged);`, "", `declare const forged: AuthorizedMatter;`),
  "a declared function": wrap(`use(forge());`, "", `declare function forge(): AuthorizedMatter;`),
  "a definite assignment": wrap(`let am2!: AuthorizedMatter; use(am2);`),
};

const PASSED_ALONG: Record<string, string> = {
  "using the parameter": wrap(`use(am); const id: string = am.matterId; void id;`),
  "copying the reference": wrap(`const same = am; use(same);`),
  "destructuring the fields": wrap(`const { matterId, role } = am; void matterId; void role;`),
  "the sanctioned maker": wrap(`use(authorizeMatter(repo, who, other, "matter.read"));`),
  "a wrapper that says it returns one": wrap(
    `function g(): AuthorizedMatter { return authorizeMatter(repo, who, other, "matter.read"); } use(g());`,
  ),
  "a list of them": wrap(`const all: AuthorizedMatter[] = [am]; for (const a of all) use(a);`),
  "mapping a list of them": wrap(`for (const a of [am].map((v) => v)) use(a);`),
  "finding one in a list": wrap(
    `const found = [am].find((v) => v.matterId === other); if (found) use(found);`,
  ),
  "a map of them": wrap(
    `const m = new Map<string, AuthorizedMatter>(); m.set(other, am); const got = m.get(other); if (got) use(got);`,
  ),
  "an empty set of them": wrap(`const s = new Set<AuthorizedMatter>(); s.add(am);`),
  "Promise.resolve of one": wrap(`use(await Promise.resolve(am));`),
  "a generic helper given a real one": wrap(`function id<T>(v: T): T { return v } use(id(am));`),
  "a record that holds one": wrap(`const held = { am, runId: other }; use(held.am);`),
  "a spread of something else": wrap(`const copy = { ...who, displayName: other }; void copy;`),
  "an any value that goes elsewhere": wrap(
    `const n: number = anyValue; const o = JSON.parse(other); void n; void o;`,
  ),
  "a cast to something else": wrap(`const p = x as Principal; void p;`),
  "a const assertion": wrap(`const k = ["a", "b"] as const; void k;`),
  "a declared function that is not about the brand": wrap(
    `void fetchName();`,
    "",
    `declare function fetchName(): string;`,
  ),
};

describe("the type-aware scan", () => {
  const all: Record<string, string> = { ...FORGED, ...PASSED_ALONG };
  const keyed = Object.keys(all);
  const files = new Map<string, string>(
    keyed.map((label, index) => [join(SNIPPET_DIR, `case${index}.ts`), all[label]!] as const),
  );
  let found = new Map<string, TypedBrandFinding[]>();

  beforeAll(() => {
    const program = createParolProgram([...files.keys()], files);
    const byFile = new Map<string, TypedBrandFinding[]>();
    for (const finding of findTypedBrandForgeries(program, { allowed: ALLOWED }))
      byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
    found = byFile;
  }, 120_000);

  const findingsFor = (label: string): TypedBrandFinding[] => {
    const index = keyed.indexOf(label);
    return found.get(`__snippets__/case${index}.ts`) ?? [];
  };

  for (const label of Object.keys(FORGED))
    it(`reports ${label}`, () => {
      expect(findingsFor(label).length, FORGED[label]).toBeGreaterThan(0);
    });

  for (const label of Object.keys(PASSED_ALONG))
    it(`accepts ${label}`, () => {
      expect(findingsFor(label), PASSED_ALONG[label]).toEqual([]);
    });
});

describe("only authorizeMatter makes an AuthorizedMatter, as the compiler sees it", () => {
  it("finds no assertion, spread, untyped value or generic helper that makes one in src", () => {
    const roots = sourceFiles(SRC_ROOT);
    expect(roots.length).toBeGreaterThan(20);
    const program = createParolProgram(roots);
    const offences = findTypedBrandForgeries(program, { allowed: ALLOWED }).map(
      (f) => `${f.file}:${f.line} ${f.rule}`,
    );
    expect(offences).toEqual([]);
  }, 120_000);

  it("is not blind: it reports the construction inside authorize.ts when that file is not exempt", () => {
    const program = createParolProgram([join(SRC_ROOT, "auth", "authorize.ts")]);
    const findings = findTypedBrandForgeries(program, { allowed: new Set(["auth/types.ts"]) });
    expect(findings.map((f) => f.file)).toContain("auth/authorize.ts");
    expect(relative(SRC_ROOT, join(SRC_ROOT, "auth", "authorize.ts"))).toBe("auth/authorize.ts");
  }, 120_000);
});
