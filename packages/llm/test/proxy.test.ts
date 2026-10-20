import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { envProxyFor } from "../src/proxy.js";

const PROXY = "http://user:hunter2@proxy.corp.example:3128/path";
const on = { NODE_USE_ENV_PROXY: "1" };

function proxyFor(url: string, env: Record<string, string>, execArgv: string[] = []) {
  return envProxyFor(new URL(url), env, execArgv);
}

describe("envProxyFor", () => {
  describe("whether Node uses the environment at all", () => {
    it("ignores every proxy variable unless Node was told to read them", () => {
      const env = { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, ALL_PROXY: PROXY, http_proxy: PROXY };
      expect(proxyFor("http://llm.example.com/v1", env)).toBeUndefined();
      expect(proxyFor("https://api.anthropic.com", env)).toBeUndefined();
    });

    it.each([
      ["NODE_USE_ENV_PROXY=1", { NODE_USE_ENV_PROXY: "1" }, []],
      [
        "--use-env-proxy in NODE_OPTIONS",
        { NODE_OPTIONS: "--max-old-space-size=8192 --use-env-proxy" },
        [],
      ],
      ["--use-env-proxy on the command line", {}, ["--use-env-proxy"]],
    ])("reads them with %s", (_name, extra, execArgv) => {
      expect(proxyFor("http://llm.example.com/v1", { HTTP_PROXY: PROXY, ...extra }, execArgv)).toBe(
        "proxy.corp.example:3128",
      );
    });

    it.each(["0", "true", "yes", ""])(
      "does not read them when NODE_USE_ENV_PROXY is %j",
      (value) => {
        expect(
          proxyFor("http://llm.example.com/v1", { HTTP_PROXY: PROXY, NODE_USE_ENV_PROXY: value }),
        ).toBeUndefined();
      },
    );

    it("does not mistake another option for the flag", () => {
      const env = { HTTP_PROXY: PROXY, NODE_OPTIONS: "--no-use-env-proxy --use-env-proxy-x" };
      expect(proxyFor("http://llm.example.com/v1", env)).toBeUndefined();
    });
  });

  describe("a dispatcher installed by code in the process", () => {
    const slot = Symbol.for("undici.globalDispatcher.1");
    const globals = globalThis as Record<symbol, unknown>;

    // No request is made while the stand-in is in place, so real fetch calls are not affected.
    function withDispatcher<T>(name: string, body: () => T): T {
      class Stand {}
      Object.defineProperty(Stand, "name", { value: name });
      const saved = globals[slot];
      globals[slot] = new Stand();
      try {
        return body();
      } finally {
        if (saved === undefined) delete globals[slot];
        else globals[slot] = saved;
      }
    }

    it("is reported as a proxy of unknown address when it is a ProxyAgent", () => {
      withDispatcher("ProxyAgent", () => {
        expect(proxyFor("https://api.anthropic.com", {})).toBe("");
      });
    });

    it("reads the variables when it is the environment's own agent, whatever started it", () => {
      withDispatcher("EnvHttpProxyAgent", () => {
        expect(proxyFor("http://llm.example.com", { HTTP_PROXY: PROXY })).toBe(
          "proxy.corp.example:3128",
        );
        expect(proxyFor("http://llm.example.com", {})).toBeUndefined();
      });
    });

    it("says nothing for the ordinary agent", () => {
      withDispatcher("Agent", () => {
        expect(proxyFor("http://llm.example.com", { HTTP_PROXY: PROXY })).toBeUndefined();
      });
    });
  });

  describe("which variable applies", () => {
    it("uses HTTP_PROXY for http and HTTPS_PROXY for https", () => {
      const env = { ...on, HTTP_PROXY: "http://plain:1", HTTPS_PROXY: "http://secure:2" };
      expect(proxyFor("http://llm.example.com/v1", env)).toBe("plain:1");
      expect(proxyFor("https://llm.example.com/v1", env)).toBe("secure:2");
    });

    it("sends https through HTTP_PROXY when there is no HTTPS_PROXY, but not the other way round", () => {
      expect(proxyFor("https://llm.example.com", { ...on, HTTP_PROXY: "http://plain:1" })).toBe(
        "plain:1",
      );
      expect(proxyFor("http://llm.example.com", { ...on, HTTPS_PROXY: "http://secure:2" })).toBe(
        undefined,
      );
    });

    it("prefers the lower case name", () => {
      expect(
        proxyFor("http://llm.example.com", {
          ...on,
          http_proxy: "http://low:1",
          HTTP_PROXY: "http://up:2",
        }),
      ).toBe("low:1");
    });

    it("treats an empty value as no proxy, as Node does", () => {
      expect(proxyFor("http://llm.example.com", { ...on, HTTP_PROXY: "" })).toBeUndefined();
    });

    it("ignores ALL_PROXY, which Node does not read", () => {
      expect(proxyFor("http://llm.example.com", { ...on, ALL_PROXY: PROXY })).toBeUndefined();
    });

    it("says a proxy is in use even when its address cannot be read", () => {
      expect(proxyFor("http://llm.example.com", { ...on, HTTP_PROXY: "not a url" })).toBe("");
    });

    it("names the host and port and nothing else", () => {
      const host = proxyFor("http://llm.example.com", { ...on, HTTP_PROXY: PROXY });
      expect(host).toBe("proxy.corp.example:3128");
      expect(host).not.toContain("hunter2");
      expect(host).not.toContain("user");
      expect(host).not.toContain("path");
    });
  });

  describe("NO_PROXY", () => {
    const env = (noProxy: string) => ({ ...on, HTTP_PROXY: PROXY, NO_PROXY: noProxy });

    it.each([
      ["an exact host", "llm.example.com", "http://llm.example.com/v1", true],
      [
        "a list with commas and spaces",
        "a.test, llm.example.com ,b.test",
        "http://llm.example.com",
        true,
      ],
      ["a leading dot", ".example.com", "http://llm.example.com", true],
      ["a leading star", "*.example.com", "http://llm.example.com", true],
      ["a star on its own", "*", "http://llm.example.com", true],
      ["the port when it matches", "llm.example.com:8080", "http://llm.example.com:8080/v1", true],
      ["an IPv6 literal in brackets", "[::1]", "http://[::1]:8080/v1", true],
      ["an IP address", "127.0.0.1", "http://127.0.0.1:8080/v1", true],
    ])("lets %s go direct", (_name, noProxy, url, direct) => {
      expect(proxyFor(url, env(noProxy)) === undefined).toBe(direct);
    });

    it.each([
      ["a parent domain without a dot", "example.com", "http://llm.example.com"],
      ["the wrong port", "llm.example.com:9999", "http://llm.example.com:8080"],
      ["an IPv6 literal without brackets", "::1", "http://[::1]:8080"],
      ["a CIDR range, which Node does not understand", "127.0.0.0/8", "http://127.0.0.1:8080"],
      ["a different host", "other.example.com", "http://llm.example.com"],
    ])("still proxies for %s", (_name, noProxy, url) => {
      expect(proxyFor(url, env(noProxy))).toBe("proxy.corp.example:3128");
    });

    it("reads the lower case name first", () => {
      expect(
        proxyFor("http://llm.example.com", {
          ...on,
          HTTP_PROXY: PROXY,
          no_proxy: "llm.example.com",
          NO_PROXY: "other.example.com",
        }),
      ).toBeUndefined();
    });

    it("uses the default port when the URL has none", () => {
      const secure = { ...on, HTTPS_PROXY: PROXY, NO_PROXY: "llm.example.com:443" };
      expect(proxyFor("https://llm.example.com/v1", secure)).toBeUndefined();
      expect(proxyFor("https://llm.example.com:8443/v1", secure)).toBe("proxy.corp.example:3128");
    });
  });
});

// What the functions above assume about Node is checked against Node itself: real requests from a
// child process, with a fake proxy that records what reaches it. A Node release that changes how
// the variables are read makes this fail, which is the point of having it.
describe("agreement with Node's own behaviour", () => {
  let proxy: Server | undefined;

  afterEach(async () => {
    const closing = proxy;
    proxy = undefined;
    if (closing === undefined) return;
    closing.closeAllConnections();
    await new Promise<void>((done) => closing.close(() => done()));
  });

  async function run(
    childEnv: (proxyUrl: string) => Record<string, string>,
    cases: { url: string; noProxy?: string }[],
  ) {
    const seen: string[] = [];
    proxy = createServer((req, res) => {
      seen.push(req.url ?? "");
      res.end("proxied");
    });
    proxy.on("connect", (req, socket) => {
      seen.push(req.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    await new Promise<void>((listening) => proxy?.listen(0, "127.0.0.1", listening));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const root = resolve(import.meta.dirname, "../../..");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(import.meta.dirname, "proxy-child.ts"), JSON.stringify(cases)],
      { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: "/tmp", ...childEnv(proxyUrl) } },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const killer = setTimeout(() => child.kill(), 60_000);
    await new Promise((done) => child.on("close", done));
    clearTimeout(killer);

    const results = output
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { url: string; predicted: string | null });
    expect(results).toHaveLength(cases.length);
    return { results, seen };
  }

  const cases = [
    { url: "http://one.invalid:8001/x" },
    { url: "http://two.invalid:8002/x", noProxy: "two.invalid" },
    { url: "http://three.invalid:8003/x", noProxy: "invalid" },
    { url: "http://four.invalid:8004/x", noProxy: ".invalid" },
    { url: "http://five.invalid:8005/x", noProxy: "five.invalid:8005" },
    { url: "http://six.invalid:8006/x", noProxy: "six.invalid:9999" },
    { url: "http://seven.invalid:8007/x", noProxy: "*" },
    { url: "http://eight.invalid:8008/x", noProxy: "a.invalid, eight.invalid ,b.invalid" },
    { url: "http://[::1]:8009/x", noProxy: "::1" },
    { url: "http://[::1]:8010/x", noProxy: "[::1]" },
    { url: "http://127.0.0.1:8011/x", noProxy: "127.0.0.0/8" },
    { url: "https://nine.invalid:8012/x" },
  ];

  it("predicts exactly the requests that reach the proxy when only HTTP_PROXY is set", async () => {
    const { results, seen } = await run(
      (proxyUrl) => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxyUrl }),
      cases,
    );
    for (const { url, predicted } of results) {
      const target = new URL(url);
      const reached = seen.some((line) => line.includes(`${target.hostname}:${target.port}`));
      expect({ url, proxied: predicted !== null }).toEqual({ url, proxied: reached });
    }
    expect(results.some((result) => result.predicted !== null)).toBe(true);
    expect(results.some((result) => result.predicted === null)).toBe(true);
  }, 90_000);

  it("predicts a direct connection for every request when the flag is off", async () => {
    const { results, seen } = await run(
      (proxyUrl) => ({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }),
      cases.slice(0, 3),
    );
    expect(seen).toEqual([]);
    expect(results.every((result) => result.predicted === null)).toBe(true);
  }, 90_000);

  it("predicts the request that HTTPS_PROXY alone leaves direct", async () => {
    const { results, seen } = await run(
      (proxyUrl) => ({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl }),
      [{ url: "http://plain.invalid:8020/x" }, { url: "https://secure.invalid:8021/x" }],
    );
    expect(seen.some((line) => line.includes("plain.invalid"))).toBe(false);
    expect(seen.some((line) => line.includes("secure.invalid"))).toBe(true);
    expect(results.map((result) => result.predicted !== null)).toEqual([false, true]);
  }, 90_000);
});
