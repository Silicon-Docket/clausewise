import type { Page } from "@playwright/test";

/**
 * Everything a page does that a lawyer should never have to notice, collected while a test runs:
 * content security policy violations, console errors and warnings, uncaught errors, dialogs,
 * windows, failed requests, and any request that leaves the server the page came from.
 */
export interface PageWatch {
  /** Each thing that went wrong, in the order it happened. Empty is the goal. */
  problems: string[];
  /** The events of the browser's own `securitypolicyviolation`, as text. A subset of `problems`. */
  violations: string[];
  /** The address of every request the page made, in order. */
  requests: string[];
  /** Responses with a status of 400 or more: `[status, address]`. Not problems by themselves. */
  badResponses: Array<[number, string]>;
}

export interface WatchOptions {
  /**
   * The origins the page may talk to, such as `http://127.0.0.1:41234`. A request to any other
   * http or https address is a problem: the app calls no third party.
   */
  origins: readonly string[];
}

let bindings = 0;

// Chromium reports every response of 400 or more as a console error of this form. The response is
// recorded in `badResponses` instead, so that a test can say which ones it expects.
const RESOURCE_FAILURE = /^Failed to load resource/;

/**
 * Starts watching a page. Call it before the page is opened. The init script runs in every
 * document, before the page's own scripts, so a violation during start up is not missed.
 */
export async function watchPage(page: Page, options: WatchOptions): Promise<PageWatch> {
  const watch: PageWatch = { problems: [], violations: [], requests: [], badResponses: [] };

  const binding = `__clausewiseReportViolation${(bindings += 1)}`;
  await page.exposeFunction(binding, (text: string) => {
    watch.violations.push(text);
    watch.problems.push(`content security policy violation: ${text}`);
  });
  await page.addInitScript((name: string) => {
    document.addEventListener(
      "securitypolicyviolation",
      (event) => {
        const report = (window as unknown as Record<string, (text: string) => void>)[name];
        report?.(
          `${event.effectiveDirective} blocked ${event.blockedURI || "(inline)"} at ${event.sourceFile || "(page)"}:${event.lineNumber}`,
        );
      },
      true,
    );
  }, binding);

  page.on("console", (message) => {
    const type = message.type();
    if (type !== "error" && type !== "warning") return;
    if (RESOURCE_FAILURE.test(message.text())) return;
    watch.problems.push(`console ${type}: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    watch.problems.push(`uncaught error: ${error.message}`);
  });
  page.on("dialog", (dialog) => {
    watch.problems.push(`${dialog.type()} dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on("popup", (popup) => {
    watch.problems.push(`the page opened a window: ${popup.url()}`);
  });
  page.on("request", (request) => {
    const url = request.url();
    watch.requests.push(url);
    if (!/^https?:/i.test(url)) return;
    if (!options.origins.includes(new URL(url).origin)) {
      watch.problems.push(`a request left the server: ${url}`);
    }
  });
  page.on("requestfailed", (request) => {
    // The app aborts a read when its screen goes away; that is not a failure.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    watch.problems.push(
      `request failed: ${request.url()} (${request.failure()?.errorText ?? "?"})`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400) watch.badResponses.push([response.status(), response.url()]);
  });
  return watch;
}
