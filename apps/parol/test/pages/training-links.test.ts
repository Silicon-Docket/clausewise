import { describe, expect, it } from "vitest";
import { SignInPage, render } from "../../src/server/pages/index.js";
import { urls } from "../../src/server/urls.js";
import { accessibleName, expectAccessible, tabStops } from "../a11y/rules.js";
import { all, attr, hasClass, readable, withClass, type El } from "./html.js";
import { checkInvariants } from "./invariants.js";
import { mattersPage } from "./render.js";
import { buildChrome, buildMatterSummary, buildUsers } from "./support.js";

/**
 * The ways into the quickstart (package W2.8): a line on the sign-in page and on the list of matters,
 * the links of the navigation, and the chip that marks a training matter in the list. Each is a
 * link to a page open to everyone, so a visitor can follow the first and the last.
 */

const visitor = buildChrome({ userName: null });
const signInHtml = (signInEnabled = true): string =>
  render(SignInPage({ chrome: visitor, users: buildUsers(), signInEnabled }));

const quickstartLinks = (root: El): El[] =>
  all(root, (el) => el.name === "a" && attr(el, "href") === urls.quickstart());

describe("the sign-in page", () => {
  it("says New here? and links to the quickstart, whether sign-in is on or off", () => {
    for (const enabled of [true, false]) {
      const root = checkInvariants(signInHtml(enabled));
      // The navigation has a link of its own; the line in the page is the other one.
      const inPage = quickstartLinks(root).filter(
        (link) => readable(link) === "Read the quickstart",
      );
      expect(inPage, String(enabled)).toHaveLength(1);
      expect(
        readable(
          all(root, (el) => el.name === "p" && readable(el).startsWith("New here?"))[0] as El,
        ),
      ).toBe("New here? Read the quickstart.");
      expectAccessible(root);
    }
  });
});

describe("the list of matters", () => {
  const training = buildMatterSummary({
    id: "m_training_t01",
    name: "Training: Lanternfish / Corvane NDA (T01)",
    training: "T01",
  });
  const ordinary = buildMatterSummary();

  it("says New to Parol? under the heading, with a link to the quickstart", () => {
    const root = checkInvariants(mattersPage([ordinary]));
    const line = all(root, (el) => el.name === "p" && readable(el).startsWith("New to Parol?"));
    expect(line.map((p) => readable(p))).toEqual(["New to Parol? Read the quickstart."]);
    expect(attr(all(line[0] as El, (el) => el.name === "a")[0] as El, "href")).toBe(
      urls.quickstart(),
    );
  });

  it("marks a training matter with a chip that has a word and a shape, and no other matter", () => {
    const root = checkInvariants(mattersPage([ordinary, training]));
    const rows = all(root, (el) => el.name === "tr").filter(
      (tr) => all(tr, (e) => e.name === "th" && attr(e, "scope") === "row").length > 0,
    );
    expect(rows).toHaveLength(2);
    const chips = (row: El): string[] => withClass(row, "chip").map((chip) => readable(chip));
    expect(chips(rows[0] as El).filter((c) => c === "Training")).toEqual([]);
    expect(chips(rows[1] as El).filter((c) => c === "Training")).toEqual(["Training"]);
    const chip = withClass(rows[1] as El, "chip").find((c) => readable(c) === "Training") as El;
    expect(hasClass(chip, "tone-info")).toBe(true);
    expect(withClass(chip, "shape-square")).toHaveLength(1);
    expectAccessible(root);
  });

  it("marks no matter whose training key is null or absent", () => {
    for (const matter of [buildMatterSummary({ training: null }), buildMatterSummary()]) {
      const root = checkInvariants(mattersPage([matter]));
      expect(withClass(root, "chip").map((c) => readable(c))).not.toContain("Training");
    }
  });
});

describe("the navigation", () => {
  it("offers a visitor and a signed-in person the quickstart and the help, after Matters", () => {
    for (const chrome of [visitor, buildChrome()]) {
      const html = mattersPage([], chrome);
      const root = checkInvariants(html);
      const names = tabStops(root).map((el) => accessibleName(root, el));
      const at = (name: string): number => names.indexOf(name);
      expect(at("Matters")).toBeGreaterThan(-1);
      expect(at("Quickstart")).toBe(at("Matters") + 1);
      expect(at("Help")).toBe(at("Quickstart") + 1);
    }
  });
});
