import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATEGORY_IDS, type PlaybookRuleRecord } from "../../src/contracts.js";
import { findRule, loadPlaybook } from "../../src/playbooks/load.js";

const appDir = join(import.meta.dirname, "..", "..");
const repoRoot = join(appDir, "..", "..");
const YAML_PATH = join(appDir, "playbooks", "parol-nda-recipient.yaml");
const yaml = readFileSync(YAML_PATH, "utf8");
const demo = loadPlaybook({ yaml, slug: "parol-nda-recipient", source: YAML_PATH });

const rule = (key: string): PlaybookRuleRecord => {
  const found = findRule(demo, key);
  if (!found) throw new Error(`the demo playbook has no rule ${key}`);
  return found;
};

describe("the demo playbook loads", () => {
  it("has the identity the design documents give it", () => {
    expect(demo.slug).toBe("parol-nda-recipient");
    expect(demo.name).toBe("Parol NDA (Recipient)");
    expect(demo.version).toBe("1.0.0");
    expect(demo.perspective).toMatch(/^We act for the party that expects to receive most/);
    expect(demo.yaml).toBe(yaml);
  });

  it("has eight rules covering all seven categories, with permitted-disclosures holding two", () => {
    expect(demo.rules.map((r) => r.key)).toEqual([
      "pty-1",
      "def-1",
      "exc-1",
      "pds-1",
      "pds-2",
      "dur-1",
      "ret-1",
      "gov-1",
    ]);
    expect(new Set(demo.rules.map((r) => r.category))).toEqual(new Set(CATEGORY_IDS));
    expect(demo.rules.filter((r) => r.category === "permitted-disclosures")).toHaveLength(2);
    for (const category of CATEGORY_IDS) {
      if (category === "permitted-disclosures") continue;
      expect(
        demo.rules.filter((r) => r.category === category),
        category,
      ).toHaveLength(1);
    }
  });

  it("has the hash of the file, which must not move without a new version", () => {
    // Version 1.0.0 is approved once and then immutable in the store, and every run records this
    // hash. If this test fails after an edit to the YAML, the edit needs a new version number and
    // a new pinned value here, not a quiet update of this line.
    expect(demo.sha256).toBe("9ac87da098c85e3d8bda539b82bb90e411c68cfdce42e821e7e2bf47e8b24251");
  });

  it("changes hash when one character of the file changes", () => {
    const changed = yaml.replace("three (3) years", "three (3) yearz");
    expect(changed).not.toBe(yaml);
    const reloaded = loadPlaybook({ yaml: changed, slug: "parol-nda-recipient" });
    expect(reloaded.sha256).not.toBe(demo.sha256);
    expect(reloaded.rules).not.toEqual(demo.rules);
    expect(loadPlaybook({ yaml, slug: "parol-nda-recipient" }).sha256).toBe(demo.sha256);
  });
});

describe("the demo playbook matches the rules table in document 3", () => {
  const doc = readFileSync(
    join(repoRoot, "docs", "parol", "03-data-model-and-contracts.md"),
    "utf8",
  );
  const tableRows = doc
    .split("\n")
    .filter((line) => /^\| `[a-z]+-\d+` \|/.test(line))
    .map((line) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replaceAll("`", "")),
    );

  it("finds the table", () => {
    expect(tableRows).toHaveLength(8);
  });

  it("agrees on every rule's category, title, severity and whether it is required", () => {
    expect(
      demo.rules.map((r) => [r.key, r.category, r.title, r.severity, r.required ? "yes" : "no"]),
    ).toEqual(tableRows);
  });

  it("lists the rules in the table's order", () => {
    expect(demo.rules.map((r) => r.key)).toEqual(tableRows.map((row) => row[0]));
  });
});

describe("every field of the demo rules maps", () => {
  it("gives dur-1 all of its fields, the rule the worked example is built on", () => {
    expect(rule("dur-1")).toEqual({
      key: "dur-1",
      category: "duration",
      title: "Duration of confidentiality obligations",
      severity: "high",
      required: true,
      kind: "presence",
      standard:
        "Obligations end three years or less after each disclosure. Continued protection of trade secrets for as long as they remain trade secrets is acceptable.",
      fallback:
        "Obligations end five years or less after each disclosure, or five years or less after the agreement ends.",
      unacceptable:
        "Obligations that are perpetual or have no stated end, for information that is not a trade secret.",
      guidance:
        "Copies kept under the return or destruction clause are covered. Protection of them for as long as they are held, with no end, is the unacceptable case, while copies that remain subject to the agreement stay subject to its own period.",
      fallbackLanguage:
        "The obligations of each Receiving Party under this Agreement shall continue for three (3) years from the date of each disclosure of Confidential Information, except that obligations with respect to any trade secret shall continue for so long as it remains a trade secret under applicable law.",
      escalateWhen: [
        {
          id: "over-five-years",
          text: "The stated period is longer than five years, counted from whichever event the clause uses, but finite, which is a business decision.",
        },
      ],
    });
  });

  it("keeps ret-1 optional, the one rule that can be not applicable", () => {
    expect(demo.rules.filter((r) => !r.required).map((r) => r.key)).toEqual(["ret-1"]);
    expect(rule("ret-1").guidance).toBe(
      "An officer's certificate of destruction is not a deviation on its own. How long retained copies stay protected is tested under dur-1, not here.",
    );
  });

  it("maps optional fields that a rule omits to null and keeps those it gives", () => {
    expect(demo.rules.filter((r) => r.fallback !== null).map((r) => r.key)).toEqual([
      "def-1",
      "dur-1",
    ]);
    expect(demo.rules.filter((r) => r.guidance !== null).map((r) => r.key)).toEqual([
      "pty-1",
      "pds-2",
      "dur-1",
      "ret-1",
    ]);
    expect(demo.rules.filter((r) => r.unacceptable === null)).toEqual([]);
    expect(demo.rules.filter((r) => r.fallbackLanguage === null)).toEqual([]);
    expect(demo.rules.every((r) => r.kind === "presence")).toBe(true);
  });

  it("maps the escalation conditions to the rules that state them", () => {
    expect(
      Object.fromEntries(
        demo.rules
          .filter((r) => r.escalateWhen.length > 0)
          .map((r) => [r.key, r.escalateWhen.map((e) => e.id)]),
      ),
    ).toEqual({
      "pty-1": ["entity-differs"],
      "dur-1": ["over-five-years"],
      "gov-1": ["forum-outside-list"],
    });
    expect(rule("def-1").escalateWhen).toEqual([]);
  });

  it("folds each YAML text into one line with single spaces, as a prompt expects", () => {
    for (const r of demo.rules) {
      const texts = [
        r.title,
        r.standard,
        r.fallback,
        r.unacceptable,
        r.guidance,
        r.fallbackLanguage,
        ...r.escalateWhen.map((e) => e.text),
      ];
      for (const text of texts) {
        if (text === null) continue;
        expect(text, r.key).not.toMatch(/[\n\r\t]|  |^\s|\s$/);
      }
    }
  });
});

describe("the demo playbook is coherent", () => {
  const withWording = demo.rules.map((r) => ({ key: r.key, wording: r.fallbackLanguage ?? "" }));

  it("gives every rule approved wording that reads as contract text", () => {
    for (const { key, wording } of withWording) {
      expect(wording, key).not.toBe("");
      expect(wording, key).toMatch(/^[A-Z"[]/);
      // pty-1 is a description of a party to drop into a preamble, so it is not a sentence.
      if (key === "pty-1") expect(wording).toMatch(/\)$/);
      else expect(wording, key).toMatch(/\.$/);
      expect(wording, key).not.toMatch(/\b(TODO|TBD|FIXME|XXX|lorem)\b|\{\{|\}\}/i);
      // Brackets and quotation marks that are opened must close, so that no wording is cut off.
      expect(wording.split("(").length, key).toBe(wording.split(")").length);
      expect(wording.split("[").length, key).toBe(wording.split("]").length);
      expect(wording.split('"').length % 2, key).toBe(1);
    }
  });

  it("uses square-bracket placeholders only in the wording for the parties", () => {
    for (const { key, wording } of withWording) {
      if (key === "pty-1") expect(wording).toMatch(/\[Client legal name\]/);
      else expect(wording, key).not.toMatch(/[[\]]/);
    }
  });

  it("introduces no defined term that the playbook does not establish", () => {
    // The wording is offered to a reviewer and adapted to the document's own terms. A capitalised
    // term that nothing defines would be pasted into an agreement as an undefined term.
    const allowed = new Set([
      "Confidential",
      "Information",
      "Disclosing",
      "Receiving",
      "Party",
      "Agreement",
      "Delaware",
      "State",
      // Sentence openers.
      "The",
      "This",
      "Within",
    ]);
    for (const { key, wording } of withWording) {
      const unbracketed = wording.replace(/\[[^\]]*\]/g, "");
      const capitalised = unbracketed.match(/\b[A-Z][a-z]+\b/g) ?? [];
      expect(
        capitalised.filter((word) => !allowed.has(word)),
        `${key} uses a capitalised term that nothing defines`,
      ).toEqual([]);
    }
  });

  it("writes each number in words and digits that agree", () => {
    const value: Record<string, number> = { two: 2, three: 3, five: 5, ten: 10, thirty: 30 };
    let checked = 0;
    for (const { key, wording } of withWording) {
      for (const [, word, digits] of wording.matchAll(/\b([a-z]+) \((\d+)\)/g)) {
        checked += 1;
        expect(value[word ?? ""], `${key}: ${word} (${digits})`).toBe(Number(digits));
      }
    }
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  // For each rule: what its approved wording must contain to meet its own standard, and what its
  // `unacceptable` list says it must not contain.
  const MUST: Record<string, { include: RegExp[]; exclude?: RegExp[] }> = {
    "pty-1": { include: [/legal name/i, /\[jurisdiction\]/, /\[entity type\]/, /Short name/] },
    "def-1": {
      include: [
        /non-public information/,
        /marked or identified as confidential/,
        /reasonable person/,
      ],
      exclude: [/whether or not/i],
    },
    "exc-1": {
      include: [
        /\(a\) is or becomes generally available to the public/,
        /\(b\) was known to the Receiving Party without a duty of confidentiality/,
        /\(c\) is independently developed/,
        /\(d\) is received by the Receiving Party from a third party without a duty of confidentiality/,
      ],
      exclude: [/records/i, /\bwritten\b/i],
    },
    "pds-1": {
      include: [
        /employees, officers, contractors and professional advisers/,
        /affiliates/,
        /need to know/,
        /no less protective/,
      ],
      exclude: [/consent/i, /\bexcept\b/i],
    },
    "pds-2": {
      include: [
        /required by law, regulation or order of a court/,
        /where legally permitted and reasonably practicable/,
        /prompt notice/,
        /at its own cost/,
      ],
      // The standard forbids a duty to resist at the recipient's own cost.
      exclude: [/\bresist\b/i, /\bchallenge\b/i, /Receiving Party shall seek/i],
    },
    "dur-1": {
      include: [/three \(3\) years from the date of each disclosure/, /trade secret/],
      exclude: [/perpetual/i, /indefinite/i, /\b(four|five|six|seven|ten)\b/i],
    },
    "ret-1": {
      include: [
        /thirty \(30\) days/,
        /return or destroy/,
        /routine backup/,
        /remain subject to this Agreement/,
      ],
      exclude: [/\b(ten|five|seven|fourteen|twenty)\b/i, /\bpurge\b/i],
    },
    "gov-1": {
      include: [/governed by the laws of the State of Delaware/, /exclusive jurisdiction/],
    },
  };

  it("meets each rule's own standard and avoids what the rule calls unacceptable", () => {
    expect(Object.keys(MUST).sort()).toEqual(demo.rules.map((r) => r.key).sort());
    for (const { key, wording } of withWording) {
      const expectation = MUST[key];
      for (const pattern of expectation?.include ?? [])
        expect(wording, `${key} ${pattern}`).toMatch(pattern);
      for (const pattern of expectation?.exclude ?? [])
        expect(wording, `${key} must not match ${pattern}`).not.toMatch(pattern);
    }
  });

  it("offers a duration no longer than the standard allows and a deadline no shorter", () => {
    expect(rule("dur-1").standard).toMatch(/three years or less/);
    expect(rule("dur-1").fallbackLanguage).toMatch(/three \(3\) years/);
    expect(rule("ret-1").standard).toMatch(/within 30 days or longer/);
    expect(rule("ret-1").fallbackLanguage).toMatch(/thirty \(30\) days/);
  });

  it("offers only a governing law and forum that the standard approves", () => {
    const standard = rule("gov-1").standard;
    expect(standard).toMatch(/Delaware, New York, or England and Wales/);
    const wording = rule("gov-1").fallbackLanguage ?? "";
    expect(wording).toMatch(/Delaware/);
    expect(wording).not.toMatch(/New York|England|Wales|California|Texas|Singapore/);
  });

  it("gives every escalation condition a lowercase, hyphenated id that is unique in the playbook", () => {
    const ids = demo.rules.flatMap((r) => r.escalateWhen.map((e) => e.id));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z]+)+$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states each escalation condition as a full sentence about a situation the rule can meet", () => {
    for (const r of demo.rules) {
      for (const e of r.escalateWhen) {
        expect(e.text, `${r.key}/${e.id}`).toMatch(/^[A-Z].*\.$/);
        expect(e.text.length, `${r.key}/${e.id}`).toBeGreaterThan(30);
      }
    }
    // The id names a number, so the rule must give that number somewhere the reviewer can see.
    expect(rule("dur-1").fallback).toMatch(/five years/);
  });

  it("does not ask a one-way NDA to bind both parties, which it cannot", () => {
    // The playbook covers a mutual or a one-way NDA, so "equally" can only be a condition of a
    // mutual one. Each sentence that says it must also say when it applies.
    expect(demo.perspective).toMatch(/mutual or one-way NDA/);
    const sentences = demo.perspective.split(/(?<=\.) /);
    const equal = sentences.filter((sentence) => /\bequally\b/.test(sentence));
    expect(equal).toHaveLength(1);
    expect(equal[0]).toMatch(/\b(where|if|when)\b[^.]*\bmutual\b/);
  });

  it("gives def-1 a fallback that concedes ground, between the standard and the unacceptable case", () => {
    const { standard, fallback, unacceptable } = rule("def-1");
    // The standard is the narrowest definition we want and the unacceptable case the widest. A
    // fallback is what we accept when the standard is refused, so it reaches further than the
    // standard (it covers information that is not marked) without being the unacceptable case
    // (which takes information of any kind, public or not).
    expect(standard).not.toMatch(/\bwhether or not\b/i);
    expect(fallback).toMatch(/\bwhether or not\b[^.]*\bmarked\b/i);
    expect(fallback).toMatch(/\bnon-public\b/i);
    expect(fallback).not.toMatch(/\bonly\b/i);
    expect(unacceptable).toMatch(/\bwhether or not\b[^.]*\bmarked\b/i);
    expect(unacceptable).not.toMatch(/\bnon-public\b/i);
    expect(fallback).not.toBe(unacceptable);
  });

  it("measures dur-1's standard, fallback and escalation from the same events", () => {
    const { standard, fallback } = rule("dur-1");
    const escalation = rule("dur-1").escalateWhen.find((e) => e.id === "over-five-years")?.text;
    // The standard counts from each disclosure. A fallback that counted only from the end of the
    // agreement could not be set against a term counted from each disclosure, so it accepts both.
    expect(standard).toMatch(/after each disclosure/);
    expect(fallback).toMatch(/after each disclosure/);
    expect(fallback).toMatch(/after the agreement ends/);
    // The escalation names its own number and holds whichever event the clause counts from, so
    // whether it applies does not depend on the anchor of the fallback.
    expect(escalation).toMatch(/\blonger than five years\b/);
    expect(escalation).toMatch(/\bwhichever event\b/);
    expect(escalation).not.toMatch(/\bthe fallback\b/);
    // The number in the escalation is the number in the fallback.
    expect(fallback?.match(/\b\w+ years\b/g)).toEqual(["five years", "five years"]);
  });

  it("settles which rule governs copies kept after return or destruction, in both rules", () => {
    // A clause that keeps retained copies protected for as long as they are held satisfies the
    // ret-1 standard and, with no end, breaches dur-1. Each rule is judged on its own text, so
    // each says that the duration of that protection is dur-1's question.
    expect(rule("ret-1").guidance).toMatch(/retained copies[^.]*\bdur-1\b[^.]*not here/);
    expect(rule("dur-1").guidance).toMatch(/return or destruction clause/);
    expect(rule("dur-1").guidance).toMatch(/no end[^.]*unacceptable case/);
    expect(rule("dur-1").guidance).toMatch(/remain subject to the agreement/);
  });

  it("takes the party terms in the wording from def-1's definition and invents no other", () => {
    // The wording is adapted to the document's own terms. "Receiving Party", "Disclosing Party"
    // and "Confidential Information" are the vocabulary def-1's wording sets up, "Agreement" is
    // the document itself and a place name is a place. A term such as "Purpose" is defined
    // nowhere in the playbook, so wording that used it would depend on a definition it lacks.
    const established = new Set(
      (rule("def-1").fallbackLanguage ?? "").match(/\b[A-Z][a-z]+\b/g) ?? [],
    );
    expect([...established].sort()).toEqual([
      "Confidential",
      "Disclosing",
      "Information",
      "Party",
      "Receiving",
    ]);
    const places = new Set(["Agreement", "Delaware", "State"]);
    const openers = new Set(["The", "This", "Within"]);
    for (const { key, wording } of withWording) {
      const words = wording.replace(/\[[^\]]*\]/g, "").match(/\b[A-Z][a-z]+\b/g) ?? [];
      const strangers = words.filter(
        (word) => !established.has(word) && !places.has(word) && !openers.has(word),
      );
      expect(strangers, key).toEqual([]);
    }
  });

  it("describes itself as invented policy and not as law, and states no law", () => {
    expect(demo.description).toMatch(/invented client policy, not a statement of law/);
    expect(demo.description).toMatch(/must not be used for a real matter/);
    const everyText = demo.rules.flatMap((r) => [
      r.title,
      r.standard,
      r.fallback,
      r.unacceptable,
      r.guidance,
      r.fallbackLanguage,
      ...r.escalateWhen.map((e) => e.text),
    ]);
    // Phrases that would assert what a law says or whether a term is enforceable. Naming a
    // jurisdiction as an approved choice is policy, so it is not on this list.
    const claimsOfLaw = [
      /\b(is|are|be|being) (legally |generally )?(enforceable|unenforceable|void|voidable|illegal|unlawful|invalid)\b/i,
      /\bcourts? (will|would|must|always|never)\b/i,
      /\b(the law|statute|case law|legislation) (requires|provides|says|states|holds|prohibits|permits)\b/i,
      /\bunder (Delaware|New York|English|US|U\.S\.|federal) law\b/i,
      /\bas a matter of law\b/i,
      /\bis the law\b/i,
    ];
    for (const text of everyText) {
      if (text === null) continue;
      for (const pattern of claimsOfLaw) expect(text, `${pattern}`).not.toMatch(pattern);
    }
  });

  it("is plain ASCII with no dash other than the hyphen, so none reaches a prompt or a memo", () => {
    expect(/[^\n\x20-\x7e]/.test(yaml)).toBe(false);
    expect(yaml).not.toMatch(/ -- |--- /);
  });
});
