import { expect, test as base } from "@playwright/test";
import { readRunState, type ServerInfo, type ServerName } from "./state.js";

export { expect };

/**
 * Playwright's `test`, with the servers of the run wired in. Every test talks to the `main` server
 * unless its describe block says `test.use({ serverName: "token" })`. The base URL follows from
 * that, so `page.goto("/")` and the `request` fixture reach the right server.
 *
 * Every test also fails if its page threw an error nobody caught, or the browser logged a console
 * error. That is how a content security policy that blocks something, or a bug that only shows in
 * a real browser, is noticed by scenarios that were not looking for it.
 */
export const test = base.extend<{
  serverName: ServerName;
  server: ServerInfo;
  pageProblems: void;
}>({
  serverName: ["main", { option: true }],
  server: async ({ serverName }, use) => {
    await use(readRunState()[serverName]);
  },
  baseURL: async ({ server }, use) => {
    await use(server.url);
  },
  pageProblems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (error) => problems.push(`uncaught error: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        // The browser logs every failed request as a console error. Scenarios that provoke one on
        // purpose (a wrong token, a review that was deleted) check the response themselves.
        if (/^Failed to load resource/.test(message.text())) return;
        problems.push(`console error: ${message.text()}`);
      });
      await use();
      expect(problems, "the page logged errors").toEqual([]);
    },
    { auto: true },
  ],
});
