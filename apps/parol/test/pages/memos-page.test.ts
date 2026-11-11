import { describe, expect, it } from "vitest";
import { MemosPage, render } from "../../src/server/pages/index.js";
import { accessibleName, auditPage } from "../a11y/rules.js";
import { checkInvariants } from "./invariants.js";
import { all, attr, hasClass, parseHtml, readable, section, type El } from "./html.js";
import { matterPage, memosPage } from "./render.js";
import { buildChrome, buildMatterSummary, buildMatterViewFor, buildMemo } from "./support.js";

/**
 * The memos page. Its list of memos is a table in a box that scrolls, in a section that has a
 * heading: two landmarks, which must not be called the same thing, and an empty list that says what
 * the person who reads it can do.
 */

/** The landmarks of a page the way a screen reader lists them: regions and navigation, by name. */
const landmarkNames = (root: El): string[] =>
  all(
    root,
    (el) =>
      el.name === "nav" ||
      el.name === "aside" ||
      attr(el, "role") === "region" ||
      (el.name === "section" && attr(el, "aria-labelledby") !== undefined),
  ).map((el) => accessibleName(root, el));

const empty = (canExport: boolean): El =>
  checkInvariants(
    render(
      MemosPage({
        chrome: buildChrome(),
        matter: buildMatterSummary(),
        memos: [],
        canExport,
        exportBlockedReason: canExport ? "Decide every finding first." : null,
      }),
    ),
  );

describe("MemosPage landmarks", () => {
  it("calls the section and the box that scrolls its table by different names", () => {
    const root = checkInvariants(memosPage(true));
    const names = landmarkNames(root);
    expect(names).toContain("Exported memos");
    expect(names).toContain("List of exported memos");
    const lowered = names.map((n) => n.toLowerCase().replace(/\s+/g, " "));
    expect(new Set(lowered).size, names.join(" | ")).toBe(lowered.length);
  });

  it("is free of the rule that two landmarks of a page have one name", () => {
    for (const html of [memosPage(true), memosPage(false)])
      expect(auditPage(parseHtml(html)).filter((v) => v.rule === "landmark-names-unique")).toEqual(
        [],
      );
  });

  it("keeps the caption of the table, which is not a landmark, as it was", () => {
    const root = checkInvariants(memosPage(true));
    const caption = all(root, (el) => el.name === "caption")[0]!;
    expect(readable(caption)).toBe("Exported memos");
  });

  it("names the box that scrolls the table the same on the matter page, where the section is called Memos", () => {
    const html = matterPage(buildMatterViewFor("reviewer", { memos: [buildMemo()] }), {
      canDelete: false,
    });
    const root = checkInvariants(html);
    expect(landmarkNames(section(root, "memos"))).toEqual(["Memos", "List of exported memos"]);
  });
});

describe("MemosPage when no memo has been exported", () => {
  it("tells the reviewing attorney what to do", () => {
    expect(readable(all(empty(true), (el) => hasClass(el, "empty"))[0]!)).toBe(
      "No memo has been exported yet. Export one when every finding has a current decision.",
    );
  });

  it("tells everyone else who exports it", () => {
    expect(readable(all(empty(false), (el) => hasClass(el, "empty"))[0]!)).toBe(
      "No memo has been exported yet. The reviewing attorney exports it when every finding has a current decision.",
    );
  });

  it("says the same on the matter page, by the role of the person", () => {
    const text = (role: "reviewer" | "viewer" | "associate"): string =>
      readable(
        section(
          checkInvariants(
            matterPage(buildMatterViewFor(role, { memos: [] }), { canDelete: false }),
          ),
          "memos",
        ),
      );
    expect(text("reviewer")).toContain(
      "No memo has been exported yet. Export one when every finding has a current decision.",
    );
    for (const role of ["viewer", "associate"] as const)
      expect(text(role), role).toContain(
        "No memo has been exported yet. The reviewing attorney exports it when every finding has a current decision.",
      );
  });
});
