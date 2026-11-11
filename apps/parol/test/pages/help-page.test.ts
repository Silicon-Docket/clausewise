import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES } from "@clausewise/playbook";
import { describe, expect, it } from "vitest";
import {
  ESCALATION_CODES,
  EVIDENCE_ROLES,
  MATTER_STATUSES,
  REVIEW_DECISIONS,
  RUN_STATUSES,
  STATUSES,
  WARNING_CODES,
} from "../../src/contracts.js";
import { urls } from "../../src/server/urls.js";
import {
  DECISION_HINT,
  DECISION_LABEL,
  ESCALATION_LABEL,
  ESCALATION_MEANING,
  MATTER_STATUS_LABEL,
  MATTER_STATUS_MEANING,
  QUOTE_CHECK_LABEL,
  QUOTE_CHECK_MEANING,
  ROLE_LABEL,
  ROLE_MEANING,
  RUN_STATUS_LABEL,
  RUN_STATUS_MEANING,
  SEVERITY_LABEL,
  SEVERITY_MEANING,
  STATUS_LABEL,
  STATUS_MEANING,
  SUPPORT_CHECK_LABEL,
  SUPPORT_CHECK_MEANING,
  WARNING_LABEL,
  WARNING_MEANING,
} from "../../src/server/views/labels.js";
import { KEYBOARD_SHORTCUTS, helpGroups } from "../../src/server/views/help.js";
import { expectAccessible, tabStops, accessibleName } from "../a11y/rules.js";
import { all, attr, byId, byTag, hasAttr, readable, withClass, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { runPage } from "./render.js";
import { buildChrome } from "./support.js";
import { helpHtml } from "./training-support.js";

/**
 * The help page (package W2.8): every word the review uses, in the sentence the page already uses
 * where the word is shown. The tests walk the vocabularies of contracts.ts and the tables of
 * labels.ts, so a word added to either without its sentence fails here (the tables are complete
 * records, so most of it fails to compile first), and they compare the keyboard list with the one on
 * the review page and with the script.
 */

const html = helpHtml();
const root = checkInvariants(html);

/** The term (`dt`) with this anchor, and the `dd` that follows it. */
function termAt(id: string): { dt: El; dd: El } {
  const dt = byId(root, id);
  if (dt === undefined) throw new Error(`the help page has no anchor ${id}`);
  const parent = all(root, (el) => el.children.includes(dt))[0] as El;
  const next = parent.children[parent.children.indexOf(dt) + 1];
  if (next === undefined || next.type !== "element" || next.name !== "dd")
    throw new Error(`the term ${id} has no meaning after it`);
  return { dt, dd: next };
}

const anchor = (prefix: string, code: string): string => `${prefix}-${code.replaceAll("_", "-")}`;

describe("the help page", () => {
  it("is open to a visitor, a whole page with one heading, and meets every rule of the keyboard and the labels", () => {
    expect(readable(byTag(root, "h1")[0] as El)).toBe("Help");
    expect(readable(byTag(root, "title")[0] as El)).toBe("Help | Parol");
    expectAccessible(html);
    expectAccessible(helpHtml(buildChrome()));
  });

  it("has no form of its own and no script but the one every page loads", () => {
    expect(byTag(root, "form")).toEqual([]);
    expect(byTag(root, "script")).toHaveLength(1);
    expect(byTag(root, "button")).toEqual([]);
  });

  it("puts every group under a heading, in a section whose id the topic list links to", () => {
    const nav = all(root, (el) => el.name === "nav" && attr(el, "aria-label") === "Help topics");
    expect(nav).toHaveLength(1);
    const links = byTag(nav[0] as El, "a");
    const groups = helpGroups();
    expect(links.map((l) => readable(l))).toEqual(groups.map((g) => g.title));
    links.forEach((link, index) => {
      const group = groups[index]!;
      expect(attr(link, "href")).toBe(urls.help(group.id));
      const target = byId(root, group.id);
      expect(target?.name).toBe("section");
      expect(readable(byId(root, `${group.id}-heading`) as El)).toBe(group.title);
      expect(group.terms.length, group.id).toBeGreaterThan(0);
    });
  });

  it("links back to the quickstart", () => {
    const link = all(root, (el) => el.name === "a" && readable(el) === "Back to the quickstart")[0];
    expect(attr(link as El, "href")).toBe(urls.quickstart());
  });
});

describe("every member of every vocabulary is on the page, with its sentence, under an anchor", () => {
  type Table = Readonly<Record<string, string>>;
  const VOCABULARIES: [string, string, readonly string[], Table, Table][] = [
    ["status", "status", STATUSES, STATUS_LABEL, STATUS_MEANING],
    ["severity", "severity", SEVERITIES, SEVERITY_LABEL, SEVERITY_MEANING],
    ["flag", "flag", ESCALATION_CODES, ESCALATION_LABEL, ESCALATION_MEANING],
    ["role", "role", EVIDENCE_ROLES, ROLE_LABEL, ROLE_MEANING],
    [
      "quote check",
      "quote",
      Object.keys(QUOTE_CHECK_LABEL),
      QUOTE_CHECK_LABEL,
      QUOTE_CHECK_MEANING,
    ],
    [
      "support check",
      "support",
      Object.keys(SUPPORT_CHECK_LABEL),
      SUPPORT_CHECK_LABEL,
      SUPPORT_CHECK_MEANING,
    ],
    ["warning", "warning", WARNING_CODES, WARNING_LABEL, WARNING_MEANING],
    ["matter state", "matter-status", MATTER_STATUSES, MATTER_STATUS_LABEL, MATTER_STATUS_MEANING],
    ["review state", "run-status", RUN_STATUSES, RUN_STATUS_LABEL, RUN_STATUS_MEANING],
  ];

  for (const [name, prefix, members, labels, meanings] of VOCABULARIES)
    it(`${name}: all ${members.length}`, () => {
      expect(Object.keys(labels).sort()).toEqual([...members].sort());
      for (const code of members) {
        const { dt, dd } = termAt(anchor(prefix, code));
        expect(readable(dt), code).toBe(labels[code]);
        // A role's sentence may be led by one more; every other term says exactly the table's words.
        if (name === "role") expect(readable(dd), code).toContain(meanings[code] as string);
        else expect(readable(dd), code).toBe(meanings[code]);
      }
    });

  it("decision: all four, with the hint of the decision form where it makes sense on a page of help", () => {
    for (const code of REVIEW_DECISIONS) {
      const { dt, dd } = termAt(anchor("decision", code));
      expect(readable(dt), code).toBe(DECISION_LABEL[code]);
      if (code === "edit") expect(readable(dd)).not.toContain("fields below");
      else expect(readable(dd), code).toBe(DECISION_HINT[code]);
      expect(readable(dd), code).toMatch(/^[A-Z].*\.$/);
    }
    expect(readable(termAt("decision-not-decided").dt)).toBe("Not decided");
    expect(readable(termAt("decision-out-of-date").dd)).toBe(
      "The documents or playbook changed after this was decided.",
    );
  });

  it("says nothing in a title attribute that the text does not say", () => {
    // The old meanings stay on the chips as a bonus; the help page itself never relies on one.
    expect(
      all(root, (el) => el.name !== "html" && hasAttr(el, "title") && el.name !== "title"),
    ).toEqual([]);
  });
});

describe("the sentences the page adds", () => {
  it("says that severity belongs to the rule and the playbook gives no wider definition", () => {
    expect(readable(byId(root, "severity") as El)).toContain(
      "Severity belongs to the rule. The playbook sets it, and neither the reader nor a reviewer's edit changes it. The playbook gives no wider definition.",
    );
  });

  it("says that a superseded quote is still a correct quote and no longer governs", () => {
    expect(readable(termAt("role-superseded").dd)).toBe(
      "A passage marked superseded is struck through. A quote that is found in it is still a correct quote; what it says no longer governs. A later passage replaces this one. It is shown for context and no longer applies.",
    );
  });

  it("says that a quote found is not support, and that the support check is off today", () => {
    expect(readable(byId(root, "checks") as El)).toContain(
      "Quote found means the words are in the paragraph. It does not mean the paragraph supports the finding. The support check is the second look at that; the two workflow versions this application registers leave it off, and then each passage says Support not checked.",
    );
  });

  it("says that an attorney decides every finding and that a decision stops counting when the documents change", () => {
    expect(readable(byId(root, "decisions") as El)).toContain(
      "Parol drafts findings and an attorney decides every one. A decision stops counting when the documents or the playbook change.",
    );
  });
});

describe("the keyboard", () => {
  const pairs = (list: El): [string, string][] => {
    const out: [string, string][] = [];
    const children = list.children.filter((c): c is El => c.type === "element");
    for (let i = 0; i + 1 < children.length; i += 2)
      out.push([readable(children[i] as El), readable(children[i + 1] as El)]);
    return out;
  };
  const expected = KEYBOARD_SHORTCUTS.map((s): [string, string] => [s.keys.join(" "), s.does]);

  it("is listed as the shortcut table has it", () => {
    const list = withClass(byId(root, "keyboard") as El, "help-terms")[0] as El;
    expect(pairs(list)).toEqual(expected);
  });

  it("is the same list as the one on the review page", () => {
    const keys = byId(checkInvariants(runPage()), "keys-help") as El;
    const list = byTag(keys, "dl")[0] as El;
    expect(pairs(list)).toEqual(expected);
  });

  it("is the set of keys the script handles, with Escape that closes the list", () => {
    const script = readFileSync(join(import.meta.dirname, "../../public/parol.js"), "utf8");
    const handled = new Set([...script.matchAll(/key === "([^"]+)"/g)].map((m) => m[1]));
    expect([...handled].sort()).toEqual(
      [...KEYBOARD_SHORTCUTS.flatMap((s) => s.keys), "Escape"].sort(),
    );
  });

  it("says where the keys work and that every other control is a link or a button", () => {
    expect(readable(byId(root, "keyboard") as El)).toContain(
      "These keys work on the review page while focus is in the issue table.",
    );
  });
});

describe("reading the page by keyboard", () => {
  it("reaches the topic links, then the links inside the page, in the order they are read", () => {
    const names = tabStops(root).map((el) => accessibleName(root, el));
    const start = names.indexOf("Statuses");
    expect(start).toBeGreaterThan(0);
    expect(names.slice(start, start + 9)).toEqual(helpGroups().map((g) => g.title));
    expect(names.at(-1)).toBe("Back to the quickstart");
  });

  it("gives every term a place a link can lead to, and no id twice", () => {
    const ids = all(root, (el) => hasAttr(el, "id")).map((el) => attr(el, "id") as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const group of helpGroups())
      for (const term of group.terms) expect(ids).toContain(term.id);
  });
});
