import { realpath, readFile, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import type { Handler } from "hono";
import type { AppEnv } from "./env.js";
import { notFound } from "./errors.js";
import { CONTENT_SECURITY_POLICY } from "./security.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serves the built web app from `root`. It answers `/` with index.html and any other path only if
 * it names a file inside the folder, after resolving links, so that neither `..` nor a symbolic
 * link can reach a file outside it. Every response carries the web app's content security policy.
 */
export function staticFiles(root: string): Handler<AppEnv> {
  // Remembered once it exists. A folder that is not there yet (the web app is built while the
  // server runs) is looked for again on the next request.
  let realRoot: string | undefined;
  const rootPath = async (): Promise<string | undefined> => {
    realRoot ??= await realpath(root).catch(() => undefined);
    return realRoot;
  };

  return async (c) => {
    let path: string;
    try {
      path = decodeURIComponent(c.req.path);
    } catch {
      throw notFound("There is nothing at this address.");
    }
    if (path === "/") path = "/index.html";
    if (path.includes("\u0000") || path.includes("\\")) {
      throw notFound("There is nothing at this address.");
    }

    const base = await rootPath();
    if (base === undefined) throw notFound("There is nothing at this address.");
    let file: string;
    try {
      file = await realpath(join(base, path));
      if (!file.startsWith(base + sep) || !(await stat(file)).isFile()) {
        throw notFound("There is nothing at this address.");
      }
    } catch {
      throw notFound("There is nothing at this address.");
    }

    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    // The files under /assets/ are named by a hash of their content, so they never change.
    const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return c.body(await readFile(file), 200, {
      "Content-Type": type,
      "Cache-Control": cache,
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
    });
  };
}
