import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiError } from "@clausewise/api";
import { beforeAll, describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY } from "../src/security.js";
import { createHarness, oracleFor, tempDir, type Harness } from "./support.js";

describe("the web app's files", () => {
  let t: Harness;
  let web: string;
  beforeAll(async () => {
    const parent = await tempDir("clausewise-web-", "file");
    web = join(parent, "dist");
    await mkdir(join(web, "assets"), { recursive: true });
    await writeFile(join(web, "index.html"), "<!doctype html><title>Clausewise</title>");
    await writeFile(join(web, "assets", "app-3f9a1c.js"), "console.log('app');");
    await writeFile(join(web, "assets", "app-3f9a1c.css"), "body{color:black}");
    await writeFile(join(web, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(web, "data.bin"), "bytes");
    await writeFile(join(parent, "outside.txt"), "SECRET OUTSIDE THE WEB FOLDER");
    await symlink(join(parent, "outside.txt"), join(web, "link.txt"));
    await symlink(parent, join(web, "up"));
    t = await createHarness({
      generator: await oracleFor("nda-aggressive.docx"),
      config: { webDir: web, accessToken: "a-token-of-sufficient-length" },
      scope: "file",
    });
  });

  it("serves the page at / with the content security policy, and no caching", async () => {
    for (const path of ["/", "/index.html"]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(200);
      expect(await response.text()).toContain("<title>Clausewise</title>");
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  it("serves the built files with their types, and lets hashed ones be cached for good", async () => {
    const js = await t.request("/assets/app-3f9a1c.js");
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(js.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY);
    expect((await t.request("/assets/app-3f9a1c.css")).headers.get("content-type")).toBe(
      "text/css; charset=utf-8",
    );
    expect((await t.request("/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await t.request("/data.bin")).headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    const head = await t.request("/assets/app-3f9a1c.js", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("needs no token, as the page is what asks for it", async () => {
    expect((await t.request("/")).status).toBe(200);
    expect((await t.request("/assets/app-3f9a1c.js")).status).toBe(200);
    expect((await t.request("/api/documents")).status).toBe(401);
  });

  it("never reaches a file outside its folder, however the path is written", async () => {
    const paths = [
      "/../outside.txt",
      "/%2e%2e/outside.txt",
      "/%2E%2E%2Foutside.txt",
      "/assets/../../outside.txt",
      "/assets/%2e%2e/%2e%2e/outside.txt",
      "/..%2foutside.txt",
      "/..\\outside.txt",
      "/%5c..%5coutside.txt",
      "/link.txt",
      "/up/outside.txt",
      "/%00",
      "/index.html%00.png",
      "//etc/passwd",
      "/%ZZ",
    ];
    for (const path of paths) {
      const response = await t.request(path);
      const text = await response.text();
      expect(response.status, path).toBe(404);
      expect(text, path).not.toContain("SECRET");
      expect(JSON.parse(text).error.code).toBe("not_found");
    }
  });

  it("answers 404 with the API's error shape for a folder, a missing file and a change", async () => {
    for (const [method, path] of [
      ["GET", "/assets"],
      ["GET", "/assets/"],
      ["GET", "/missing.js"],
      ["POST", "/"],
      ["DELETE", "/index.html"],
    ] as const) {
      const response = await t.request(path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(((await response.json()) as ApiError).error.code).toBe("not_found");
    }
  });

  it("never answers a path under /api with the page", async () => {
    const response = await t.request("/api/anything", {
      headers: { Authorization: "Bearer a-token-of-sufficient-length" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("finds the web folder when it is built after the server has started", async () => {
    const parent = await tempDir("clausewise-web-late-");
    const late = await createHarness({
      generator: await oracleFor("nda-aggressive.docx"),
      config: { webDir: join(parent, "dist") },
    });
    expect((await late.request("/")).status).toBe(404);
    await mkdir(join(parent, "dist"));
    await writeFile(join(parent, "dist", "index.html"), "<!doctype html><title>Late</title>");
    const page = await late.request("/");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Late");
  });

  it("answers 404 for the page when there is no web folder, and the API still works", async () => {
    const bare = await createHarness({ generator: await oracleFor("nda-aggressive.docx") });
    const page = await bare.request("/");
    expect(page.status).toBe(404);
    expect(((await page.json()) as ApiError).error.code).toBe("not_found");
    expect((await bare.request("/healthz")).status).toBe(200);
  });
});
