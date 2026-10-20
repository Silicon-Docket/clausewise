import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { findChromium } from "./browser.js";
import { REPO_ROOT } from "./paths.js";

const inCi = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "0";
const executablePath = findChromium();

export default defineConfig({
  testDir: join(import.meta.dirname, "tests"),
  // Screenshots and traces go here, and only for a test that failed. The folder is ignored by git.
  outputDir: join(REPO_ROOT, "test-results"),
  globalSetup: join(import.meta.dirname, "global-setup.ts"),

  // The scenarios share servers and look at the data folder, so they run one after the other.
  workers: 1,
  fullyParallel: false,
  retries: inCi ? 1 : 0,
  forbidOnly: inCi,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: inCi
    ? [["list"], ["html", { open: "never", outputFolder: join(REPO_ROOT, "playwright-report") }]]
    : [["list"]],

  use: {
    // The address of the server under test is known only after the global setup has started it, so
    // the base URL is given by the fixture in fixtures.ts, which overrides this.
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    locale: "en-US",
    reducedMotion: "reduce",
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        ...(executablePath === undefined ? {} : { launchOptions: { executablePath } }),
      },
    },
  ],
});
