import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { playbooksDir, tempDir } from "./support.js";

const LAUNCHER = join(import.meta.dirname, "main-launcher.mjs");
const SECRET = "sk-ant-api03-SECRET-VALUE-0123456789";
const TIMEOUT = 90_000;

const started: ChildProcess[] = [];
afterEach(() => {
  for (const child of started.splice(0)) child.kill("SIGKILL");
});

interface Running {
  child: ChildProcess;
  url: string;
  output: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function launch(env: Record<string, string>): {
  child: ChildProcess;
  output: () => string;
  exited: Running["exited"];
} {
  // No key or setting of the machine running the tests is passed on.
  const child = spawn(process.execPath, [LAUNCHER], {
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "/", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(child);
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (text += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, output: () => text, exited };
}

async function startMain(env: Record<string, string>): Promise<Running> {
  const dataDir = await tempDir("clausewise-main-");
  const run = launch({
    HOST: "127.0.0.1",
    PORT: "0",
    CLAUSEWISE_DATA_DIR: dataDir,
    CLAUSEWISE_PLAYBOOKS_DIR: playbooksDir,
    ...env,
  });
  const url = await new Promise<string>((resolve, reject) => {
    const watch = setInterval(() => {
      const line = run
        .output()
        .split("\n")
        .find((l) => l.includes('"Clausewise is running"'));
      if (line !== undefined) {
        clearInterval(watch);
        resolve((JSON.parse(line) as { url: string }).url);
      }
    }, 50);
    void run.exited.then(({ code }) => {
      clearInterval(watch);
      reject(new Error(`The process ended with ${code} before it was running:\n${run.output()}`));
    });
  });
  return { ...run, url };
}

describe("the server process", () => {
  it(
    "stops cleanly on SIGTERM and exits 0, having said where the text goes",
    { timeout: TIMEOUT },
    async () => {
      const running = await startMain({ ANTHROPIC_API_KEY: SECRET });
      expect(running.output()).toContain("Reviews are sent to: Anthropic API (api.anthropic.com)");

      const health = await fetch(`${running.url}/healthz`);
      expect(await health.json()).toEqual({ ok: true });
      const config = (await (await fetch(`${running.url}/api/config`)).json()) as {
        model: { configured: boolean; provider?: string; disclosure?: string };
      };
      expect(config.model).toMatchObject({ configured: true, provider: "anthropic" });
      expect(config.model.disclosure).toContain("api.anthropic.com");

      running.child.kill("SIGTERM");
      const { code } = await running.exited;
      expect(code).toBe(0);
      expect(running.output()).toContain("Stopping on SIGTERM");
      // The port is closed.
      await expect(fetch(`${running.url}/healthz`)).rejects.toThrow();
      // The key is never printed.
      expect(running.output()).not.toContain(SECRET);
    },
  );

  it(
    "stops cleanly on SIGINT and exits 0, and starts without a key, saying so",
    { timeout: TIMEOUT },
    async () => {
      const running = await startMain({});
      expect(running.output()).toContain("The model is not configured, so reviews cannot run.");
      expect(running.output()).toContain("ANTHROPIC_API_KEY is required");
      const config = (await (await fetch(`${running.url}/api/config`)).json()) as {
        model: { configured: boolean; problem?: string };
      };
      expect(config.model).toMatchObject({ configured: false });
      expect(config.model.problem).toContain("ANTHROPIC_API_KEY");

      running.child.kill("SIGINT");
      expect((await running.exited).code).toBe(0);
      expect(running.output()).toContain("Stopping on SIGINT");
    },
  );

  it(
    "warns once when it listens beyond this machine without a token, and not with one",
    { timeout: TIMEOUT },
    async () => {
      const [open, guarded] = await Promise.all([
        startMain({ HOST: "0.0.0.0" }),
        startMain({ HOST: "0.0.0.0", CLAUSEWISE_ACCESS_TOKEN: "0123456789abcdef0123" }),
      ]);
      const warning = open
        .output()
        .split("\n")
        .filter((line) => line.includes('"level":"warn"') && line.includes("access token"));
      expect(warning).toHaveLength(1);
      expect(warning[0]).toContain("CLAUSEWISE_ACCESS_TOKEN");

      expect(guarded.output()).not.toContain("without an access token");
      expect(guarded.output()).not.toContain("0123456789abcdef0123");
      // A token turns the Host check off and asks for the token on the API.
      expect((await fetch(`${guarded.url}/api/documents`)).status).toBe(401);
      for (const running of [open, guarded]) running.child.kill("SIGTERM");
      await Promise.all([open.exited, guarded.exited]);
    },
  );

  it(
    "stops with exit code 1 on an error nobody caught, and logs its kind and not what it said",
    { timeout: TIMEOUT },
    async () => {
      // The launcher raises the error on a signal: a rejection nobody handles, or an exception.
      for (const [signal, message] of [
        ["SIGUSR2", "an unhandled promise rejection"],
        ["SIGHUP", "an uncaught exception"],
      ] as const) {
        const running = await startMain({});
        running.child.kill(signal);
        const { code } = await running.exited;
        expect(code, message).toBe(1);
        const line = running
          .output()
          .split("\n")
          .find((l) => l.includes(`"${message}"`));
        expect(line, message).toBeDefined();
        expect(JSON.parse(line ?? "{}")).toMatchObject({ level: "error", name: "Error" });
        // What the error said is a sentence of a contract, and it is nowhere in the output.
        expect(running.output(), message).not.toContain("penalty");
      }
    },
  );

  it(
    "refuses to start on a setting that is wrong, in one line and with exit code 1",
    { timeout: TIMEOUT },
    async () => {
      for (const [env, message] of [
        [{ PORT: "eighty" }, "PORT must be a whole number from 0 to 65535"],
        [
          { CLAUSEWISE_ACCESS_TOKEN: "short" },
          "CLAUSEWISE_ACCESS_TOKEN must be at least 16 characters",
        ],
      ] as const) {
        const run = launch({ ...env, CLAUSEWISE_DATA_DIR: await tempDir("clausewise-main-") });
        const { code } = await run.exited;
        expect(code, message).toBe(1);
        expect(run.output()).toContain(`Clausewise could not start: ${message}`);
        expect(run.output()).not.toContain("    at ");
        expect(run.output()).not.toContain("short");
      }
    },
  );
});
