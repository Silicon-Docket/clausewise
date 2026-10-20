import { readFile, readdir } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import JSZip from "jszip";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  request as playwrightRequest,
} from "@playwright/test";
import type { ReviewDetail } from "../../packages/api/src/index.js";
import { findChromium } from "../browser.js";
import { readDocx } from "../docx-reader.js";
import { SLOW_CLIENT_MARKER, UNANCHORED_CLIENT_MARKER, scriptedEdit } from "../oracle.js";
import {
  NDA_PLAYBOOK,
  card,
  decide,
  fixtureBytes,
  openStart,
  decisionLine,
  redlineButton,
  reviewContract,
  reviewIdOf,
  startReview,
  storedReview,
  waitForFindings,
} from "../pages.js";
import { REPO_ROOT, fixturePath } from "../paths.js";
import { auditPage, coveredControls, type AuditResult } from "../support/audit.js";
import { attackPage, startOtherSite } from "../support/evil-site.js";
import {
  NDA_PLAYBOOK_ID,
  SAAS_PLAYBOOK_ID,
  createReview,
  finishedReview,
  getReview,
  listDocuments,
  listReviews,
  uploadFixture,
} from "../support/api.js";
import {
  HOSTILE_QUOTE,
  HOSTILE_REPLACEMENT,
  HOSTILE_SNIPPETS,
  LONG_QUOTE,
  LONG_REPLACEMENT,
  buildHostileContract,
  buildLongContract,
  hostileModel,
  longContractModel,
} from "../support/contracts.js";
import { listenForFileChooser, pressTabUntil } from "../support/keyboard.js";
import { buildScreens, type ScreenSet } from "../support/screens.js";
import {
  makeScratch,
  readLog,
  requestsOf,
  restartOwnServer,
  startOwnServer,
} from "../support/servers.js";
import { expect, test } from "../support/tidy.js";
import { readRunState } from "../state.js";
import { watchPage, type PageWatch } from "../support/watch.js";

const NDA = "nda-aggressive.docx";
const SAAS = "saas-vendor-friendly.docx";
const originOf = (url: string): string => new URL(url).origin;

/** What a page may not do, said once for a whole screen's worth of watching. */
function expectClean(watch: PageWatch, screen: string): void {
  expect(watch.problems, `problems on the screen: ${screen}`).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// The measuring instruments
// ---------------------------------------------------------------------------------------------

// Contrast, target size and overflow are measured by code that runs in the page. A measurement that
// could not say "too low" would pass for ever, so these scenarios feed it pages whose answers are
// known from arithmetic done here, a second time and another way.
test.describe("the measuring instruments", () => {
  const channel = (value: number): number => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const luminance = (rgb: [number, number, number]): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
  const ratio = (a: [number, number, number], b: [number, number, number]): number => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (high + 0.05) / (low + 0.05);
  };

  const sample = (result: AuditResult, text: string): number => {
    const found = result.texts.find((item) => item.where.includes(`"${text}`));
    if (found === undefined) throw new Error(`The audit did not measure "${text}".`);
    return found.ratio;
  };

  test("contrast: plain, translucent, faded and dark pages give the ratios worked out by hand", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; background: #ffffff; color: #000000; font: 16px sans-serif; }
      .grey { color: #767676; }
      .light-grey { color: #777777; }
      .layered { background: rgba(255, 255, 255, 0.5); color: #000000; }
      .base { background: #808080; }
      .faded { opacity: 0.5; color: #000000; }
      .red { color: #ff0000; }
      .blue { color: #0000ff; }
      .green { color: #00ff00; background: #000000; }
      .picture { background-image: linear-gradient(#000, #fff); color: #fff; }
      .hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; color: #fefefe; }
    </style></head><body>
      <p id="p1">Black on white</p>
      <p class="grey">Grey seven six</p>
      <p class="light-grey">Grey seven seven</p>
      <div class="base"><p class="layered">Layered text</p></div>
      <p class="faded">Faded text</p>
      <p class="red">Pure red</p>
      <p class="blue">Pure blue</p>
      <p class="green">Pure green</p>
      <p class="picture">Text on a picture</p>
      <p class="hidden">Hidden text</p>
      <button disabled style="color:#eeeeee;background:#ffffff">Disabled</button>
    </body></html>`);
    const result = await page.evaluate(auditPage);

    expect(sample(result, "Black on white")).toBeCloseTo(21, 1);
    expect(sample(result, "Grey seven six")).toBeCloseTo(
      ratio([0x76, 0x76, 0x76], [255, 255, 255]),
      2,
    );
    expect(sample(result, "Grey seven six")).toBeGreaterThanOrEqual(4.5);
    // One step lighter is under the line, and the instrument says so.
    expect(sample(result, "Grey seven seven")).toBeCloseTo(
      ratio([0x77, 0x77, 0x77], [255, 255, 255]),
      2,
    );
    expect(sample(result, "Grey seven seven")).toBeLessThan(4.5);
    // The three primaries carry their own weights in the formula, which greys do not test. The
    // figures are the ones every contrast checker gives: 4.0, 8.59 and 15.3 to 1.
    expect(sample(result, "Pure red")).toBeCloseTo(4.0, 1);
    expect(sample(result, "Pure blue")).toBeCloseTo(8.59, 1);
    expect(sample(result, "Pure green")).toBeCloseTo(15.3, 1);
    // White at half strength over mid grey is 191.5 per channel.
    expect(sample(result, "Layered text")).toBeCloseTo(ratio([0, 0, 0], [191.5, 191.5, 191.5]), 1);
    // Black at half strength over white is mid grey, 127.5.
    expect(sample(result, "Faded text")).toBeCloseTo(
      ratio([127.5, 127.5, 127.5], [255, 255, 255]),
      1,
    );
    // Text on a picture cannot be measured, and is said not to have been, never passed.
    expect(result.texts.some((item) => item.where.includes("Text on a picture"))).toBe(false);
    expect(result.unmeasured.join("\n")).toContain("background image");
    // Text nobody can see, and disabled controls, are left out.
    expect(result.texts.some((item) => item.where.includes("Hidden text"))).toBe(false);
    expect(result.skippedDisabled).toBe(1);
  });

  test("contrast: a page that has no background of its own sits on the colour scheme's canvas", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setContent(`<!doctype html><html style="color-scheme: light dark"><head>
      <meta charset="utf-8"><style>p { color: #777777; font: 16px sans-serif; }</style></head>
      <body><p>Dark canvas</p></body></html>`);
    const dark = await page.evaluate(auditPage);
    expect(sample(dark, "Dark canvas")).toBeCloseTo(ratio([0x77, 0x77, 0x77], [18, 18, 18]), 1);

    await page.emulateMedia({ colorScheme: "light" });
    const light = await page.evaluate(auditPage);
    expect(sample(light, "Dark canvas")).toBeCloseTo(ratio([0x77, 0x77, 0x77], [255, 255, 255]), 1);
  });

  test("targets: small buttons are found, links in a sentence and well spaced ones are allowed", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 700 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; font: 16px/1.5 sans-serif; }
      .row { display: flex; gap: 40px; padding: 20px; }
      .small { width: 20px; height: 20px; padding: 0; border: 1px solid #000; }
      .big { width: 30px; height: 30px; padding: 0; }
      .crowd { display: flex; gap: 2px; padding: 20px; }
      .crowd a { display: inline-block; width: 16px; height: 16px; background: #444; }
      .alone a { display: inline-block; width: 16px; height: 16px; background: #444; }
      .clip { width: 360px; overflow-x: auto; }
      .wide { width: 700px; height: 10px; background: #ccc; }
    </style></head><body>
      <div class="row">
        <button class="small" id="small">x</button>
        <button class="big" id="big">y</button>
      </div>
      <p>See <a href="#a" style="font-size:10px">this small link</a> in a sentence.</p>
      <div class="crowd"><a href="#1" aria-label="one"></a><a href="#2" aria-label="two"></a></div>
      <div class="alone" style="padding:60px 20px"><a href="#3" aria-label="three"></a></div>
      <div class="clip"><div class="wide">inside a scroller</div></div>
    </body></html>`);
    const result = await page.evaluate(auditPage);
    const problems = result.targetProblems.map((item) => item.where);
    expect(problems.some((where) => where.startsWith("button#small"))).toBe(true);
    expect(problems.some((where) => where.startsWith("button#big"))).toBe(false);
    // Two 16 pixel links two pixels apart are a problem; one with room around it, or in a sentence, is not.
    expect(problems.filter((where) => where.startsWith("a "))).toHaveLength(2);
    expect(problems.some((where) => where.includes("this small link"))).toBe(false);
    // The wide box scrolls on its own, so it is not the page that is too wide.
    expect(result.scrollWidth).toBeLessThanOrEqual(result.innerWidth);
    expect(result.overflowing).toEqual([]);
  });

  test("overflow: a box wider than the window is found, and named", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 0; } .wide { width: 500px; height: 20px; background: #ccc; }
    </style></head><body><div class="wide" id="wide">too wide</div></body></html>`);
    const result = await page.evaluate(auditPage);
    expect(result.scrollWidth).toBeGreaterThan(result.innerWidth);
    expect(result.overflowing.join("\n")).toContain("wide");
  });
});

// ---------------------------------------------------------------------------------------------
// 1. Content security policy, console, headers
// ---------------------------------------------------------------------------------------------

test.describe("content security policy and headers", () => {
  const POLICY =
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

  test("every screen of the app loads under the policy with no violation, no error and no third party", async ({
    page,
    request,
    server,
  }) => {
    const watch = await watchPage(page, { origins: [originOf(server.url)] });

    // The start screen: empty, with a refused file, and with a file chosen.
    await openStart(page);
    expectClean(watch, "start");
    await page.getByLabel("Choose a Word file").setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("not a contract"),
    });
    await expect(page.getByRole("alert")).toContainText("not a Word .docx file");
    expectClean(watch, "start with a refused file");
    await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(NDA));
    await page
      .getByRole("textbox", { name: "Who are you acting for? (optional)" })
      .fill("Fabrikam Labs LLC, the Recipient");
    await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
    expectClean(watch, "start with a file chosen");

    // A review in each of its states: running, finished with a finding of each kind, cancelled.
    await page
      .getByRole("textbox", { name: "Who are you acting for? (optional)" })
      .fill(`Fabrikam Labs LLC ${SLOW_CLIENT_MARKER} ${UNANCHORED_CLIENT_MARKER}`);
    await page.getByRole("button", { name: "Start review" }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Rules checked" })).toBeVisible();
    expectClean(watch, "review in progress");
    await waitForFindings(page);
    expectClean(watch, "review finished");

    const term = card(page, "Duration of confidentiality obligations");
    await term.getByRole("button", { name: "Edit wording" }).click();
    await term.getByRole("textbox", { name: "Your wording" }).fill("end two (2) years later");
    await expect(term.getByRole("insertion")).toContainText("end two (2) years later");
    expectClean(watch, "wording editor open");
    await term.getByRole("button", { name: "Save and accept" }).click();
    await expect(term.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();
    await decide(page, "Remedies", "Reject");
    await page.getByText("Comment that goes into the Word file").first().click();
    await expect(page.getByRole("button", { name: "Download redline (1 accepted)" })).toBeEnabled();
    expectClean(watch, "decisions made");

    await page.getByRole("button", { name: "Delete the contract and its reviews" }).click();
    expectClean(watch, "delete question");
    await page.getByRole("button", { name: "Keep it" }).click();

    // A second contract with rules that need no change, folded away.
    const second = await finishedReview(request, { fixture: SAAS, playbookId: SAAS_PLAYBOOK_ID });
    await page.goto(`/#/reviews/${second.review.id}`);
    await waitForFindings(page);
    await page.getByText(/^Rules with nothing to change/).click();
    expectClean(watch, "review with rules folded away");

    // A review that is cancelled.
    await startReview(page, {
      fixture: NDA,
      playbook: NDA_PLAYBOOK,
      client: `Fabrikam Labs LLC ${SLOW_CLIENT_MARKER}`,
    });
    await page.getByRole("button", { name: "Cancel review" }).click();
    expectClean(watch, "cancel question");
    await page.getByRole("button", { name: "Stop the review" }).click();
    await expect(page.getByText("This review was cancelled")).toBeVisible();
    expectClean(watch, "review cancelled");

    // The playbooks: list, a built-in one, a copy with a mistake in it.
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playbooks" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Playbooks" })).toBeVisible();
    expectClean(watch, "playbooks");
    await page
      .getByRole("navigation", { name: "Playbooks" })
      .getByRole("button", { name: /^Mutual NDA/ })
      .click();
    await page.getByRole("button", { name: "Copy to edit" }).click();
    await page.getByRole("textbox", { name: "Playbook (YAML)" }).fill("name: [unclosed");
    await expect(page.getByText(/problem to fix|problems to fix/)).toBeVisible();
    expectClean(watch, "playbook with a mistake");

    // Addresses that lead nowhere.
    await page.goto("/#/nowhere");
    await expect(
      page.getByRole("heading", { name: "There is nothing at this address" }),
    ).toBeVisible();
    expectClean(watch, "unknown address");
    await page.goto("/#/reviews/00000000-0000-4000-8000-000000000000");
    await expect(
      page.getByRole("heading", { level: 1, name: "This review could not be opened" }),
    ).toBeVisible();
    expectClean(watch, "review that does not exist");
    await page.goto("/#/reviews/not-an-id");
    await expect(
      page.getByRole("heading", { level: 1, name: "This review could not be opened" }),
    ).toBeVisible();
    expectClean(watch, "review with a broken id");

    // Only the two reads of a review that is not there were refused, and only the page's own server was spoken to.
    expect(watch.badResponses.map(([status]) => status).sort()).toEqual([404, 404]);
    for (const url of watch.requests) {
      expect(new URL(url).origin, url).toBe(originOf(server.url));
    }
    // Everything the app loaded is its own: a script and a style sheet (the icon too, in browsers that fetch it).
    const assets = watch.requests.filter((url) => new URL(url).pathname.startsWith("/assets/"));
    const kinds = [...new Set(assets.map((url) => new URL(url).pathname.replace(/^.*\./, "")))];
    expect(kinds).toEqual(expect.arrayContaining(["css", "js"]));
    expect(kinds.filter((kind) => !["css", "js", "svg"].includes(kind))).toEqual([]);

    // Nothing was kept in the browser: no cookie, no storage, no cache, no worker.
    const kept = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
      workers: (await navigator.serviceWorker.getRegistrations()).length,
      cookie: document.cookie,
    }));
    expect(kept).toEqual({ local: 0, session: 0, databases: 0, caches: 0, workers: 0, cookie: "" });
    expect(await page.context().cookies()).toEqual([]);
  });

  test("the browser enforces the policy: inline script, a remote address, an inline style and a form elsewhere are blocked", async ({
    context,
    server,
  }) => {
    // A page of its own, because the violations here are on purpose and the scenario's own page
    // must end clean.
    const probe = await context.newPage();
    const watch = await watchPage(probe, { origins: [originOf(server.url)] });
    await probe.goto(`${server.url}/`);
    await expect(probe.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
    expect(watch.violations).toEqual([]);

    const tried = await probe.evaluate(async () => {
      const outcome: Record<string, string> = {};
      const script = document.createElement("script");
      script.textContent = "window.ranInline = true;";
      document.body.append(script);
      outcome["inline script"] = String((window as unknown as { ranInline?: boolean }).ranInline);

      document.body.setAttribute("style", "background: red");
      outcome["inline style"] = getComputedStyle(document.body).backgroundColor;

      try {
        await fetch("https://example.invalid/collect", { mode: "no-cors" });
        outcome["remote fetch"] = "sent";
      } catch {
        outcome["remote fetch"] = "blocked";
      }

      const image = new Image();
      image.src = "https://example.invalid/pixel.png";
      outcome["remote image"] = "requested";

      const form = document.createElement("form");
      form.action = "https://example.invalid/post";
      form.method = "post";
      form.target = "_self";
      document.body.append(form);
      form.requestSubmit();
      outcome["form elsewhere"] = "submitted";
      return outcome;
    });
    // The browser reports each refusal as an event of its own, a moment after the attempt.
    await expect
      .poll(() => watch.violations.map((line) => line.split(" ")[0]), { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^script-src/),
          expect.stringMatching(/^style-src/),
          "connect-src",
          "img-src",
          "form-action",
        ]),
      );

    expect(tried["inline script"]).toBe("undefined");
    expect(tried["inline style"]).not.toBe("rgb(255, 0, 0)");
    expect(tried["remote fetch"]).toBe("blocked");
    const directives = watch.violations.map((line) => line.split(" ")[0]);
    expect(directives.some((name) => name?.startsWith("script-src"))).toBe(true);
    expect(directives.some((name) => name?.startsWith("style-src"))).toBe(true);
    expect(directives).toContain("connect-src");
    expect(directives).toContain("img-src");
    expect(directives).toContain("form-action");
    // The page is still ours: it did not navigate to the other address.
    expect(new URL(probe.url()).origin).toBe(originOf(server.url));
    await probe.close();
  });

  test("the response headers of the page, an asset and the API", async ({ request }) => {
    const noCors = (headers: Record<string, string>): void => {
      expect(Object.keys(headers).filter((name) => name.startsWith("access-control-"))).toEqual([]);
    };
    const always = (headers: Record<string, string>): void => {
      expect(headers["x-content-type-options"]).toBe("nosniff");
      expect(headers["referrer-policy"]).toBe("no-referrer");
      expect(headers["x-frame-options"]).toBe("DENY");
      noCors(headers);
    };

    const html = await request.get("/", { headers: { Origin: "http://evil.example" } });
    expect(html.status()).toBe(200);
    const page = html.headers();
    expect(page["content-security-policy"]).toBe(POLICY);
    expect(page["cache-control"]).toBe("no-cache");
    expect(page["content-type"]).toMatch(/^text\/html/);
    always(page);

    // Every file the page names is served with the policy, the right type, and a cache that never
    // needs to ask again: the file names carry a hash of what is in them.
    const text = await html.text();
    // The page says what language it is in, and does not stop a person from zooming it.
    expect(text).toMatch(/<html lang="en">/);
    expect(text).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    expect(text).not.toMatch(/user-scalable|maximum-scale|minimum-scale/i);
    const names = [...text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? "");
    expect(names.length).toBeGreaterThanOrEqual(3);
    const types: Record<string, RegExp> = {
      js: /^text\/javascript/,
      css: /^text\/css/,
      svg: /^image\/svg\+xml/,
    };
    for (const name of names) {
      const asset = await request.get(name);
      expect(asset.status(), name).toBe(200);
      const headers = asset.headers();
      expect(headers["cache-control"], name).toBe("public, max-age=31536000, immutable");
      expect(headers["content-security-policy"], name).toBe(POLICY);
      expect(headers["content-type"], name).toMatch(types[name.replace(/^.*\./, "")] ?? /^$/);
      always(headers);
    }

    // The API: never kept by a cache, never readable by another site.
    for (const path of ["/api/config", "/api/playbooks", "/api/reviews", "/api/documents"]) {
      const response = await request.get(path, { headers: { Origin: "http://evil.example" } });
      expect(response.status(), path).toBe(200);
      expect(response.headers()["cache-control"], path).toBe("no-store");
      expect(response.headers()["content-type"], path).toMatch(/^application\/json/);
      always(response.headers());
    }
    for (const path of ["/api/nothing", "/api/reviews/not-an-id"]) {
      const response = await request.get(path);
      expect(response.status(), path).toBeGreaterThanOrEqual(400);
      expect(response.headers()["cache-control"], path).toBe("no-store");
      always(response.headers());
    }
    const refused = await request.post("/api/reviews", { form: { a: "b" } });
    expect(refused.status()).toBe(415);
    expect(refused.headers()["cache-control"]).toBe("no-store");
    always(refused.headers());
    const health = await request.get("/healthz");
    expect(health.status()).toBe(200);
    always(health.headers());

    // A preflight is not answered: there is nothing for another site to be allowed.
    const preflight = await request.fetch("/api/reviews", {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status()).toBeGreaterThanOrEqual(400);
    noCors(preflight.headers());
  });

  test("a path that climbs out of the web folder finds nothing", async ({ server }) => {
    // The request client tidies a path before it sends it, so these go out as they are written.
    const get = (
      path: string,
    ): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> =>
      new Promise((resolve, reject) => {
        const url = new URL(server.url);
        const outgoing = httpRequest(
          { host: url.hostname, port: url.port, path, method: "GET" },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
                headers: response.headers,
              }),
            );
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
    for (const path of [
      "/../../../../etc/passwd",
      "/assets/../../package.json",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/..%2f..%2fpackage.json",
      "/..%5c..%5cpackage.json",
      "/assets/%00.js",
      "/%2e%2e%2fserver%2fpackage.json",
      "//etc/passwd",
    ]) {
      const response = await get(path);
      expect([200, 404], path).toContain(response.status);
      // The only 200 is the page itself, for a path that the server reads as the root.
      if (response.status === 200) expect(response.body, path).toContain('<div id="root">');
      expect(response.body, path).not.toContain("root:");
      expect(response.body, path).not.toContain('"name"');
      expect(response.headers["x-content-type-options"], path).toBe("nosniff");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Host and origin
// ---------------------------------------------------------------------------------------------

test.describe("who may talk to the server", () => {
  test("a request addressed to another name is refused with 421, and this machine's own names are answered", async ({
    request,
    server,
  }) => {
    const port = new URL(server.url).port;
    for (const host of [
      "evil.example",
      `evil.example:${port}`,
      "localhost.evil.example",
      `127.0.0.1.evil.example:${port}`,
      "10.0.0.5",
      "[2001:db8::1]",
    ]) {
      for (const path of ["/api/config", "/api/playbooks", "/", "/healthz"]) {
        const response = await request.get(path, { headers: { Host: host } });
        expect(response.status(), `${host} ${path}`).toBe(421);
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("wrong_host");
        expect(body.error.message).toContain("CLAUSEWISE_ALLOWED_HOSTS");
      }
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, "LOCALHOST"]) {
      const response = await request.get("/api/config", { headers: { Host: host } });
      expect(response.status(), host).toBe(200);
    }
    // A name the owner listed is answered, and only that one.
    const scratch = await makeScratch("allowed-host");
    const listed = await startOwnServer({ dir: scratch.dir, allowedHosts: ["clausewise.test"] });
    try {
      const own = await request.get(`${listed.url}/api/config`, {
        headers: { Host: "clausewise.test" },
      });
      expect(own.status()).toBe(200);
      const other = await request.get(`${listed.url}/api/config`, {
        headers: { Host: "other.test" },
      });
      expect(other.status()).toBe(421);
    } finally {
      await listed.close();
      await scratch.remove();
    }
  });

  test("a name that points at this machine is refused even when the browser itself sends it", async ({
    server,
  }) => {
    const port = new URL(server.url).port;
    // The browser is told that rebind.example is this machine, as a DNS answer would tell it after
    // an attacker's name has been pointed at 127.0.0.1. Nothing is forged: the browser sends the
    // Host header it would send.
    const browser = await chromium.launch({
      ...(findChromium() === undefined ? {} : { executablePath: findChromium() as string }),
      args: ["--host-resolver-rules=MAP rebind.example 127.0.0.1"],
    });
    try {
      const context = await browser.newContext({ baseURL: `http://localhost:${port}` });
      const page = await context.newPage();
      const watch = await watchPage(page, {
        origins: [`http://localhost:${port}`, `http://rebind.example:${port}`],
      });

      const refused = await page.goto(`http://rebind.example:${port}/`);
      expect(refused?.status()).toBe(421);
      expect(await page.locator("#root").count()).toBe(0);
      expect(await page.locator("body").innerText()).toContain('"code":"wrong_host"');
      const api = await page.goto(`http://rebind.example:${port}/api/playbooks`);
      expect(api?.status()).toBe(421);
      expect(await page.locator("body").innerText()).not.toContain("Mutual NDA");

      // The same server under a name that is its own is the app, and everything works with it: a
      // review is started with an upload, which carries an Origin that must match the Host.
      await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
      await decide(page, "Duration of confidentiality obligations", "Accept");
      await expect(redlineButton(page, 1)).toBeEnabled();
      expect(page.url()).toMatch(/^http:\/\/localhost:/);
      expect(watch.problems.filter((problem) => !problem.includes("Failed to load"))).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  test("a request that changes something and names another site as its origin is refused with 403", async ({
    request,
    server,
  }) => {
    const { document, review } = await finishedReview(request, {
      fixture: NDA,
      playbookId: NDA_PLAYBOOK_ID,
    });
    const before = JSON.stringify(await (await request.get(`/api/reviews/${review.id}`)).json());
    const reviewsBefore = (await listReviews(request)).length;
    const forged = { Origin: "http://evil.example" };

    const attempts: Array<[string, () => Promise<{ status(): number; text(): Promise<string> }>]> =
      [
        [
          "start a review",
          () =>
            request.post("/api/reviews", {
              headers: forged,
              data: { documentId: document.id, playbookId: NDA_PLAYBOOK_ID },
            }),
        ],
        [
          "accept a finding",
          () =>
            request.patch(`/api/reviews/${review.id}/findings/term`, {
              headers: forged,
              data: { decision: "accepted" },
            }),
        ],
        [
          "accept everything",
          () =>
            request.patch(`/api/reviews/${review.id}/findings`, {
              headers: forged,
              data: { decision: "accepted" },
            }),
        ],
        [
          "delete the document",
          () => request.delete(`/api/documents/${document.id}`, { headers: forged }),
        ],
        [
          "delete the review",
          () => request.delete(`/api/reviews/${review.id}`, { headers: forged }),
        ],
        [
          "upload a file",
          () =>
            request.post("/api/documents", {
              headers: forged,
              multipart: {
                file: {
                  name: "x.docx",
                  mimeType: "application/octet-stream",
                  buffer: Buffer.from("PK"),
                },
              },
            }),
        ],
        [
          "write a playbook",
          () =>
            request.post("/api/playbooks", {
              headers: forged,
              data: { yaml: "name: evil\nrules: []" },
            }),
        ],
        [
          "a null origin, as a sandboxed frame sends",
          () =>
            request.post("/api/reviews", {
              headers: { Origin: "null" },
              data: { documentId: document.id, playbookId: NDA_PLAYBOOK_ID },
            }),
        ],
        [
          "an origin on this machine but another port",
          () =>
            request.post("/api/reviews", {
              headers: { Origin: "http://127.0.0.1:1" },
              data: { documentId: document.id, playbookId: NDA_PLAYBOOK_ID },
            }),
        ],
        [
          "an origin that is this machine under another name",
          () =>
            request.post("/api/reviews", {
              headers: { Origin: `http://localhost:${new URL(server.url).port}` },
              data: { documentId: document.id, playbookId: NDA_PLAYBOOK_ID },
            }),
        ],
      ];
    for (const [what, attempt] of attempts) {
      const response = await attempt();
      expect(response.status(), what).toBe(403);
      expect(JSON.parse(await response.text()).error.code, what).toBe("forbidden");
    }

    // Nothing moved.
    expect(JSON.stringify(await (await request.get(`/api/reviews/${review.id}`)).json())).toBe(
      before,
    );
    expect(await listReviews(request)).toHaveLength(reviewsBefore);
    expect((await listDocuments(request)).some((item) => item.id === document.id)).toBe(true);

    // The same requests from the page's own origin are what the app sends, and they are accepted.
    const own = { Origin: server.url };
    const accepted = await request.patch(`/api/reviews/${review.id}/findings/term`, {
      headers: own,
      data: { decision: "accepted" },
    });
    expect(accepted.status()).toBe(200);
  });

  test("a body that a form on another site could send without asking is refused with 415", async ({
    request,
    server,
  }) => {
    const { document } = await finishedReview(request, {
      fixture: NDA,
      playbookId: NDA_PLAYBOOK_ID,
    });
    const body = { documentId: document.id, playbookId: NDA_PLAYBOOK_ID };
    const reviewsBefore = (await listReviews(request)).length;

    const urlencoded = await request.post("/api/reviews", { form: body });
    expect(urlencoded.status()).toBe(415);
    const plain = await request.post("/api/reviews", {
      headers: { "Content-Type": "text/plain" },
      data: JSON.stringify(body),
    });
    expect(plain.status()).toBe(415);
    // A refusal that names the content type is the same with the page's own origin.
    const sameOrigin = await request.post("/api/reviews", {
      headers: { Origin: server.url, "Content-Type": "text/plain;charset=UTF-8" },
      data: JSON.stringify(body),
    });
    expect(sameOrigin.status()).toBe(415);
    const upload = await request.post("/api/documents", { form: { file: "PK" } });
    expect(upload.status()).toBe(415);
    for (const response of [urlencoded, plain, sameOrigin, upload]) {
      const parsed = (await response.json()) as { error: { code: string } };
      expect(parsed.error.code).toBe("unsupported_media_type");
    }
    expect(await listReviews(request)).toHaveLength(reviewsBefore);

    // A request with no body to read is the plainest thing a form on another site can send, and
    // what it asks for must not happen on the strength of a type nobody checked.
    const running = await uploadFixture(request, NDA);
    const slow = await createReview(request, {
      documentId: running.id,
      playbookId: NDA_PLAYBOOK_ID,
      client: `Fabrikam Labs LLC ${SLOW_CLIENT_MARKER}`,
    });
    const cancelAsText = await request.post(`/api/reviews/${slow.id}/cancel`, {
      headers: { "Content-Type": "text/plain" },
      data: "stop",
    });
    expect(cancelAsText.status()).toBe(415);
    const deleteAsForm = await request.delete(`/api/documents/${running.id}`, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      data: "a=b",
    });
    expect(deleteAsForm.status()).toBe(415);
    expect((await getReview(request, slow.id)).status).not.toBe("cancelled");
    expect((await listDocuments(request)).some((item) => item.id === running.id)).toBe(true);
  });

  test("a page on another site cannot read, change, upload or delete anything", async ({
    context,
    playwright,
  }) => {
    const scratch = await makeScratch("other-site");
    const target = await startOwnServer({ dir: scratch.dir });
    const api = await playwright.request.newContext({ baseURL: target.url });
    const other = await (async () => {
      const seeded = await finishedReview(api, { fixture: NDA, playbookId: NDA_PLAYBOOK_ID });
      const bytes = await fixtureBytes(NDA);
      return {
        seeded,
        site: await startOtherSite({
          "/": attackPage({
            target: target.url,
            documentId: seeded.document.id,
            reviewId: seeded.review.id,
            docxBase64: Buffer.from(bytes).toString("base64"),
          }),
        }),
      };
    })();
    try {
      // The control: the same kind of request made by a page of the server's own, which is what
      // the app does, is accepted. Without this the rest would pass against a server that refuses
      // everyone.
      const home = await context.newPage();
      await home.goto(`${target.url}/`);
      const control = await home.evaluate(
        async (bytes: number[]) => {
          const form = new FormData();
          form.append("file", new File([new Uint8Array(bytes)], "control.docx"));
          const response = await fetch("/api/documents", { method: "POST", body: form });
          return response.status;
        },
        [...(await fixtureBytes(NDA))],
      );
      expect(control).toBe(201);
      for (const item of await listDocuments(api)) {
        if (item.id !== other.seeded.document.id) {
          expect((await api.delete(`/api/documents/${item.id}`)).status()).toBe(204);
        }
      }
      await home.close();

      // What the server holds, before.
      const snapshot = async () => ({
        documents: JSON.stringify(await listDocuments(api)),
        reviews: JSON.stringify(await listReviews(api)),
        detail: JSON.stringify(
          await (await api.get(`/api/reviews/${other.seeded.review.id}`)).json(),
        ),
        files: (await readdir(join(target.dataDir, "documents"))).sort(),
      });
      const before = await snapshot();
      const logBefore = (await readLog(target.logFile)).length;
      expect(before.files).toHaveLength(1);

      // The other site's page runs every attempt it has.
      const attacker = await context.newPage();
      await attacker.goto(`${other.site.url}/`);
      await attacker.waitForFunction(
        () => (window as unknown as { finished: boolean }).finished,
        null,
        {
          timeout: 30_000,
        },
      );
      const results = await attacker.evaluate(
        () =>
          (window as unknown as { results: Record<string, { outcome: string; value?: unknown }> })
            .results,
      );

      // What the page itself could learn: nothing. Requests it could send were sent, and their
      // answers are hidden from it; reading needs permission the server never gives, and a
      // preflight is never answered, so the delete and the change never left the browser.
      for (const name of [
        "no-cors multipart upload",
        "no-cors multipart upload with credentials",
        "no-cors text/plain review",
        "no-cors form-encoded review",
      ]) {
        expect(results[name], name).toEqual({ outcome: "returned", value: "opaque" });
      }
      for (const name of [
        "read the review list",
        "read the configuration",
        "delete the document",
        "accept a finding",
        // PATCH is not a method a request without permission may use at all.
        "accept everything",
      ]) {
        expect(results[name]?.outcome, name).toBe("threw");
      }
      expect(results["read in no-cors mode"]).toEqual({
        outcome: "returned",
        value: { type: "opaque", status: 0, length: 0 },
      });

      // The server's side: not one thing changed.
      expect(await snapshot()).toEqual(before);
      const sent = (await readLog(target.logFile)).slice(logBefore);
      const changes = sent.filter((line) => line.msg === "request" && line.method !== "GET");
      // Every request that could have changed something was answered 403: the origin was not ours.
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.filter((line) => line.method === "POST").map((line) => line.status)).toEqual(
        changes.filter((line) => line.method === "POST").map(() => 403),
      );
      expect(changes.some((line) => (line.status ?? 0) < 400 && line.method !== "OPTIONS")).toBe(
        false,
      );
      expect(requestsOf(sent).join("\n")).not.toMatch(/POST \S+ 20\d/);

      // The page that is framed shows nothing of the app.
      const frame = attacker
        .frames()
        .find(
          (candidate) =>
            candidate !== attacker.mainFrame() && candidate.url().startsWith(target.url),
        );
      if (frame !== undefined) {
        expect(await frame.locator("#root").count()).toBe(0);
        expect(await frame.locator("text=Review a contract").count()).toBe(0);
      }
      await attacker.close();
    } finally {
      await api.dispose();
      await other.site.close();
      await target.close();
      await scratch.remove();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 4. Keyboard only
// ---------------------------------------------------------------------------------------------

test.describe("a lawyer who uses only the keyboard", () => {
  const TERM = "Duration of confidentiality obligations";
  const REMEDIES = "Remedies";

  /** The focus has an outline you can see: the control's own, or its label's for the hidden file input. */
  async function expectVisibleFocus(page: Page): Promise<void> {
    const ring = await page.evaluate(() => {
      let el = document.activeElement;
      if (el === null || el === document.body) return null;
      // The file input is hidden from the eye; the button that looks like it is its label.
      if (el instanceof HTMLInputElement && el.type === "file" && el.labels?.[0] !== undefined) {
        el = el.labels[0];
      }
      const css = getComputedStyle(el);
      return {
        what: el.tagName.toLowerCase(),
        style: css.outlineStyle,
        width: Number.parseFloat(css.outlineWidth),
      };
    });
    expect(ring, "something has the focus").not.toBeNull();
    expect(ring?.style, `the outline of the ${ring?.what}`).not.toBe("none");
    expect(ring?.width ?? 0, `the outline of the ${ring?.what}`).toBeGreaterThanOrEqual(2);
  }

  const focusedId = (page: Page): Promise<string> =>
    page.evaluate(() => document.activeElement?.id ?? "");

  test("upload, choose a playbook, start, accept, edit, save and download without touching a pointer", async ({
    page,
    server,
  }) => {
    const watch = await watchPage(page, { origins: [originOf(server.url)] });
    const choosers = listenForFileChooser(page);
    const term = await scriptedEdit(NDA, "term");
    const wording = "end two (2) years after the date of disclosure";
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();

    // The first Tab offers a way past the header, and the offer can be seen and taken.
    await page.keyboard.press("Tab");
    const skip = page.getByRole("button", { name: "Skip to the page content" });
    await expect(skip).toBeFocused();
    const box = await skip.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    expect(await focusedId(page)).toBe("main");
    // The next Tab is the first control of the page, not the header again.
    await page.keyboard.press("Tab");
    await expect(page.getByLabel(/^Choose a (Word|different) file$/)).toBeFocused();
    expect(await pressTabUntil(page, skip, { backwards: true, max: 10 })).toBe(4);

    // The file chooser opens from the keyboard, and its answer is what Enter and Space ask for.
    // The label changes once a file is chosen, so the input is found by either of its two names.
    const input = page.getByLabel(/^Choose a (Word|different) file$/);
    await pressTabUntil(page, input, { max: 10 });
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");
    await (await choosers.next()).setFiles(fixturePath(NDA));
    await expect(page.getByText("nda-aggressive.docx", { exact: false }).first()).toBeVisible();
    // Choosing a file does not take the focus from the control that was used.
    await expect(input).toBeFocused();

    // Remove, the playbook, the client, Start: in that order, each one reached by Tab.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Remove" })).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("Tab");
    const playbook = page.getByRole("combobox", { name: "Playbook" });
    await expect(playbook).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.type("SaaS");
    await expect(playbook).toHaveValue(SAAS_PLAYBOOK_ID);
    await page.keyboard.press("ArrowUp");
    await expect(playbook).toHaveValue(NDA_PLAYBOOK_ID);
    await page.keyboard.press("Tab");
    const client = page.getByRole("textbox", { name: "Who are you acting for? (optional)" });
    await expect(client).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.type("Fabrikam Labs LLC, the Recipient");
    await page.keyboard.press("Tab");
    const start = page.getByRole("button", { name: "Start review" });
    await expect(start).toBeFocused();
    await expectVisibleFocus(page);
    await page.keyboard.press("Enter");

    // The screen changes and the focus goes to the page, so that the next Tab starts at its top.
    await page.waitForURL(/#\/reviews\//);
    await waitForFindings(page);
    expect(await focusedId(page)).toBe("main");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "All reviews" })).toBeFocused();

    // Accept with Space. The button that was pressed keeps the focus while the change is saved
    // and after it.
    const accept = card(page, TERM).getByRole("button", { name: "Accept", exact: true });
    await pressTabUntil(page, accept);
    await expectVisibleFocus(page);
    await expect(accept).toHaveAttribute("aria-pressed", "false");
    const saved = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.status() === 200,
    );
    await page.keyboard.press("Space");
    await saved;
    await expect(accept).toHaveAttribute("aria-pressed", "true");
    await expect(accept).toBeFocused();
    await expect(accept).not.toHaveAttribute("aria-disabled", "true");
    // What happened was said to a screen reader, in the polite region that is always in the page.
    await expect(
      page.getByRole("status").filter({ hasText: `${TERM}: accepted. 1 accepted in all.` }),
    ).toHaveCount(1);

    // Reject another with Enter, then take the decision back with Reset, which goes away when it has
    // done its work: the focus moves to Accept of that card and not to the top of the page.
    const other = card(page, REMEDIES);
    await pressTabUntil(page, other.getByRole("button", { name: "Reject", exact: true }));
    await page.keyboard.press("Enter");
    const reset = other.getByRole("button", { name: "Reset", exact: true });
    await expect(reset).toBeVisible();
    await expect(other.getByRole("button", { name: "Reject", pressed: true })).toBeFocused();
    await pressTabUntil(page, reset);
    await page.keyboard.press("Enter");
    await expect(reset).toHaveCount(0);
    await expect(other.getByRole("button", { name: "Accept", exact: true })).toBeFocused();

    // Edit the wording of the accepted finding. Opening the box puts the cursor in it.
    const edit = card(page, TERM).getByRole("button", { name: "Edit wording" });
    await pressTabUntil(page, edit);
    await page.keyboard.press("Enter");
    const box2 = card(page, TERM).getByRole("textbox", { name: "Your wording" });
    await expect(box2).toBeFocused();
    await expectVisibleFocus(page);
    await expect(box2).toHaveValue(term.replacement);

    // Escape throws the draft away, closes the box, and puts the focus back on the button that
    // opened it. Nothing is sent to the server.
    let patches = 0;
    page.on("request", (request) => {
      if (request.method() === "PATCH") patches += 1;
    });
    await page.keyboard.type(" and then some");
    await page.keyboard.press("Escape");
    await expect(box2).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(card(page, TERM).getByRole("insertion")).toContainText(term.replacement);
    expect(patches).toBe(0);

    // Open it again, replace the wording, and save with the keyboard: Tab goes from the box to
    // Save, Enter presses it, the box closes, and the focus is back on Edit.
    await page.keyboard.press("Enter");
    await expect(box2).toBeFocused();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.type(wording);
    await page.keyboard.press("Tab");
    await expect(card(page, TERM).getByRole("button", { name: "Save wording" })).toBeFocused();
    await expectVisibleFocus(page);
    const stored = page.waitForResponse(
      (response) => response.request().method() === "PATCH" && response.status() === 200,
    );
    await page.keyboard.press("Enter");
    await stored;
    await expect(box2).toHaveCount(0);
    await expect(edit).toBeFocused();
    await expect(card(page, TERM).getByRole("insertion")).toContainText(wording);
    await expect(card(page, TERM).getByText("Suggested change, with your wording")).toBeVisible();

    // Back up the page with Shift+Tab to the download button, and press it. The file is made and
    // saved, and the button is where it was.
    const download = redlineButton(page, 1);
    await pressTabUntil(page, download, { backwards: true, max: 60 });
    await expectVisibleFocus(page);
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      page.waitForResponse((response) =>
        /\/api\/reviews\/[^/]+\/docx\?include=accepted$/.test(response.url()),
      ),
      page.keyboard.press("Enter"),
    ]);
    expect(file.suggestedFilename()).toBe("nda-aggressive.redlined.docx");
    await expect(download).toBeFocused();
    const redline = await readDocx(new Uint8Array(await readFile(await file.path())));
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions.map((change) => change.text)).toEqual([wording]);
    expect(redline.comments).toHaveLength(1);

    // The way between screens: a link of the header, taken with Enter, lands on the new screen's
    // heading, which is where a screen reader should start reading.
    const playbooks = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playbooks" });
    await pressTabUntil(page, playbooks, { backwards: true, max: 80 });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Playbooks" })).toBeFocused();
    const reviews = page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Reviews" });
    await pressTabUntil(page, reviews, { backwards: true, max: 10 });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeFocused();
    await expectVisibleFocus(page);

    expectClean(watch, "the whole keyboard run");
  });

  test("Space opens the file chooser as Enter does, and Shift+Tab walks back through the form", async ({
    page,
  }) => {
    const choosers = listenForFileChooser(page);
    await page.goto("/");
    const input = page.getByLabel(/^Choose a (Word|different) file$/);
    await pressTabUntil(page, input, { max: 10 });
    await page.keyboard.press("Space");
    await (await choosers.next()).setFiles(fixturePath(SAAS));
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();

    // Forward through the form: Remove, the playbook, the client, Start. Then back the way it came.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Start review" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("textbox", { name: "Who are you acting for? (optional)" }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("combobox", { name: "Playbook" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "Remove" })).toBeFocused();
    // Remove takes the file away, and the focus goes to the file chooser, not to the top.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Remove" })).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
  });

  test("the question before a cancel is answered from the keyboard, with the safe answer first", async ({
    page,
  }) => {
    await startReview(page, {
      fixture: NDA,
      playbook: NDA_PLAYBOOK,
      client: `Fabrikam Labs LLC ${SLOW_CLIENT_MARKER}`,
    });
    const cancel = page.getByRole("button", { name: "Cancel review" });
    await pressTabUntil(page, cancel, { max: 10 });
    await page.keyboard.press("Enter");
    // The question holds the focus on the answer that changes nothing.
    await expect(page.getByRole("button", { name: "Keep going" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(cancel).toBeFocused();
    await expect(page.getByRole("heading", { level: 2, name: "Review in progress" })).toBeVisible();

    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Stop the review" })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.getByText("This review was cancelled")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------------------------
// 5. Layout and colour on every screen
// ---------------------------------------------------------------------------------------------

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;
const SCHEMES = ["light", "dark"] as const;
/** WCAG 2.2: text 4.5 to 1 (1.4.3), pointer targets 24 by 24 CSS pixels (2.5.8). */
const MIN_CONTRAST = 4.5;

/** Waits for the page to have drawn what it was told to draw, twice over. */
const settled = (page: Page): Promise<void> =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );

/** What is wrong with one screen's measurements, in words that name the element. */
function faults(result: AuditResult): string[] {
  const found: string[] = [];
  if (result.scrollWidth > result.innerWidth) {
    found.push(
      `scrolls sideways: ${result.scrollWidth} wide in a window ${result.innerWidth} wide`,
    );
  }
  for (const item of result.overflowing) found.push(`sticks out of the window: ${item}`);
  for (const item of result.clipped) found.push(`cuts its own content off: ${item}`);
  for (const item of result.targetProblems) {
    found.push(`${item.why}: ${item.where} is ${item.width} by ${item.height}`);
  }
  for (const item of result.texts) {
    if (item.ratio < MIN_CONTRAST) {
      found.push(
        `contrast ${item.ratio.toFixed(2)} to 1 (${item.kind}, ${item.foreground} on ${item.background}): ${item.where}`,
      );
    }
  }
  for (const item of result.unmeasured) found.push(`could not be measured: ${item}`);
  if (result.texts.length === 0) found.push("has no text at all");
  return found;
}

const lowest = (result: AuditResult): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const text of result.texts) {
    out[text.kind] = Math.min(out[text.kind] ?? Infinity, Math.round(text.ratio * 100) / 100);
  }
  return out;
};

test.describe("layout and colour on every screen", () => {
  test.describe.configure({ mode: "serial" });
  let set: ScreenSet | undefined;

  test.beforeAll(async ({ playwright }) => {
    set = await buildScreens(playwright, readRunState());
  });
  test.afterAll(async () => {
    await set?.dispose();
  });

  for (const viewport of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      test(`${viewport.width} by ${viewport.height}, ${scheme}: no sideways scroll, targets of 24 pixels, text of 4.5 to 1`, async ({
        page,
      }, testInfo) => {
        if (set === undefined) throw new Error("The screens were not built.");
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme: scheme });
        const found: string[] = [];
        const report: Record<string, unknown> = {};
        let measured = 0;

        for (const screen of set.screens) {
          const undo = await screen.open(page);
          await settled(page);
          const result = await page.evaluate(auditPage);
          measured += 1;
          report[screen.name] = {
            texts: result.texts.length,
            targets: result.targets,
            skippedDisabled: result.skippedDisabled,
            lowestContrast: lowest(result),
          };
          for (const fault of faults(result)) found.push(`${screen.name}: ${fault}`);
          if (screen.picture === true) {
            // For a person to look at; nothing asserts on pixels.
            const file = join(
              REPO_ROOT,
              "test-results",
              "screenshots",
              `${screen.name.replace(/[^a-z0-9]+/gi, "-")}-${viewport.width}x${viewport.height}-${scheme}.png`,
            );
            await page.screenshot({ path: file, fullPage: true });
          }
          await undo?.();
        }

        await testInfo.attach("measurements.json", {
          body: JSON.stringify(report, null, 2),
          contentType: "application/json",
        });
        expect(measured).toBe(set.screens.length);
        expect(found).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 6. Zoom and reflow
// ---------------------------------------------------------------------------------------------

// What was done to approximate a browser zoomed to 400 percent with its text at 200 percent: the
// window is 320 CSS pixels wide, which is what a 1280 pixel window shows at 400 percent zoom (WCAG
// 1.4.10), and the root font size is set to 200 percent from the page's own script context, which
// is what a person who chose a larger default font size gets, as the sizes of the app are in rem.
// It is not the browser's zoom command, which Playwright cannot press. The size of the root font
// is set through the style object of the element, which the page's policy allows; a style sheet
// or a style attribute would be blocked by it.
test.describe("zoom and reflow", () => {
  const rootFontAt200 = (): void => {
    const apply = (): void => {
      document.documentElement.style.setProperty("font-size", "200%");
    };
    if (document.documentElement !== null) apply();
    else {
      new MutationObserver((_records, observer) => {
        if (document.documentElement !== null) {
          apply();
          observer.disconnect();
        }
      }).observe(document, { childList: true });
    }
  };

  async function expectUsable(page: Page, where: string): Promise<void> {
    await settled(page);
    const result = await page.evaluate(auditPage);
    expect(
      faults(result).filter((fault) => !fault.startsWith("contrast")),
      `${where}: layout at 320 pixels and 200 percent`,
    ).toEqual([]);
    expect(await page.evaluate(coveredControls), `${where}: controls covered by something`).toEqual(
      [],
    );
  }

  test("at 320 CSS pixels and 200 percent text the whole review can still be done", async ({
    page,
    server,
  }) => {
    const watch = await watchPage(page, { origins: [originOf(server.url)] });
    await page.setViewportSize({ width: 320, height: 640 });
    const term = await scriptedEdit(NDA, "term");

    // At 100 percent first, to know what each size is.
    const { id } = await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    const plain = await page.evaluate(auditPage);

    await page.addInitScript(rootFontAt200);
    await page.reload();
    await waitForFindings(page);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe(
      "32px",
    );
    const big = await page.evaluate(auditPage);

    // Every piece of text grew with the setting: none is fixed in pixels.
    const sizes = new Map<string, number>();
    for (const text of plain.texts) if (!sizes.has(text.where)) sizes.set(text.where, text.fontPx);
    const fixed: string[] = [];
    let compared = 0;
    for (const text of big.texts) {
      const before = sizes.get(text.where);
      if (before === undefined) continue;
      compared += 1;
      if (Math.abs(text.fontPx / before - 2) > 0.1) {
        fixed.push(`${text.where}: ${before}px became ${text.fontPx}px`);
      }
    }
    expect(compared).toBeGreaterThan(100);
    expect(fixed).toEqual([]);
    await expectUsable(page, "review");

    // Work through the review at this size: decide, reword, save, download.
    const finding = card(page, "Duration of confidentiality obligations");
    await finding.getByRole("button", { name: "Accept", exact: true }).click();
    await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();
    await finding.getByRole("button", { name: "Edit wording" }).click();
    await expectUsable(page, "review with the editor open");
    await finding
      .getByRole("textbox", { name: "Your wording" })
      .fill("end two (2) years after the date of disclosure");
    await finding.getByRole("button", { name: "Save wording" }).click();
    await expect(finding.getByRole("insertion")).toContainText("end two (2) years");
    await decide(page, "Remedies", "Reject");
    await finding.getByText("Comment that goes into the Word file").click();
    await expectUsable(page, "review with decisions");

    const [file] = await Promise.all([
      page.waitForEvent("download"),
      redlineButton(page, 1).click(),
    ]);
    const redline = await readDocx(new Uint8Array(await readFile(await file.path())));
    expect(redline.deletions.map((change) => change.text)).toEqual([term.quote]);
    expect(redline.insertions.map((change) => change.text)).toEqual([
      "end two (2) years after the date of disclosure",
    ]);

    // The other screens at this size.
    await page.goto("/#/playbooks");
    await expect(page.getByRole("heading", { level: 1, name: "Playbooks" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Playbooks" })
      .getByRole("button", { name: /^Mutual NDA/ })
      .click();
    await page.getByRole("button", { name: "Copy to edit" }).click();
    await expectUsable(page, "playbook editor");

    await openStart(page);
    await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(NDA));
    await expectUsable(page, "start with a file chosen");
    await page.getByRole("button", { name: "Start review" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expectClean(watch, "zoomed screens");
  });
});

// ---------------------------------------------------------------------------------------------
// 7. Long content
// ---------------------------------------------------------------------------------------------

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Opens a context of its own on a server of its own, with a watch on its page. */
async function openOn(
  browser: Browser,
  address: string,
  options: { acceptDownloads?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page; watch: PageWatch }> {
  const context = await browser.newContext({
    baseURL: address,
    locale: "en-US",
    reducedMotion: "reduce",
    acceptDownloads: options.acceptDownloads ?? true,
  });
  const page = await context.newPage();
  const watch = await watchPage(page, { origins: [originOf(address)] });
  return { context, page, watch };
}

/** A browser that runs in a UTF-8 locale, so that it can save a file under a name with accents in it. */
async function launchUtf8Browser(): Promise<Browser> {
  const executablePath = findChromium();
  return chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    env: { ...process.env, LC_ALL: "C.UTF-8", LANG: "C.UTF-8" } as Record<string, string>,
  });
}

/** Does what the start screen asks for, with a file made in memory instead of one from the fixtures. */
async function startWithBytes(
  page: Page,
  file: { name: string; bytes: Uint8Array },
  options: { client?: string } = {},
): Promise<void> {
  await openStart(page);
  await page.getByLabel("Choose a Word file").setInputFiles({
    name: file.name,
    mimeType: DOCX_TYPE,
    buffer: Buffer.from(file.bytes),
  });
  await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
  if (options.client !== undefined) {
    await page
      .getByRole("textbox", { name: "Who are you acting for? (optional)" })
      .fill(options.client);
  }
  await page.getByRole("button", { name: "Start review" }).click();
  await page.waitForURL(/#\/reviews\//);
}

test.describe("heavy content", () => {
  test("200 paragraphs and a clause of 3,000 words: the screen is drawn, the diff keeps to the changed words, and it stays quick", async ({
    browser,
  }, testInfo) => {
    test.setTimeout(150_000);
    const long = await buildLongContract();
    expect(long.paragraphs).toBeGreaterThanOrEqual(200);
    expect(long.longClauseWords).toBeGreaterThanOrEqual(3000);
    expect(long.longClauseText.split(LONG_QUOTE)).toHaveLength(2);

    const scratch = await makeScratch("long");
    const own = await startOwnServer({ dir: scratch.dir, model: longContractModel() });
    const { context, page, watch } = await openOn(browser, own.url);
    try {
      // Long tasks, which the page's own scripts make the browser wait for, are what a person feels.
      await page.addInitScript(() => {
        const durations: number[] = [];
        (window as unknown as { longTasks: number[] }).longTasks = durations;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) durations.push(entry.duration);
        }).observe({ type: "longtask", buffered: true });
      });
      const timings: Record<string, number> = {};
      const timed = async (name: string, action: () => Promise<void>): Promise<void> => {
        const started = Date.now();
        await action();
        timings[name] = Date.now() - started;
      };

      await timed("start to findings (ms)", async () => {
        await startWithBytes(page, { name: "long-contract.docx", bytes: long.bytes });
        await waitForFindings(page);
      });
      await expect(page.getByText("10 rules checked.")).toBeVisible();
      await expect(page.getByText("2 findings", { exact: true })).toBeVisible();

      const finding = card(page, "Duration of confidentiality obligations");

      // The clause is shown in part, with a way to the rest.
      const figure = finding.getByRole("figure", { name: "Clause 7.3, 7. Section number 7" });
      const quote = figure.getByRole("blockquote");
      const preview = await quote.innerText();
      expect(preview.length).toBeLessThanOrEqual(905);
      expect(preview.endsWith("...")).toBe(true);
      await timed("show the whole clause (ms)", async () => {
        await figure.getByRole("button", { name: "Show the whole clause" }).click();
        await expect(figure.getByRole("button", { name: "Show less" })).toBeVisible();
      });
      expect((await quote.innerText()).length).toBeGreaterThan(15_000);
      await figure.getByRole("button", { name: "Show less" }).click();

      // The change is two small marks inside the whole paragraph, and the paragraph is all there.
      const removed = finding.getByRole("deletion");
      const added = finding.getByRole("insertion");
      await expect(removed).toHaveCount(1);
      await expect(added).toHaveCount(1);
      expect(await removed.textContent()).toBe(`Removed: ${LONG_QUOTE}`);
      expect(await added.textContent()).toBe(`Added: ${LONG_REPLACEMENT}`);
      const paragraph = removed.locator("xpath=..");
      const text = await paragraph.innerText();
      expect(text.length).toBeGreaterThan(15_000);
      expect(text).toContain(
        `Recipient's obligations under this Agreement ${LONG_REPLACEMENT}`.slice(0, 44),
      );
      expect(text).toContain(", whether or not the parties proceed.");
      await expect(finding.getByText(/too long to compare word by word/)).toHaveCount(0);

      // The page scrolls, and the buttons far down it work.
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 1500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
      const accept = finding.getByRole("button", { name: "Accept", exact: true });
      await timed("accept (ms)", async () => {
        await accept.click();
        await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();
      });

      // The editor on the long paragraph opens, follows the typing, and saves.
      await timed("open the editor (ms)", async () => {
        await finding.getByRole("button", { name: "Edit wording" }).click();
        await expect(finding.getByRole("textbox", { name: "Your wording" })).toBeFocused();
      });
      const typed = " and then some more";
      await timed("type 19 characters, with the diff following (ms)", async () => {
        // The cursor starts at the front of the text; the words are added at the end.
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type(typed);
        // The shared word "and" splits the added words in two marks; the last holds the end of them.
        await expect(added.last()).toContainText("some more");
      });
      await timed("save the wording (ms)", async () => {
        await finding.getByRole("button", { name: "Save wording" }).click();
        await expect(finding.getByRole("textbox", { name: "Your wording" })).toHaveCount(0);
      });

      // The file made from it has the one change, in the one long paragraph, and every other
      // paragraph as it was.
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        redlineButton(page, 1).click(),
      ]);
      const redline = await readDocx(new Uint8Array(await readFile(await file.path())));
      const original = await readDocx(long.bytes);
      expect(redline.deletions.map((change) => change.text)).toEqual([LONG_QUOTE]);
      expect(redline.insertions.map((change) => change.text)).toEqual([LONG_REPLACEMENT + typed]);
      expect(redline.accepted).toHaveLength(original.accepted.length);
      expect(redline.rejected).toEqual(original.accepted);
      expect(redline.comments).toHaveLength(1);

      // On a phone the same screen does not scroll sideways.
      await page.setViewportSize({ width: 360, height: 740 });
      await settled(page);
      const phone = await page.evaluate(auditPage);
      expect(faults(phone)).toEqual([]);

      // How long it took is reported, and bounded only far from what a person would put up with.
      const longTasks = await page.evaluate(
        () => (window as unknown as { longTasks: number[] }).longTasks,
      );
      timings["longest stretch the page was busy (ms)"] = Math.round(Math.max(0, ...longTasks));
      await testInfo.attach("timings.json", {
        body: JSON.stringify(timings, null, 2),
        contentType: "application/json",
      });
      console.log(`Heavy contract timings: ${JSON.stringify(timings)}`);
      expect(timings["start to findings (ms)"]).toBeLessThan(60_000);
      expect(timings["accept (ms)"]).toBeLessThan(10_000);
      expect(timings["open the editor (ms)"]).toBeLessThan(10_000);
      expect(timings["type 19 characters, with the diff following (ms)"]).toBeLessThan(20_000);
      expect(timings["longest stretch the page was busy (ms)"]).toBeLessThan(5_000);
      expectClean(watch, "the long contract");
    } finally {
      await context.close();
      await own.close();
      await scratch.remove();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 8. File names, and text that is not what it looks like
// ---------------------------------------------------------------------------------------------

// Nothing a name or a contract holds may become markup, a path or an instruction. The checks do not
// reuse the server's own list of bad characters: they use the Unicode categories of control and
// format characters, and the code points of the bidirectional marks, written out here.
const BIDI_CODE_POINTS = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];
const hasBidi = (text: string): boolean =>
  [...text].some((char) => BIDI_CODE_POINTS.includes(char.codePointAt(0) ?? 0));
const hasControl = (text: string): boolean => /\p{Cc}|\u2028|\u2029/u.test(text);
const hasSeparator = (text: string): boolean => /[/\\]/.test(text);

/** What a Content-Disposition header says the name is, read two ways: the plain one and the starred one. */
function dispositionNames(header: string): { ascii: string; unicode: string } {
  const ascii = /filename="([^"]*)"/.exec(header)?.[1] ?? "";
  const starred = /filename\*=UTF-8''([^;]*)/.exec(header)?.[1] ?? "";
  return { ascii, unicode: decodeURIComponent(starred) };
}

test.describe("names and text that are not what they look like", () => {
  const E_ACUTE = String.fromCodePoint(0xe9);
  const RLO = String.fromCodePoint(0x202e);
  const BELL = String.fromCodePoint(7);

  // Chromium saves a download under the name the page gave it, and with the locale of the machine
  // it runs on set to C, which is the default of a container, it cannot write an accented name and
  // saves the file as "download", with no extension. That is a property of the machine and not of
  // the app, so this scenario runs its own browser in a UTF-8 locale, as every desktop is.
  test("a name with spaces, quotes, accents, a path and a right-to-left override is cleaned, shown, and saved under a safe name", async ({
    server,
    request,
  }) => {
    const browser = await launchUtf8Browser();
    const { context, page, watch } = await openOn(browser, server.url);
    try {
      const raw = `C:\\fakepath\\..\\..\\etc/Q3 "final" contrat r${E_ACUTE}sum${E_ACUTE} ${RLO}gnp.docx`;
      const cleaned = `Q3 "final" contrat r${E_ACUTE}sum${E_ACUTE} gnp.docx`;
      const stem = cleaned.replace(/\.docx$/, "");

      await startWithBytes(page, { name: raw, bytes: await fixtureBytes(NDA) });
      await waitForFindings(page);
      await decide(page, "Duration of confidentiality obligations", "Accept");

      // The name the page shows is the one the server cleaned: the base name, whole, with nothing
      // that reorders or hides.
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toHaveText(cleaned);
      const shown = (await heading.textContent()) ?? "";
      expect(hasBidi(shown) || hasControl(shown) || hasSeparator(shown)).toBe(false);
      const stored = (await listDocuments(request)).find((item) => item.fileName === cleaned);
      expect(stored?.fileName).toBe(cleaned);
      await expect(page).toHaveTitle(`${cleaned} - Clausewise`);

      // Each file the page offers is saved under a name that is safe on any system, and the server's
      // header says the same name two ways.
      const saved: Array<[string, Locator, RegExp, string]> = [
        [
          "the redline",
          redlineButton(page, 1),
          /\/docx\?include=accepted$/,
          `${stem}.redlined.docx`,
        ],
        [
          "the original",
          page.getByRole("button", { name: "Download the original file" }),
          /\/file$/,
          cleaned,
        ],
        [
          "the report",
          page.getByRole("button", { name: "Download the report (Markdown)" }),
          /format=md$/,
          `${stem}.summary.md`,
        ],
      ];
      for (const [what, button, route, expected] of saved) {
        const [file, response] = await Promise.all([
          page.waitForEvent("download"),
          page.waitForResponse((candidate) => route.test(candidate.url())),
          button.click(),
        ]);
        const header = response.headers()["content-disposition"] ?? "";
        // The whole header has one shape: a plain name that holds no quote and no backslash, and a
        // starred name that is percent-encoded down to the characters the standard allows.
        expect(header, `${what}: the header`).toMatch(
          /^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''(?:[A-Za-z0-9._~!-]|%[0-9A-F]{2})+$/,
        );
        expect(header.match(/"/g)?.length, `${what}: quotes in the header`).toBe(2);
        expect(header, `${what}: a backslash in the header`).not.toContain("\\");
        const names = dispositionNames(header);
        expect(names.unicode, `${what}: the starred name`).toBe(expected);
        expect(names.ascii, `${what}: the plain name`).toMatch(/^[\x20-\x7e]+$/);
        expect(names.ascii, `${what}: the plain name`).not.toMatch(/["\\/%]/);
        const onDisk = file.suggestedFilename();
        for (const [label, name] of [
          ["the header", names.unicode],
          ["the browser", onDisk],
        ] as const) {
          expect(hasSeparator(name), `${what}: ${label} has a path separator in ${name}`).toBe(
            false,
          );
          expect(hasControl(name), `${what}: ${label} has a control character`).toBe(false);
          expect(hasBidi(name), `${what}: ${label} has a direction mark`).toBe(false);
        }
        expect(onDisk, `${what}: the name the browser would save`).toContain("contrat");
        expect(onDisk).toContain("gnp");
        expect(
          onDisk.startsWith("."),
          `${what}: a name that starts with a dot hides the file`,
        ).toBe(false);
      }
      expectClean(watch, "the cleaned name");
    } finally {
      await context.close();
      await browser.close();
    }
  });

  test("markup in a file name stays text on every screen, and a name of any length fits", async ({
    page,
    server,
    request,
  }) => {
    const watch = await watchPage(page, { origins: [originOf(server.url)] });
    const markup = `<img src=x onerror="window.__pwned=1"> <b>bold.docx`;
    await startWithBytes(page, { name: markup, bytes: await fixtureBytes(NDA) });
    await waitForFindings(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(markup);
    await expect(page.locator("main img, main b, main script")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
    ).toBeUndefined();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Reviews" })
      .click();
    await expect(
      page.getByRole("region", { name: "Recent reviews" }).getByRole("link", { name: markup }),
    ).toBeVisible();
    await expect(page.locator("main img, main b")).toHaveCount(0);

    // A name of 250 characters with no break in it is cut to 200 with its extension, and the screens
    // do not grow sideways for it.
    const long = `${"a".repeat(246)}.docx`;
    await page.setViewportSize({ width: 360, height: 740 });
    await startWithBytes(page, { name: long, bytes: await fixtureBytes(NDA) });
    await waitForFindings(page);
    const heading = (await page.getByRole("heading", { level: 1 }).textContent()) ?? "";
    expect([...heading].length).toBeLessThanOrEqual(200);
    expect(heading.endsWith(".docx")).toBe(true);
    expect(faults(await page.evaluate(auditPage))).toEqual([]);
    const names = (await listDocuments(request)).map((item) => item.fileName);
    expect(names.every((name) => [...name].length <= 200)).toBe(true);
    await page.goto("/#/");
    await expect(page.getByRole("region", { name: "Recent reviews" })).toBeVisible();
    expect(faults(await page.evaluate(auditPage))).toEqual([]);
    expectClean(watch, "markup and long names");
  });

  test("names that clean to nothing, and control characters, are handled by the server in the same way", async ({
    request,
  }) => {
    const bytes = await fixtureBytes(NDA);
    const upload = async (name: string): Promise<string> => {
      const response = await request.post("/api/documents", {
        multipart: { file: { name, mimeType: DOCX_TYPE, buffer: Buffer.from(bytes) } },
      });
      expect(response.status(), name).toBe(201);
      return ((await response.json()) as { fileName: string }).fileName;
    };
    expect(await upload("../../")).toBe("contract.docx");
    expect(await upload("..\\..\\")).toBe("contract.docx");
    expect(await upload(`${RLO}${RLO}`)).toBe("contract.docx");
    expect(await upload("...")).toBe("contract.docx");
    expect(await upload(`bell${BELL}ring.docx`)).toBe("bellring.docx");
    expect(await upload(`..${"/"}..${"/"}passwd${RLO}.docx`)).toBe("passwd.docx");
  });

  test("a contract and a model that are full of markup are shown as text, and the file keeps the text", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const bytes = await buildHostileContract();
    const scratch = await makeScratch("hostile");
    const own = await startOwnServer({ dir: scratch.dir, model: hostileModel() });
    const { context, page, watch } = await openOn(browser, own.url);
    try {
      await startWithBytes(page, { name: "hostile.docx", bytes });
      await waitForFindings(page);

      // Everything is text. The page did not run anything, and no element came out of the text.
      expect(
        await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      await expect(
        page.locator("main img, main b, main script, main a[href^='javascript']"),
      ).toHaveCount(0);

      const finding = card(page, "Duration of confidentiality obligations");
      await expect(
        finding.getByText(HOSTILE_SNIPPETS.script, { exact: false }).first(),
      ).toBeVisible();
      await expect(finding.getByRole("insertion")).toContainText(HOSTILE_REPLACEMENT);
      await expect(finding.getByRole("deletion")).toContainText(HOSTILE_QUOTE);
      const clause = finding.getByRole("figure");
      await expect(clause).toContainText(HOSTILE_SNIPPETS.link);
      await expect(clause).toContainText(HOSTILE_SNIPPETS.entity);
      const missing = card(page, "Disclosure required by law");
      await expect(
        missing.getByText(HOSTILE_SNIPPETS.image, { exact: false }).first(),
      ).toBeVisible();
      await expect(page.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();

      // The wording editor shows what is typed as it is typed, tags included.
      await finding.getByRole("button", { name: "Edit wording" }).click();
      const box = finding.getByRole("textbox", { name: "Your wording" });
      await expect(box).toHaveValue(HOSTILE_REPLACEMENT);
      await box.fill(`<u>two</u> ${HOSTILE_SNIPPETS.image}`);
      await expect(finding.getByRole("insertion")).toContainText(
        `<u>two</u> ${HOSTILE_SNIPPETS.image}`,
      );
      await expect(page.locator("main img, main u")).toHaveCount(0);
      await box.fill(HOSTILE_REPLACEMENT);
      await finding.getByRole("button", { name: "Save and accept" }).click();
      await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();

      // The tags went into the Word file as the words they are.
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        redlineButton(page, 1).click(),
      ]);
      const redline = await readDocx(new Uint8Array(await readFile(await file.path())));
      expect(redline.deletions.map((change) => change.text)).toEqual([HOSTILE_QUOTE]);
      expect(redline.insertions.map((change) => change.text)).toEqual([HOSTILE_REPLACEMENT]);
      expect(redline.comments[0]?.text).toContain(HOSTILE_SNIPPETS.script);
      expect(redline.accepted.join("\n")).toContain(HOSTILE_SNIPPETS.entity);
      expectClean(watch, "hostile contract");
    } finally {
      await context.close();
      await own.close();
      await scratch.remove();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 9. The server goes away
// ---------------------------------------------------------------------------------------------

test.describe("when the server stops", () => {
  const LOST = "The server cannot be reached. This page keeps trying.";

  test("a review that is being followed says the connection is lost, keeps trying, and shows what became of it when the server is back", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const scratch = await makeScratch("restart");
    const first = await startOwnServer({ dir: scratch.dir });
    const api = await playwrightRequest.newContext({ baseURL: first.url });
    const { context, page } = await openOn(browser, first.url);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let second: Awaited<ReturnType<typeof startOwnServer>> | undefined;
    try {
      // One review runs and a second waits behind it, so that both a running and a waiting page can
      // be watched. (The server runs one review at a time.)
      const running = await uploadFixture(api, NDA);
      const slow = await createReview(api, {
        documentId: running.id,
        playbookId: NDA_PLAYBOOK_ID,
        client: `Fabrikam Labs LLC ${SLOW_CLIENT_MARKER}`,
      });
      const waiting = await uploadFixture(api, NDA);
      const behind = await createReview(api, {
        documentId: waiting.id,
        playbookId: NDA_PLAYBOOK_ID,
      });
      const other = await context.newPage();

      await page.goto(`/#/reviews/${slow.id}`);
      await expect(
        page.getByRole("heading", { level: 2, name: "Review in progress" }),
      ).toBeVisible();
      await other.goto(`/#/reviews/${behind.id}`);
      await expect(
        other.getByRole("heading", { level: 2, name: "Waiting to start" }),
      ).toBeVisible();
      const lost = (where: Page): Locator => where.getByRole("main").getByText(LOST);
      await expect(lost(page)).toHaveCount(0);

      // The server stops.
      await first.close();
      await expect(lost(page)).toBeVisible({ timeout: 15_000 });
      await expect(lost(other)).toBeVisible({ timeout: 15_000 });
      // It said so in words, to a screen reader as well, and the screen does not pretend that
      // the review is moving: the progress it last knew is still what it shows.
      await expect(page.getByRole("status").filter({ hasText: LOST })).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Cancel review" })).toBeVisible();

      // Asking to stop the review gets an answer too, in words, and the question can be asked again.
      await page.getByRole("button", { name: "Cancel review" }).click();
      await page.getByRole("button", { name: "Stop the review" }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "The Clausewise server could not be reached." }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Cancel review" })).toBeEnabled();

      // It stays like that while the server is away: no crash, no empty screen.
      await page.waitForTimeout(2500);
      await expect(lost(page)).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 1, name: "nda-aggressive.docx" }),
      ).toBeVisible();

      // The server comes back on the same port with the same data.
      second = await restartOwnServer(first, {}, scratch.dir);
      expect(second.port).toBe(first.port);

      // The review that was running was stopped with the server, and the page says so. The one that
      // waited is picked up, runs, and its page shows the findings, with no reload.
      await expect(page.getByText("This review was cancelled")).toBeVisible({ timeout: 20_000 });
      await expect(lost(page)).toHaveCount(0);
      await expect(other.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible({
        timeout: 40_000,
      });
      await expect(lost(other)).toHaveCount(0);
      await expect(
        other
          .getByRole("heading", { level: 2, name: "High severity (4)" })
          .or(other.getByRole("heading", { level: 2, name: /High severity/ })),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await api.dispose();
      await context.close();
      await second?.close().catch(() => {});
      await first.close().catch(() => {});
      await scratch.remove();
    }
  });

  test("decisions and downloads that are asked of a server that is away fail in words, put things back, and work when it returns", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const scratch = await makeScratch("away");
    const first = await startOwnServer({ dir: scratch.dir });
    const { context, page } = await openOn(browser, first.url);
    let second: Awaited<ReturnType<typeof startOwnServer>> | undefined;
    try {
      const { id } = await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
      const finding = card(page, "Duration of confidentiality obligations");
      await first.close();

      // A decision is shown at once and taken back, with the reason.
      await finding.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(
        finding.getByRole("alert").filter({
          hasText:
            "That change was not saved, and the finding is back as it was. The Clausewise server could not be reached.",
        }),
      ).toBeVisible();
      await expect(finding.getByRole("button", { name: "Accept", pressed: false })).toBeVisible();
      await expect(finding.getByText("Accepted", { exact: true })).toHaveCount(0);

      // So is a file that was asked for, and the button comes back.
      await page.getByRole("button", { name: "Download the original file" }).click();
      await expect(
        page.getByRole("alert").filter({
          hasText: "The file could not be downloaded. The Clausewise server could not be reached.",
        }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Download the original file" })).toBeEnabled();

      // And so is a contract that is deleted.
      await page.getByRole("button", { name: "Delete the contract and its reviews" }).click();
      await page.getByRole("button", { name: "Delete everything" }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "The contract was not deleted" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 1, name: "nda-aggressive.docx" }),
      ).toBeVisible();

      // The page does not know the server is back until it asks; asking again is all it takes.
      second = await restartOwnServer(first, {}, scratch.dir);
      await finding.getByRole("button", { name: "Accept", exact: true }).click();
      await expect(finding.getByRole("button", { name: "Accept", pressed: true })).toBeVisible();
      await expect(finding.getByRole("alert")).toHaveCount(0);
      const [file] = await Promise.all([
        page.waitForEvent("download"),
        redlineButton(page, 1).click(),
      ]);
      const redline = await readDocx(new Uint8Array(await readFile(await file.path())));
      expect(redline.insertions).toHaveLength(1);
      // The decision was kept by the restarted server, not only by the page.
      await page.reload();
      await waitForFindings(page);
      await expect(
        card(page, "Duration of confidentiality obligations").getByRole("button", {
          name: "Accept",
          pressed: true,
        }),
      ).toBeVisible();
      expect(page.url()).toContain(id);
    } finally {
      await context.close();
      await second?.close().catch(() => {});
      await first.close().catch(() => {});
      await scratch.remove();
    }
  });

  test("a review started while the server is away says so, keeps the form, and starts when it returns", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const scratch = await makeScratch("away-start");
    const first = await startOwnServer({ dir: scratch.dir });
    const { context, page } = await openOn(browser, first.url);
    let second: Awaited<ReturnType<typeof startOwnServer>> | undefined;
    try {
      await openStart(page);
      await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(NDA));
      await page
        .getByRole("textbox", { name: "Who are you acting for? (optional)" })
        .fill("Fabrikam Labs LLC, the Recipient");
      await first.close();

      await page.getByRole("button", { name: "Start review" }).click();
      const failure = page.getByRole("alert").filter({ hasText: "The review did not start" });
      await expect(failure).toContainText("The Clausewise server could not be reached.");
      // What was typed is still there, and the button can be pressed again.
      await expect(
        page.getByRole("textbox", { name: "Who are you acting for? (optional)" }),
      ).toHaveValue("Fabrikam Labs LLC, the Recipient");
      await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Start review" })).toBeFocused();

      second = await restartOwnServer(first, {}, scratch.dir);
      await page.getByRole("button", { name: "Start review" }).click();
      await page.waitForURL(/#\/reviews\//);
      await waitForFindings(page);
      await expect(page.getByText(/Acting for: Fabrikam Labs LLC, the Recipient/)).toBeVisible();
    } finally {
      await context.close();
      await second?.close().catch(() => {});
      await first.close().catch(() => {});
      await scratch.remove();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 10. What else a tester would try
// ---------------------------------------------------------------------------------------------

test.describe("what else a tester would try in an hour", () => {
  test("the back button, a new tab, a bookmark and addresses that are wrong", async ({
    page,
    context,
    server,
  }) => {
    const watch = await watchPage(page, { origins: [originOf(server.url)] });
    await openStart(page);
    await expect(page).toHaveTitle("Clausewise");
    const { id } = await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    await expect(page).toHaveTitle("nda-aggressive.docx - Clausewise");
    await decide(page, "Remedies", "Reject");

    // Back goes to the start screen, which lists the review, and forward comes back to it.
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Recent reviews" })
        .getByRole("link", { name: "nda-aggressive.docx" })
        .first(),
    ).toBeVisible();
    await page.goForward();
    await waitForFindings(page);
    await expect(
      card(page, "Remedies").getByRole("button", { name: "Reject", pressed: true }),
    ).toBeVisible();

    // The address is a bookmark: a tab that has never seen the review opens it.
    const tab = await context.newPage();
    await tab.goto(`/#/reviews/${id}`);
    await waitForFindings(tab);
    await expect(tab).toHaveTitle("nda-aggressive.docx - Clausewise");
    // A query string after the address changes nothing.
    await tab.goto(`/#/reviews/${id}?utm=1`);
    await tab.reload();
    await waitForFindings(tab);

    // Addresses that are wrong say so, and are not run as anything.
    for (const hash of [
      "#/reviews/%E0%A4%A",
      "#/playbooks/extra",
      "#/reviews",
      "#/reviews/",
      `#/reviews/${id}/extra`,
      "#/%3Cimg%20src=x%20onerror=window.__pwned=1%3E",
      "#/reviews/%3Cb%3E",
    ]) {
      await tab.goto(`/${hash}`);
      await tab.reload();
      const heading = tab.getByRole("heading", { level: 1 });
      await expect(heading, hash).toHaveText(
        /^(There is nothing at this address|This review could not be opened)$/,
      );
      expect(
        await tab.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      await expect(tab.locator("main img, main b")).toHaveCount(0);
    }
    for (const hash of ["#", "#/", "#//", "#/?x=1"]) {
      await tab.goto(`/${hash}`);
      await tab.reload();
      await expect(
        tab.getByRole("heading", { level: 1, name: "Review a contract" }),
        hash,
      ).toBeVisible();
    }
    await tab.goto("/#/playbooks");
    await expect(tab).toHaveTitle("Playbooks - Clausewise");
    // The header names the screen the person is on, for those who cannot see which one is lit.
    await expect(
      tab.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Playbooks" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      watch.problems.filter((problem) => !problem.includes("Failed to load resource")),
    ).toEqual([]);
  });

  test("pressing Start twice starts one review, and pressing Accept twice leaves the page and the server agreeing", async ({
    page,
    request,
  }) => {
    const documentsBefore = (await listDocuments(request)).length;
    const reviewsBefore = (await listReviews(request)).length;

    await openStart(page);
    await page.getByLabel("Choose a Word file").setInputFiles(fixturePath(NDA));
    await page.getByRole("button", { name: "Start review" }).dblclick();
    await page.waitForURL(/#\/reviews\//);
    await waitForFindings(page);
    await page.waitForTimeout(500);
    expect(await listDocuments(request)).toHaveLength(documentsBefore + 1);
    expect(await listReviews(request)).toHaveLength(reviewsBefore + 1);
    const id = reviewIdOf(page);

    // Two quick presses are one decision, or a decision and its undoing: the screen and the
    // server end up the same, and nothing is reported as an error.
    const finding = card(page, "Duration of confidentiality obligations");
    await finding.getByRole("button", { name: "Accept", exact: true }).dblclick();
    await expect(finding.getByText("Saving...")).toHaveCount(0);
    const pressed = await finding
      .getByRole("button", { name: "Accept", exact: true })
      .getAttribute("aria-pressed");
    const stored = await storedReview(request, id);
    expect(stored.findings.find((item) => item.ruleId === "term")?.decision).toBe(
      pressed === "true" ? "accepted" : "pending",
    );
    await expect(finding.getByRole("alert")).toHaveCount(0);
    // Pressing everything at once does not leave a half-saved screen either.
    await Promise.all([
      page.getByRole("button", { name: "Accept all findings" }).click(),
      page.getByRole("button", { name: "Reject all findings" }).click({ force: true }),
    ]);
    await expect(page.getByRole("button", { name: "Accept all findings" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
    const after = await storedReview(request, id);
    const counts = { accepted: 0, rejected: 0, pending: 0 };
    for (const item of after.findings) counts[item.decision] += 1;
    await decisionLine(page, counts).waitFor();
  });

  test("a file that cannot be used is refused in words, nothing is kept of it, and the form takes a good one next", async ({
    page,
    request,
  }) => {
    const documentsBefore = (await listDocuments(request)).length;
    await openStart(page);
    // The label changes once a file is chosen, so the input is found by either of its two names.
    const input = page.getByLabel(/^Choose a (Word|different) file$/);
    const alert = page.getByRole("alert");
    const refuse = async (
      file: { name: string; mimeType: string; buffer: Buffer },
      text: string | RegExp,
    ): Promise<void> => {
      await input.setInputFiles(file);
      await expect(alert).toContainText(text);
      await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
    };
    await refuse(
      { name: "old.doc", mimeType: "application/msword", buffer: Buffer.from("x") },
      "old Word format (.doc)",
    );
    await refuse(
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") },
      "not a Word .docx file",
    );
    await refuse(
      { name: "empty.docx", mimeType: DOCX_TYPE, buffer: Buffer.alloc(0) },
      "That file is empty.",
    );
    await refuse(
      { name: "big.docx", mimeType: DOCX_TYPE, buffer: Buffer.alloc(26 * 1024 * 1024) },
      "That file is 26 MB, and the largest this server accepts is 25 MB.",
    );

    // Files that look right and are not are refused by the server, in its words, and the page keeps
    // the form so that another file can be tried.
    const zip = new JSZip();
    zip.file("hello.txt", "not a document");
    const notWord = Buffer.from(await zip.generateAsync({ type: "uint8array" }));
    const oldBinary = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    for (const [name, buffer] of [
      ["fake.docx", Buffer.from("PK\u0003\u0004 and then nothing that is a zip")],
      ["zip-but-not-word.docx", notWord],
      ["really-old.docx", oldBinary],
    ] as const) {
      await input.setInputFiles({ name, mimeType: DOCX_TYPE, buffer });
      await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
      await page.getByRole("button", { name: "Start review" }).click();
      const failure = page.getByRole("alert").filter({ hasText: "The review did not start" });
      await expect(failure, name).toBeVisible();
      const said = (await failure.innerText()).replace(/\s+/g, " ");
      // Plain words: nothing of the machine, no stack, no path, no file name of the server's.
      expect(said, name).not.toMatch(
        /node_modules|\/home\/|\bat [A-Za-z]+\.|TypeError|Error:|stack|\.ts:\d/,
      );
      expect(said.length, name).toBeGreaterThan("The review did not start".length + 10);
      await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Start review" })).toBeFocused();
    }
    expect(await listDocuments(request)).toHaveLength(documentsBefore);

    // A good file, chosen in place of the bad one, goes through.
    await input.setInputFiles(fixturePath(NDA));
    await page.getByRole("button", { name: "Start review" }).click();
    await page.waitForURL(/#\/reviews\//);
    await waitForFindings(page);
    expect(await listDocuments(request)).toHaveLength(documentsBefore + 1);
  });

  test("a file dropped on the box is chosen, and one that is not a contract is refused", async ({
    page,
  }) => {
    await openStart(page);
    const box = page.getByRole("group", { name: "Contract" });
    const dropped = async (name: string, bytes: Uint8Array) =>
      page.evaluateHandle(
        ([fileName, encoded]) => {
          const transfer = new DataTransfer();
          const content = Uint8Array.from(atob(encoded as string), (c) => c.charCodeAt(0));
          transfer.items.add(new File([content], fileName as string));
          return transfer;
        },
        [name, Buffer.from(bytes).toString("base64")],
      );

    await box.dispatchEvent("dragover", {
      dataTransfer: await dropped("nda-aggressive.docx", await fixtureBytes(NDA)),
    });
    await expect(page.locator(".dropzone-active")).toHaveCount(1);
    await box.dispatchEvent("dragleave");
    await expect(page.locator(".dropzone-active")).toHaveCount(0);
    await box.dispatchEvent("drop", {
      dataTransfer: await dropped("nda-aggressive.docx", await fixtureBytes(NDA)),
    });
    await expect(page.getByRole("button", { name: "Remove" })).toBeVisible();
    await expect(page.getByText("nda-aggressive.docx", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Start review" })).toBeEnabled();

    await box.dispatchEvent("drop", {
      dataTransfer: await dropped("picture.png", new Uint8Array([1, 2, 3])),
    });
    await expect(page.getByRole("alert")).toContainText("not a Word .docx file");
    await expect(page.getByRole("button", { name: "Start review" })).toBeDisabled();
  });

  test("a running review is read once a second, one request at a time, and not at all once it has ended or the screen is left", async ({
    page,
    request,
  }) => {
    const { review } = await finishedReview(request, { fixture: NDA, playbookId: NDA_PLAYBOOK_ID });
    const id = review.id;
    let phase: "running" | "done" = "running";
    const hits: number[] = [];
    let inFlight = 0;
    let busiest = 0;
    const matches = (url: URL): boolean => url.pathname === `/api/reviews/${id}`;
    await page.route(matches, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      hits.push(Date.now());
      inFlight += 1;
      busiest = Math.max(busiest, inFlight);
      try {
        const response = await route.fetch();
        const detail = (await response.json()) as ReviewDetail;
        await route.fulfill({
          response,
          json:
            phase === "running"
              ? {
                  ...detail,
                  status: "running",
                  progress: { done: 3, total: 10 },
                  findings: [],
                  results: [],
                  counts: null,
                  stats: null,
                  open: null,
                  finishedAt: null,
                }
              : detail,
        });
      } finally {
        inFlight -= 1;
      }
    });

    await page.goto(`/#/reviews/${id}`);
    await expect(page.getByText("3 of 10 rules checked")).toBeVisible();
    const startedAt = hits.length;
    await page.waitForTimeout(5200);
    const polled = hits.length - startedAt;
    expect(polled, "reads in about five seconds").toBeGreaterThanOrEqual(3);
    expect(polled, "reads in about five seconds").toBeLessThanOrEqual(7);
    expect(busiest, "reads at the same time").toBe(1);

    // It ends: the next read brings the findings, and then the reading stops.
    phase = "done";
    await waitForFindings(page);
    const atEnd = hits.length;
    await page.waitForTimeout(3500);
    expect(hits.length, "reads after the review ended").toBe(atEnd);

    // Leaving while it runs stops the reading as well.
    phase = "running";
    await page.reload();
    await expect(page.getByText("3 of 10 rules checked")).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Playbooks" })
      .click();
    await expect(page.getByRole("heading", { level: 1, name: "Playbooks" })).toBeVisible();
    const atLeaving = hits.length;
    await page.waitForTimeout(3500);
    expect(hits.length - atLeaving, "reads after the screen was left").toBeLessThanOrEqual(1);
  });

  test("two tabs on one review: each tells the server what its person did, and the last word stands", async ({
    page,
    context,
    request,
  }) => {
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    const id = reviewIdOf(page);
    const second = await context.newPage();
    await second.goto(`/#/reviews/${id}`);
    await waitForFindings(second);

    await decide(page, "Remedies", "Accept");
    await decide(second, "Remedies", "Reject");
    // The first tab is not told: it still shows what its person did. Pressing Accept there again
    // takes that decision back, as it says it will.
    await expect(
      card(page, "Remedies").getByRole("button", { name: "Accept", pressed: true }),
    ).toBeVisible();
    await decide(page, "Remedies", "Reset");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(second.getByRole("alert")).toHaveCount(0);

    await page.reload();
    await waitForFindings(page);
    const stored = await storedReview(request, id);
    expect(stored.findings.find((item) => item.ruleId === "remedies")?.decision).toBe("pending");
    await expect(
      card(page, "Remedies").getByRole("button", { name: "Accept", pressed: false }),
    ).toBeVisible();
  });

  test("another language and another time zone do not break the dates", async ({
    browser,
    server,
    request,
  }) => {
    const { review } = await finishedReview(request, { fixture: NDA, playbookId: NDA_PLAYBOOK_ID });
    const context = await browser.newContext({
      baseURL: server.url,
      locale: "ja-JP",
      timezoneId: "Pacific/Kiritimati",
    });
    try {
      const page = await context.newPage();
      await page.goto(`/#/reviews/${review.id}`);
      await waitForFindings(page);
      const meta = await page
        .getByText(/^Playbook: /)
        .first()
        .innerText();
      expect(meta).not.toContain("Invalid");
      expect(meta).toMatch(/Started .*\d/);
      await page.goto("/#/");
      await page.reload();
      const list = page.getByRole("region", { name: "Recent reviews" });
      await expect(list).toBeVisible();
      expect(await list.innerText()).not.toContain("Invalid");
    } finally {
      await context.close();
    }
  });

  test("a change is never told by colour alone, in any colour setting, and the contract text can be selected", async ({
    page,
    request,
  }, testInfo) => {
    const { review } = await finishedReview(request, {
      fixture: NDA,
      playbookId: NDA_PLAYBOOK_ID,
      client: UNANCHORED_CLIENT_MARKER,
    });
    await page.goto(`/#/reviews/${review.id}`);
    await waitForFindings(page);
    await decide(page, "Duration of confidentiality obligations", "Accept");

    const looks = () =>
      page.evaluate(() => {
        const first = <T extends Element>(selector: string): T => {
          const el = document.querySelector<T>(selector);
          if (el === null) throw new Error(`No ${selector} on the page.`);
          return el;
        };
        const style = (el: Element) => getComputedStyle(el);
        return {
          removed: style(first("del")).textDecorationLine,
          added: style(first("ins")).textDecorationLine,
          // Each badge and chip has a word, and a shape that differs from the others'.
          badges: [...document.querySelectorAll(".severity")].map((el) => ({
            word: (el.textContent ?? "").trim(),
            // The outline of the shape: a triangle, a diamond and a circle are three drawings.
            shape: (() => {
              const drawn = el.querySelector("svg path, svg circle");
              return drawn === null
                ? ""
                : `${drawn.tagName}:${drawn.getAttribute("d") ?? drawn.getAttribute("r") ?? ""}`;
            })(),
          })),
          chips: [...document.querySelectorAll(".decision")].map((el) => ({
            word: (el.textContent ?? "").trim(),
            hasShape: el.querySelector("svg") !== null,
          })),
          select: style(first("blockquote")).userSelect,
          buttonBorder: style(first("button.button")).borderTopStyle,
        };
      });

    for (const forced of ["none", "active"] as const) {
      await page.emulateMedia({ forcedColors: forced });
      const seen = await looks();
      expect(seen.removed, `struck through with forced colors ${forced}`).toContain("line-through");
      expect(seen.added, `underlined with forced colors ${forced}`).toContain("underline");
      expect(seen.select).not.toBe("none");
      expect(seen.buttonBorder, `a button has an edge with forced colors ${forced}`).not.toBe(
        "none",
      );
      expect(seen.badges.length).toBeGreaterThan(0);
      for (const badge of seen.badges) {
        expect(badge.word).toMatch(/^(High|Medium|Low)/);
        expect(badge.shape).not.toBe("");
      }
      // Three severities, three shapes.
      const shapes = new Map(seen.badges.map((badge) => [badge.word.split(" ")[0], badge.shape]));
      expect(new Set(shapes.values()).size).toBe(shapes.size);
      for (const chip of seen.chips) {
        expect(chip.word).toMatch(/^(Accepted|Rejected|Not decided)$/);
        expect(chip.hasShape).toBe(true);
      }
      const file = join(
        REPO_ROOT,
        "test-results",
        "screenshots",
        `review-forced-colors-${forced}.png`,
      );
      await page.screenshot({ path: file, fullPage: false });
      await testInfo.attach(`forced-colors-${forced}`, { path: file, contentType: "image/png" });
    }
    // The focus is drawn when colours are forced as well.
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const css = getComputedStyle(document.activeElement ?? document.body);
      return { style: css.outlineStyle, width: Number.parseFloat(css.outlineWidth) };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThanOrEqual(2);
  });

  test("text that is too long for a box is stopped in the box, or refused by the server in words that leave the draft alone", async ({
    page,
    request,
    server,
  }) => {
    await openStart(page);
    const client = page.getByRole("textbox", { name: "Who are you acting for? (optional)" });
    await client.focus();
    await page.keyboard.insertText("c".repeat(400));
    expect((await client.inputValue()).length).toBe(300);

    // The server says the same when it is asked directly.
    const { document } = await finishedReview(request, {
      fixture: NDA,
      playbookId: NDA_PLAYBOOK_ID,
    });
    const tooLong = await request.post("/api/reviews", {
      headers: { Origin: server.url },
      data: { documentId: document.id, playbookId: NDA_PLAYBOOK_ID, client: "c".repeat(301) },
    });
    expect(tooLong.status()).toBe(400);

    // A wording over the limit, put into the box in one go (as a paste would), is refused by the
    // server with its reason, the box stays open with the text, and a shorter one is accepted.
    await reviewContract(page, { fixture: NDA, playbook: NDA_PLAYBOOK });
    const finding = card(page, "Duration of confidentiality obligations");
    await finding.getByRole("button", { name: "Edit wording" }).click();
    const box = finding.getByRole("textbox", { name: "Your wording" });
    await box.evaluate((el: HTMLTextAreaElement) => {
      el.removeAttribute("maxlength");
    });
    await box.fill("w".repeat(20_001));
    await finding.getByRole("button", { name: "Save wording" }).click();
    const refusal = finding.getByRole("alert");
    await expect(refusal).toContainText("That change was not saved");
    await expect(refusal).toContainText("20000");
    await expect(box).toBeVisible();
    expect((await box.inputValue()).length).toBe(20_001);
    await box.fill("end two (2) years after the date of disclosure");
    await finding.getByRole("button", { name: "Save wording" }).click();
    await expect(box).toHaveCount(0);
    await expect(finding.getByRole("alert")).toHaveCount(0);
  });

  test("a second visit does not fetch the script and the style sheet again", async ({
    page,
    server,
  }) => {
    const staticHits = async (): Promise<number> =>
      (await readLog(server.logFile)).filter(
        (line) =>
          line.msg === "request" &&
          line.method === "GET" &&
          !(line.route ?? "").startsWith("/api") &&
          line.route !== "/healthz",
      ).length;
    const before = await staticHits();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
    const first = (await staticHits()) - before;
    expect(first, "files fetched on the first visit").toBeGreaterThanOrEqual(3);
    await page.goto("/?again=1");
    await expect(page.getByRole("heading", { level: 1, name: "Review a contract" })).toBeVisible();
    const second = (await staticHits()) - before - first;
    // The page itself is asked for again, as its cache header says; its files are not.
    expect(second, "files fetched on the second visit").toBe(1);
  });
});

// (end of the groups written so far)
