import { describe, expect, it } from "vitest";
import { checkInvariants } from "./invariants.js";
import { variants } from "./variants.js";
import { chrome } from "./render.js";
import { buildFindingView, buildIssueRows } from "./support.js";

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
