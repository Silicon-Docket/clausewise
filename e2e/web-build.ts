import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { REPO_ROOT, WEB_DIR } from "./paths.js";

// What the built web app is made from. A file newer than the build means the build is stale.
const SOURCES = [
  join(REPO_ROOT, "apps", "web", "src"),
  join(REPO_ROOT, "apps", "web", "index.html"),
  join(REPO_ROOT, "apps", "web", "vite.config.ts"),
  join(REPO_ROOT, "packages", "api", "src"),
];

function newestChange(path: string): number {
  if (!existsSync(path)) return 0;
  const info = statSync(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let newest = info.mtimeMs;
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
    }
  }
  return newest;
}

/** True when apps/web/dist is missing, or older than the source it was built from. */
export function webBuildNeeded(): boolean {
  const index = join(WEB_DIR, "index.html");
  if (!existsSync(index)) return true;
  const built = statSync(index).mtimeMs;
  return SOURCES.some((source) => newestChange(source) > built);
}

/**
 * Makes sure the server has a web app to serve, and that it is the one the source describes. The
 * tests drive the built files, so a stale build would test code nobody has now. Builds with the
 * same command a person would run. CLAUSEWISE_E2E_SKIP_BUILD=1 trusts an existing build (a CI job
 * that built it already); a missing one is still an error.
 */
export function ensureWebBuild(env: NodeJS.ProcessEnv = process.env): void {
  const index = join(WEB_DIR, "index.html");
  if (env.CLAUSEWISE_E2E_SKIP_BUILD === "1") {
    if (!existsSync(index)) {
      throw new Error(
        `CLAUSEWISE_E2E_SKIP_BUILD is set, but there is no built web app at ${WEB_DIR}. Run: pnpm --filter @clausewise/web build`,
      );
    }
    return;
  }
  if (!webBuildNeeded()) return;

  console.log("Building the web app (pnpm --filter @clausewise/web build) ...");
  const result = spawnSync("pnpm", ["--filter", "@clausewise/web", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    // On Windows pnpm is a script and needs a shell to start.
    shell: process.platform === "win32",
  });
  if (result.error !== undefined || result.status !== 0 || !existsSync(index)) {
    const why =
      result.error !== undefined
        ? `pnpm could not be started (${result.error.message})`
        : "the build failed";
    throw new Error(
      `The end to end tests need the built web app, and ${why}. Run it yourself to see why: pnpm --filter @clausewise/web build`,
    );
  }
}
