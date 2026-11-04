/**
 * The headers every response carries, errors and 404s included (docs/parol/06). The policy allows
 * script, style and connections from the same origin only, and forms that post to the same origin
 * only: exactly what the pages, the stylesheet and the script use. They load no image and no font
 * (the stylesheet uses the system fonts and has no `url()`), so the policy grants neither, and a
 * test in test/integration/layers.test.ts fails if it grants a kind of resource that nothing
 * uses. Nothing inline, so a page cannot run text that came from a document even if some escaping
 * were ever missed.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Every browser feature that current browsers recognise, switched off. Parol uses none of them.
 * Names a browser does not know are left out on purpose: Chromium prints a console warning for
 * each one on every page (ambient-light-sensor, battery, bluetooth, document-domain and
 * web-share were seen), which buries a real warning, and it gains nothing to deny a feature the
 * browser has no way to grant. Add a name only after checking that the browser console stays quiet.
 */
const DENIED_FEATURES = [
  "accelerometer",
  "autoplay",
  "camera",
  "clipboard-read",
  "clipboard-write",
  "display-capture",
  "encrypted-media",
  "fullscreen",
  "gamepad",
  "geolocation",
  "gyroscope",
  "hid",
  "idle-detection",
  "interest-cohort",
  "local-fonts",
  "magnetometer",
  "microphone",
  "midi",
  "payment",
  "picture-in-picture",
  "publickey-credentials-get",
  "screen-wake-lock",
  "serial",
  "sync-xhr",
  "usb",
  "xr-spatial-tracking",
];
export const PERMISSIONS_POLICY = DENIED_FEATURES.map((feature) => `${feature}=()`).join(", ");

export const CACHE_NO_STORE = "no-store";
/** Static files change only with a release, so a day is safe and saves the browser a trip. */
export const CACHE_ASSET = "public, max-age=86400";

export function isAssetPath(path: string): boolean {
  return path.startsWith("/assets/");
}

/**
 * Sets the security headers on a response's headers. `Cache-Control: no-store` goes on everything
 * except a successful static asset: a response under /assets that already carries its own cache
 * header keeps it, and an error under /assets (a missing name) does not get cached.
 */
export function applySecurityHeaders(
  headers: Headers,
  options: { path: string; https: boolean },
): void {
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  if (options.https) headers.set("Strict-Transport-Security", "max-age=31536000");
  const keepAssetCache = isAssetPath(options.path) && headers.get("Cache-Control") === CACHE_ASSET;
  if (!keepAssetCache) headers.set("Cache-Control", CACHE_NO_STORE);
}
