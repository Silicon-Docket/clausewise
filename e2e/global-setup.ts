import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocx } from "../packages/docx/src/index.js";
import { LOCK_FILE_NAME } from "../apps/server/src/lock.js";
import { fixturePath } from "./paths.js";
import { startE2eServer, type E2eModel, type E2eServer } from "./start.js";
import { STATE_FILE_VARIABLE, type RunState, type ServerName } from "./state.js";
import { ensureWebBuild } from "./web-build.js";

/** An access token for the server that asks for one. A throwaway, at least 16 characters. */
export const E2E_ACCESS_TOKEN = "e2e-access-token-0123456789abcdef";

const SERVERS: { name: ServerName; model: E2eModel; accessToken?: string }[] = [
  { name: "main", model: "oracle" },
  { name: "token", model: "oracle", accessToken: E2E_ACCESS_TOKEN },
  { name: "rejected-key", model: "rejected-key" },
  { name: "unconfigured", model: "unconfigured" },
];

async function closeAll(servers: E2eServer[]): Promise<string[]> {
  const problems: string[] = [];
  const results = await Promise.allSettled(servers.map((server) => server.close()));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      problems.push(`The ${servers[index]?.name ?? "?"} server did not close cleanly: ${reason}`);
    }
  });
  return problems;
}

/**
 * Pieces of the fixture contracts, long enough that a log line holding one is a leak: every
 * paragraph of 40 characters or more is cut into overlapping windows of 32, so that a line holding
 * only part of a paragraph is found too. A window with a quotation mark or a backslash in it is
 * left out, because a log line is JSON and writes those differently.
 */
async function contractPieces(): Promise<string[]> {
  const pieces: string[] = [];
  for (const name of ["nda-aggressive.docx", "nda-balanced.docx", "saas-vendor-friendly.docx"]) {
    const parsed = await parseDocx(new Uint8Array(await readFile(fixturePath(name))));
    for (const paragraph of parsed.paragraphs) {
      if (paragraph.text.length < 40) continue;
      for (let at = 0; at + 32 <= paragraph.text.length; at += 16) {
        const window = paragraph.text.slice(at, at + 32);
        if (!/["\\]/.test(window)) pieces.push(window);
      }
    }
  }
  return pieces;
}

// What must be true of a server once the run is over, whatever the tests did.
async function checkAfterRun(servers: E2eServer[]): Promise<string[]> {
  const problems: string[] = [];
  const pieces = await contractPieces();
  for (const server of servers) {
    // Closing the server releases the lock on its data folder. A lock left behind means the next
    // server on that folder would think this one still runs.
    const files = existsSync(server.dataDir) ? await readdir(server.dataDir) : [];
    if (files.includes(LOCK_FILE_NAME)) {
      problems.push(`The ${server.name} server left its lock file ${LOCK_FILE_NAME} behind.`);
    }
    // The design promises that the log holds no contract text and no secret.
    const log = existsSync(server.logFile) ? await readFile(server.logFile, "utf8") : "";
    if (pieces.some((piece) => log.includes(piece))) {
      problems.push(`The log of the ${server.name} server holds text of a contract.`);
    }
    if (server.accessToken !== undefined && log.includes(server.accessToken)) {
      problems.push(`The log of the ${server.name} server holds the access token.`);
    }
  }
  return problems;
}

/**
 * Builds the web app if it needs it, starts the servers the scenarios talk to, and tells the
 * workers where they are. The function it returns is the global teardown: it closes every server,
 * checks what a clean shutdown and a private log promise, and removes the data folders.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  ensureWebBuild();

  const runDir = await mkdtemp(join(tmpdir(), "clausewise-e2e-"));
  const started: E2eServer[] = [];
  try {
    await Promise.all(
      SERVERS.map(async (spec) => {
        const server = await startE2eServer({ ...spec, runDir });
        started.push(server);
      }),
    );
  } catch (error) {
    await closeAll(started);
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }

  const state = Object.fromEntries(
    started.map((server) => [
      server.name,
      {
        name: server.name,
        url: server.url,
        dataDir: server.dataDir,
        logFile: server.logFile,
        accessToken: server.accessToken,
      },
    ]),
  ) as RunState;
  const stateFile = join(runDir, "servers.json");
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  process.env[STATE_FILE_VARIABLE] = stateFile;

  return async () => {
    const problems = await closeAll(started);
    problems.push(...(await checkAfterRun(started)));
    if (process.env.CLAUSEWISE_E2E_KEEP === "1") {
      console.log(`The data and logs of this run were kept in ${runDir}`);
    } else {
      await rm(runDir, { recursive: true, force: true });
    }
    if (problems.length > 0) throw new Error(problems.join("\n"));
  };
}
