// Node 22 ignores HTTP_PROXY, HTTPS_PROXY and NO_PROXY for fetch unless NODE_USE_ENV_PROXY=1 is set
// or Node is started with --use-env-proxy. With either, the global dispatcher becomes undici's
// EnvHttpProxyAgent, which reads the variables below on its own. ALL_PROXY is not read at all.
// All of this was checked against Node 22.22 with a fake proxy rather than taken from the docs.

type Env = Record<string, string | undefined>;

const DISPATCHER = Symbol.for("undici.globalDispatcher.1");

function optionIsSet(options: string | undefined, flag: string): boolean {
  return (options ?? "").split(/\s+/).some((part) => part === flag);
}

function dispatcherName(): string {
  try {
    const dispatcher: unknown = (globalThis as Record<symbol, unknown>)[DISPATCHER];
    return typeof dispatcher === "object" && dispatcher !== null
      ? (dispatcher.constructor?.name ?? "")
      : "";
  } catch {
    return "";
  }
}

// undici reads the lower case name first and does not fall through to the upper case one when the
// lower case one is set, even to an empty string.
function pick(env: Env, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

// The same rules as undici: entries split on commas and whitespace, a name matches exactly, a
// leading dot or star matches any host that ends with the rest, and an entry may pin a port. There
// is no CIDR syntax, and an IPv6 literal has to be written with its brackets.
function excluded(noProxy: string, hostname: string, port: number): boolean {
  if (noProxy === "*") return true;
  for (const entry of noProxy.split(/[,\s]/)) {
    if (entry === "") continue;
    const pinned = /^(.+):(\d+)$/.exec(entry);
    const name = (pinned?.[1] ?? entry).toLowerCase();
    const entryPort = pinned?.[2] === undefined ? 0 : Number(pinned[2]);
    if (entryPort !== 0 && entryPort !== port) continue;
    if (/^[.*]/.test(name)) {
      if (hostname.endsWith(name.replace(/^\*/, ""))) return true;
    } else if (hostname === name) {
      return true;
    }
  }
  return false;
}

function hostOf(proxy: string): string {
  try {
    return new URL(proxy).host;
  } catch {
    return "";
  }
}

/**
 * The host of the proxy that Node would send a request to `target` through, an empty string when
 * a proxy is in use but its host cannot be told, and undefined when the request goes direct.
 */
export function envProxyFor(
  target: URL,
  env: Env = process.env,
  execArgv: readonly string[] = process.execArgv,
): string | undefined {
  const dispatcher = dispatcherName();
  const enabled =
    env.NODE_USE_ENV_PROXY === "1" ||
    optionIsSet(env.NODE_OPTIONS, "--use-env-proxy") ||
    execArgv.includes("--use-env-proxy") ||
    dispatcher === "EnvHttpProxyAgent";
  if (!enabled) {
    // Something else, such as a preloaded module, may have installed a proxying dispatcher. Its
    // address is not readable, so the line can only say that one exists.
    return /proxy/i.test(dispatcher) ? "" : undefined;
  }
  const https = target.protocol === "https:";
  // An https request uses the https proxy when one is set to something, and the http proxy if not.
  const httpProxy = pick(env, "http_proxy", "HTTP_PROXY");
  const proxy = (https ? pick(env, "https_proxy", "HTTPS_PROXY") || httpProxy : httpProxy) ?? "";
  if (proxy === "") return undefined;
  const noProxy = pick(env, "no_proxy", "NO_PROXY");
  const port = target.port === "" ? (https ? 443 : 80) : Number(target.port);
  if (noProxy !== undefined && excluded(noProxy, target.hostname, port)) return undefined;
  return hostOf(proxy);
}
