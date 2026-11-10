import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_PLAYBOOK_SLUG } from "../../src/boot/index.js";
import { DEFAULT_DATA_DIR, DEFAULT_HOST, DEFAULT_PORT } from "../../src/main.js";
import { WORKFLOW_LABELS } from "../../src/boot/register.js";
import { WORKFLOWS } from "../../src/prompts/workflows.js";
import { ROOT, loadDemoPlaybook } from "../integration/pipeline.js";

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
    expect([...documented].filter((name) => !read.has(name))).toEqual([]);
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
    for (const row of [
      "Evaluation comparison page",
      "Feedback on findings",
      "Pilot measures",
      "PDF documents",
      "Word add-in",
    ])
      expect(README, row).toMatch(new RegExp(`\\|\\s*${row}[^|]*\\|\\s*Not built`));
  });

  it("names the playbook and its version as the store has them", () => {
    const playbook = loadDemoPlaybook();
    expect(playbook.slug).toBe(DEMO_PLAYBOOK_SLUG);
    expect(README).toContain(`${playbook.slug}\` ${playbook.version}`);
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
