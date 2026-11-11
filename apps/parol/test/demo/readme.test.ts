import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_PLAYBOOK_SLUG } from "../../src/boot/index.js";
import { DEFAULT_DATA_DIR, DEFAULT_HOST, DEFAULT_PORT } from "../../src/main.js";
import { WORKFLOW_LABELS } from "../../src/boot/register.js";
import { GLOBAL_ACTIONS } from "../../src/auth/actions.js";
import { PLANTED_RULE_KEY, TRAINING_TITLE_MARKER } from "../../src/demo/training-example.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { parseAuditVerifyArgs, runAuditVerify } from "../../src/audit-verify.js";
import { parseRetainArgs, runRetain } from "../../src/retain.js";
import { DEFAULT_MAX_MATTERS_PER_RUN, MAX_MATTERS_CEILING } from "../../src/retention/job.js";
import { describeSeedFailure, parseSeedArgs } from "../../src/seed.js";
import { NAV_ITEMS } from "../../src/server/pages/layout.js";
import { urls } from "../../src/server/urls.js";
import { DEFAULT_RETAIN_DAYS, MAX_RETAIN_DAYS } from "../../src/store/repo-matters.js";
import { T01 } from "../../src/training/t01.js";
import { RULE_IDS } from "../a11y/rules.js";
import { ROOT, loadDemoPlaybook } from "../integration/pipeline.js";
import { variants } from "../pages/variants.js";

/**
 * The README is a set of promises about commands, settings, screens and honesty. Each is checked
 * against the thing it names, so that it cannot go on saying something that stopped being true.
 */

const PAROL = join(ROOT, "apps", "parol");
const README = readFileSync(join(PAROL, "README.md"), "utf8");
const rootPackage = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

const source = (...path: string[]): string => readFileSync(join(PAROL, "src", ...path), "utf8");

/** The README with its line breaks folded, so that a sentence can be looked for across them. */
const FOLDED = README.replace(/\s+/g, " ");

/**
 * The rows of the README's tables, as their cells. The one table of what is built is read by its
 * first cell, so a row cannot be reworded to something this file no longer finds.
 */
const TABLE_ROWS = README.split("\n")
  .filter((line) => line.startsWith("|"))
  .map((line) =>
    line
      .slice(1, line.lastIndexOf("|"))
      .split("|")
      .map((cell) => cell.trim()),
  );
const stateOf = (label: string): string => {
  const row = TABLE_ROWS.find((cells) => cells[0]!.startsWith(label));
  if (row === undefined) throw new Error(`the README has no table row that starts "${label}"`);
  return row.slice(1).join(" | ");
};

/** Every file under a folder, with the ones the reader asks for. */
function filesUnder(dir: string, pattern = /\.(?:ts|tsx|md)$/): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? filesUnder(path, pattern)
      : pattern.test(name)
        ? [path]
        : [];
  });
}

describe("the commands in the README", () => {
  // `pnpm <script>`, `pnpm exec <binary>`, `pnpm --filter <package> <script>`.
  const COMMAND = /pnpm\s+(?:--filter\s+(\S+)\s+)?(exec\s+)?([A-Za-z][\w:-]*)/g;
  const commands = [...README.matchAll(COMMAND)].map((m) => ({
    filter: m[1],
    exec: m[2] !== undefined,
    word: m[3]!,
    text: m[0],
  }));

  it("mentions the commands of the walk-through", () => {
    const words = commands.map((c) => c.text.replace(/\s+/g, " "));
    for (const wanted of ["pnpm install", "pnpm parol:seed", "pnpm parol", "pnpm test"])
      expect(words, wanted).toContain(wanted);
  });

  it("names only commands that exist: a package script, a pnpm command or an installed binary", () => {
    const missing: string[] = [];
    for (const { filter, exec, word, text } of commands) {
      if (filter !== undefined) {
        const manifests = ["apps", "packages"].flatMap((group) =>
          readdirSync(join(ROOT, group)).flatMap((name) => {
            const path = join(ROOT, group, name, "package.json");
            return existsSync(path)
              ? [
                  JSON.parse(readFileSync(path, "utf8")) as {
                    name: string;
                    scripts?: Record<string, string>;
                  },
                ]
              : [];
          }),
        );
        const target = manifests.find((m) => m.name === filter);
        if (target === undefined || target.scripts?.[word] === undefined) missing.push(text);
      } else if (exec) {
        if (!existsSync(join(ROOT, "node_modules", ".bin", word))) missing.push(text);
      } else if (word !== "install" && rootPackage.scripts[word] === undefined) {
        missing.push(text);
      }
    }
    expect(missing).toEqual([]);
  });

  it("runs the server and the seed with the script names the root package gives them", () => {
    expect(rootPackage.scripts["parol"]).toContain("apps/parol/src/main.ts");
    expect(rootPackage.scripts["parol:seed"]).toContain("apps/parol/src/seed.ts");
    for (const script of ["parol", "parol:seed"])
      expect(rootPackage.scripts[script], script).toContain("--tsconfig apps/parol/tsconfig.json");
    expect(README).toContain("PAROL_DEMO_IDENTITY=1 pnpm parol:seed");
    expect(README).toContain("PAROL_DEMO_IDENTITY=1 PAROL_SCRIPTED=1 pnpm parol");
    expect(README).toContain("http://127.0.0.1:8787");
  });
});

/** Settings that only the tests read. The README may name them, and says that the server does not. */
const TEST_ONLY: string[] = ["PAROL_BROWSER_TESTS"];

describe("the settings in the README", () => {
  const main = source("main.ts");
  const llm = readFileSync(join(ROOT, "packages", "llm", "src", "config.ts"), "utf8");

  it("documents every PAROL_ variable the server reads, and no other", () => {
    const read = new Set(
      [...main.matchAll(/(?:read|readFlag|readInteger)\(\s*env,\s*"(PAROL_[A-Z_]+)"/g)].map(
        (m) => m[1]!,
      ),
    );
    expect([...read].length).toBeGreaterThanOrEqual(9);
    const documented = new Set([...README.matchAll(/\bPAROL_[A-Z_]+\b/g)].map((m) => m[0]));
    expect([...read].filter((name) => !documented.has(name))).toEqual([]);
    expect([...documented].filter((name) => !read.has(name) && !TEST_ONLY.includes(name))).toEqual(
      [],
    );
  });

  it("names a setting that only the tests read only as that, and the tests do read it", () => {
    for (const name of TEST_ONLY) {
      // The server does not read it, the browser tests do, and the root script that asks for them sets it.
      expect(main, name).not.toContain(name);
      const support = readFileSync(join(PAROL, "test", "a11y", "browser", "playwright.ts"), "utf8");
      expect(support, name).toContain(`"${name}"`);
      expect(rootPackage.scripts["test:browser"], name).toContain(`${name}=1`);
      expect(FOLDED, name).toContain(
        `sets \`${name}=1\` for them, and the server does not read that setting`,
      );
    }
  });

  it("documents the model settings the Clausewise layer reads", () => {
    const named = new Set(
      [...README.matchAll(/\b(?:CLAUSEWISE_[A-Z_]+|ANTHROPIC_API_KEY|OPENAI_API_KEY)\b/g)].map(
        (m) => m[0],
      ),
    );
    expect(named.size).toBeGreaterThanOrEqual(6);
    for (const name of named) expect(llm, name).toContain(`"${name}"`);
  });

  it("names every CLAUSEWISE_ setting the Clausewise layer reads, so that none is left to a document that does not describe it", () => {
    const read = new Set([...llm.matchAll(/"(CLAUSEWISE_[A-Z_]+)"/g)].map((m) => m[1]!));
    expect(read.size).toBeGreaterThanOrEqual(9);
    const named = new Set([...README.matchAll(/\bCLAUSEWISE_[A-Z_]+\b/g)].map((m) => m[0]));
    expect([...read].filter((name) => !named.has(name))).toEqual([]);
  });

  it("sends the reader to the Clausewise README only for settings that README describes", () => {
    const clausewise = readFileSync(join(ROOT, "README.md"), "utf8");
    const pointing = README.split(/\n{2,}/).filter((paragraph) =>
      /\]\(\.\.\/\.\.\/README\.md/.test(paragraph.replace(/\s+/g, " ")),
    );
    for (const paragraph of pointing)
      for (const name of paragraph.match(/\bCLAUSEWISE_[A-Z_]+\b/g) ?? [])
        expect(clausewise, `${name} in "${paragraph.slice(0, 60)}"`).toContain(name);
  });

  it("warns, where it says where the text goes, that CLAUSEWISE_FALLBACK sends it to a second model", () => {
    const where = README.slice(README.indexOf("**Where the text goes.**")).split(/\n{2,}/)[0]!;
    const folded = where.replace(/\s+/g, " ");
    expect(folded).toContain("CLAUSEWISE_FALLBACK");
    expect(folded).toMatch(/second model/);
    expect(llm).toContain('"CLAUSEWISE_FALLBACK"');
  });

  it("states the defaults the server has", () => {
    expect(README).toContain(`\`${DEFAULT_DATA_DIR}\``);
    expect(README).toContain(String(DEFAULT_PORT));
    expect(README).toContain(DEFAULT_HOST);
    expect(DEFAULT_PORT).toBe(8787);
  });

  it("describes the data folder as the server lays it out", () => {
    expect(main).toContain('"parol.sqlite"');
    expect(main).toContain('"matters"');
    expect(README).toContain("parol.sqlite");
    expect(README).toContain("matters/<matter id>/");
  });
});

describe("the claims about what is built", () => {
  it("says the model support check is off, and neither version the application ships pins a support prompt", () => {
    expect(README).toMatch(/Model support check\s*\|\s*Wired but off by default/);
    for (const label of WORKFLOW_LABELS)
      expect(WORKFLOWS[label]!.manifest.prompts.support, label).toBeNull();
    // v3 pins it, and is a candidate that only the evaluation runner can select.
    expect(WORKFLOWS["v3"]!.manifest.prompts.support).toBe("support.p1");
    expect(README).toMatch(/Workflow v3 pins it, in the evaluation only/);
  });

  it("says v1 and v2 use the check set C1 and that neither shipped version turns C2 on", () => {
    for (const label of WORKFLOW_LABELS)
      expect([label, WORKFLOWS[label]!.manifest.checks]).toEqual([label, ["C1"]]);
    expect(WORKFLOWS["v1"]!.manifest.retrieval).toBe("R1");
    expect(WORKFLOWS["v2"]!.manifest.retrieval).toBe("R2");
    expect(WORKFLOWS["v3"]!.manifest.checks).toEqual(["C1", "C2"]);
    expect(README).toMatch(/neither version the application ships turns it on/);
  });

  it("lists what is deferred, each as not built", () => {
    for (const row of ["Pilot go/no-go memo", "PDF documents", "Word add-in"])
      expect(README, row).toMatch(new RegExp(`\\|\\s*${row}[^|]*\\|\\s*Not built`));
  });

  it("lists what needs a provider key and the owner's decision to spend as not done, and says no result of it exists", () => {
    const state = stateOf("A live run, a measured baseline");
    expect(state).toMatch(/^Not done\./);
    expect(state).toMatch(/provider key/);
    expect(state).toMatch(/decision to spend/);
    expect(state).toMatch(/No document here states a result/);
    // The row names each of the things that have not been done.
    const row = TABLE_ROWS.find((cells) => cells[0]!.startsWith("A live run"))![0]!;
    for (const thing of [
      "measured baseline",
      "improvement cycle",
      "freezing EXP-001",
      "qualified review of the dataset",
      "measured numbers for the pilot",
    ])
      expect(row, thing).toContain(thing);
  });

  it("lists what part 3 built as built, and each row has its code", () => {
    // Each row's first cell, and the files that must exist for it to be true.
    const built: [string, string[]][] = [
      [
        "Evaluation comparison page",
        [
          "src/evaluations/index.ts",
          "src/server/pages/evaluations.tsx",
          "src/server/routes/evaluations.ts",
        ],
      ],
      [
        "Feedback on findings",
        [
          "src/services/feedback.ts",
          "src/server/pages/feedback.tsx",
          "migrations/006_feedback_capture.sql",
        ],
      ],
      [
        "Timers, shadow-mode reference list",
        [
          "src/pilot/compute.ts",
          "src/server/pages/pilot.tsx",
          "src/server/pages/timer.tsx",
          "src/server/pages/reference.tsx",
          "migrations/008_pilot_measures.sql",
        ],
      ],
      [
        "Training matter T01",
        [
          "src/training/start.ts",
          "src/server/pages/quickstart.tsx",
          "src/server/pages/help.tsx",
          "training/t01-nda.docx",
        ],
      ],
      [
        "Deletion of expired matters",
        [
          "src/retain.ts",
          "src/audit-verify.ts",
          "src/retention/job.ts",
          "src/server/pages/audit.tsx",
        ],
      ],
      [
        "Usage and the reported model",
        ["src/usage/guard.ts", "src/usage/live.ts", "migrations/004_usage_settled.sql"],
      ],
      [
        "Keyboard, contrast and error wording",
        [
          "test/a11y/rules.ts",
          "test/a11y/browser/audit.test.ts",
          "test/a11y/browser/flows.test.ts",
        ],
      ],
    ];
    for (const [label, files] of built) {
      expect(stateOf(label), label).toMatch(/^Built/);
      for (const file of files)
        expect(existsSync(join(PAROL, file)), `${label}: ${file}`).toBe(true);
    }
  });

  it("says that the five global actions follow a table and are not access control, and the table says who", () => {
    expect(FOLDED).toMatch(/with this sign-in they are not access control either \(gap 26/);
    expect(stateOf("Authorization on the server")).toMatch(/one of five global actions/);
    expect(Object.keys(GLOBAL_ACTIONS)).toHaveLength(5);
    expect(stateOf("Authorization on the server")).toMatch(/not access control with this sign-in/);
    // The roles the README gives: the legal engineer and the administrator for the first, the
    // administrator alone for the audit log.
    for (const action of ["evaluation.read", "pilot.read", "pilot.manage", "training.key"] as const)
      expect([...GLOBAL_ACTIONS[action]].sort(), action).toEqual(["admin", "legal_engineer"]);
    expect([...GLOBAL_ACTIONS["audit.read"]], "audit.read").toEqual(["admin"]);
    const labels = (global: string): string[] =>
      NAV_ITEMS.filter((item) => item.global === global).map((item) => item.label);
    expect(labels("evaluation.read")).toEqual(["Evaluations"]);
    expect(labels("pilot.read")).toEqual(["Pilot measures"]);
    expect(labels("audit.read")).toEqual(["Audit log"]);
    expect(FOLDED).toMatch(
      /\*\*Evaluations\*\*, \*\*Pilot measures\*\* and \*\*Audit log\*\* appear only for the people who may open them: the legal engineer and the administrator for the first two, the administrator alone for the third/,
    );
    // Quickstart and Help are shown to everyone.
    expect(NAV_ITEMS.filter((item) => item.global === undefined).map((item) => item.label)).toEqual(
      ["Matters", "Quickstart", "Help"],
    );
  });

  it("names the playbook and its version as the store has them", () => {
    const playbook = loadDemoPlaybook();
    expect(playbook.slug).toBe(DEMO_PLAYBOOK_SLUG);
    expect(README).toContain(`${playbook.slug}\` ${playbook.version}`);
  });
});

describe("the options, addresses and numbers in the README", () => {
  it("names the options of the seed, and the seed reads each of them", () => {
    for (const option of ["--run", "--training", "--pilot-demo"])
      expect(README, option).toContain(option);
    expect(parseSeedArgs(["--run", "v1", "--run", "v2"]).runs).toEqual(["v1", "v2"]);
    expect(parseSeedArgs(["--training"]).training).toBe(true);
    expect(parseSeedArgs(["--pilot-demo"]).pilotDemo).toBe(true);
    // An option the README does not name is refused, so the three are all there is.
    expect(() => parseSeedArgs(["--everything"])).toThrow();
  });

  it("names the options of the retention and audit commands, and they read each of them", () => {
    for (const option of ["--apply", "--max-matters", "--as-of", "--json", "--expect-head"])
      expect(README, option).toContain(option);
    expect(parseRetainArgs([]).apply).toBe(false);
    expect(parseRetainArgs(["--apply", "--max-matters", "3", "--json"])).toMatchObject({
      apply: true,
      maxMatters: 3,
      json: true,
    });
    expect(parseRetainArgs(["--as-of", "2026-12-01"]).asOf).toBeInstanceOf(Date);
    expect(() => parseRetainArgs(["--apply", "--as-of", "2026-12-01"])).toThrow();
    expect(parseAuditVerifyArgs(["--json"]).json).toBe(true);
    expect(parseAuditVerifyArgs(["--expect-head", `7:${"a".repeat(64)}`]).anchor?.seq).toBe(7);
  });

  it("names the start of the line each terminal command prints when it cannot run, as the command prints it", async () => {
    const empty = mkdtempSync(join(tmpdir(), "parol-readme-"));
    try {
      const env = { PAROL_DATA_DIR: empty };
      const lines: string[] = [];
      const err = (line: string): void => void lines.push(line);
      expect(await runRetain(env, [], () => undefined, err)).toBe(2);
      expect(await runAuditVerify(env, [], () => undefined, err)).toBe(2);
      lines.push(describeSeedFailure(new Error("no matter which")));
      expect(lines).toHaveLength(3);
      const named = [
        "Parol retention cannot run:",
        "Parol audit check cannot run:",
        "Parol seed cannot run:",
      ];
      named.forEach((prefix, index) => {
        expect(lines[index], prefix).toMatch(new RegExp(`^${prefix}`));
        expect(FOLDED, prefix).toContain(`\`${prefix}\``);
      });
      expect(FOLDED).not.toContain("Parol <command> cannot run:");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("names the options of the evaluation command that publish a comparison, and the command has each", () => {
    const cli = readFileSync(join(ROOT, "evals", "src", "parol", "cli.ts"), "utf8");
    for (const option of [
      "--simulate",
      "--workflow",
      "--compare",
      "--baseline",
      "--candidate",
      "--publish",
      "--open-heldout-trails",
    ]) {
      expect(README, option).toContain(option);
      expect(cli, option).toContain(`"${option.slice(2)}"`);
    }
  });

  it("states the retention numbers the application has", () => {
    expect(DEFAULT_RETAIN_DAYS).toBe(30);
    expect(MAX_RETAIN_DAYS).toBe(90);
    expect(FOLDED).toContain(`kept for ${DEFAULT_RETAIN_DAYS} days from its creation by default`);
    expect(FOLDED).toContain(`a whole number from 1 to ${MAX_RETAIN_DAYS}`);
    expect(FOLDED).toContain(
      `\`--max-matters N\` (default ${DEFAULT_MAX_MATTERS_PER_RUN}, at most ${MAX_MATTERS_CEILING})`,
    );
  });

  it("names the addresses of the pages that the application serves", () => {
    const named: [string, string][] = [
      ["/evaluations", urls.evaluations()],
      ["/pilot", urls.pilot()],
      ["/pilot?scope=synthetic", urls.pilot("synthetic")],
      ["/pilot/measures.csv", urls.pilotCsv()],
      ["/quickstart", urls.quickstart()],
      ["/help", urls.help()],
      ["/training/key", urls.trainerKey()],
      ["/audit", urls.audit()],
    ];
    for (const [address, served] of named) {
      expect(README, address).toContain(`\`${address}\``);
      expect(served, address).toBe(address);
    }
  });

  it("states the counts of the accessibility rules and the page fixtures that the tests have", () => {
    expect(RULE_IDS.length).toBe(15);
    expect(FOLDED).toContain("Fifteen rules (`apps/parol/test/a11y/rules.ts`)");
    // The README gives no count of fixtures, so that a fixture added is not a sentence gone false;
    // it says the rules run over every one of them, and the list is large.
    expect(variants.length).toBeGreaterThan(200);
    expect(FOLDED).toContain("run over every page fixture of the tests");
    expect(FOLDED).not.toMatch(/\d+ page fixtures/);
  });

  it("says where the browser tests are, how the package is found, and that they are opt in", () => {
    const folder = join(PAROL, "test", "a11y", "browser");
    for (const file of ["audit.test.ts", "flows.test.ts", "judge.test.ts"]) {
      expect(existsSync(join(folder, file)), file).toBe(true);
      expect(README, file).toContain(file);
    }
    expect(rootPackage.scripts["test:browser"]).toContain("apps/parol/test/a11y/browser");
    expect(README).toContain("pnpm test:browser");
    const finder = readFileSync(join(folder, "playwright.ts"), "utf8");
    for (const how of ["PLAYWRIGHT_MODULES_DIR", "NODE_PATH", "npm", "root", "-g"])
      expect(finder, how).toContain(how);
    for (const how of ["`PLAYWRIGHT_MODULES_DIR`", "`NODE_PATH`", "`npm root -g`"])
      expect(FOLDED, how).toContain(how);
    // Not a dependency of the repository, and not run by the continuous integration.
    expect(JSON.stringify(rootPackage)).not.toContain("playwright");
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("pnpm test");
    expect(ci).not.toContain("test:browser");
    expect(FOLDED).toMatch(/continuous integration runs `pnpm test` and not these/);
    // A skipped file prints its own line, so the README says a line for each, and not one line.
    const notice = readFileSync(join(folder, "playwright.ts"), "utf8");
    expect(notice).toContain("[browser tests] ${file}: SKIPPED");
    expect(FOLDED).toContain("prints a line for each of them that says how to ask");
    // The tests were run more than once (an earlier run found defects), so none of the README says
    // that they were run once.
    expect(FOLDED).not.toMatch(/\b(?:run|been run) once\b/);
    expect(FOLDED).toContain("They were last run on 11 November 2026");
  });
});

describe("the training matter in the README", () => {
  it("names the reader's two document sets, the planted finding and where T01's files are", () => {
    expect(FOLDED).toContain("knows two document sets");
    expect(README).toContain("T01");
    expect(T01.key).toBe("T01");
    expect(T01.documents.every((doc) => doc.title.includes(TRAINING_TITLE_MARKER))).toBe(true);
    // The planted rule, by the title the playbook gives it.
    const rule = loadDemoPlaybook().rules.find((r) => r.key === PLANTED_RULE_KEY)!;
    expect(README).toContain(rule.title);
    expect(README).toContain(PLANTED_RULE_KEY.toUpperCase());
    expect(FOLDED).toContain("The answer is the script's");
    expect(FOLDED).toContain("not a language model's mistake");
    for (const doc of T01.documents)
      expect(existsSync(join(PAROL, "training", doc.fileName)), doc.fileName).toBe(true);
    expect(README).toContain("apps/parol/training");
    expect(rootPackage.scripts["fixtures:parol:training"]).toBeDefined();
  });
});

describe("the walk-through", () => {
  const pages = filesUnder(join(PAROL, "src", "server", "pages"), /\.tsx?$/)
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const playbook = loadDemoPlaybook();

  it("names the buttons, headings and fields that the pages have", () => {
    for (const label of [
      "Where document text is sent",
      "Start the review",
      "Re-run review",
      "Workflow version",
      "Save date",
      "Save decision",
      "Export memo",
      "Choose a demo identity",
      "Results are out of date",
    ])
      expect(pages, label).toContain(label);
    expect(README).toMatch(/Start review/);
  });

  it("names the controls that part 3 added, and the pages have them", () => {
    // The words of some controls are constants of the views, which the pages import.
    const views = filesUnder(join(PAROL, "src", "server", "views"), /\.tsx?$/)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const label of [
      "Reason code",
      "This is a minor edit",
      "Add note",
      "Report missed issue",
      "Save rating",
      "Start timer",
      "Stop timer",
      "Reference list for shadow mode",
      "How long this matter is kept",
      "Keep for (days)",
      "Start the training matter",
    ]) {
      expect(pages + views, label).toContain(label);
      expect(FOLDED, label).toContain(label);
    }
    // Part 3 pages say the same of themselves: the reason code is chosen on an edit.
    expect(FOLDED).toContain("choose a reason code (for example Missed context)");
  });

  it("names the rules by the titles the playbook gives them", () => {
    for (const key of ["dur-1", "ret-1"]) {
      const rule = playbook.rules.find((r) => r.key === key)!;
      expect(README, rule.title).toContain(rule.title);
      expect(README, key).toContain(key.toUpperCase());
    }
  });

  it("names the people as the store seeds them, and the matters as the seed creates them", () => {
    const store = readFileSync(join(PAROL, "src", "store", "repo-matters.ts"), "utf8");
    for (const person of ["Alex Ruiz", "Dana Whitfield", "Lee Okafor", "Sam Patel"]) {
      expect(store, person).toContain(person);
      expect(README, person).toContain(person);
    }
    expect(README).toContain("Lanternfish / Corvane NDA");
    expect(README).toContain("Heronbridge / Tamarind NDA");
  });

  it("owns up to the lines of document 9 that the demonstration does not back", () => {
    const folded = README.replace(/\s+/g, " ");
    const nine = readFileSync(join(ROOT, "docs", "parol", "09-portfolio-materials.md"), "utf8");
    // Playbook version: document 9 names one, the seeded playbook is another.
    const named = /playbook (\d+\.\d+\.\d+)/.exec(nine)?.[1];
    if (named !== undefined && named !== playbook.version)
      expect(folded, "playbook version").toContain(`0:10 gives playbook ${named}`);
    expect(folded).toContain(`The seeded playbook is ${playbook.version}`);
    // The picker starts on v1, which is the workflow whose answer for DUR-1 is Compliant.
    expect(folded).toMatch(/The picker on the matter page starts on v1, which says `Compliant`/);
    // The support check is off, so the checks panel says so.
    expect(folded).toContain("Support not checked");
    expect(source("server", "views", "labels.ts")).toContain("Support not checked");
    for (const label of WORKFLOW_LABELS)
      expect(WORKFLOWS[label]!.manifest.prompts.support).toBeNull();
    // A new amendment version is not something the reader can read.
    expect(folded).toMatch(/1:02 uploads a new amendment version/);
    expect(folded).toMatch(/edited paragraph of either document, makes it decline every rule/);
  });

  it("quotes the memo's provenance line as the memo writes it", () => {
    const render = source("export", "render.ts");
    expect(render).toContain("reported by the provider:");
    const quoted = /"(Model: requested [^"]+)"/.exec(README.replace(/\s+/g, " "))?.[1];
    expect(quoted).toBe(
      "Model: requested simulated parol-simulated-reader; reported by the provider: not reported.",
    );
    expect(render).toContain('"Model:"');
  });

  it("points at the embedded-instruction document by a file that exists", () => {
    expect(existsSync(join(ROOT, "fixtures", "parol", "files", "parol-d08-nda.docx"))).toBe(true);
    expect(README).toContain("fixtures/parol/files/parol-d08-nda.docx");
    expect(README).toContain("Larkspur Freight Systems, Inc.");
  });
});

describe("the links and paths in the README", () => {
  it("point at files that exist", () => {
    const links = [...README.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!);
    const relative = links.filter((link) => !/^[a-z]+:/i.test(link));
    expect(relative.length).toBeGreaterThanOrEqual(8);
    const missing = relative.filter((link) => !existsSync(resolve(PAROL, link)));
    expect(missing).toEqual([]);
    // The design documents it names are the ones in docs/parol.
    expect(relative.some((link) => link.endsWith("docs/parol/README.md"))).toBe(true);
  });

  it("name folders and files of the repository that exist", () => {
    const spans = [...README.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]!);
    const paths = spans.filter((token) =>
      /^(?:fixtures|docs|evals|src|test|playbooks|apps)\/[\w./-]+$/.test(token),
    );
    expect(paths.length).toBeGreaterThanOrEqual(8);
    const missing = paths.filter(
      (token) => !existsSync(join(PAROL, token)) && !existsSync(join(ROOT, token)),
    );
    expect(missing).toEqual([]);
  });
});

describe("the table of where things are in the README", () => {
  const section = README.slice(README.indexOf("## Where things are"));
  const table = section.slice(
    section.indexOf("| Folder"),
    section.indexOf("\n\n", section.indexOf("| Folder")),
  );
  // The paths of the table; an option such as `--pilot-demo` in a description is not one.
  const named = [...table.matchAll(/`([^`\s]+)`/g)]
    .map((m) => m[1]!)
    .filter((t) => !t.startsWith("-"));

  it("names only folders and files that exist", () => {
    expect(named.length).toBeGreaterThanOrEqual(20);
    for (const token of named)
      expect(existsSync(join(PAROL, token)) || existsSync(join(ROOT, token)), token).toBe(true);
  });

  it("has a row for every folder of the source, the migrations and the files the pages are served from", () => {
    const folders = readdirSync(join(PAROL, "src"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `src/${entry.name}`);
    for (const folder of [...folders, "migrations", "public", "src/main.ts"])
      expect(named, folder).toContain(folder);
  });
});

describe("what a re-run does to what a person wrote, in the README", () => {
  it("says that a note and a missed-issue report are not carried to the new review", () => {
    expect(FOLDED).toContain("after a re-run neither is carried to the new review");
  });
});

describe("the honesty of the README", () => {
  it("says the data is synthetic, the identity is not authentication, the reader is not a language model and nothing was measured", () => {
    expect(README).toMatch(/Synthetic data only/);
    expect(README).toMatch(/not authentication/);
    expect(README).toMatch(/not a language model/i);
    expect(README).toMatch(/scripted/i);
    expect(README).toMatch(/No score has been measured/);
    expect(README).toMatch(/not a measurement/i);
    expect(README).toMatch(/nothing is sent anywhere/);
  });

  it("warns where document text goes when a real model is used", () => {
    expect(README).toMatch(/Where the text goes/);
    expect(README).toMatch(/sent to that provider/);
    expect(README).toMatch(/Do not do that\s+with anything but synthetic documents/);
  });

  it("states no score, rate, latency or cost of its own", () => {
    // The only figures are ports, versions, sizes and times in the walk-through.
    expect(README).not.toMatch(/\d\s?%/);
    expect(README).not.toMatch(/percent/i);
    expect(README).not.toMatch(/\bp(?:50|95|99)\b/i);
    expect(README).not.toMatch(/\bUSD\b|\$\s?\d/);
    expect(README).not.toMatch(/\d\s?(?:ms|milliseconds|seconds)\b/i);
    expect(README).not.toMatch(/\b(?:accuracy|recall|precision)\s+(?:of|was|is)\s+\d/i);
  });

  it("links the design documents", () => {
    expect(README).toContain("docs/parol/README.md");
    for (const doc of [
      "02-experience-and-architecture",
      "03-data-model-and-contracts",
      "04-worked-example",
      "05-evaluation",
      "06-access-and-governance",
      "09-portfolio-materials",
    ])
      expect(README, doc).toContain(`docs/parol/${doc}.md`);
  });
});

// Built from code points, so that this file holds none of these characters itself.
const DASH = new RegExp(
  `[${[0x2012, 0x2013, 0x2014, 0x2015, 0x2212].map((c) => String.fromCodePoint(c)).join("")}]`,
);

describe("the style of the files of the demonstration", () => {
  const mine = [
    join(PAROL, "README.md"),
    join(PAROL, "src", "seed.ts"),
    ...filesUnder(join(PAROL, "src", "demo")),
    ...filesUnder(join(PAROL, "test", "demo")),
  ];

  it("hold no em dash, en dash or other dash that stands for one", () => {
    expect(mine.length).toBeGreaterThan(10);
    const found = mine.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          DASH.test(line) ? [`${relative(PAROL, path)}:${index + 1}`] : [],
        ),
    );
    expect(found).toEqual([]);
  });

  it("keep the simulated reader away from the answer key, the dataset code, the network and the file system", () => {
    const demo = filesUnder(join(PAROL, "src", "demo"), /\.ts$/);
    expect(demo.length).toBeGreaterThanOrEqual(6);
    for (const path of demo) {
      const text = readFileSync(path, "utf8");
      const imports = [...text.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const specifier of imports) {
        const where = `${relative(PAROL, path)} imports ${specifier}`;
        expect(specifier, where).not.toMatch(/fixtures|evals|answer-keys/);
        expect(specifier, where).not.toMatch(/^node:(?:fs|net|http|https|child_process|dns|tls)/);
        expect(specifier, where).not.toMatch(/^(?:node-fetch|undici|axios)/);
      }
      expect(text, relative(PAROL, path)).not.toMatch(/\bfetch\(|process\.env|XMLHttpRequest/);
    }
  });

  it("is in a folder the README names", () => {
    expect(dirname(join(PAROL, "src", "demo", "index.ts"))).toBe(join(PAROL, "src", "demo"));
    expect(README).toContain("`src/demo`");
  });
});
