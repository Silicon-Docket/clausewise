import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOracleGenerator } from "@clausewise/review/testing";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import { startLocal } from "../src/index.js";

// The page signs in against Entra ID in a real browser. Entra ID itself is played by the test:
// every request to login.microsoftonline.com is answered here, so nothing leaves this machine,
// and the PKCE exchange, the tokens and the API call are checked end to end.
//
// Playwright is not a dependency of Clausewise. Where it is installed (as in the development
// container) this runs; elsewhere it is skipped.

// The part of Playwright's API this test uses, declared here because Playwright and its types are
// not a dependency.
interface Route {
  request(): { url(): string; method(): string; postData(): string | null };
  fulfill(response: {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<void>;
  abort(): Promise<void>;
}
interface Locator {
  click(): Promise<void>;
  count(): Promise<number>;
  textContent(): Promise<string | null>;
  selectOption(value: string): Promise<unknown>;
  setInputFiles(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  waitFor(): Promise<void>;
}
interface Page {
  on(event: "console", handler: (message: { type(): string; text(): string }) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  goto(url: string): Promise<unknown>;
  getByRole(role: string, options: { name: string; exact?: boolean }): Locator;
  locator(selector: string): Locator;
  waitForFunction(
    check: () => boolean,
    arg?: undefined,
    options?: { timeout: number },
  ): Promise<unknown>;
  waitForEvent(
    event: "download",
  ): Promise<{ path(): Promise<string>; suggestedFilename(): string }>;
}
interface Playwright {
  chromium: {
    launch(): Promise<{
      newContext(options: { acceptDownloads: boolean }): Promise<{
        addInitScript(script: () => void): Promise<void>;
        route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
        newPage(): Promise<Page>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

let playwright: Playwright | undefined;
try {
  playwright = createRequire(import.meta.url)("playwright") as Playwright;
} catch {
  playwright = undefined;
}

const TENANT = "11111111-2222-4333-8444-555555555555";
const CLIENT = "66666666-7777-4888-9999-000000000000";
const OID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LOGIN = "https://login.microsoftonline.com";
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let signing: CryptoKey;
let keySet: JSONWebKeySet;
let fixture: Fixture;
let local: Awaited<ReturnType<typeof startLocal>> | undefined;

const now = () => Math.floor(Date.now() / 1000);
const base64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

async function jwt(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "key-1", typ: "JWT" })
    .sign(signing);
}

describe.skipIf(playwright === undefined)("signing in from the page", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    signing = pair.privateKey;
    keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "key-1", alg: "RS256" }] };
    [fixture] = (await loadFixtures(ROOT, ["nda-aggressive.docx"])) as [Fixture];
    local = await startLocal({
      playbooksDir: join(ROOT, "playbooks"),
      generator: createOracleGenerator(oracleScripts(fixture)),
      port: 0,
      entra: { tenantId: TENANT, clientId: CLIENT, options: { keys: createLocalJWKSet(keySet) } },
    });
  });

  afterAll(async () => {
    await local?.close();
  });

  it(
    "signs in with PKCE, calls the API with the token and runs a review",
    { timeout: 60_000 },
    async () => {
      const origin = `http://localhost:${new URL(local!.url).port}`;
      const browser = await playwright!.chromium.launch();
      const problems: string[] = [];
      let authorize: URLSearchParams | undefined;
      let redeemed: URLSearchParams | undefined;
      const unexpected: string[] = [];

      try {
        const context = await browser.newContext({ acceptDownloads: true });
        await context.addInitScript(() => {
          document.addEventListener("securitypolicyviolation", (event) => {
            console.error(`CSP: ${event.violatedDirective} ${event.blockedURI}`);
          });
        });

        await context.route(`${LOGIN}/**`, async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const cors = {
            "access-control-allow-origin": origin,
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "GET, POST",
          };
          if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });

          if (url.pathname.endsWith("/v2.0/.well-known/openid-configuration")) {
            return route.fulfill({
              status: 200,
              headers: { ...cors, "content-type": "application/json" },
              body: JSON.stringify({
                issuer: `${LOGIN}/${TENANT}/v2.0`,
                authorization_endpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/authorize`,
                token_endpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/token`,
                end_session_endpoint: `${LOGIN}/${TENANT}/oauth2/v2.0/logout`,
                jwks_uri: `${LOGIN}/${TENANT}/discovery/v2.0/keys`,
                response_types_supported: ["code", "id_token", "code id_token", "id_token token"],
                response_modes_supported: ["query", "fragment", "form_post"],
                scopes_supported: ["openid", "profile", "email", "offline_access"],
              }),
            });
          }
          if (url.pathname.endsWith("/discovery/instance")) {
            return route.fulfill({
              status: 200,
              headers: { ...cors, "content-type": "application/json" },
              body: JSON.stringify({
                tenant_discovery_endpoint: `${LOGIN}/${TENANT}/v2.0/.well-known/openid-configuration`,
                "api-version": "1.1",
                metadata: [
                  {
                    preferred_network: "login.microsoftonline.com",
                    preferred_cache: "login.windows.net",
                    aliases: [
                      "login.microsoftonline.com",
                      "login.windows.net",
                      "login.microsoft.com",
                    ],
                  },
                ],
              }),
            });
          }
          if (url.pathname === `/${TENANT}/oauth2/v2.0/authorize`) {
            authorize = url.searchParams;
            const answer = new URLSearchParams({
              code: "test-authorization-code",
              state: url.searchParams.get("state") ?? "",
              client_info: base64url(JSON.stringify({ uid: OID, utid: TENANT })),
            });
            const separator = url.searchParams.get("response_mode") === "query" ? "?" : "#";
            return route.fulfill({
              status: 302,
              headers: { location: `${url.searchParams.get("redirect_uri")}${separator}${answer}` },
            });
          }
          if (url.pathname === `/${TENANT}/oauth2/v2.0/token` && request.method() === "POST") {
            redeemed = new URLSearchParams(request.postData() ?? "");
            const claims = {
              tid: TENANT,
              oid: OID,
              ver: "2.0",
              iat: now() - 5,
              nbf: now() - 5,
              exp: now() + 3600,
            };
            const idToken = await jwt({
              ...claims,
              iss: `${LOGIN}/${TENANT}/v2.0`,
              aud: CLIENT,
              sub: "subject-of-alex",
              nonce: authorize?.get("nonce"),
              name: "Alex Example",
              preferred_username: "alex@contoso.example",
            });
            const accessToken = await jwt({
              ...claims,
              iss: `${LOGIN}/${TENANT}/v2.0`,
              aud: CLIENT,
              azp: CLIENT,
              scp: "access_as_user",
            });
            return route.fulfill({
              status: 200,
              headers: { ...cors, "content-type": "application/json" },
              body: JSON.stringify({
                token_type: "Bearer",
                scope: `${CLIENT}/access_as_user openid profile offline_access`,
                expires_in: 3599,
                ext_expires_in: 3599,
                access_token: accessToken,
                refresh_token: "test-refresh-token",
                id_token: idToken,
                client_info: base64url(JSON.stringify({ uid: OID, utid: TENANT })),
              }),
            });
          }
          unexpected.push(`${request.method()} ${url.pathname}`);
          return route.abort();
        });

        const page = await context.newPage();
        page.on("console", (message) => {
          if (message.type() === "error") problems.push(message.text());
        });
        page.on("pageerror", (error) => problems.push(error.message));

        await page.goto(`${origin}/`);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("heading", { name: "Review a contract" }).waitFor();

        // The authorize request is the authorization code flow with PKCE, for this app's scope.
        expect(authorize?.get("client_id")).toBe(CLIENT);
        expect(authorize?.get("response_type")).toBe("code");
        expect(authorize?.get("redirect_uri")).toBe(`${origin}/`);
        expect(authorize?.get("code_challenge_method")).toBe("S256");
        expect(authorize?.get("scope")?.split(" ")).toEqual(
          expect.arrayContaining([`${CLIENT}/access_as_user`, "openid"]),
        );
        // The verifier the page sends when it redeems the code is the one the challenge was made from.
        const verifier = redeemed?.get("code_verifier") ?? "";
        expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
          authorize?.get("code_challenge"),
        );
        expect(redeemed?.get("grant_type")).toBe("authorization_code");
        expect(redeemed?.has("client_secret")).toBe(false);

        // The API accepted the access token: the playbooks it lists are on the page.
        await page.waitForFunction(() => document.querySelectorAll("#playbook option").length > 0);
        expect(await page.locator("#playbook option").count()).toBe(2);
        expect(await page.locator("#account").textContent()).toBe("Alex Example");

        // And a whole review runs from the page.
        await page.locator("#playbook").selectOption("nda-mutual");
        await page.locator("#contract").setInputFiles({
          name: fixture.name,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer: Buffer.from(fixture.docx),
        });
        await page.getByRole("button", { name: "Review", exact: true }).click();
        await page.waitForFunction(
          () => {
            const text = document.getElementById("status")?.textContent ?? "";
            return text === "The review is done." || /wrong|fail/i.test(text);
          },
          undefined,
          { timeout: 30_000 },
        );
        expect(await page.locator("#status").textContent()).toBe("The review is done.");
        expect(await page.locator("#open").textContent()).toMatch(/^Open items: \d+ high, /);

        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Download the summary" }).click();
        const file = await (await download).path();
        expect(await readFile(file, "utf8")).toContain("Mutual NDA");
        expect((await download).suggestedFilename()).toBe("nda-aggressive.summary.md");

        expect(problems).toEqual([]);
        expect(unexpected).toEqual([]);
      } finally {
        await browser.close();
      }
    },
  );
});
