// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ERROR_ROW,
  COMPLIANT_ROW,
  appliedFinding,
  commentOnlyFinding,
  missingFinding,
  playbookDetail,
  reviewDetail,
} from "./fixtures.js";
import { installCommonHooks, renderApp } from "./support.js";

installCommonHooks();

// Text from a contract, a model or a playbook is data. Whatever it holds, the page shows it as
// text: no element, no script, no handler comes out of it.
const IMG = '<img src=x onerror="window.__pwned=1">';
const SCRIPT = "<script>window.__pwned=2</script>";
const BOLD = "<b>bold</b>";

function noMarkupWasCreated(): void {
  expect(
    document.querySelectorAll(
      "img, script, iframe, object, embed, form[action], a[href^='javascript:']",
    ),
  ).toHaveLength(0);
  // The only <b> or <i> in the page would have come from the text; the app uses neither.
  expect(document.querySelectorAll("b, i, u")).toHaveLength(0);
  expect(document.querySelectorAll("[onerror], [onload], [onclick], [onmouseover]")).toHaveLength(
    0,
  );
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
}

describe("document text is never rendered as HTML", () => {
  it("in a finished review, in every field a contract or a model can fill", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          documentName: `${IMG}.docx`,
          playbookName: `${BOLD} playbook`,
          client: `${SCRIPT} Ltd`,
          warnings: [`Warning ${IMG}`],
          findings: [
            appliedFinding({
              title: `Title ${BOLD}`,
              explanation: `Explanation ${IMG}`,
              comment: `Comment ${SCRIPT}`,
              clauses: [
                { id: "c", number: `4${BOLD}`, heading: `Head ${IMG}`, text: `Clause ${SCRIPT}` },
              ],
            }),
            commentOnlyFinding({
              ruleId: "co",
              title: "Comment only",
              edit: {
                kind: "comment-only",
                proposed: { quote: IMG, replacement: SCRIPT },
                reason: `Because ${BOLD}`,
              },
            }),
            missingFinding({ suggestedClause: `Suggested ${IMG}` }),
          ],
          results: [
            { ...COMPLIANT_ROW, title: `Rule ${BOLD}`, explanation: SCRIPT, clauseNumbers: [IMG] },
            { ...ERROR_ROW, error: `Error ${IMG}` },
          ],
        }),
      ],
    });
    await screen.findByRole("heading", { name: "Summary" });
    noMarkupWasCreated();

    // The text itself is on the page, character for character.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`${IMG}.docx`);
    expect(screen.getByText(`Warning ${IMG}`)).toBeInTheDocument();
    expect(screen.getByText(`Explanation ${IMG}`)).toBeInTheDocument();
    const card = screen.getByRole("article", { name: `Title ${BOLD}` });
    expect(
      within(card).getByText(`Clause ${SCRIPT}`, { selector: "blockquote" }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent(`Clause 4${BOLD}, Head ${IMG}`);
    expect(screen.getByText(`Suggested ${IMG}`)).toBeInTheDocument();
    expect(alert).not.toHaveBeenCalled();
  });

  it("in the paragraph around a suggested edit, and in the lawyer's own wording", async () => {
    const paragraph = `Pay ${IMG} within ten days ${SCRIPT}.`;
    const start = paragraph.indexOf("ten days");
    renderApp("#/reviews/rev-1", {
      reviews: [
        reviewDetail({
          findings: [
            appliedFinding({
              editedReplacement: `${BOLD} thirty days`,
              edit: {
                kind: "applied",
                original: "ten days",
                replacement: "thirty days",
                paragraphText: paragraph,
                start,
                end: start + "ten days".length,
              },
            }),
          ],
        }),
      ],
    });
    const card = await screen.findByRole("article");
    noMarkupWasCreated();
    expect(card.querySelector(".diff-text")?.textContent).toContain(IMG);
    expect(card.querySelector(".diff-text")?.textContent).toContain(SCRIPT);
    expect(card.querySelector("ins")?.textContent).toContain(BOLD);
  });

  it("in the editor, where it is typed and previewed", async () => {
    const { user } = renderApp("#/reviews/rev-1", {
      reviews: [reviewDetail({ findings: [appliedFinding()] })],
    });
    const card = await screen.findByRole("article");
    await user.click(within(card).getByRole("button", { name: "Edit wording" }));
    const box = within(card).getByRole("textbox", { name: "Your wording" });
    await user.clear(box);
    await user.click(box);
    await user.paste(`${IMG}${SCRIPT}`);
    noMarkupWasCreated();
    expect(card.querySelector(".wording-editor ins")?.textContent).toContain(IMG);
  });

  it("in a failed review's message and on the start screen's list", async () => {
    renderApp("#/", {
      reviews: [
        reviewDetail({
          documentName: `${IMG}.docx`,
          playbookName: SCRIPT,
          status: "failed",
          error: IMG,
          open: null,
        }),
      ],
    });
    await screen.findByRole("link", { name: `${IMG}.docx` });
    noMarkupWasCreated();
  });

  it("in an error message from the server", async () => {
    const { server, user } = renderApp("#/");
    server.failNext((call) => call.path === "/api/documents", {
      status: 422,
      code: "invalid_document",
      message: `Bad file ${IMG}`,
    });
    const input = await screen.findByLabelText("Choose a Word file");
    await user.upload(input, new File(["x"], "a.docx"));
    await user.click(screen.getByRole("button", { name: "Start review" }));
    expect(await screen.findByText(`Bad file ${IMG}`)).toBeInTheDocument();
    noMarkupWasCreated();
  });

  it("in a playbook's name, text and problems", async () => {
    const { server, user } = renderApp("#/playbooks", {
      playbooks: [
        playbookDetail({ name: `${BOLD} NDA`, yaml: `name: ${IMG}\n`, editable: false }),
        playbookDetail({
          id: "c",
          source: "custom",
          name: SCRIPT,
          editable: true,
          yaml: `name: ${IMG}\n`,
        }),
      ],
    });
    server.state.validate = () => ({ ok: false, problems: [`Problem ${IMG}`] });
    await user.click(
      await screen.findByRole("button", {
        name: new RegExp(SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      }),
    );
    expect(await screen.findByText(`Problem ${IMG}`)).toBeInTheDocument();
    noMarkupWasCreated();
  });
});
