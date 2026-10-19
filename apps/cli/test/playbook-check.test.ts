import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPlaybookFile } from "@clausewise/playbook/node";
import { describe, expect, it } from "vitest";
import { run } from "../src/index.js";
import { makeIo, playbookPath, tempDirs } from "./support.js";

describe("playbook check on the shipped playbooks", () => {
  it.each(["nda-mutual.yaml", "saas-customer.yaml"])(
    "validates %s and lists its rules with their severity",
    async (file) => {
      const playbook = await loadPlaybookFile(playbookPath(file));
      const { io, stdout, stderr } = makeIo();

      const code = await run(["playbook", "check", playbookPath(file)], io);

      expect(code).toBe(0);
      expect(stderr()).toBe("");
      const out = stdout();
      expect(out).toContain(`${playbookPath(file)} is a valid playbook.`);
      expect(out).toContain(`Name: ${playbook.name}\n`);
      expect(out).toContain(`Contract types: ${playbook.contractTypes.join(", ")}\n`);
      expect(out).toContain(`Rules (${playbook.rules.length}):\n`);
      const rows = out.split("\n").filter((line) => line.startsWith("  "));
      expect(rows).toHaveLength(playbook.rules.length);
      playbook.rules.forEach((rule, i) => {
        const suffix = rule.required ? `${rule.severity}, required` : rule.severity;
        expect(rows[i]).toMatch(new RegExp(`^ {2}${rule.id} +${suffix}$`));
      });
    },
  );

  it("needs no model settings", async () => {
    const { io, stderr } = makeIo({ env: {} });

    expect(await run(["playbook", "check", playbookPath("nda-mutual.yaml")], io)).toBe(0);
    expect(stderr()).toBe("");
  });

  it("lines the rule ids up in one column", async () => {
    const { io, stdout } = makeIo();

    await run(["playbook", "check", playbookPath("saas-customer.yaml")], io);

    const columns = stdout()
      .split("\n")
      .filter((line) => line.startsWith("  "))
      .map((line) => line.search(/ (high|medium|low)/) + 1);
    expect(new Set(columns).size).toBe(1);
  });

  it("shows help for the command", async () => {
    const { io, stdout } = makeIo();

    expect(await run(["playbook", "check", "--help"], io)).toBe(0);
    expect(stdout()).toContain("clausewise playbook check <file.yaml>");
  });
});

describe("playbook check on a broken playbook", () => {
  const makeDir = tempDirs();

  async function check(content: string | undefined) {
    const dir = await makeDir();
    const path = join(dir, "broken.yaml");
    if (content !== undefined) await writeFile(path, content);
    const { io, stdout, stderr } = makeIo();

    const code = await run(["playbook", "check", path], io);

    expect(code).toBe(1);
    expect(stdout()).toBe("");
    return { stderr: stderr(), path };
  }

  it("prints every problem and exits 1", async () => {
    const { stderr, path } = await check(
      [
        "contractTypes: []",
        "rules:",
        "  - id: Bad_ID",
        "    title: One",
        "    severity: urgent",
        "    standard: ok",
        "    required: maybe",
        "  - title: No id",
        "    severity: low",
      ].join("\n"),
    );

    expect(stderr).toContain(`Error: ${path} is invalid:`);
    for (const problem of [
      "name:",
      "contractTypes:",
      "perspective:",
      "rules[0].id:",
      "rules[0].severity:",
      "rules[0].required:",
      "rules[1].id:",
      "rules[1].standard:",
    ]) {
      expect(stderr).toContain(`  ${problem}`);
    }
  });

  it("says when the text is not YAML", async () => {
    expect((await check("rules: [oops\n")).stderr).toContain("is not valid YAML");
  });

  it("says when the file is empty", async () => {
    expect((await check("")).stderr).toContain("is invalid");
  });

  it("says when the file does not exist", async () => {
    const { stderr, path } = await check(undefined);

    expect(stderr).toBe(`Error: Cannot read the playbook ${path}: no such file or directory.\n`);
  });
});

describe("playbook check on a playbook that tries to write to the terminal", () => {
  const makeDir = tempDirs();

  it("does not pass control characters on", async () => {
    const dir = await makeDir();
    const path = join(dir, "sneaky.yaml");
    // YAML escapes in double quotes: \x1b is the escape character, \n a line break.
    await writeFile(
      path,
      [
        'name: "Sneaky \\x1b[31mred\\nsecond line"',
        "contractTypes: [nda]",
        "perspective: P",
        "rules:",
        "  - {id: a, title: T, severity: low, standard: s}",
      ].join("\n"),
    );
    const { io, stdout } = makeIo();

    expect(await run(["playbook", "check", path], io)).toBe(0);

    expect(stdout()).toContain("Name: Sneaky [31mred second line\n");
    expect(stdout()).not.toContain(String.fromCharCode(27));
  });
});
