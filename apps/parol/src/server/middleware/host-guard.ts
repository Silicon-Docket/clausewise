import type { MiddlewareHandler } from "hono";
import { ForbiddenError } from "../../services/errors.js";
import type { AppConfig } from "../deps.js";

/** The names a browser on this machine uses for it. `URL` keeps the brackets on an IPv6 address. */
export const LOOPBACK_NAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The host name in a URL or a Host header value, lower case, or null when it does not parse. */
function hostnameOf(authority: string): string | null {
  try {
    // A value with a path, a user or a space in it is not a bare host and port, whatever `URL`
    // makes of it, so it is never ours.
    if (/[\s/\\@?#]/.test(authority)) return null;
    return new URL(`http://${authority}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * With the demo identity on, a request is answered only when it was addressed to this machine.
 *
 * The demo identity has no passwords and the server binds to loopback, so a page on the internet
 * cannot reach it by address. It can reach it by name: a hostile site points its own name at
 * 127.0.0.1 (DNS rebinding), and the browser then treats the local server as that site's own
 * origin, free to read every page and post every form. The request still carries the hostile name
 * in its Host header, so refusing any name that is not this machine's closes that route.
 *
 * Two names are checked: the one in the address of the request, and the one in the Host header.
 * They are the same for a browser. They differ when a client sends a request line in absolute form
 * (`GET http://localhost/ ...`), where the server takes the address from the request line and
 * leaves Host alone, so checking only the address would pass a request whose Host says otherwise.
 */
export function hostGuard(config: Pick<AppConfig, "demoIdentity">): MiddlewareHandler {
  return async (c, next) => {
    if (config.demoIdentity) {
      let hostname = "";
      try {
        hostname = new URL(c.req.url).hostname.toLowerCase();
      } catch {
        // An address that does not parse is not ours.
      }
      if (!LOOPBACK_NAMES.has(hostname)) throw new ForbiddenError("host");
      const header = c.req.header("host");
      if (header !== undefined) {
        const named = hostnameOf(header);
        if (named === null || !LOOPBACK_NAMES.has(named)) throw new ForbiddenError("host");
      }
    }
    await next();
  };
}
