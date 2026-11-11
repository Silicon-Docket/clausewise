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
import {
  EscalationChip,
  MatterStatusChip,
  QuoteCheckChip,
  RoleChip,
  RunStatusChip,
  StatusChip,
  SupportCheckChip,
} from "../../src/server/pages/components.js";
import { render } from "../../src/server/pages/index.js";
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
import {
  all,
  attr,
  byId,
  byTag,
  hasAttr,
  hasClass,
  parseHtml,
  readable,
  textOf,
  withClass,
  type El,
} from "./html.js";
import { checkInvariants } from "./invariants.js";
import { findingPage, matterPage, mattersPage, memosPage, runPage, signInPage } from "./render.js";
import { buildChrome } from "./support.js";
import { helpHtml, quickstartHtml } from "./training-support.js";

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

describe("the lead of the page says where its sentences come from", () => {
  const lead = readable(withClass(root, "lead")[0] as El);

  /** Everything a page shows outside its help lists: its text and the titles of its elements. */
  function shownOutsideHelp(html: string): string {
    const parts: string[] = [];
    const visit = (el: El): void => {
      if (hasClass(el, "words-help") || hasClass(el, "context-help")) return;
      const title = attr(el, "title");
      if (typeof title === "string") parts.push(title);
      for (const child of el.children) {
        if (child.type === "text") parts.push(textOf(child));
        else visit(child);
      }
    };
    visit(parseHtml(html));
    return parts.join("\n").replace(/\s+/g, " ");
  }

  /** The sentences the chips of the vocabularies show as their titles, for every code. */
  function chipTitles(): Set<string> {
    const html = [
      ...STATUSES.map((status) => render(StatusChip({ status }))),
      ...EVIDENCE_ROLES.map((role) => render(RoleChip({ role }))),
      ...Object.keys(QUOTE_CHECK_LABEL).map((check) =>
        render(QuoteCheckChip({ check: check as never })),
      ),
      ...Object.keys(SUPPORT_CHECK_LABEL).map((check) =>
        render(SupportCheckChip({ check: check as never })),
      ),
      ...ESCALATION_CODES.map((code) => render(EscalationChip({ code }))),
      ...RUN_STATUSES.map((status) => render(RunStatusChip({ status }))),
      ...MATTER_STATUSES.map((status) => render(MatterStatusChip({ status }))),
    ];
    const titles = html.map((chip) => attr(byTag(parseHtml(chip), "span")[0] as El, "title"));
    return new Set(titles.filter((t): t is string => typeof t === "string"));
  }

  /** The pages that explain or show words, as a signed-in person gets them. */
  const OTHER_PAGES: [string, string][] = [
    ["the review page", runPage()],
    ["the finding page", findingPage()],
    ["the matter page", matterPage()],
    ["the matters page", mattersPage()],
    ["the memos page", memosPage()],
    ["the quickstart", quickstartHtml()],
    ["the sign-in page", signInPage()],
  ];

  it("no longer says that nothing on it is new", () => {
    expect(lead).not.toMatch(/nothing here is new/i);
    expect(lead).toBe(
      "What the words on the review page mean. Most of these are the sentences the pages show where the word appears. The meaning of each severity, and the notes that explain a group or a term, are written for help and appear only here and in the help lists of the review page. Nothing depends on hovering a chip.",
    );
  });

  it("is right that most of its sentences are ones the pages show: the title of a chip, or the hint of the decision form", () => {
    const shown = chipTitles();
    for (const hint of Object.values(DECISION_HINT)) shown.add(hint);
    const terms = helpGroups()
      .filter((group) => group.id !== "keyboard")
      .flatMap((group) => group.terms);
    const known = terms.filter((term) =>
      [...shown].some((sentence) => term.meaning.includes(sentence)),
    );
    // A tie would not be most of them.
    expect(known.length, `${known.length} of ${terms.length}`).toBeGreaterThan(terms.length / 2);
  });

  it("reads the pages as a person does: it sees the sentences they show, and it leaves their help lists out", () => {
    // Without these two, the checks below would pass on a reader that saw nothing.
    expect(shownOutsideHelp(findingPage())).toContain(DECISION_HINT.reject);
    expect(shownOutsideHelp(runPage())).toContain(STATUS_MEANING.compliant);
    expect(readable(parseHtml(runPage()))).toContain(SEVERITY_MEANING.high);
    expect(shownOutsideHelp(runPage())).not.toContain(SEVERITY_MEANING.high);
  });

  it("is right that the meaning of each severity is on no page outside help", () => {
    for (const [name, html] of OTHER_PAGES)
      for (const sentence of Object.values(SEVERITY_MEANING))
        expect(shownOutsideHelp(html), `${name}: ${sentence}`).not.toContain(sentence);
  });

  it("is right that the notes that explain a group or a term are on no page outside help", () => {
    const notes = [
      ...helpGroups().flatMap((group) => (group.intro === undefined ? [] : [group.intro])),
      // The sentence that leads the meaning of a superseded passage, before the chip's own.
      readable(termAt("role-superseded").dd).replace(ROLE_MEANING.superseded, "").trim(),
    ];
    expect(notes.length).toBeGreaterThan(5);
    for (const [name, html] of OTHER_PAGES)
      for (const note of notes)
        expect(shownOutsideHelp(html), `${name}: ${note}`).not.toContain(note);
  });
});
