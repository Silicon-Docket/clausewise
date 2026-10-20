import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/**
 * Where a browser Playwright can drive is, or undefined to let Playwright use its own.
 *
 * Playwright launches the exact Chromium revision its version was built for, and CI installs that
 * one with `playwright install`. A machine whose browsers were put there by something else may
 * hold another revision, and Playwright then stops with "Executable doesn't exist". The scripts
 * here never download a browser, so for such a machine this looks for one, in this order:
 *
 * 1. CLAUSEWISE_E2E_CHROMIUM, the path of a Chromium or Chrome executable. A wrong path is an
 *    error and not a reason to look elsewhere: the person who set it wants that browser.
 * 2. The browser Playwright expects, if it is installed. Nothing is overridden then.
 * 3. The newest Chromium found next to it, in PLAYWRIGHT_BROWSERS_PATH or in Playwright's default
 *    cache folder. The headless shell comes first, because it is what Playwright runs in headless
 *    mode, and full Chromium is the second choice.
 *
 * If none exists, Playwright's own error says which command installs the browser.
 */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.CLAUSEWISE_E2E_CHROMIUM?.trim();
  if (named !== undefined && named !== "") {
    if (!existsSync(named)) {
      throw new Error(
        `CLAUSEWISE_E2E_CHROMIUM names ${named}, which does not exist. Set it to the path of a Chromium or Chrome executable, or unset it.`,
      );
    }
    return named;
  }

  if (existsSync(chromium.executablePath())) return undefined;

  const folder = browsersFolder(env);
  if (!existsSync(folder)) return undefined;
  // Newest revision first. Revisions are whole numbers, so they are compared as numbers: 999 is
  // older than 1194.
  const kinds = [
    { prefix: "chromium_headless_shell-", binaries: SHELLS },
    { prefix: "chromium-", binaries: LAUNCHERS },
  ];
  const names = readdirSync(folder);
  for (const kind of kinds) {
    const revisions = names
      .filter((name) => new RegExp(`^${kind.prefix}\\d+$`).test(name))
      .sort((a, b) => revisionOf(b) - revisionOf(a));
    for (const revision of revisions) {
      for (const binary of kind.binaries) {
        const candidate = join(folder, revision, ...binary);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const revisionOf = (name: string): number => Number(name.slice(name.lastIndexOf("-") + 1));

const LAUNCHERS: string[][] = [
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  [
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  [
    "chrome-mac-x64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  ],
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-win64", "chrome.exe"],
  ["chrome-win", "chrome.exe"],
];

const SHELLS: string[][] = [
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  ["chrome-linux", "headless_shell"],
  ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
];

function browsersFolder(env: NodeJS.ProcessEnv): string {
  const set = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (set !== undefined && set !== "" && set !== "0") return set;
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "ms-playwright");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", "ms-playwright");
  }
  return join(env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
}
