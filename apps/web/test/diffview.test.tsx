// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "../src/components/DiffView.js";
import { installCommonHooks } from "./support.js";

installCommonHooks();

const PARAGRAPH =
  "The Recipient shall keep the information secret for ten (10) years after disclosure, and no longer.";
const ORIGINAL = "ten (10) years";
const START = PARAGRAPH.indexOf(ORIGINAL);
const END = START + ORIGINAL.length;

function show(overrides: Partial<Parameters<typeof DiffView>[0]> = {}) {
  return render(
    <DiffView
      paragraphText={PARAGRAPH}
      start={START}
      end={END}
      original={ORIGINAL}
      replacement="three (3) years"
      {...overrides}
    />,
  );
}

describe("DiffView", () => {
  it("shows the whole paragraph, with the words before and after the edit untouched", () => {
    const { container } = show();
    const text = container.querySelector(".diff-text") as HTMLElement;
    // Everything outside the edit is plain text, as it is in the paragraph, not marked as removed or added.
    expect(text.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(text.firstChild?.nodeValue).toBe("The Recipient shall keep the information secret for ");
    expect(text.lastChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(text.lastChild?.nodeValue).toBe(" after disclosure, and no longer.");
    // Words the two wordings share, such as the closing bracket and "years", are not marked.
    const marked = [...text.querySelectorAll("del, ins")]
      .map((el) => el.textContent ?? "")
      .join("");
    expect(marked).not.toContain("years");
  });

  it("strikes through the removed words and underlines the added ones, each with a label for a screen reader", () => {
    const { container } = show();
    const removed = [...container.querySelectorAll("del")];
    const added = [...container.querySelectorAll("ins")];
    expect(removed.map((el) => el.textContent)).toEqual(["Removed: ten", "Removed: 10"]);
    expect(added.map((el) => el.textContent)).toEqual(["Added: three", "Added: 3"]);
    // The label is there for assistive technology only; the marks themselves carry the meaning for the eye.
    expect(removed[0]?.querySelector(".visually-hidden")?.textContent).toBe("Removed: ");
    expect(added[0]?.querySelector(".visually-hidden")?.textContent).toBe("Added: ");
  });

  it("explains the marks in words", () => {
    show();
    expect(screen.getByText(/Struck through/)).toBeInTheDocument();
    expect(screen.getByText(/Underlined/)).toBeInTheDocument();
  });

  it("shows an insertion alone when the original and the replacement share their start", () => {
    const { container } = show({ replacement: "ten (10) years, or less" });
    expect([...container.querySelectorAll("del")]).toHaveLength(0);
    expect([...container.querySelectorAll("ins")].map((el) => el.textContent)).toEqual([
      "Added: , or less",
    ]);
  });

  it("says when the replacement removes the words and puts nothing in their place", () => {
    const { container } = show({ replacement: "" });
    expect([...container.querySelectorAll("ins")]).toHaveLength(0);
    expect([...container.querySelectorAll("del")].map((el) => el.textContent)).toEqual([
      "Removed: ten (10) years",
    ]);
    expect(
      screen.getByText("This removes the words and puts nothing in their place."),
    ).toBeInTheDocument();
  });

  it("says when the replacement is the same as the original, so no change will be written", () => {
    const { container } = show({ replacement: ORIGINAL });
    expect([...container.querySelectorAll("del, ins")]).toHaveLength(0);
    expect(
      screen.getByText(/the same as the original, so no tracked change will be written/),
    ).toBeInTheDocument();
  });

  it("says when a passage was too long to compare word by word", () => {
    const left = Array.from({ length: 3000 }, (_, i) => `left${i}`).join(" ");
    const right = Array.from({ length: 3000 }, (_, i) => `right${i}`).join(" ");
    const { container } = render(
      <DiffView
        paragraphText={left}
        start={0}
        end={left.length}
        original={left}
        replacement={right}
      />,
    );
    expect(screen.getByText(/too long to compare word by word/)).toBeInTheDocument();
    expect(container.querySelectorAll("del")).toHaveLength(1);
    expect(container.querySelectorAll("ins")).toHaveLength(1);
  });
});

describe("DiffView when the stored position does not fit", () => {
  it("shows the two wordings side by side, labelled, when the text at start..end is not the original", () => {
    const { container } = show({ start: START + 1, end: END + 1 });
    expect(container.querySelector(".diff-text")).toBeNull();
    expect(container.querySelectorAll("del, ins")).toHaveLength(0);
    expect(screen.getByText("Original wording")).toBeInTheDocument();
    expect(screen.getByText("Suggested wording")).toBeInTheDocument();
    expect(screen.getByText(ORIGINAL)).toBeInTheDocument();
    expect(screen.getByText("three (3) years")).toBeInTheDocument();
    expect(
      screen.getByText(/could not be found where the review recorded them/),
    ).toBeInTheDocument();
  });

  it("does the same for a paragraph that changed after the review", () => {
    show({ paragraphText: "A different paragraph altogether." });
    expect(screen.getByText("Original wording")).toBeInTheDocument();
  });

  it.each([
    ["a negative start", -1, END],
    ["an end past the paragraph", START, PARAGRAPH.length + 5],
    ["an end before the start", END, START],
    ["a fractional start", START + 0.5, END],
    ["not a number", Number.NaN, END],
  ])("does the same for %s", (_name, start, end) => {
    const { container } = show({ start, end });
    expect(container.querySelector(".diff-text")).toBeNull();
    expect(screen.getByText("Original wording")).toBeInTheDocument();
  });

  it("shows a removal as words, not as an empty block, in the side by side view", () => {
    show({ start: 0, end: 3, replacement: "" });
    expect(screen.getByText("(the words are removed)")).toBeInTheDocument();
  });

  it("shows the diff as soon as the position fits again", () => {
    const { rerender, container } = show({ start: 0, end: 3 });
    expect(container.querySelector(".diff-text")).toBeNull();
    rerender(
      <DiffView
        paragraphText={PARAGRAPH}
        start={START}
        end={END}
        original={ORIGINAL}
        replacement="three (3) years"
      />,
    );
    expect(container.querySelector(".diff-text")).not.toBeNull();
  });
});

describe("DiffView and document text", () => {
  it("shows markup in the paragraph as text and creates no elements from it", () => {
    const hostile =
      'Pay <img src=x onerror="alert(1)"> within <b>ten</b> days <script>alert(2)</script>.';
    const start = hostile.indexOf("ten");
    const { container } = render(
      <DiffView
        paragraphText={hostile}
        start={start}
        end={start + 3}
        original="ten"
        replacement="<i>thirty</i>"
      />,
    );
    expect(container.querySelector("img, script, b, i")).toBeNull();
    expect(container.querySelector(".diff-text")?.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
    expect(container.querySelector(".diff-text")?.textContent).toContain(
      "<script>alert(2)</script>",
    );
    expect(container.querySelector("ins")?.textContent).toBe("Added: <i>thirty</i>");
  });
});
