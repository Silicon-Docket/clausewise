import { describe, expect, it } from "vitest";
import { LOOPBACK_NAMES } from "../../src/server/middleware/host-guard.js";
import { makeShell } from "./support-app.js";

/**
 * A hostile website can point its own name at 127.0.0.1 and then talk to a local server as if it
 * were its own origin (DNS rebinding). The demo identity has no passwords, so that would hand the
 * whole application to the site. A request is therefore answered only when its Host is this machine.
 */
describe("the host check", () => {
  const send = (shell: ReturnType<typeof makeShell>, url: string, host?: string) =>
    shell.app.request(url, host === undefined ? {} : { headers: { host } });

  it("answers requests addressed to this machine", async () => {
    const shell = makeShell();
    for (const url of [
      "http://localhost/healthz",
      "http://localhost:8787/healthz",
      "http://LOCALHOST:8787/healthz",
      "http://127.0.0.1:8787/healthz",
      "http://[::1]:8787/healthz",
      "/healthz",
    ])
      expect((await send(shell, url)).status, url).toBe(200);
  });

  it("refuses any other name, with the usual headers and no hint of why", async () => {
    const shell = makeShell();
    for (const url of [
      "http://evil.example/healthz",
      "http://evil.example:8787/healthz",
      "http://localhost.evil.example/healthz",
      "http://127.0.0.1.evil.example/healthz",
      "http://192.168.1.20:8787/healthz",
      "http://0.0.0.0:8787/healthz",
      "http://[::2]:8787/healthz",
      "http://localhost./healthz",
    ]) {
      const response = await send(shell, url);
      expect(response.status, url).toBe(403);
      expect(response.headers.get("content-security-policy"), url).toBeTruthy();
      expect(await response.text(), url).not.toContain("evil");
    }
  });

  it("also checks the Host header, which a client can make differ from the address of the request", async () => {
    // A request line in absolute form names its own address, and the server takes the address
    // from it and ignores Host. A rebinding page cannot send that, but the header is the thing the
    // browser does send, so it is checked as well and a mismatch refuses the request.
    const shell = makeShell();
    for (const host of [
      "evil.example",
      "evil.example:8787",
      "localhost.evil.example",
      "localhost@evil.example",
      "foo bar",
      "[::2]:8787",
      "192.168.1.20",
      "localhost:evil",
    ]) {
      const response = await send(shell, "http://localhost/healthz", host);
      expect(response.status, host).toBe(403);
      expect(response.headers.get("content-security-policy"), host).toBeTruthy();
      expect(await response.text(), host).not.toContain("evil");
    }
  });

  it("accepts a Host header that names this machine, in any of its forms", async () => {
    const shell = makeShell();
    for (const host of [
      "localhost",
      "localhost:8787",
      "LOCALHOST:8787",
      "127.0.0.1",
      "127.0.0.1:8787",
      "[::1]",
      "[::1]:8787",
    ])
      expect((await send(shell, "http://localhost/healthz", host)).status, host).toBe(200);
  });

  it("does not look at the Host header when the demo identity is off", async () => {
    const off = makeShell({ demoIdentity: false });
    expect((await send(off, "http://localhost/healthz", "evil.example")).status).toBe(200);
  });

  it("applies to every route, not only the health check", async () => {
    const shell = makeShell();
    for (const [method, path] of [
      ["GET", "/assets/parol.css"],
      ["GET", "/__test/csrf"],
      ["POST", "/session"],
      ["GET", "/nowhere"],
      ["GET", "/api/nowhere"],
    ] as const) {
      const response = await shell.app.request(`http://evil.example${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("is on only with the demo identity, which is what makes the server dangerous to expose", async () => {
    const off = makeShell({ demoIdentity: false });
    expect((await send(off, "http://evil.example/healthz")).status).toBe(200);
    const on = makeShell({ demoIdentity: true });
    expect((await send(on, "http://evil.example/healthz")).status).toBe(403);
  });

  it("agrees with the hosts the demo identity is allowed to bind to", () => {
    expect([...LOOPBACK_NAMES].sort()).toEqual(["127.0.0.1", "[::1]", "localhost"]);
  });
});
