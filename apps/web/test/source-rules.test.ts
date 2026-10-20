// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Rules for the files in this package that a test of behaviour would not catch. Each one is a way
 * for the page to break the server's content security policy, show document text as markup, or
 * reach a host that is not the server.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const sourceFiles = [
  ...filesUnder(join(root, "src")),
  join(root, "index.html"),
  join(root, "vite.config.ts"),
];
const code = sourceFiles.filter(
  (file) => /\.(ts|tsx)$/.test(file) && file.endsWith("vite.config.ts") === false,
);
const text = (file: string): string => readFileSync(file, "utf8");
const name = (file: string): string => relative(root, file);

// Comments may say what the code must never do, so the rules about what the code does skip them.
function withoutComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function offenders(
  files: string[],
  pattern: RegExp,
  options: { comments?: boolean } = {},
): string[] {
  const read = options.comments === true ? text : (file: string) => withoutComments(text(file));
  return files.filter((file) => pattern.test(read(file))).map(name);
}

describe("source files", () => {
  it("found the files it is meant to check", () => {
    expect(code.length).toBeGreaterThan(20);
    expect(sourceFiles.some((file) => file.endsWith("index.html"))).toBe(true);
    expect(sourceFiles.some((file) => file.endsWith(".css"))).toBe(true);
  });

  it("are ASCII only, which also keeps out the long dashes", () => {
    const bad: string[] = [];
    // The tests too: a test file is read by the same people, and a long dash in one is as much a slip.
    for (const file of [...sourceFiles, ...filesUnder(join(root, "test"))]) {
      const body = text(file);
      for (let index = 0; index < body.length; index++) {
        if (body.charCodeAt(index) > 0x7f) {
          bad.push(`${name(file)} at ${index}`);
          break;
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("never turn text into markup", () => {
    expect(
      offenders(
        code,
        /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/,
      ),
    ).toEqual([]);
  });

  it("never run text as code or open a browser dialog", () => {
    expect(offenders(code, /\beval\(|new Function\(|\balert\(|\bconfirm\(|\bprompt\(/)).toEqual([]);
  });

  it("put no style attribute and no inline style in the markup", () => {
    expect(offenders(code, /\bstyle=|\bstyle:\s*\{/)).toEqual([]);
    const html = text(join(root, "index.html"));
    expect(html).not.toMatch(/<style|\sstyle=|<script(?![^>]*\ssrc=)[^>]*>\s*\S|\son[a-z]+=/);
  });

  it("name no host: every address is relative to the server that served the page", () => {
    // The SVG's namespace and the dev server's proxy target are not addresses the page reaches.
    const reached = sourceFiles.filter(
      (file) => !file.endsWith(".svg") && !file.endsWith("vite.config.ts"),
    );
    expect(offenders(reached, /https?:\/\//, { comments: true })).toEqual([]);
    expect(
      offenders(code, /\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|sendBeacon|importScripts/),
    ).toEqual([]);
  });

  it("show a server's message with its line breaks, and style a button that is unavailable but not disabled", () => {
    const css = text(join(root, "src", "styles", "components.css"));
    // jsdom does not read the stylesheets, so the rules the screens rely on are checked here.
    expect(css).toMatch(/\.message-text\s*\{[^}]*white-space:\s*pre-line/);
    expect(css).toMatch(/\.button\[aria-disabled="true"\]/);
    expect(css).toMatch(/\.link-button\[aria-disabled="true"\]/);
    expect(css).toMatch(/:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  });

  it("load nothing from the network in the stylesheets", () => {
    const css = sourceFiles.filter((file) => file.endsWith(".css"));
    expect(offenders(css, /@import|url\(/)).toEqual([]);
  });

  it("keep the token out of anything that could log it or send it away", () => {
    expect(offenders(code, /console\.(log|info|debug|warn|error)/)).toEqual([]);
    expect(offenders(code, /document\.cookie|localStorage/)).toEqual([]);
  });

  it("leave no unfinished marker, type escape or skipped test behind", () => {
    expect(
      offenders(code, /\bTODO\b|\bFIXME\b|@ts-ignore|@ts-expect-error|\bas any\b|: any\b/, {
        comments: true,
      }),
    ).toEqual([]);
    const tests = filesUnder(join(root, "test")).filter((file) => /\.test\.tsx?$/.test(file));
    expect(tests.length).toBeGreaterThan(10);
    expect(offenders(tests, /\b(it|test|describe)\.(skip|only|todo)\b/)).toEqual([]);
    // Each test file says it runs in a browser-like environment.
    expect(
      tests.filter((file) => !text(file).startsWith("// @vitest-environment jsdom")).map(name),
    ).toEqual([]);
  });
});
