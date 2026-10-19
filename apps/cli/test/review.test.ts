import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { renderMarkdown, type ReviewReport } from "@clausewise/review";
import { createOracleGenerator } from "@clausewise/review/testing";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import {
  HALLUCINATED_EDIT,
  TERM_EDIT,
  aggressiveOracle,
  bytesOf,
  compliantScript,
  expectedScript,
  failingGenerator,
  listing,
  makeIo,
  makeTempDir,
  playbookPath,
  removeDir,
  ruleIds,
  same,
  stage,
  tempDirs,
  tracing,
  viewDocx,
  type DocxView,
  type Harness,
} from "./support.js";

const PLAYBOOK = playbookPath("nda-mutual.yaml");
const DISCLOSURE =
  "Sending the contract text to: a scripted test oracle (nothing is sent anywhere)";

describe("review of the aggressive NDA", () => {
  let dir: string;
  let input: string;
  let code: number;
  let harness: Harness;
  let log: string[];
  let oracle: ReturnType<typeof aggressiveOracle>;
  let report: ReviewReport;
  let summary: string;
  let before: DocxView;
  let after: DocxView;
  let titles: Map<string, string>;

  beforeAll(async () => {
    dir = await makeTempDir();
    input = await stage(dir, "nda-aggressive.docx");
    titles = new Map(
      (await loadPlaybookFile(PLAYBOOK)).rules.map((rule) => [rule.id, rule.title] as const),
    );
    log = [];
    oracle = aggressiveOracle();
    harness = makeIo({ generator: tracing(oracle, log), log });
    code = await run(["review", input, "--playbook", PLAYBOOK], harness.io);

    report = JSON.parse(await readFile(join(dir, "nda-aggressive.report.json"), "utf8"));
    summary = await readFile(join(dir, "nda-aggressive.summary.md"), "utf8");
    before = await viewDocx(await bytesOf(input));
    after = await viewDocx(await bytesOf(join(dir, "nda-aggressive.redlined.docx")));
  });

  afterAll(() => removeDir(dir));

  const title = (id: string): string => titles.get(id) ?? `(no rule ${id})`;

  it("exits 0 and writes the three outputs next to the input, leaving the input alone", async () => {
    expect(code).toBe(0);
    expect(await listing(dir)).toEqual([
      "nda-aggressive.docx",
      "nda-aggressive.redlined.docx",
      "nda-aggressive.report.json",
      "nda-aggressive.summary.md",
    ]);
    const original = await bytesOf(join(dir, "nda-aggressive.docx"));
    expect(same(original, await bytesOf(input))).toBe(true);
    expect(same(original, await bytesOf(join(dir, "nda-aggressive.redlined.docx")))).toBe(false);
    expect(harness.stderr()).not.toMatch(/error/i);
  });

  it("writes the ReviewReport as pretty printed JSON with the counts a correct review gives", async () => {
    const text = await readFile(join(dir, "nda-aggressive.report.json"), "utf8");
    expect(text).toBe(`${JSON.stringify(report, null, 2)}\n`);
    expect(report.document).toBe("nda-aggressive.docx");
    expect(report.model).toEqual({
      provider: "oracle",
      model: "oracle",
      disclosure: "a scripted test oracle (nothing is sent anywhere)",
    });
    expect(report.counts).toEqual({
      compliant: 0,
      deviation: 9,
      missing: 1,
      not_applicable: 0,
      error: 0,
    });
    expect(report.open).toEqual({ high: 4, medium: 4, low: 2 });
    expect(report.results.map((result) => result.ruleId)).toEqual(ruleIds("nda-aggressive.docx"));
    expect(report.stats.editsApplied).toBe(1);
  });

  it("records the valid edit as applied and the invented quote as comment-only", () => {
    const term = report.results.find((result) => result.ruleId === "term");
    expect(term?.edit).toMatchObject({
      kind: "applied",
      original: TERM_EDIT.quote,
      replacement: TERM_EDIT.replacement,
    });
    const remedies = report.results.find((result) => result.ruleId === "remedies");
    expect(remedies?.status).toBe("deviation");
    expect(remedies?.edit).toMatchObject({
      kind: "comment-only",
      proposed: { quote: HALLUCINATED_EDIT.quote },
      reason: expect.stringMatching(/not found/),
    });
  });

  it("puts the one valid edit in the redlined contract as a tracked change", () => {
    const tracked = after.paragraphs.flatMap((paragraph, i) => (paragraph.tracked ? [i] : []));
    expect(tracked).toHaveLength(1);
    const index = tracked[0] ?? -1;
    const original = before.paragraphs[index]?.accepted ?? "";
    expect(original).toContain(TERM_EDIT.quote);
    expect(after.paragraphs[index]?.accepted).toBe(
      original.replace(TERM_EDIT.quote, TERM_EDIT.replacement),
    );
  });

  it("restores the original text everywhere when the tracked changes are rejected", () => {
    expect(after.paragraphs.map((paragraph) => paragraph.rejected)).toEqual(
      before.paragraphs.map((paragraph) => paragraph.accepted),
    );
  });

  it("leaves one comment for each deviation and missing clause, by the default author", () => {
    expect(after.comments).toHaveLength(10);
    expect(new Set(after.comments.map((comment) => comment.author))).toEqual(
      new Set(["Clausewise"]),
    );
    const term = after.comments.find((comment) => comment.text.includes(title("term")));
    expect(term?.text).toContain("[HIGH]");
    expect(term?.text).toContain("Please fix term.");
    const missing = after.comments.find((comment) =>
      comment.text.includes(title("compelled-disclosure")),
    );
    expect(missing?.text).toContain("Suggested clause:");
  });

  it("writes the Markdown summary from the report, naming the high severity items", () => {
    expect(summary).toBe(renderMarkdown(report));
    expect(summary.match(/\*\*High\*\* severity/g)).toHaveLength(4);
    for (const id of ["mutuality", "exclusions", "term", "restrictive-covenants"]) {
      expect(summary).toContain(title(id));
    }
  });

  it("tells the user where the text goes before the first model call", () => {
    const notice = log.indexOf(`stderr: ${DISCLOSURE}\n`);
    const firstCall = log.indexOf("generate");
    expect(notice).toBeGreaterThanOrEqual(0);
    expect(firstCall).toBeGreaterThan(notice);
    expect(oracle.calls).toHaveLength(10);
    expect(harness.stderr().startsWith(`${DISCLOSURE}\n`)).toBe(true);
  });

  it("prints one progress line per finished rule", () => {
    const lines = harness.stderr().split("\n");
    const progress = lines.filter((line) => line.startsWith("["));
    expect(progress).toHaveLength(10);
    expect(progress.map((line) => /^\[(\d+)\/10\] /.exec(line)?.[1])).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
    expect(progress.some((line) => /^\[\d+\/10\] term: deviation$/.test(line))).toBe(true);
    expect(progress.some((line) => /^\[\d+\/10\] compelled-disclosure: missing$/.test(line))).toBe(
      true,
    );
    expect(lines).toContain("Checking 16 clauses against 10 rules.");
  });

  it("prints a summary on stdout with the counts, the open items by severity and the paths", () => {
    const out = harness.stdout();
    expect(out).toMatch(/Deviations:\s+9/);
    expect(out).toMatch(/Missing clauses:\s+1/);
    expect(out).toContain("Open items by severity: 4 high, 4 medium, 2 low");
    expect(out).toContain("Tracked changes applied: 1");
    expect(out).toContain(`[high] ${title("mutuality")}: deviation, clauses 1.1, 2.1`);
    expect(out).toContain(`[medium] ${title("compelled-disclosure")}: missing\n`);
    expect(out).toContain(`[low] ${title("governing-law")}: deviation, clause 7.1`);
    for (const name of ["redlined.docx", "report.json", "summary.md"]) {
      expect(out).toContain(join(dir, `nda-aggressive.${name}`));
    }
  });

  it("lists the most severe items first and keeps the playbook's order within a severity", () => {
    const rows = harness
      .stdout()
      .split("\n")
      .filter((line) => /^ {2}\[(high|medium|low)\]/.test(line));
    expect(rows.map((row) => /\[(\w+)\]/.exec(row)?.[1])).toEqual([
      ...Array<string>(4).fill("high"),
      ...Array<string>(4).fill("medium"),
      ...Array<string>(2).fill("low"),
    ]);
    expect(rows[0]).toContain(title("mutuality"));
    expect(rows[1]).toContain(title("exclusions"));
    expect(rows[2]).toContain(title("term"));
    expect(rows[3]).toContain(title("restrictive-covenants"));
  });
});

describe("review of the balanced NDA", () => {
  const makeDir = tempDirs();

  it("exits 0 and hands back the input bytes when nothing needs a change", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const generator = createOracleGenerator(expectedScript("nda-balanced.docx"));
    const { io, stdout } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK], io)).toBe(0);

    const redlined = await bytesOf(join(dir, "nda-balanced.redlined.docx"));
    expect(same(redlined, await bytesOf(input))).toBe(true);
    const report: ReviewReport = JSON.parse(
      await readFile(join(dir, "nda-balanced.report.json"), "utf8"),
    );
    expect(report.counts).toEqual({
      compliant: 9,
      deviation: 0,
      missing: 0,
      not_applicable: 1,
      error: 0,
    });
    expect(report.open).toEqual({ high: 0, medium: 0, low: 0 });
    expect(stdout()).toContain("No deviations or missing clauses.");
    expect(await readFile(join(dir, "nda-balanced.summary.md"), "utf8")).toContain(
      "Nothing needs attention.",
    );
  });
});

describe("review options", () => {
  const makeDir = tempDirs();
  // One deviation with a valid edit, so there is a tracked change and a comment to look at.
  const oneDeviation = () =>
    createOracleGenerator(
      compliantScript({ term: { status: "deviation", clauseNumbers: ["3.1"], edit: TERM_EDIT } }),
    );

  it("names the outputs after the input, whatever its extension or dots", async () => {
    const dir = await makeDir();
    const odd = join(dir, "Deal v2.final.DOCX");
    await rename(await stage(dir, "nda-balanced.docx"), odd);
    const { io } = makeIo({ generator: oneDeviation() });

    expect(await run(["review", odd, "--playbook", PLAYBOOK], io)).toBe(0);

    expect(await listing(dir)).toEqual([
      "Deal v2.final.DOCX",
      "Deal v2.final.redlined.docx",
      "Deal v2.final.report.json",
      "Deal v2.final.summary.md",
    ]);
  });

  it("writes to the paths given with --out, --report and --summary", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const out = join(dir, "marked-up.docx");
    const reportPath = join(dir, "r.json");
    const summaryPath = join(dir, "s.md");
    const { io, stdout } = makeIo({ generator: oneDeviation() });

    const code = await run(
      [
        ...["review", input, "--playbook", PLAYBOOK],
        ...["--out", out, "--report", reportPath, `--summary=${summaryPath}`],
      ],
      io,
    );

    expect(code).toBe(0);
    expect(await listing(dir)).toEqual(["marked-up.docx", "nda-aggressive.docx", "r.json", "s.md"]);
    for (const path of [out, reportPath, summaryPath]) expect(stdout()).toContain(path);
  });

  it("writes the author given with --author on the tracked change and the comment", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const { io } = makeIo({ generator: oneDeviation() });

    await run(["review", input, "--playbook", PLAYBOOK, "--author", "Dana Reviewer"], io);

    const redlined = await bytesOf(join(dir, "nda-aggressive.redlined.docx"));
    expect((await viewDocx(redlined)).comments.map((comment) => comment.author)).toEqual([
      "Dana Reviewer",
    ]);
    const xml = await (await JSZip.loadAsync(redlined)).file("word/document.xml")?.async("string");
    expect(xml).toContain('w:author="Dana Reviewer"');
    expect(xml).not.toContain('w:author="Clausewise"');
  });

  it("prints no progress with --quiet, but still says where the text is going", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const generator = createOracleGenerator(expectedScript("nda-balanced.docx"));
    const { io, stderr, stdout } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", PLAYBOOK, "--quiet"], io)).toBe(0);

    expect(stderr()).toBe(`${DISCLOSURE}\n`);
    expect(stdout()).toContain("Results:");
  });
});

describe("paths and names", () => {
  const makeDir = tempDirs();

  it("takes a contract whose name starts with a dash after --", async () => {
    const dir = await makeDir();
    const odd = join(dir, "-odd.docx");
    await rename(await stage(dir, "nda-balanced.docx"), odd);
    const generator = createOracleGenerator(compliantScript());
    const { io } = makeIo({ generator });

    expect(await run(["review", "--playbook", PLAYBOOK, "--", odd], io)).toBe(0);

    expect(await listing(dir)).toContain("-odd.redlined.docx");
  });

  it("writes next to a contract given by a relative path, and shows the paths as given", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, "deals"));
    await rename(await stage(dir, "nda-balanced.docx"), join(dir, "deals", "acme.docx"));
    const generator = createOracleGenerator(compliantScript());
    const { io, stdout } = makeIo({ generator });
    const before = process.cwd();

    process.chdir(dir);
    try {
      expect(await run(["review", join("deals", "acme.docx"), "--playbook", PLAYBOOK], io)).toBe(0);
    } finally {
      process.chdir(before);
    }

    expect(await listing(join(dir, "deals"))).toEqual([
      "acme.docx",
      "acme.redlined.docx",
      "acme.report.json",
      "acme.summary.md",
    ]);
    expect(stdout()).toMatch(/Redlined contract: +deals\/acme\.redlined\.docx\n/);
  });

  it("keeps control characters in a playbook's titles off the terminal", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-balanced.docx");
    const playbook = join(dir, "sneaky.yaml");
    // YAML escapes in double quotes: \x1b is the escape character, \n a line break.
    await writeFile(
      playbook,
      [
        'name: "Sneaky \\x1b[31mplaybook"',
        "contractTypes: [nda]",
        "perspective: P",
        "rules:",
        '  - {id: a, title: "Evil \\x1b[31mtitle\\nsecond line", severity: low, standard: s}',
        "  - {id: b, title: Fine, severity: low, standard: s}",
      ].join("\n"),
    );
    const generator = createOracleGenerator({
      a: { status: "deviation", clauseNumbers: ["1.1"] },
      b: { status: "compliant" },
    });
    const { io, stdout, stderr } = makeIo({ generator });

    expect(await run(["review", input, "--playbook", playbook], io)).toBe(0);

    expect(stdout() + stderr()).not.toContain(String.fromCharCode(27));
    expect(stdout()).toContain("[low] Evil [31mtitle second line: deviation, clause 1.1\n");
    expect(stdout()).toContain("against Sneaky [31mplaybook.\n");
  });
});

describe("a review that ends with rules it could not check", () => {
  const makeDir = tempDirs();

  it("lists them, exits 0, and warns when --fail-on cannot count them", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const script = compliantScript();
    delete script["remedies"];
    const { io, stdout, stderr } = makeIo({ generator: createOracleGenerator(script) });

    const code = await run(["review", input, "--playbook", PLAYBOOK, "--fail-on", "low"], io);

    expect(code).toBe(0);
    expect(stdout()).toMatch(/Could not be checked:\s+1/);
    expect(stdout()).toContain(
      "These rules could not be checked, so the review does not cover them:",
    );
    expect(stdout()).toContain("Remedies: The check failed unexpectedly (Error).");
    expect(stderr()).toContain(
      "Warning: 1 rule could not be checked, and --fail-on does not count them.",
    );
  });
});

describe("confidentiality", () => {
  const makeDir = tempDirs();
  const SECRET = "SECRET-CLAUSE-TEXT-7731";

  it("prints and writes nothing from the message of a failing model call", async () => {
    const dir = await makeDir();
    const input = await stage(dir, "nda-aggressive.docx");
    const generator = failingGenerator(() => new Error(`The model said: ${SECRET}`));
    const { io, stdout, stderr } = makeIo({ generator });

    const code = await run(["review", input, "--playbook", PLAYBOOK], io);

    expect(code).toBe(0);
    expect(stdout()).toMatch(/Could not be checked:\s+10/);
    const seen = [stdout(), stderr()];
    for (const name of await listing(dir)) {
      if (name.endsWith(".json") || name.endsWith(".md")) {
        seen.push(await readFile(join(dir, name), "utf8"));
      }
    }
    expect(seen).toHaveLength(4);
    expect(seen.join("\n")).not.toContain(SECRET);
  });
});
