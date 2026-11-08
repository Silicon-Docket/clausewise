import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type CliIo } from "@clausewise/cli";
import { createOracleGenerator } from "@clausewise/review/testing";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixtures, type Fixture } from "../../../evals/src/fixtures.js";
import { oracleScripts } from "../../../evals/src/selftest.js";
import { createReviewService, processReviewJob, type ResultKind } from "../src/index.js";
import { memoryBlobs, memoryQueue, memoryRecords } from "../src/memory.js";
import { directoryPlaybooks } from "../src/node.js";

// Phase 1's first exit criterion (docs/azure-in-tenant.md, section 9): with the scripted test
// model, every fixture contract reviewed through the service gives the same results as the
// command line.

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const decoder = new TextDecoder();

let fixtures: Fixture[];
let dir: string;

beforeAll(async () => {
  fixtures = await loadFixtures(ROOT, []);
  dir = await mkdtemp(join(tmpdir(), "clausewise-parity-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Results {
  redlined: Uint8Array;
  report: string;
  summary: string;
}

async function viaCli(fixture: Fixture): Promise<Results> {
  const input = join(dir, fixture.name);
  await writeFile(input, fixture.docx);
  const out = join(dir, `${fixture.name}.cli`);
  const io: CliIo = {
    stdout: () => {},
    stderr: () => {},
    env: {},
    generatorFactory: () => createOracleGenerator(oracleScripts(fixture)),
  };
  const code = await run(
    [
      "review",
      input,
      "--playbook",
      join(ROOT, fixture.playbookPath),
      "--quiet",
      "--out",
      `${out}.docx`,
      "--report",
      `${out}.json`,
      "--summary",
      `${out}.md`,
    ],
    io,
  );
  expect(code).toBe(0);
  return {
    redlined: new Uint8Array(await readFile(`${out}.docx`)),
    report: await readFile(`${out}.json`, "utf8"),
    summary: await readFile(`${out}.md`, "utf8"),
  };
}

async function viaService(fixture: Fixture): Promise<Results> {
  const deps = {
    records: memoryRecords(),
    contracts: memoryBlobs(),
    results: memoryBlobs(),
    queue: memoryQueue(),
    playbooks: directoryPlaybooks(join(ROOT, "playbooks")),
  };
  const service = createReviewService(deps);
  const user = { id: "user-1" };
  const review = await service.createReview(user, {
    playbookId: basename(fixture.playbookPath, ".yaml"),
    fileName: fixture.name,
  });
  await service.uploadContract(user, review.id, fixture.docx);
  await service.startReview(user, review.id);

  const delivery = await deps.queue.receive();
  expect(delivery?.job).toEqual({ reviewId: review.id });
  const outcome = await processReviewJob(delivery!.job, {
    ...deps,
    generator: createOracleGenerator(oracleScripts(fixture)),
  });
  expect(outcome).toBe("done");

  const result = (kind: ResultKind) => service.getResult(user, review.id, kind);
  return {
    redlined: await result("redlined"),
    report: decoder.decode(await result("report")),
    summary: decoder.decode(await result("summary")),
  };
}

// Tracked changes and comments carry the time they were made, which differs between two runs.
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;

async function parts(docx: Uint8Array): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(docx);
  const contents = new Map<string, string>();
  for (const name of Object.keys(zip.files).sort()) {
    const file = zip.files[name];
    if (file === undefined || file.dir) continue;
    contents.set(name, (await file.async("string")).replace(TIMESTAMP, "<time>"));
  }
  return contents;
}

describe("the service gives the command line's results", () => {
  it("has fixtures to compare", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(["nda-aggressive.docx", "nda-balanced.docx", "saas-vendor-friendly.docx"])(
    "for %s",
    async (name) => {
      const fixture = fixtures.find((candidate) => candidate.name === name);
      expect(fixture).toBeDefined();
      const [cli, service] = await Promise.all([viaCli(fixture!), viaService(fixture!)]);

      expect(service.report).toBe(cli.report);
      expect(service.summary).toBe(cli.summary);
      expect(await parts(service.redlined)).toEqual(await parts(cli.redlined));
    },
  );

  it("covers every fixture in expected.json", () => {
    expect(fixtures.map((fixture) => fixture.name).sort()).toEqual([
      "nda-aggressive.docx",
      "nda-balanced.docx",
      "saas-vendor-friendly.docx",
    ]);
  });
});
