import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_ENV, TIMEOUT, cleanUpChildren, cli, start } from "./child.js";
import { listing, playbookPath, stage, tempDirs } from "./support.js";

cleanUpChildren();

describe("the clausewise command", () => {
  const makeDir = tempDirs();

  it("prints the usage for --help and exits 0", { timeout: TIMEOUT }, async () => {
    const outcome = await cli(["--help"]);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("Usage:");
    expect(outcome.stdout).toContain("clausewise review <contract.docx> --playbook <file.yaml>");
    expect(outcome.stdout).toContain("ANTHROPIC_API_KEY");
  });

  it("exits 1 with the usage hint for an unknown command", { timeout: TIMEOUT }, async () => {
    const outcome = await cli(["frobnicate"]);

    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain("Unknown command: frobnicate");
    expect(outcome.stderr).toContain('Run "clausewise --help" for usage.');
  });

  it("checks a shipped playbook", { timeout: TIMEOUT }, async () => {
    const outcome = await cli(["playbook", "check", playbookPath("nda-mutual.yaml")]);

    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain("is a valid playbook.");
  });

  it(
    "asks for ANTHROPIC_API_KEY, exits 1 and writes nothing when there is none",
    {
      timeout: TIMEOUT,
    },
    async () => {
      const dir = await makeDir();
      const input = await stage(dir, "nda-balanced.docx");

      const outcome = await cli(["review", input, "--playbook", playbookPath("nda-mutual.yaml")]);

      expect(outcome.code).toBe(1);
      expect(outcome.stderr).toContain("ANTHROPIC_API_KEY");
      expect(outcome.stderr).not.toContain("    at ");
      expect(outcome.stdout).toBe("");
      expect(await listing(dir)).toEqual(["nda-balanced.docx"]);
    },
  );
});

describe("Ctrl-C on the real command", () => {
  const makeDir = tempDirs();
  let server: Server | undefined;

  afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  it(
    "stops a review that is waiting for the model and exits 130",
    { timeout: TIMEOUT },
    async () => {
      // A server on this machine that takes every request and never answers, so the review is
      // certainly in flight when the signal arrives.
      let requested!: () => void;
      const firstRequest = new Promise<void>((resolve) => (requested = resolve));
      server = createServer(() => requested());
      const listening = server;
      await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
      const { port } = listening.address() as AddressInfo;

      const dir = await makeDir();
      const input = await stage(dir, "nda-aggressive.docx");
      const run = start(
        process.execPath,
        [
          ...["--import", "tsx", "apps/cli/src/bin.ts"],
          ...["review", input, "--playbook", playbookPath("nda-mutual.yaml")],
        ],
        {
          ...BASE_ENV,
          CLAUSEWISE_PROVIDER: "openai-compatible",
          CLAUSEWISE_MODEL: "no-such-model",
          CLAUSEWISE_BASE_URL: `http://127.0.0.1:${port}/v1`,
          CLAUSEWISE_MAX_RETRIES: "0",
        },
      );

      await firstRequest;
      run.child.kill("SIGINT");
      const outcome = await run.done;

      expect(outcome.code).toBe(130);
      expect(outcome.stderr).toContain("OpenAI-compatible server (127.0.0.1:");
      expect(outcome.stderr).toContain("Interrupted. No files were written.");
      expect(outcome.stdout).toBe("");
      expect(await listing(dir)).toEqual(["nda-aggressive.docx"]);
    },
  );
});
