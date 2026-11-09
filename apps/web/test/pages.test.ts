import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOracleGenerator } from "@clausewise/review/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_CSP, startLocal } from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-9999-000000000000";

describe("the web page", () => {
  let plain: Awaited<ReturnType<typeof startLocal>>;
  let signedIn: Awaited<ReturnType<typeof startLocal>>;

  beforeAll(async () => {
    const shared = {
      playbooksDir: join(ROOT, "playbooks"),
      generator: createOracleGenerator({}),
      port: 0,
    };
    plain = await startLocal(shared);
    signedIn = await startLocal({ ...shared, entra: { tenantId: TENANT, clientId: CLIENT } });
  });

  afterAll(async () => {
    await Promise.all([plain.close(), signedIn.close()]);
  });

  it.each([
    ["/", "text/html; charset=utf-8", "<title>Clausewise</title>"],
    ["/app.js", "text/javascript; charset=utf-8", "createStandardPublicClientApplication"],
    ["/app.css", "text/css; charset=utf-8", "font-family"],
    [
      "/vendor/msal-browser.min.js",
      "text/javascript; charset=utf-8",
      "@azure/msal-browser v5.26.0",
    ],
  ])("serves %s under the page's own strict policy", async (path, type, content) => {
    const response = await fetch(`${plain.url}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(type);
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain(content);
  });

  it("lets the page run only its own scripts and reach only this server and Entra ID", () => {
    expect(PAGE_CSP).toContain("script-src 'self'");
    expect(PAGE_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(PAGE_CSP).toContain("connect-src 'self' https://login.microsoftonline.com");
    expect(PAGE_CSP).toContain("frame-ancestors 'none'");
  });

  it("tells the page to skip sign-in in plain local mode", async () => {
    expect(await (await fetch(`${plain.url}/api/config`)).json()).toEqual({ signIn: false });
  });

  it("gives the page the ids it signs in with, and nothing else", async () => {
    expect(await (await fetch(`${signedIn.url}/api/config`)).json()).toEqual({
      signIn: true,
      tenantId: TENANT,
      clientId: CLIENT,
    });
  });

  it("serves the page without a sign-in, but not the API", async () => {
    expect((await fetch(`${signedIn.url}/`)).status).toBe(200);
    const api = await fetch(`${signedIn.url}/api/playbooks`);
    expect(api.status).toBe(401);
    expect(api.headers.get("www-authenticate")).toBe("Bearer");
  });

  it.each([
    "/index.html",
    "/public/app.js",
    "/../package.json",
    "/vendor/",
    "/vendor/msal-browser.js",
  ])("serves no file for %s", async (path) => {
    const response = await fetch(`${signedIn.url}${path}`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-security-policy")).not.toBe(PAGE_CSP);
  });
});
