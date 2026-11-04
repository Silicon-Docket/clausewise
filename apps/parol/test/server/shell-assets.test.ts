import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_ASSETS_DIR, contentTypeFor, loadAssets } from "../../src/server/assets.js";
import { makeShell } from "./support-app.js";

/** A secret one folder above the assets, which no request should ever reach. */
const SECRET_TEXT = "SECRET_outside_the_assets_folder";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function site() {
  const root = mkdtempSync(join(tmpdir(), "parol-assets-"));
  roots.push(root);
  const dir = join(root, "public");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(root, "secret.txt"), SECRET_TEXT);
  writeFileSync(join(dir, "app.css"), "body { color: black; }\n");
  writeFileSync(join(dir, "app.js"), "export {};\n");
  writeFileSync(join(dir, "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(dir, "font.woff2"), Buffer.from([1, 2, 3]));
  writeFileSync(join(dir, ".hidden"), "hidden");
  writeFileSync(join(dir, "has space.css"), "x");
  writeFileSync(join(dir, "nested", "inner.css"), "inner");
  symlinkSync(join(root, "secret.txt"), join(dir, "linked.txt"));
  const shell = makeShell({ app: { assetsDir: dir } });
  return { root, dir, shell };
}

describe("serving static files", () => {
  it("serves the files of the directory with the right type and a day of caching", async () => {
    const { shell } = site();
    const expectations: [string, string][] = [
      ["app.css", "text/css; charset=utf-8"],
      ["app.js", "text/javascript; charset=utf-8"],
      ["logo.svg", "image/svg+xml"],
      ["data.bin", "application/octet-stream"],
      ["font.woff2", "font/woff2"],
    ];
    for (const [name, type] of expectations) {
      const response = await shell.anonymous().get(`/assets/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("content-type"), name).toBe(type);
      expect(response.headers.get("cache-control"), name).toBe("public, max-age=86400");
      expect(response.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(response.headers.get("etag"), name).toMatch(/^"[0-9a-f]{32}"$/);
    }
    const css = await shell.anonymous().get("/assets/app.css");
    expect(await css.text()).toBe("body { color: black; }\n");
    const bin = new Uint8Array(
      await (await shell.anonymous().get("/assets/data.bin")).arrayBuffer(),
    );
    expect([...bin]).toEqual([0, 1, 2, 3]);
  });

  it("answers HEAD, and answers 304 when the browser already has the file", async () => {
    const { shell } = site();
    const first = await shell.anonymous().get("/assets/app.css");
    const etag = first.headers.get("etag")!;
    const head = await shell.anonymous().send("HEAD", "/assets/app.css");
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);
    const again = await shell.anonymous().get("/assets/app.css", { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("cache-control")).toBe("public, max-age=86400");
    const other = await shell.anonymous().get("/assets/app.css", { "if-none-match": '"stale"' });
    expect(other.status).toBe(200);
  });

  it("needs no session and does not issue a cookie", async () => {
    const { shell } = site();
    const response = await shell.anonymous().get("/assets/app.css");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("serves nothing that was not in the directory when the server started", async () => {
    const { shell, dir } = site();
    writeFileSync(join(dir, "late.css"), "late");
    expect((await shell.anonymous().get("/assets/late.css")).status).toBe(404);
  });

  it("serves the real stylesheet and script of the application", async () => {
    const shell = makeShell();
    const css = await shell.anonymous().get("/assets/parol.css");
    const js = await shell.anonymous().get("/assets/parol.js");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await css.text()).toBe(readFileSync(join(DEFAULT_ASSETS_DIR, "parol.css"), "utf8"));
  });
});

describe("what is not served", () => {
  it("is anything outside the allowlist: dotfiles, odd names, folders, links and listings", async () => {
    const { shell } = site();
    const paths = [
      "/assets/.hidden",
      "/assets/has%20space.css",
      "/assets/nested",
      "/assets/nested/",
      "/assets/nested/inner.css",
      "/assets/linked.txt",
      "/assets/",
      "/assets",
      "/assets/missing.css",
      "/assets/APP.CSS",
      "/assets/app.css/",
      "/assets/app.css.",
      "/assets/app.css%20",
      "/assets/app.cs",
      "/assets/*",
      "/assets/__proto__",
      "/assets/constructor",
      "/assets/toString",
    ];
    for (const path of paths) {
      const response = await shell.anonymous().get(path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).not.toContain(SECRET_TEXT);
      expect(response.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("is reached by no form of path traversal", async () => {
    const { shell } = site();
    const attempts = [
      "/assets/../secret.txt",
      "/assets/..%2fsecret.txt",
      "/assets/..%2Fsecret.txt",
      "/assets/%2e%2e/secret.txt",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/%2E%2E%2Fsecret.txt",
      "/assets/.%2e/secret.txt",
      "/assets/..%5csecret.txt",
      "/assets/..%5Csecret.txt",
      "/assets/..\\secret.txt",
      "/assets/%5c..%5csecret.txt",
      "/assets/%252e%252e%252fsecret.txt",
      "/assets/%252e%252e/secret.txt",
      "/assets/..%252fsecret.txt",
      "/assets/%c0%ae%c0%ae/secret.txt",
      "/assets/%c0%ae%c0%ae%c0%afsecret.txt",
      "/assets/..%c0%afsecret.txt",
      "/assets/app.css%00.txt",
      "/assets/app.css%00",
      "/assets/%00app.css",
      "/assets/secret.txt%00.css",
      "/assets/....//secret.txt",
      "/assets/.../secret.txt",
      "/assets/./app.css/../secret.txt",
      "//assets/../secret.txt",
      "/assets//app.css",
      "/assets/..;/secret.txt",
      "/assets/%2f%2fsecret.txt",
      "/assets/%2fetc%2fpasswd",
      "/assets/..%2f..%2f..%2f..%2fetc%2fpasswd",
      "/assets/file:///etc/passwd",
      `/assets/${encodeURIComponent("../secret.txt")}`,
      `/assets/${encodeURIComponent(encodeURIComponent("../secret.txt"))}`,
    ];
    for (const path of attempts) {
      const response = await shell.anonymous().get(path);
      const text = await response.text();
      expect(text, path).not.toContain(SECRET_TEXT);
      expect(text, path).not.toContain("root:");
      expect(text, path).not.toContain("body { color");
      expect(response.status, path).not.toBe(200);
    }
  });

  it("does not reach the application's own files either, which sit beside the assets folder", async () => {
    // The real server, whose assets folder is apps/parol/public: its neighbours are the source,
    // the migrations and the package file.
    const shell = makeShell();
    const neighbours: [string, RegExp][] = [
      ["package.json", /@clausewise\/parol|"dependencies"/],
      ["src/main.ts", /parseEnv|export async function start/],
      ["src/auth/identity.ts", /SESSION_COOKIE/],
      ["migrations/001_init.sql", /CREATE TABLE/],
      ["tsconfig.json", /compilerOptions/],
    ];
    const dressings = [
      (p: string) => `../${p}`,
      (p: string) => encodeURIComponent(`../${p}`),
      (p: string) => `..%2f${p.replaceAll("/", "%2f")}`,
      (p: string) => `%2e%2e%2f${p.replaceAll("/", "%2f")}`,
      (p: string) => `%2e%2e/${p}`,
      (p: string) => `..%5c${p.replaceAll("/", "%5c")}`,
      (p: string) => `..\\${p.replaceAll("/", "\\")}`,
      (p: string) => encodeURIComponent(encodeURIComponent(`../${p}`)),
      (p: string) => `%252e%252e%252f${p.replaceAll("/", "%252f")}`,
      (p: string) => `${p}%00.css`,
      (p: string) => `../${p}%00`,
      (p: string) => `....//${p}`,
    ];
    for (const [file, content] of neighbours) {
      for (const dress of dressings) {
        const response = await shell.anonymous().get(`/assets/${dress(file)}`);
        const text = await response.text();
        expect(response.status, dress(file)).toBe(404);
        expect(text, dress(file)).not.toMatch(content);
      }
    }
    for (const path of [
      "/assets/%2fetc%2fpasswd",
      "/assets//etc/passwd",
      "/assets/..%2f..%2f..%2f..%2f..%2f..%2fetc%2fpasswd",
    ]) {
      const response = await shell.anonymous().get(path);
      expect(await response.text(), path).not.toContain("root:");
      expect(response.status, path).not.toBe(200);
    }
  });

  it("does not answer a write", async () => {
    const { shell } = site();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await shell.anonymous().send(method, "/assets/app.css", { body: "x" });
      expect(response.status, method).toBe(404);
    }
  });
});

describe("the allowlist", () => {
  it("holds plain files with plain names, and nothing else", () => {
    const { dir } = site();
    const names = [...loadAssets(dir).keys()].sort();
    expect(names).toEqual(["app.css", "app.js", "data.bin", "font.woff2", "logo.svg"]);
  });

  it("holds exactly the plain files of the real public folder", () => {
    const expected = readdirSync(DEFAULT_ASSETS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect([...loadAssets().keys()].sort()).toEqual(expected);
    expect(expected).toContain("parol.css");
    expect(expected).toContain("parol.js");
  });

  it("refuses to start when the directory cannot be read, without naming the path", () => {
    const shell = () => makeShell({ app: { assetsDir: "/nonexistent/secret-dir-name" } });
    expect(shell).toThrow("the static assets directory cannot be read");
    expect(shell).not.toThrow(/secret-dir-name/);
  });

  it("types unknown extensions as binary", () => {
    expect(contentTypeFor("x.exe")).toBe("application/octet-stream");
    expect(contentTypeFor("noextension")).toBe("application/octet-stream");
    expect(contentTypeFor("X.CSS")).toBe("text/css; charset=utf-8");
  });
});
