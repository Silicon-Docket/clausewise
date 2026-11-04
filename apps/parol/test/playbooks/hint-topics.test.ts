import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_PLAYBOOK_SLUG, registerAll } from "../../src/boot/index.js";
import { CATEGORY_IDS } from "../../src/contracts.js";
import { findRule, loadPlaybook } from "../../src/playbooks/load.js";
import { HINT_TOPICS } from "../../src/ingest/signals.js";
import { createRepository, openDatabase } from "../../src/store/index.js";
import { loadObject, playbookErrorOf, playbookOf, ruleFor, rulesWith } from "./support.js";

/**
 * A rule says which keyword-hint topics matter to it. The loader maps the list and holds it to the
 * topics the hinting code has for the rule's category: a topic nothing raises would never match a
 * hint, and a rule whose list is all such topics would count no hint at all, which turns off the
 * check that a finding of "missing" is not contradicted by one.
 */

const permitted = (hintTopics: unknown) =>
  playbookOf({
    rules: rulesWith("permitted-disclosures", ruleFor("permitted-disclosures", { hintTopics })),
  });

describe("mapping hintTopics", () => {
  it("keeps the topics in the order written", () => {
    const loaded = loadObject(permitted(["legal-compulsion", "representatives"]));
    expect(findRule(loaded, "rule-permitted-disclosures")?.hintTopics).toEqual([
      "legal-compulsion",
      "representatives",
    ]);
  });

  it("gives every rule that has no field an empty list, which means every topic of its category", () => {
    const loaded = loadObject(playbookOf());
    for (const rule of loaded.rules) expect(rule.hintTopics, rule.key).toEqual([]);
  });

  it("keeps an empty list as an empty list", () => {
    expect(findRule(loadObject(permitted([])), "rule-permitted-disclosures")?.hintTopics).toEqual(
      [],
    );
  });

  it("gives each rule a list of its own, not one shared with another record", () => {
    const loaded = loadObject(playbookOf());
    loaded.rules[0]!.hintTopics!.push("changed");
    expect(loaded.rules[1]!.hintTopics).toEqual([]);
  });

  it("accepts every topic the category has, together or alone", () => {
    for (const topic of HINT_TOPICS["permitted-disclosures"]) {
      expect(
        findRule(loadObject(permitted([topic])), "rule-permitted-disclosures")?.hintTopics,
      ).toEqual([topic]);
    }
    expect(() => loadObject(permitted([...HINT_TOPICS["permitted-disclosures"]]))).not.toThrow();
  });

  it("changes the hash of the file, because the topics change what a run reports", () => {
    const without = loadObject(permitted([]));
    const withTopic = loadObject(permitted(["legal-compulsion"]));
    expect(withTopic.sha256).not.toBe(without.sha256);
  });
});

describe("refusing a topic the category does not have", () => {
  it("names the rule, the position and the category and lists the topics to use", () => {
    const error = playbookErrorOf(() => loadObject(permitted(["legal-compulsion", "advisers"])));
    expect(error.problems).toEqual([
      'rules[3].hintTopics[1]: rule "rule-permitted-disclosures" lists a topic the category "permitted-disclosures" does not have; use representatives, legal-compulsion',
    ]);
  });

  it("does not repeat the topic the file wrote, in the message or in the problems", () => {
    const secret = "client-secret-topic-9f3a";
    const error = playbookErrorOf(() => loadObject(permitted([secret])));
    expect(error.message).not.toContain(secret);
    expect(error.problems.join("\n")).not.toContain(secret);
    expect(error.problems).toHaveLength(1);
  });

  it("reports every unknown topic, not only the first", () => {
    const error = playbookErrorOf(() =>
      loadObject(permitted(["one-bad", "representatives", "two-bad"])),
    );
    expect(error.problems.map((p) => p.slice(0, p.indexOf(":")))).toEqual([
      "rules[3].hintTopics[0]",
      "rules[3].hintTopics[2]",
    ]);
  });

  it("refuses topics on a category that has none, whatever they are called", () => {
    for (const category of CATEGORY_IDS) {
      if (HINT_TOPICS[category].length > 0) continue;
      const error = playbookErrorOf(() =>
        loadObject(
          playbookOf({
            rules: rulesWith(category, ruleFor(category, { hintTopics: ["representatives"] })),
          }),
        ),
      );
      expect(error.problems, category).toEqual([
        `rules[${CATEGORY_IDS.indexOf(category)}].hintTopics: rule "rule-${category}" lists hint topics, and the category "${category}" has none`,
      ]);
    }
  });

  it("accepts an empty list on a category that has no topics", () => {
    expect(() =>
      loadObject(
        playbookOf({ rules: rulesWith("duration", ruleFor("duration", { hintTopics: [] })) }),
      ),
    ).not.toThrow();
  });

  it("is reported together with the other Parol problems, so an author fixes the file in one pass", () => {
    const rules = rulesWith(
      "permitted-disclosures",
      ruleFor("permitted-disclosures", { hintTopics: ["nope"] }),
    ).filter((rule) => rule.category !== "duration");
    const error = playbookErrorOf(() => loadObject(playbookOf({ rules })));
    expect(error.problems).toHaveLength(2);
    expect(error.problems.some((p) => p.includes("hintTopics[0]"))).toBe(true);
    expect(error.problems.some((p) => p.includes('no rule covers the category "duration"'))).toBe(
      true,
    );
  });

  it("is refused by the base format first when the spelling is wrong, and the Parol checks wait", () => {
    const error = playbookErrorOf(() => loadObject(permitted(["Legal Compulsion"])));
    expect(error.problems).toEqual([
      "rules[3].hintTopics[0]: use lowercase letters, digits and hyphens",
    ]);
    expect(error.message).toContain("are checked once these are fixed");
  });
});

describe("the demo playbook", () => {
  const yaml = readFileSync(
    join(import.meta.dirname, "..", "..", "playbooks", "parol-nda-recipient.yaml"),
    "utf8",
  );
  const demo = loadPlaybook({ yaml, slug: "parol-nda-recipient" });

  it("says that pds-1 is about representatives and pds-2 about disclosure that law compels", () => {
    expect(findRule(demo, "pds-1")?.hintTopics).toEqual(["representatives"]);
    expect(findRule(demo, "pds-2")?.hintTopics).toEqual(["legal-compulsion"]);
  });

  it("leaves every other rule taking every topic of its category", () => {
    for (const rule of demo.rules) {
      if (rule.key === "pds-1" || rule.key === "pds-2") continue;
      expect(rule.hintTopics, rule.key).toEqual([]);
    }
  });

  it("gives the two rules of the shared category topics that do not overlap", () => {
    const [a, b] = ["pds-1", "pds-2"].map((key) => new Set(findRule(demo, key)?.hintTopics));
    expect([...a!].filter((topic) => b!.has(topic))).toEqual([]);
  });
});

/**
 * The demo playbook gained hintTopics after version 1.0.0 had been committed. A version is
 * immutable once approved, so the file under 1.0.0 must stay what it was and the new text is a new
 * version: a database that was started on 1.0.0 would otherwise refuse to boot on the changed file.
 */
describe("the demo playbook after hintTopics were added", () => {
  const scratch = mkdtempSync(join(tmpdir(), "parol-hint-topics-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  const yaml = readFileSync(
    join(import.meta.dirname, "..", "..", "playbooks", "parol-nda-recipient.yaml"),
    "utf8",
  );
  const demo = loadPlaybook({ yaml, slug: DEMO_PLAYBOOK_SLUG });

  // The text of version 1.0.0 as it was released: the current file without the two hintTopics lines.
  const released = yaml
    .replace(/^version: .*$/m, "version: 1.0.0")
    .replace(/^ {4}hintTopics: \[.*\]\n/gm, "");
  const RELEASED_1_0_0 = "9ac87da098c85e3d8bda539b82bb90e411c68cfdce42e821e7e2bf47e8b24251";

  it("can tell the text released as 1.0.0 from the text it has now", () => {
    expect(released).not.toBe(yaml);
    expect(loadPlaybook({ yaml: released, slug: DEMO_PLAYBOOK_SLUG }).sha256).toBe(RELEASED_1_0_0);
  });

  it("is not version 1.0.0, whose text had no hintTopics", () => {
    expect(demo.version).not.toBe("1.0.0");
    expect(demo.sha256).not.toBe(RELEASED_1_0_0);
    expect(demo.version).toBe("1.0.1");
  });

  it("starts on a database that already holds 1.0.0, and adds the new version beside it", () => {
    const repo = createRepository(openDatabase(":memory:"));
    const oldFile = join(scratch, "released.yaml");
    writeFileSync(oldFile, released);
    const first = registerAll(repo, { seedDemoUsers: true, playbookPath: oldFile });
    expect(first.playbook).toMatchObject({ version: "1.0.0", status: "approved" });

    const second = registerAll(repo, { seedDemoUsers: false });
    expect(second.playbook).toMatchObject({ version: demo.version, status: "approved" });
    expect(repo.listPlaybookVersions().map((v) => v.version)).toEqual(["1.0.0", demo.version]);
    // The approved 1.0.0 is untouched, and has no topics for its rules to carry.
    expect(repo.findPlaybookVersion(DEMO_PLAYBOOK_SLUG, "1.0.0")?.sha256).toBe(RELEASED_1_0_0);
    expect(repo.listRules(first.playbook.id).every((r) => (r.hintTopics ?? []).length === 0)).toBe(
      true,
    );
    expect(
      repo
        .listRules(second.playbook.id)
        .filter((r) => (r.hintTopics ?? []).length > 0)
        .map((r) => [r.key, r.hintTopics]),
    ).toEqual([
      ["pds-1", ["representatives"]],
      ["pds-2", ["legal-compulsion"]],
    ]);
  });
});
