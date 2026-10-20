// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TOKEN_STORAGE_KEY } from "../src/api/token.js";
import {
  COMPLIANT_ROW,
  ERROR_ROW,
  appliedFinding,
  commentOnlyFinding,
  missingFinding,
  playbookDetail,
  reviewDetail,
} from "./fixtures.js";
import { installCommonHooks, renderApp } from "./support.js";

installCommonHooks();

/**
 * Checks by hand what a tool such as axe would check cheaply: names, ids, headings, landmarks and
 * that nothing depends on colour alone or on a style attribute. jest-axe is not installed.
 */
function audit(): void {
  // No id is used twice, or a label and a description could point at the wrong thing.
  const ids = [...document.querySelectorAll("[id]")].map((el) => el.id);
  expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);

  // Every control has a name that a screen reader can say.
  for (const role of [
    "button",
    "link",
    "textbox",
    "combobox",
    "progressbar",
    "article",
    "region",
  ] as const) {
    const all = screen.queryAllByRole(role);
    const named = screen.queryAllByRole(role, { name: /\S/ });
    expect(named.map((el) => el.outerHTML)).toEqual(all.map((el) => el.outerHTML));
  }

  // Everything an aria-labelledby or aria-describedby points at exists.
  for (const el of document.querySelectorAll("[aria-labelledby], [aria-describedby]")) {
    for (const attribute of ["aria-labelledby", "aria-describedby"]) {
      for (const id of (el.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean)) {
        expect(
          document.getElementById(id),
          `${attribute}="${id}" on <${el.tagName.toLowerCase()}>`,
        ).not.toBeNull();
      }
    }
  }

  // The page has its landmarks and one top heading, and the headings do not skip a level.
  expect(screen.getAllByRole("banner")).toHaveLength(1);
  expect(screen.getAllByRole("main")).toHaveLength(1);
  expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
  const levels = screen.getAllByRole("heading").map((h) => Number(h.tagName.slice(1)));
  expect(levels.filter((level) => level === 1)).toHaveLength(1);
  levels.reduce((previous, level) => {
    expect(level).toBeLessThanOrEqual(previous + 1);
    return level;
  }, 0);

  // Icons are decoration: the words next to them carry the meaning.
  for (const svg of document.querySelectorAll("svg")) {
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  }
  // No style attribute in the markup; the page's policy does not allow one.
  expect(document.querySelectorAll("[style]")).toHaveLength(0);
  // Nothing jumps the tab order.
  for (const el of document.querySelectorAll("[tabindex]")) {
    expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
  }
  // One live region, and it is polite.
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
}

describe("accessibility of each screen", () => {
  it("start", async () => {
    renderApp("#/", {
      reviews: [
        reviewDetail({ id: "a" }),
        reviewDetail({
          id: "b",
          documentName: "Second.docx",
          status: "failed",
          error: "x",
          open: null,
        }),
      ],
    });
    await screen.findByRole("link", { name: "Second.docx" });
    audit();
    // Every field is labelled in words.
    expect(screen.getByLabelText("Choose a Word file")).toBeInTheDocument();
    expect(screen.getByLabelText("Playbook")).toBeInTheDocument();
    expect(screen.getByLabelText("Who are you acting for? (optional)")).toBeInTheDocument();
  });

  it("start with the model not set up", async () => {
    renderApp("#/", { config: { model: { configured: false, problem: "No key." } } });
    await screen.findByRole("alert");
    audit();
  });

  it("a review that is running", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "running",
          progress: { done: 2, total: 9 },
          findings: [],
          results: [],
          open: null,
        }),
      ],
    });
    await screen.findByRole("progressbar");
    audit();
  });

  it("a finished review with every kind of finding, an error row and the editor open", async () => {
    const { user } = renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          warnings: ["A warning."],
          notShown: {
            trackedInsertions: 1,
            trackedDeletions: 0,
            comments: 0,
            footnotes: 0,
            endnotes: 0,
            headerFooterParts: 0,
            hiddenRuns: 0,
            images: 0,
          },
          findings: [
            appliedFinding({ decision: "accepted" }),
            appliedFinding({
              ruleId: "other",
              title: "Another change",
              decision: "rejected",
              editedReplacement: "x",
            }),
            commentOnlyFinding(),
            missingFinding(),
          ],
          results: [COMPLIANT_ROW, ERROR_ROW],
          counts: { compliant: 1, deviation: 3, missing: 1, not_applicable: 0, error: 1 },
        }),
      ],
    });
    const card = await screen.findByRole("article", {
      name: "Duration of confidentiality obligations",
    });
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    audit();
    expect(within(card).getByRole("textbox", { name: "Your wording" })).toBeInTheDocument();
  });

  it("a failed review", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          status: "failed",
          error: "It failed.",
          findings: [],
          results: [],
          open: null,
        }),
      ],
    });
    await screen.findByRole("alert");
    audit();
  });

  it("playbooks with the editor open and problems listed", async () => {
    const { user, server } = renderApp("#/playbooks", {
      playbooks: [
        playbookDetail(),
        playbookDetail({
          id: "c1",
          source: "custom",
          name: "Mine",
          editable: true,
          yaml: "name: Mine\n",
        }),
      ],
    });
    server.state.validate = () => ({ ok: false, problems: ["One.", "Two."] });
    await user.click(await screen.findByRole("button", { name: /Mine/ }));
    await screen.findByText("2 problems to fix");
    audit();
  });

  it("the access token screen", async () => {
    renderApp("#/", { config: { authRequired: true }, token: "token-value-1234" });
    await screen.findByLabelText("Access token");
    audit();
  });

  it("a screen that does not exist", async () => {
    renderApp("#/nowhere");
    await screen.findByRole("heading", { name: "There is nothing at this address" });
    audit();
  });

  it("the page after a token was accepted", async () => {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, "token-value-1234");
    renderApp("#/", { config: { authRequired: true }, token: "token-value-1234" });
    await screen.findByRole("heading", { name: "Review a contract" });
    audit();
    expect(screen.getByRole("button", { name: "Forget the access token" })).toBeInTheDocument();
  });
});

describe("severity and decisions are never told by colour alone", () => {
  it("gives every finding a severity word and shape and a decision word and shape", async () => {
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          findings: [
            appliedFinding({ decision: "accepted" }),
            commentOnlyFinding({ decision: "rejected" }),
            missingFinding(),
          ],
        }),
      ],
    });
    const cards = await screen.findAllByRole("article");
    const expected: Array<[string, string]> = [
      ["High", "Accepted"],
      ["Medium", "Rejected"],
      ["Low", "Not decided"],
    ];
    cards.forEach((card, index) => {
      const [severity, decision] = expected[index] ?? ["", ""];
      const badge = card.querySelector(".severity") as HTMLElement;
      expect(badge).toHaveTextContent(severity);
      expect(badge.querySelector("svg")).not.toBeNull();
      const chip = card.querySelector(".decision") as HTMLElement;
      expect(chip).toHaveTextContent(decision);
      expect(chip.querySelector("svg")).not.toBeNull();
    });
    // The three severities have three different shapes.
    const shapes = cards.map((card) => card.querySelector(".severity svg")?.innerHTML);
    expect(new Set(shapes).size).toBe(3);
  });
});

describe("the keyboard", () => {
  it("reaches the file chooser, the fields and the Start button in reading order", async () => {
    const { user } = renderApp("#/");
    await screen.findByRole("heading", { name: "Review a contract" });
    const order: string[] = [];
    for (let step = 0; step < 14 && order[order.length - 1] !== "Playbook"; step++) {
      await user.tab();
      const active = document.activeElement as HTMLElement | null;
      order.push(
        active?.getAttribute("aria-label") ?? active?.textContent?.trim() ?? active?.id ?? "?",
      );
    }
    // Skip link, brand, the two nav links, then the file chooser, then the playbook field.
    expect(order.slice(0, 4)).toEqual([
      "Skip to the page content",
      "Clausewise",
      "Reviews",
      "Playbooks",
    ]);
    expect(document.activeElement).toBe(screen.getByLabelText("Playbook"));
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByLabelText("Who are you acting for? (optional)"),
    );
  });

  it("decides on a finding with the keyboard alone", async () => {
    const { user, server } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [appliedFinding()] })],
    });
    const card = await screen.findByRole("article");
    within(card).getByRole("button", { name: "Accept" }).focus();
    await user.keyboard("{Enter}");
    await within(card).findByText("Accepted", { selector: ".decision" });
    expect(server.callsTo("PATCH", /findings\/term$/)).toHaveLength(1);
    within(card).getByRole("button", { name: "Reject" }).focus();
    await user.keyboard(" ");
    await within(card).findByText("Rejected", { selector: ".decision" });
  });

  it("moves the focus to the page when the screen changes, and shows the title in the tab", async () => {
    const { user } = renderApp("#/");
    await screen.findByRole("heading", { name: "Review a contract" });
    await user.click(screen.getByRole("link", { name: "Playbooks" }));
    await screen.findByRole("heading", { name: "Playbooks", level: 1 });
    expect(screen.getByRole("main")).toHaveFocus();
    expect(document.title).toBe("Playbooks - Clausewise");
    expect(screen.getByRole("link", { name: "Playbooks" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Reviews" })).not.toHaveAttribute("aria-current");
  });

  it("lets the skip link move the focus into the page", async () => {
    const { user } = renderApp("#/");
    await screen.findByRole("heading", { name: "Review a contract" });
    await user.click(screen.getByRole("button", { name: "Skip to the page content" }));
    expect(screen.getByRole("main")).toHaveFocus();
  });
});
