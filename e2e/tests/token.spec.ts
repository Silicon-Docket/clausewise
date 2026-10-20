import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { BrowserContext, Page } from "@playwright/test";
import { request as playwrightRequest } from "@playwright/test";
import { readDocx } from "../docx-reader.js";
import {
  NDA_PLAYBOOK,
  card,
  decide,
  fixtureBytes,
  redlineButton,
  reviewContract,
} from "../pages.js";
import { createReview, uploadFixture, waitForEnd } from "../support/api.js";
import {
  makeScratch,
  readLog,
  requestsOf,
  restartOwnServer,
  startOwnServer,
} from "../support/servers.js";
import { expect, test } from "../support/tidy.js";
import { watchPage } from "../support/watch.js";

const NDA = "nda-aggressive.docx";
const STORAGE_KEY = "clausewise.access-token";

// Every scenario of this file talks to the server that asks for an access token.
test.use({ serverName: "token" });

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Records every request a context makes, with all of its headers, cookies included. */
function recordRequests(context: BrowserContext): { seen: Seen[]; done(): Promise<void> } {
  const seen: Seen[] = [];
  const pending: Promise<void>[] = [];
  context.on("request", (request) => {
    pending.push(
      request.allHeaders().then((headers) => {
        seen.push({ url: request.url(), method: request.method(), headers });
      }),
    );
  });
  return { seen, done: () => Promise.all(pending).then(() => undefined) };
}

const gate = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "This server asks for an access token" });
const startHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: "Review a contract" });

async function signIn(page: Page, token: string): Promise<void> {
  await page.goto("/");
  await expect(gate(page)).toBeVisible();
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(startHeading(page)).toBeVisible();
}

/** Everything the page could have kept the token in, and what is in each. */
async function kept(page: Page): Promise<{
  session: Record<string, string>;
  local: string[];
  cookie: string;
  databases: number;
  caches: number;
}> {
  return page.evaluate(async () => ({
    session: Object.fromEntries(
      Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key) ?? ""]),
    ),
    local: Object.keys(localStorage),
    cookie: document.cookie,
    databases: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
  }));
}

test.describe("the access token in the browser", () => {
  test("the gate asks first, refuses a wrong token and keeps nothing of it, and takes the right one", async ({
    page,
    context,
    server,
  }) => {
    const token = server.accessToken ?? "";
    expect(token.length).toBeGreaterThanOrEqual(16);
    const recorded = recordRequests(context);
    const watch = await watchPage(page, { origins: [server.url] });

    await page.goto("/");
    await expect(gate(page)).toBeVisible();
    await expect(page).toHaveTitle("Access token - Clausewise");
    const field = page.getByLabel("Access token");
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("type", "password");
    await expect(field).toHaveAttribute("autocomplete", "off");
    // Nothing of the app is offered, and nothing of the server is asked for, until there is a token.
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Forget the access token" })).toHaveCount(0);
    await expect(page.getByText("Recent reviews")).toHaveCount(0);
    await recorded.done();
    const before = recorded.seen
      .filter((item) => new URL(item.url).pathname.startsWith("/api/"))
      .map((item) => `${item.method} ${new URL(item.url).pathname}`);
    expect(before).toEqual(["GET /api/config"]);

    // Nothing typed: told so, at the box.
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter the access token.");
    await expect(field).toHaveAttribute("aria-invalid", "true");

    // A wrong one is refused in words, and is not kept anywhere.
    const wrong = "this-is-not-the-token-at-all";
    await field.fill(wrong);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "That token was not accepted. Check it and try again.",
    );
    await expect(gate(page)).toBeVisible();
    const afterWrong = await kept(page);
    expect(afterWrong.session).toEqual({});
    expect(afterWrong.local).toEqual([]);
    expect(afterWrong.cookie).toBe("");
    expect(JSON.stringify(afterWrong)).not.toContain(wrong);

    // The right one, with a space at either end as a paste may bring, is accepted and kept in this
    // tab and nowhere else.
    await field.fill(`  ${token} `);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(startHeading(page)).toBeVisible();
    await expect(page).toHaveTitle("Clausewise");
    const held = await kept(page);
    expect(held.session).toEqual({ [STORAGE_KEY]: token });
    expect(held.local).toEqual([]);
    expect(held.cookie).toBe("");
    expect(held.databases).toBe(0);
    expect(held.caches).toBe(0);
    expect(await context.cookies()).toEqual([]);
    expect(page.url()).not.toContain(token);
    expect(await page.locator("body").innerText()).not.toContain(token);
    expect(await page.content()).not.toContain(token);

    // Where the token went on the wire: in the Authorization header of requests to the API, and
    // in no address, no cookie, and no request for a page or a file.
    await recorded.done();
    for (const item of recorded.seen) {
      expect(item.url, "a request address").not.toContain(token);
      expect(item.headers["cookie"], `a cookie sent to ${item.url}`).toBeUndefined();
      const path = new URL(item.url).pathname;
      if (item.headers["authorization"] !== undefined) {
        expect(path.startsWith("/api/"), `the token was sent to ${item.url}`).toBe(true);
        expect([`Bearer ${token}`, `Bearer ${wrong}`]).toContain(item.headers["authorization"]);
      }
    }
    // The wrong token went out once, in the check the gate makes, and nowhere else.
    expect(
      recorded.seen
        .filter((item) => item.headers["authorization"] === `Bearer ${wrong}`)
        .map((item) => `${item.method} ${new URL(item.url).pathname}`),
    ).toEqual(["GET /api/playbooks"]);
    const answered = recorded.seen.filter((item) => item.headers["authorization"] !== undefined);
    expect(answered.length).toBeGreaterThan(0);
    // The one request that carried the wrong token is the check made by the gate.
    expect(watch.badResponses.map(([status]) => status)).toEqual([401]);
    expect(watch.problems).toEqual([]);
  });

  test("the whole flow works with the token, files included, and a hard reload keeps working", async ({
    page,
    context,
    server,
  }) => {
    const token = server.accessToken ?? "";
    const recorded = recordRequests(context);
    await signIn(page, token);

    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    await decide(page, "Duration of confidentiality obligations", "Accept");
    const reviewAddress = page.url();

    // The three files are fetched by the page with the token, saved from memory, and are the files.
    const [redline, redlineResponse] = await Promise.all([
      page.waitForEvent("download"),
      page.waitForResponse((response) => /\/docx\?include=accepted$/.test(response.url())),
      redlineButton(page, 1).click(),
    ]);
    expect(redlineResponse.status()).toBe(200);
    expect(redline.suggestedFilename()).toBe("nda-aggressive.redlined.docx");
    const changed = await readDocx(new Uint8Array(await readFile(await redline.path())));
    expect(changed.deletions).toHaveLength(1);
    expect(changed.insertions).toHaveLength(1);
    expect(changed.comments).toHaveLength(1);

    const [original] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download the original file" }).click(),
    ]);
    expect(original.suggestedFilename()).toBe(NDA);
    expect(
      Buffer.from(await readFile(await original.path())).equals(
        Buffer.from(await fixtureBytes(NDA)),
      ),
    ).toBe(true);

    const [report] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Download the report (Markdown)" }).click(),
    ]);
    expect(report.suggestedFilename()).toBe("nda-aggressive.summary.md");
    expect(await readFile(await report.path(), "utf8")).toContain(
      "Duration of confidentiality obligations",
    );

    // A file is not a link: no request for one went out without the token, and none was a page
    // navigation to the API.
    await recorded.done();
    const files = recorded.seen.filter((item) =>
      /\/(docx|file|report)(\?|$)/.test(new URL(item.url).pathname + new URL(item.url).search),
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const item of files) {
      expect(item.headers["authorization"], item.url).toBe(`Bearer ${token}`);
    }

    // A hard reload of the same tab goes on where it was: the token is in this tab's storage.
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();
    expect(page.url()).toBe(reviewAddress);
    await expect(
      card(page, "Duration of confidentiality obligations").getByRole("button", {
        name: "Accept",
        pressed: true,
      }),
    ).toBeVisible();
    await expect(gate(page)).toHaveCount(0);
    // And a load of the address as if typed in: the same.
    await page.goto(reviewAddress);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();
  });

  test("a new tab asks again, and forgetting the token in one tab leaves the other alone", async ({
    page,
    context,
    server,
  }) => {
    const token = server.accessToken ?? "";
    await signIn(page, token);

    const other = await context.newPage();
    await other.goto("/");
    await expect(gate(other)).toBeVisible();
    expect((await kept(other)).session).toEqual({});
    // Not even the address of a review gets past it.
    await other.goto("/#/reviews/00000000-0000-4000-8000-000000000000");
    await other.reload();
    await expect(gate(other)).toBeVisible();
    await other.close();

    // Another browser profile has nothing either.
    const stranger = await (await page.context().browser())?.newContext({ baseURL: server.url });
    const strangerPage = await stranger?.newPage();
    if (strangerPage === undefined) throw new Error("No second browser context.");
    await strangerPage.goto("/");
    await expect(gate(strangerPage)).toBeVisible();
    await stranger?.close();

    // Forget it: the gate is back, a reload does not bring the token back, and nothing is left.
    await page.getByRole("button", { name: "Forget the access token" }).click();
    await expect(gate(page)).toBeVisible();
    expect((await kept(page)).session).toEqual({});
    await page.reload();
    await expect(gate(page)).toBeVisible();
    // The gate takes the focus for the first field, and the header no longer offers the button.
    await expect(page.getByLabel("Access token")).toBeFocused();
    await expect(page.getByRole("button", { name: "Forget the access token" })).toHaveCount(0);
  });

  test("a token the server does not know is dropped on the first answer, and the gate says it was refused", async ({
    page,
    server,
  }) => {
    const token = server.accessToken ?? "";
    await page.goto("/");
    await expect(gate(page)).toBeVisible();
    await page.evaluate(
      ([key, value]) => sessionStorage.setItem(key as string, value as string),
      [STORAGE_KEY, "a-token-from-before-it-was-changed"],
    );
    await page.reload();
    await expect(
      page.getByText("The server did not accept the token this page was using. Enter it again."),
    ).toBeVisible();
    await expect(gate(page)).toBeVisible();
    // The refused token is gone from the tab, not kept for another try.
    expect((await kept(page)).session).toEqual({});

    await page.getByLabel("Access token").fill(token);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(startHeading(page)).toBeVisible();
    await expect(
      page.getByText("The server did not accept the token this page was using."),
    ).toHaveCount(0);
  });

  test("when the owner changes the token and restarts the server, the open page asks for the new one", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const oldToken = "the-old-token-0123456789abcdef";
    const newToken = "the-new-token-0123456789abcdef";
    const scratch = await makeScratch("rotate");
    const first = await startOwnServer({ dir: scratch.dir, accessToken: oldToken });
    const context = await browser.newContext({ baseURL: first.url, acceptDownloads: true });
    const page = await context.newPage();
    let second: Awaited<ReturnType<typeof startOwnServer>> | undefined;
    try {
      await signIn(page, oldToken);
      const { id } = await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      await first.close();
      second = await restartOwnServer(first, { accessToken: newToken }, scratch.dir);

      // The next thing the page does is refused, and the page says why instead of going blank.
      await decide(page, "Duration of confidentiality obligations", "Accept").catch(
        () => undefined,
      );
      await expect(gate(page)).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("The server did not accept the token this page was using. Enter it again."),
      ).toBeVisible();
      expect((await kept(page)).session).toEqual({});

      // The old token is refused, the new one is not, and the review is where it was.
      await page.getByLabel("Access token").fill(oldToken);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("alert")).toHaveText(
        "That token was not accepted. Check it and try again.",
      );
      await page.getByLabel("Access token").fill(newToken);
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();
      expect((await kept(page)).session).toEqual({ [STORAGE_KEY]: newToken });
    } finally {
      await context.close();
      await second?.close().catch(() => {});
      await first.close().catch(() => {});
      await scratch.remove();
    }
  });
});

test.describe("the access token on the wire", () => {
  test("an address opened without the token is refused with 401, and the token is taken from nowhere else", async ({
    page,
    request,
    server,
  }) => {
    const token = server.accessToken ?? "";

    // The browser, going to the address by hand.
    const bare = await page.goto("/api/reviews");
    expect(bare?.status()).toBe(401);
    expect(bare?.headers()["www-authenticate"]).toBe("Bearer");
    expect(bare?.headers()["cache-control"]).toBe("no-store");
    const text = await page.locator("body").innerText();
    expect(JSON.parse(text)).toEqual({
      error: { code: "unauthorized", message: "Sign in with the access token to use Clausewise." },
    });
    // No box asking for a password came up: the answer is a page of its own.
    expect(page.url()).toMatch(/\/api\/reviews$/);

    for (const address of [
      "/api/documents",
      "/api/playbooks",
      "/api/reviews/not-an-id",
      "/api/nothing",
    ]) {
      const response = await page.goto(address);
      expect(response?.status(), address).toBe(401);
    }

    // The token in an address, a cookie, or another kind of header is not a token.
    const refused = async (
      what: string,
      path: string,
      headers: Record<string, string>,
    ): Promise<void> => {
      const response = await request.get(path, { headers });
      expect(response.status(), what).toBe(401);
      expect(await response.text(), what).not.toContain(token);
    };
    await refused("in the address", `/api/reviews?token=${token}&access_token=${token}`, {});
    await refused("in a cookie", "/api/reviews", {
      Cookie: `token=${token}; Authorization=${token}`,
    });
    await refused("as the token header", "/api/reviews", { "X-Access-Token": token });
    await refused("without its scheme", "/api/reviews", { Authorization: token });
    await refused("as Basic", "/api/reviews", {
      Authorization: `Basic ${Buffer.from(`user:${token}`).toString("base64")}`,
    });
    await refused("empty", "/api/reviews", { Authorization: "Bearer " });
    await refused("one character off", "/api/reviews", {
      Authorization: `Bearer ${token.slice(0, -1)}x`,
    });
    await refused("cut short", "/api/reviews", { Authorization: `Bearer ${token.slice(0, -1)}` });
    await refused("too long", "/api/reviews", { Authorization: `Bearer ${token}x` });
    // Changing anything needs it as well.
    for (const [method, path] of [
      ["POST", "/api/reviews"],
      ["POST", "/api/documents"],
      ["PATCH", "/api/reviews/x/findings"],
      ["DELETE", "/api/documents/x"],
      ["POST", "/api/config"],
    ] as const) {
      const response = await request.fetch(path, { method, data: {} });
      expect(response.status(), `${method} ${path}`).toBe(401);
    }

    // What needs none: the health check, the page, its files, and the settings that say a token is wanted.
    expect((await request.get("/healthz")).status()).toBe(200);
    const config = await request.get("/api/config");
    expect(config.status()).toBe(200);
    expect(((await config.json()) as { authRequired: boolean }).authRequired).toBe(true);
    const html = await request.get("/");
    expect(html.status()).toBe(200);
    const assets = [...(await html.text()).matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)];
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const [, path] of assets) {
      const asset = await request.get(path ?? "");
      expect(asset.status(), path).toBe(200);
      // The web app is the same for everyone and holds no secret: the token is in none of it.
      expect(await asset.text(), path).not.toContain(token);
    }

    // The right token, in the header, with the scheme in any case, is accepted.
    for (const authorization of [`Bearer ${token}`, `bearer ${token}`, `BEARER ${token}`]) {
      const response = await request.get("/api/reviews", {
        headers: { Authorization: authorization },
      });
      expect(response.status(), authorization.slice(0, 8)).toBe(200);
    }
  });

  test("the token is the defence here, and the check on where a request came from stays as well", async ({
    request,
    server,
  }) => {
    const token = server.accessToken ?? "";
    const withToken = { Authorization: `Bearer ${token}` };

    // Any name the server is called by is answered when the token comes with it, and not otherwise.
    const evil = await request.get("/api/config", { headers: { Host: "evil.example" } });
    expect(evil.status()).toBe(200);
    expect(
      (await request.get("/api/reviews", { headers: { Host: "evil.example" } })).status(),
    ).toBe(401);
    expect(
      (
        await request.get("/api/reviews", { headers: { ...withToken, Host: "evil.example" } })
      ).status(),
    ).toBe(200);

    // A page on another site that somehow had the token still could not change anything.
    const forged = await request.post("/api/reviews", {
      headers: { ...withToken, Origin: "http://evil.example" },
      data: {
        documentId: "00000000-0000-4000-8000-000000000000",
        playbookId: "builtin:nda-mutual",
      },
    });
    expect(forged.status()).toBe(403);
    const form = await request.post("/api/reviews", { headers: withToken, form: { a: "b" } });
    expect(form.status()).toBe(415);

    // What the API says never holds the token, whoever asks.
    for (const path of ["/api/config", "/api/playbooks", "/api/reviews", "/api/documents"]) {
      const response = await request.get(path, { headers: withToken });
      expect(await response.text(), path).not.toContain(token);
      expect(JSON.stringify(response.headers()), path).not.toContain(token);
    }
    const error = await request.get("/api/reviews/not-an-id", { headers: withToken });
    expect(await error.text()).not.toContain(token);
  });

  test("a page on another site cannot use the token that a tab of the app holds", async ({
    context,
    server,
  }) => {
    const token = server.accessToken ?? "";
    const scratch = await makeScratch("token-other");
    const own = await startOwnServer({ dir: scratch.dir, accessToken: token });
    const api = await playwrightRequest.newContext({
      baseURL: own.url,
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    try {
      const document = await uploadFixture(api, NDA);
      const review = await createReview(api, {
        documentId: document.id,
        playbookId: "builtin:nda-mutual",
      });
      await waitForEnd(api, review.id);

      // A tab of the app signs in; then another tab, on another site, does what it can with
      // credentials and no-cors requests. The token lives in the app's own tab storage, which
      // another origin cannot see, and is sent only by the app's own script.
      const app = await context.newPage();
      await app.goto(`${own.url}/`);
      await app.getByLabel("Access token").fill(token);
      await app.getByRole("button", { name: "Continue" }).click();
      await expect(startHeading(app)).toBeVisible();

      const logBefore = (await readLog(own.logFile)).length;
      const stranger = await context.newPage();
      await stranger.goto("about:blank");
      const outcome = await stranger.evaluate(
        async ([target, id]) => {
          const results: Record<string, string> = {};
          const attempt = async (name: string, run: () => Promise<Response>): Promise<void> => {
            try {
              const response = await run();
              results[name] = `${response.type}:${response.status}`;
            } catch (error) {
              results[name] = `threw ${(error as Error).name}`;
            }
          };
          await attempt("read", () => fetch(`${target}/api/reviews`, { credentials: "include" }));
          await attempt("read without cors", () =>
            fetch(`${target}/api/reviews`, { mode: "no-cors", credentials: "include" }),
          );
          await attempt("accept", () =>
            fetch(`${target}/api/reviews/${id}/findings`, {
              method: "PATCH",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ decision: "accepted" }),
            }),
          );
          await attempt("post as text", () =>
            fetch(`${target}/api/reviews`, {
              method: "POST",
              mode: "no-cors",
              credentials: "include",
              headers: { "Content-Type": "text/plain" },
              body: "{}",
            }),
          );
          return results;
        },
        [own.url, review.id] as const,
      );
      // From a page with no origin of its own the browser says what it says; the point is below.
      expect(Object.keys(outcome)).toHaveLength(4);

      // Whatever reached the server was turned away, and the review is as it was.
      const sent = (await readLog(own.logFile)).slice(logBefore);
      const lines = requestsOf(sent);
      expect(lines.some((line) => /^(POST|PATCH|DELETE) \S+ 2\d\d$/.test(line))).toBe(false);
      const detail = (await (await api.get(`/api/reviews/${review.id}`)).json()) as {
        findings: Array<{ decision: string }>;
      };
      expect(detail.findings.every((finding) => finding.decision === "pending")).toBe(true);
    } finally {
      await api.dispose();
      await own.close();
      await scratch.remove();
    }
  });

  test("a raw request that names a path with the token in it is still refused", async ({
    server,
  }) => {
    const token = server.accessToken ?? "";
    const url = new URL(server.url);
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `/api/reviews/${token}`,
          method: "GET",
          headers: { Cookie: `Authorization=Bearer ${token}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    expect(status).toBe(401);
  });
});
