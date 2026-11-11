import { describe, expect, it } from "vitest";
import { checkInvariants } from "./invariants.js";
import { variants } from "./variants.js";
import { chrome, matterPage, memosPage, paneOnly } from "./render.js";
import { buildFindingView, buildIssueRows, buildMatterViewFor } from "./support.js";

/**
 * Every page, in every state that changes what it shows, must be a well-formed document that the
 * content security policy allows, with the banner, labelled controls, scoped table headers, a
 * token in every form, and words on every chip. One helper checks all of that, here for each
 * variant.
 */
describe("every page variant satisfies the page invariants", () => {
  for (const [name, make, options] of variants) {
    it(name, () => {
      checkInvariants(make(), options);
    });
  }

  it("covers the page types the routes will use", () => {
    expect(variants.length).toBeGreaterThan(30);
    expect(chrome.csrfToken.length).toBeGreaterThan(20);
    expect(buildIssueRows()).toHaveLength(8);
    expect(buildFindingView().evidence).toHaveLength(3);
  });
});

/**
 * `checkInvariants` ends with the rules of `test/a11y/rules.ts`, so that every page test of every
 * package holds its page to them. These cases plant one defect each in a page that is otherwise
 * whole and check that the helper refuses it, whole page or pane, and names the rule.
 */
describe("checkInvariants holds a page to the accessibility rules", () => {
  const associate = matterPage(buildMatterViewFor("associate"));

  it("accepts the pages as they are", () => {
    expect(() => checkInvariants(associate)).not.toThrow();
    expect(() => checkInvariants(memosPage(true))).not.toThrow();
    expect(() => checkInvariants(paneOnly(), { fragment: true })).not.toThrow();
  });

  it("refuses a button whose name does not contain the text it shows", () => {
    const planted = associate.replaceAll(
      'aria-label="Save date of version 1 of D1"',
      'aria-label="Store the stated date of version 1 of D1"',
    );
    expect(planted).not.toBe(associate);
    expect(() => checkInvariants(planted)).toThrow(/label-in-name/);
  });

  it("refuses two buttons that do different things under one name", () => {
    const planted = associate.replaceAll(/ aria-label="Upload new version of D[12]"/g, "");
    expect(planted).not.toBe(associate);
    expect(() => checkInvariants(planted)).toThrow(/distinct-button-names/);
  });

  it("refuses two landmarks of one name", () => {
    const planted = memosPage(true).replace(
      'aria-label="List of exported memos"',
      'aria-label="Exported memos"',
    );
    expect(() => checkInvariants(planted)).toThrow(/landmark-names-unique/);
  });

  it("refuses an error notice that does not mark what to do", () => {
    const planted = associate.replace(
      /<main([^>]*)>/,
      '<main$1><div class="notice notice-error" role="alert"><p>It failed.</p></div>',
    );
    expect(() => checkInvariants(planted)).toThrow(/error-needs-todo/);
  });

  it("holds a pane to the rules too, where there is no frame", () => {
    const pane = paneOnly();
    const planted = pane.replace("<a ", '<a tabindex="3" ');
    expect(planted).not.toBe(pane);
    expect(() => checkInvariants(planted, { fragment: true })).toThrow(/positive-tabindex/);
  });
});
