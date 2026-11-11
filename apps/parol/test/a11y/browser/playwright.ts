import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * Finding Playwright and Chromium for the browser tests, without making either a dependency of the
 * repository. Nothing here installs anything. When the package or the browser cannot be loaded the
 * tests are skipped, and `openBrowser` says why in one line that the test file prints, so that a
 * skipped run is visibly skipped and not mistaken for a passing one.
 *
 * The package is looked for, in this order:
 *   1. the folder named by the environment variable PLAYWRIGHT_MODULES_DIR, which is a folder that
 *      holds a `playwright` folder (for example the global `node_modules` of the machine);
 *   2. normal CommonJS resolution from this file, which finds a local install and every folder
 *      in NODE_PATH;
 *   3. the global folder that `npm root -g` prints.
 * The browser is whatever `chromium.launch()` starts with no options, which is the one Playwright
 * finds itself (PLAYWRIGHT_BROWSERS_PATH, or its own cache).
 */

// ---------------------------------------------------------------------------------------------
// The part of Playwright's interface that these tests use. The package has no types in this
// repository, so they are written out here, and a member that is not listed is not used.
// ---------------------------------------------------------------------------------------------

export interface PwCookie {
  name: string;
  value: string;
  url: string;
}

export interface PwKeyboard {
  press(key: string): Promise<void>;
  type(text: string): Promise<void>;
}

export interface PwDownload {
  suggestedFilename(): string;
}

export interface PwResponse {
  status(): number;
}

export interface PwPage {
  goto(url: string): Promise<PwResponse | null>;
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  /** A string is run in the page as an expression (a function expression is called). */
  evaluate<T = unknown>(script: string): Promise<T>;
  waitForEvent(event: "download", options?: { timeout?: number }): Promise<PwDownload>;
  setInputFiles(selector: string, files: string): Promise<void>;
  emulateMedia(options: {
    colorScheme?: "light" | "dark" | null;
    reducedMotion?: "reduce" | "no-preference" | null;
    forcedColors?: "active" | "none" | null;
  }): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  on(event: "pageerror", listener: (error: Error) => void): void;
  on(event: "console", listener: (message: { type(): string; text(): string }) => void): void;
  keyboard: PwKeyboard;
  close(): Promise<void>;
}

export interface PwContext {
  newPage(): Promise<PwPage>;
  addCookies(cookies: PwCookie[]): Promise<void>;
  close(): Promise<void>;
}

export interface PwContextOptions {
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
  javaScriptEnabled?: boolean;
  colorScheme?: "light" | "dark";
  reducedMotion?: "reduce" | "no-preference";
  forcedColors?: "active" | "none";
  acceptDownloads?: boolean;
  /** Lets a script add a style element, which the pages' security policy otherwise refuses. */
  bypassCSP?: boolean;
}

export interface PwBrowser {
  newContext(options?: PwContextOptions): Promise<PwContext>;
  version(): string;
  close(): Promise<void>;
}

export interface Opened {
  browser: PwBrowser;
  /** For the record: what ran. */
  versions: { playwright: string; chromium: string };
  /** Where the package was found, as words (never a secret). */
  foundBy: string;
}

interface PwModule {
  chromium: { launch(options?: Record<string, unknown>): Promise<PwBrowser> };
}

const here = join(import.meta.dirname, "playwright.ts");

/** Loads the package named by `spec` (`playwright`, or the path of its folder) and reads its version. */
function tryLoad(
  spec: string,
  how: string,
): { mod: PwModule; version: string; how: string } | null {
  try {
    const req = createRequire(here);
    const mod = req(spec) as PwModule;
    let version = "unknown";
    try {
      version = (req(`${spec}/package.json`) as { version?: string }).version ?? "unknown";
    } catch {
      // The version is for the record only.
    }
    return { mod, version, how };
  } catch {
    return null;
  }
}

function load(): { mod: PwModule; version: string; how: string } | null {
  const dir = process.env["PLAYWRIGHT_MODULES_DIR"];
  if (dir !== undefined && dir !== "") {
    const found = tryLoad(join(dir, "playwright"), "PLAYWRIGHT_MODULES_DIR");
    if (found !== null) return found;
  }
  const direct = tryLoad("playwright", "module resolution (a local install or NODE_PATH)");
  if (direct !== null) return direct;
  const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 20_000 });
  const globalDir = root.status === 0 ? root.stdout.trim() : "";
  if (globalDir !== "") return tryLoad(join(globalDir, "playwright"), "npm root -g");
  return null;
}

/**
 * Starts Chromium, or says why it could not. Returns `skipped` with the reason when the package
 * is missing or the browser does not start; the caller prints the reason and skips its tests.
 */
export async function openBrowser(): Promise<
  { ok: true; opened: Opened } | { ok: false; reason: string }
> {
  const loaded = load();
  if (loaded === null)
    return {
      ok: false,
      reason:
        "Playwright could not be loaded (set PLAYWRIGHT_MODULES_DIR to a folder that holds it, or put it on NODE_PATH)",
    };
  try {
    const browser = await loaded.mod.chromium.launch();
    return {
      ok: true,
      opened: {
        browser,
        versions: { playwright: loaded.version, chromium: browser.version() },
        foundBy: loaded.how,
      },
    };
  } catch {
    return { ok: false, reason: "Chromium could not be started by Playwright" };
  }
}

/** The one line a test file prints when it is skipped, or when it runs, so that a log shows which. */
export function browserNotice(file: string, result: Awaited<ReturnType<typeof openBrowser>>): void {
  if (result.ok) {
    const v = result.opened.versions;
    console.info(
      `[browser tests] ${file}: running with Playwright ${v.playwright} and Chromium ${v.chromium} (found by ${result.opened.foundBy})`,
    );
  } else {
    console.info(`[browser tests] ${file}: SKIPPED, ${result.reason}`);
  }
}
