import { describe, expect, it } from "vitest";
import { GUIDANCE, GUIDANCE_KEYS } from "../../src/server/guidance.js";
import { all, attr, hasClass, parseHtml, readable, type El } from "./html.js";
import { variants } from "./variants.js";

/**
 * The list of page fixtures is what every page-wide check sweeps. A page state that has no fixture
 * is a state no sweep sees, so this test names the states that must be on the list: an error page
 * for each sentence of the guidance table, an error notice with its link, a long passage, and every
 * empty state that has an action. That every fixture passes the accessibility rules is held by
 * `test/a11y/pages.test.ts`, which sweeps the list, so the sweep does not depend on a page test
 * remembering to call them.
 */

const pages = (): { name: string; root: El; html: string; fragment: boolean }[] =>
  variants.map(([name, make, options]) => {
    const html = make();
    return { name, root: parseHtml(html), html, fragment: options?.fragment === true };
  });

const sweep = pages();
const text = (root: El): string => readable(root).replace(/\s+/g, " ");
const withText = (needle: string): string[] =>
  sweep.filter((p) => text(p.root).includes(needle)).map((p) => p.name);

describe("the list of page fixtures", () => {
  it("has a name for each fixture, and no two the same", () => {
    const names = sweep.map((p) => p.name);
    expect(names.length).toBeGreaterThan(100);
    expect(new Set(names).size).toBe(names.length);
  });

  it("holds an error page for each key of the guidance table, with its sentence and the part to do marked", () => {
    for (const key of GUIDANCE_KEYS) {
      const named = sweep.filter((p) => p.name === `error page, ${key}`);
      expect(named, key).toHaveLength(1);
      const page = named[0]!;
      const box = all(page.root, (el) => hasClass(el, "error-page"));
      expect(box, key).toHaveLength(1);
      expect(text(box[0]!), key).toContain(GUIDANCE[key].text);
      expect(all(page.root, (el) => hasClass(el, "todo")).map(readable), key).toEqual([
        GUIDANCE[key].todo,
      ]);
    }
  });

  it("holds an error notice for each way a notice can say what to do: with the sentence marked, and with a link to the field", () => {
    const notices = sweep.flatMap((p) =>
      all(p.root, (el) => hasClass(el, "notice-error")).map((notice) => ({ p, notice })),
    );
    const withTodo = notices.filter(
      ({ notice }) => all(notice, (el) => hasClass(el, "todo")).length > 0,
    );
    expect(withTodo.length).toBeGreaterThan(0);
    expect(notices.every(({ notice }) => attr(notice, "role") === "alert")).toBe(true);
    const withJump = withTodo.filter(
      ({ notice }) => all(notice, (el) => hasClass(el, "notice-jump")).length > 0,
    );
    expect(withJump.length).toBeGreaterThan(0);
    // The link leads to an element of the page that holds it.
    for (const { p, notice } of withJump) {
      const link = all(notice, (el) => hasClass(el, "notice-jump"))[0]!;
      const target = (attr(link, "href") ?? "").slice(1);
      expect(
        all(p.root, (el) => attr(el, "id") === target),
        p.name,
      ).not.toHaveLength(0);
    }
  });

  it("holds a long passage that is a region with a name, and one paragraph cited twice", () => {
    const longs = sweep.flatMap((p) =>
      all(p.root, (el) => el.name === "blockquote" && hasClass(el, "long")).map((box) => ({
        p,
        box,
      })),
    );
    expect(longs.length).toBeGreaterThan(1);
    for (const { p, box } of longs) {
      expect(attr(box, "role"), p.name).toBe("region");
      expect((attr(box, "aria-label") ?? "").startsWith("Text of "), p.name).toBe(true);
    }
    expect(longs.some(({ box }) => (attr(box, "aria-label") ?? "").endsWith("citation 2"))).toBe(
      true,
    );
  });

  // Each empty state of the pages that has an action to name, with the words that name it, as the
  // role that has the action and as one that does not.
  it.each([
    ["no matters", "You have no matters yet. Start one below."],
    ["no documents, for the associate", "No documents yet. Add the NDA first."],
    [
      "no documents, for anyone else",
      "No documents yet. Someone with the associate role on the matter adds them.",
    ],
    [
      "no review, for the associate",
      "No review has been run yet. Start one under Start the review.",
    ],
    [
      "no review, for anyone else",
      "No review has been run yet. The associate on the matter starts it.",
    ],
    [
      "no memo, for the reviewing attorney",
      "No memo has been exported yet. Export one when every finding has a current decision.",
    ],
    [
      "no memo, for anyone else",
      "No memo has been exported yet. The reviewing attorney exports it when every finding has a current decision.",
    ],
    [
      "no findings, for the associate",
      "This review has no findings. Go to the matter to run it again.",
    ],
    [
      "no findings, for anyone else",
      "This review has no findings. The associate on the matter can run it again.",
    ],
    [
      "a filter that matches nothing",
      "No finding matches this filter. Choose All to see every finding.",
    ],
    ["nothing chosen in the inspector", "Choose a rule in the table to see the passages it cites"],
    [
      "a finding that is not in the review",
      "That finding is not part of this review. Choose a row from the table.",
    ],
    ["no identity to sign in as", "No demo identities have been set up."],
    ["a finding that cites nothing", "This finding cites no passage."],
    ["a finding with no checks", "No checks were recorded for this finding."],
    ["a finding with no suggestion", "No language is suggested for this finding."],
    ["a finding nobody has decided", "Nobody has decided this finding yet."],
  ] as const)("holds a fixture for the empty state: %s", (_name, words) => {
    expect(withText(words), words).not.toHaveLength(0);
  });
});
