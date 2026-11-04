import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { CACHE_ASSET } from "./middleware/security-headers.js";

/**
 * Static files: the stylesheet, the script and anything else in apps/parol/public, served at
 * /assets/<name>.
 *
 * The set of names is read from the directory once, at start-up, and a request is answered only
 * when its name is in that set. The request's text is never joined to a path, so there is nothing
 * to traverse: `..`, encoded dots, backslashes, null bytes and double encoding all fail the same
 * way, by not being a name in the set. Only plain files with a conservative name are included, so
 * there is no directory listing, no dotfile, no nested folder and no symbolic link.
 */

/** Found from this file and not from the working directory, so the server starts from anywhere. */
export const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

export interface Asset {
  readonly name: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly etag: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
};

/** A name must start with a letter or digit and use only these characters. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

export function loadAssets(dir: string = DEFAULT_ASSETS_DIR): ReadonlyMap<string, Asset> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // The path is a deployment detail; the message names the kind of problem only.
    throw new Error("the static assets directory cannot be read");
  }
  const assets = new Map<string, Asset>();
  for (const entry of entries) {
    // isFile() is false for a symbolic link, a directory and anything else that is not a plain file.
    if (!entry.isFile() || !SAFE_NAME.test(entry.name)) continue;
    const bytes = readFileSync(join(dir, entry.name));
    if (bytes.length > MAX_ASSET_BYTES) continue;
    const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
    assets.set(entry.name, {
      name: entry.name,
      bytes,
      contentType: contentTypeFor(entry.name),
      etag: `"${digest}"`,
    });
  }
  return assets;
}

/** The handler for `GET /assets/:name`. Unknown names fall through to the shell's 404. */
export function assetHandler(assets: ReadonlyMap<string, Asset>) {
  return (c: Context): Response | Promise<Response> => {
    const name = c.req.param("name");
    const asset = name === undefined ? undefined : assets.get(name);
    if (asset === undefined) return c.notFound();
    const headers = {
      "Cache-Control": CACHE_ASSET,
      ETag: asset.etag,
    };
    const candidates = c.req.header("if-none-match");
    if (candidates !== undefined && candidates.split(",").some((tag) => tag.trim() === asset.etag))
      return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(asset.bytes), {
      status: 200,
      headers: {
        ...headers,
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes.length),
      },
    });
  };
}
