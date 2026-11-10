import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** What the page needs to know to sign in. None of it is secret. */
export type PageConfig = { signIn: false } | { signIn: true; tenantId: string; clientId: string };

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MSAL_BUNDLE = join(
  dirname(createRequire(import.meta.url).resolve("@azure/msal-browser/package.json")),
  "lib",
  "msal-browser.min.js",
);

const JS = "text/javascript; charset=utf-8";

// A fixed list, not a folder: nothing outside it can be asked for, whatever the path says.
const ASSETS: ReadonlyMap<string, { file: string; type: string }> = new Map([
  ["/", { file: join(PUBLIC_DIR, "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { file: join(PUBLIC_DIR, "app.js"), type: JS }],
  ["/app.css", { file: join(PUBLIC_DIR, "app.css"), type: "text/css; charset=utf-8" }],
  ["/vendor/msal-browser.min.js", { file: MSAL_BUNDLE, type: JS }],
]);

/**
 * The page may run only its own scripts and styles, and may talk only to this server and to
 * Entra ID, whose token endpoint MSAL calls and whose page it may frame to renew a session.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self' https://login.microsoftonline.com",
  "frame-src https://login.microsoftonline.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function pageAssets() {
  const loaded = new Map<string, Promise<Uint8Array>>();
  return {
    async get(path: string): Promise<{ data: Uint8Array; type: string } | undefined> {
      const asset = ASSETS.get(path);
      if (asset === undefined) return undefined;
      let data = loaded.get(path);
      if (data === undefined) {
        data = readFile(asset.file).then((buffer) => new Uint8Array(buffer));
        data.catch(() => loaded.delete(path));
        loaded.set(path, data);
      }
      return { data: await data, type: asset.type };
    },
  };
}
