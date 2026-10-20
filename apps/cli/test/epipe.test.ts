import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LAUNCHER,
  TIMEOUT,
  cleanUpChildren,
  fakeModelServer,
  modelEnv,
  start,
  type Verdict,
} from "./child.js";
import { listing, playbookPath, root, stage, tempDirs } from "./support.js";

cleanUpChildren();

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const LAUNCH = [LAUNCHER];
const hasBash = spawnSync("bash", ["--version"]).status === 0;

const OUTPUTS = [
  "nda-balanced.docx",
  "nda-balanced.redlined.docx",
  "nda-balanced.report.json",
  "nda-balanced.summary.md",
];

// A reader that goes away makes the next write to the pipe fail with EPIPE. The reader here is
// this test, and it hangs up before the command has started, so every write finds a closed pipe.
async function reviewWithClosedPipes(options: {
  verdict: Verdict;
  closed: ("stdout" | "stderr")[];
  gate?: string;
  dir: string;
}) {
  const { port, requests } = await fakeModelServer(options.verdict);
  const input = await stage(options.dir, "nda-balanced.docx");
  const run = start(
    process.execPath,
    [
      ...LAUNCH,
      ...["review", input, "--playbook", PLAYBOOK],
      ...(options.gate === undefined ? [] : ["--fail-on", options.gate]),
    ],
    modelEnv(port),
  );
  for (const name of options.closed) run.child[name].destroy();
  const outcome = await run.done;
  return { outcome, requests: requests() };
}

describe("a pipe whose reader has gone", () => {
  const makeDir = tempDirs();

  it(
    "does not change the exit code of a finished review when stdout is closed",
    { timeout: TIMEOUT },
    async () => {
      const dir = await makeDir();

      const { outcome } = await reviewWithClosedPipes({
        verdict: "compliant",
        closed: ["stdout"],
        dir,
      });

      expect(outcome.code).toBe(0);
      expect(outcome.stderr).not.toMatch(/EPIPE|Unhandled|node:events/);
      expect(await listing(dir)).toEqual([...OUTPUTS].sort());
    },
  );

  it(
    "keeps the gate's exit code 2 when stdout is closed, as announced on stderr",
    { timeout: TIMEOUT },
    async () => {
      const dir = await makeDir();

      const { outcome } = await reviewWithClosedPipes({
        verdict: "deviation",
        closed: ["stdout"],
        gate: "high",
        dir,
      });

      expect(outcome.stderr).toContain("Exiting with code 2");
      expect(outcome.code).toBe(2);
      expect(outcome.stderr).not.toMatch(/EPIPE|Unhandled|node:events/);
      expect(await listing(dir)).toEqual([...OUTPUTS].sort());
    },
  );

  it("does not abort a paid review when stderr is closed", { timeout: TIMEOUT }, async () => {
    const dir = await makeDir();

    const { outcome, requests } = await reviewWithClosedPipes({
      verdict: "deviation",
      closed: ["stderr"],
      gate: "high",
      dir,
    });

    // Ten rules were asked about, and the results were written and reported.
    expect(requests).toBe(10);
    expect(outcome.code).toBe(2);
    expect(outcome.stdout).toContain("Written:");
    expect(await listing(dir)).toEqual([...OUTPUTS].sort());
    const report = JSON.parse(await readFile(join(dir, "nda-balanced.report.json"), "utf8"));
    expect(report.counts.deviation).toBe(10);
  });

  it("finishes a review with both streams closed", { timeout: TIMEOUT }, async () => {
    const dir = await makeDir();

    const { outcome } = await reviewWithClosedPipes({
      verdict: "compliant",
      closed: ["stdout", "stderr"],
      dir,
    });

    expect(outcome.code).toBe(0);
    expect(await listing(dir)).toEqual([...OUTPUTS].sort());
  });

  it("does not crash on --help when stdout is closed", { timeout: TIMEOUT }, async () => {
    const run = start(process.execPath, [...LAUNCH, "--help"], modelEnv(1));
    run.child.stdout.destroy();

    const outcome = await run.done;

    expect(outcome.code).toBe(0);
    expect(outcome.stderr).not.toMatch(/EPIPE|Unhandled|node:events/);
  });

  // The same thing through a shell, which is how a person meets it: `clausewise ... | true`.
  it.skipIf(!hasBash)(
    "keeps the exit code of a review piped into a command that never reads",
    { timeout: TIMEOUT },
    async () => {
      const dir = await makeDir();
      const { port } = await fakeModelServer("deviation");
      const input = await stage(dir, "nda-balanced.docx");
      const script = [
        `"${process.execPath}" "${LAUNCHER}" review "$1" --playbook "$2" ` +
          '--fail-on high 2> "$3" | true',
        'echo "${PIPESTATUS[0]}" > "$4"',
      ].join("\n");
      const err = join(dir, "stderr.txt");
      const code = join(dir, "code.txt");

      const run = start(
        "bash",
        ["-c", script, "bash", input, PLAYBOOK, err, code],
        modelEnv(port),
        {
          cwd: root,
        },
      );
      await run.done;

      expect((await readFile(code, "utf8")).trim()).toBe("2");
      expect(await readFile(err, "utf8")).not.toMatch(/EPIPE|Unhandled|node:events/);
      expect(await listing(dir)).toEqual([...OUTPUTS, "code.txt", "stderr.txt"].sort());
    },
  );
});
