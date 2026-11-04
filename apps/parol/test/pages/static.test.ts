import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Checks on the source files this module owns. Rendering tests only see the branches they reach;
 * these read the code, so a forbidden construct cannot hide in a state no test renders.
 */
const APP = join(import.meta.dirname, "../..");
const OWNED = ["src/server/views", "src/server/pages", "public", "test/pages"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const all = OWNED.flatMap((dir) => files(join(APP, dir)));
const read = (path: string): string => readFileSync(path, "utf8");
const rel = (path: string): string => relative(APP, path);
const pageSources = [
  ...files(join(APP, "src/server/pages")),
  ...files(join(APP, "src/server/views")),
];

describe("the files this module owns", () => {
  it("are found", () => {
    expect(all.length).toBeGreaterThan(25);
    expect(pageSources.length).toBeGreaterThan(10);
  });

  it("contain no em dash or en dash", () => {
    for (const path of all) {
      expect(read(path), rel(path)).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("contain no invisible or direction-changing character, which could hide code from a reader", () => {
    const hidden = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
    for (const path of all) {
      expect(read(path), rel(path)).not.toMatch(hidden);
    }
  });

  it("leave no TODO, FIXME or debugging output", () => {
    for (const path of all.filter((p) => !p.endsWith("static.test.ts"))) {
      const text = read(path);
      expect(text, rel(path)).not.toMatch(/\b(TODO|FIXME|XXX)\b/);
      expect(text, rel(path)).not.toMatch(/console\.(log|debug|info|warn|error)/);
      expect(text, rel(path)).not.toMatch(/\bdebugger\b/);
    }
  });
});

describe("the page and view sources", () => {
  it("never set a style, an event handler or markup from a string", () => {
    for (const path of pageSources.filter((p) => p.endsWith(".tsx"))) {
      const text = read(path);
      expect(text, rel(path)).not.toMatch(/\bstyle=/);
      expect(text, rel(path)).not.toMatch(/\bon[A-Z][A-Za-z]+=/);
      expect(text, rel(path)).not.toMatch(/\bon[a-z]+=\{/);
      expect(text, rel(path)).not.toContain("dangerouslySetInnerHTML");
      expect(text, rel(path)).not.toContain("innerHTML");
      // The one script is the external file, named by src.
      expect(text, rel(path)).not.toMatch(/<script(?![^>]*\bsrc=)/);
      expect(text, rel(path)).not.toMatch(/<style[\s>]/);
    }
  });

  it("use raw markup in one place only: the doctype", () => {
    const uses = pageSources.flatMap((path) =>
      [...read(path).matchAll(/\braw\(([^)]*)\)/g)].map((m) => `${rel(path)}: ${m[1]}`),
    );
    expect(uses).toEqual(['src/server/pages/layout.tsx: "<!doctype html>"']);
    for (const path of pageSources) {
      for (const m of read(path).matchAll(/import \{([^}]*)\} from "hono\/html"/g)) {
        expect((m[1] as string).trim(), rel(path)).toBe("raw");
      }
      expect(read(path), rel(path)).not.toMatch(/\bhtml`/);
    }
  });

  it("read nothing from the clock, the environment, the disk or the network", () => {
    for (const path of pageSources) {
      const text = read(path);
      expect(text, rel(path)).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|performance\.now/);
      expect(text, rel(path)).not.toMatch(
        /process\.|node:fs|node:child_process|node:net|node:http|\bfetch\(/,
      );
    }
  });

  it("import only the shared contracts, the url table, hono and each other", () => {
    const allowed = [
      /^hono(\/[a-z-]+)?$/,
      /^@clausewise\/playbook$/,
      /^\.\.\/\.\.\/contracts\.js$/,
      /^\.\.\/\.\.\/auth\/actions\.js$/,
      /^\.\.\/\.\.\/services\/views\.js$/,
      /^\.\.\/\.\.\/ingest\/invisible\.js$/,
      /^\.\.\/urls\.js$/,
      /^\.\.\/views\/[a-z]+\.js$/,
      /^\.\/[a-z]+\.js$/,
    ];
    for (const path of pageSources) {
      for (const m of read(path).matchAll(/from "([^"]+)"/g)) {
        const spec = m[1] as string;
        expect(
          allowed.some((re) => re.test(spec)),
          `${rel(path)} imports ${spec}`,
        ).toBe(true);
      }
    }
  });

  it("leave authorization to the server: no page decides a role from a field", () => {
    const text = read(join(APP, "src/server/pages/matter.tsx"));
    // Roles come from the view the service built, through the one shared table.
    expect(text).toContain('roleAllows(role, "document.write")');
    expect(text).toContain('roleAllows(role, "run.start")');
    expect(text).toContain('roleAllows(role, "memo.export", { relaxedSegregation: relaxed })');
    expect(text).toContain("const role = matter.role;");
  });

  it("use the shared url table for every link and form action", () => {
    let seen = 0;
    for (const path of pageSources.filter((p) => p.endsWith(".tsx"))) {
      const text = read(path);
      for (const m of text.matchAll(/(?:href|action)=(\{[^}]*\}|"[^"]*")/g)) {
        const value = m[1] as string;
        const ok =
          /urls\./.test(value) ||
          value === '"#main"' ||
          value === '"#decision"' ||
          value === '"#inspector"' ||
          value === '"#issue-table"' ||
          /runHref\(/.test(value) ||
          /^\{(item\.href|props\.backHref \?\? urls|runStatusUrl)/.test(value) ||
          /^\{href\}$/.test(value);
        expect(ok, `${rel(path)}: ${m[0]}`).toBe(true);
        seen += 1;
      }
    }
    expect(seen).toBeGreaterThan(25);
  });
});
