import { describe, expect, it } from "vitest";
import { markerOf, revealInvisible } from "../../src/server/views/reveal.js";

describe("revealInvisible", () => {
  it("passes ordinary text through as one piece", () => {
    expect(revealInvisible("Section 6.1 survives.")).toEqual([
      { kind: "text", text: "Section 6.1 survives." },
    ]);
  });

  it("keeps white space, including line breaks and tabs, as text", () => {
    expect(revealInvisible("a\n\tb c")).toEqual([{ kind: "text", text: "a\n\tb c" }]);
  });

  it("shows a direction override and a zero-width space as visible markers", () => {
    const pieces = revealInvisible("pay\u202e100\u200bk");
    expect(pieces).toEqual([
      { kind: "text", text: "pay" },
      { kind: "invisible", marker: "[U+202E]", name: "right-to-left override" },
      { kind: "text", text: "100" },
      { kind: "invisible", marker: "[U+200B]", name: "zero-width space" },
      { kind: "text", text: "k" },
    ]);
  });

  it("counts the byte order mark as invisible, though a regular expression calls it white space", () => {
    expect(revealInvisible(String.fromCodePoint(0xfeff))).toEqual([
      { kind: "invisible", marker: "[U+FEFF]", name: "zero-width no-break space" },
    ]);
  });

  it("keeps every kind of space a reader sees as a gap", () => {
    for (const code of [0x20, 0x09, 0x0a, 0xa0, 0x2003, 0x3000]) {
      const char = String.fromCodePoint(code);
      expect(revealInvisible(`a${char}b`)).toEqual([{ kind: "text", text: `a${char}b` }]);
    }
  });

  it("names an invisible character it has no name for without guessing", () => {
    expect(revealInvisible("\u2800")).toEqual([
      { kind: "invisible", marker: "[U+2800]", name: "invisible character" },
    ]);
  });

  it("loses nothing: text and invisible characters rebuild the input", () => {
    const input = "a\u200bb\u202ec\u2066d\ufeffe\u{1F600}f";
    const rebuilt = revealInvisible(input)
      .map((p) =>
        p.kind === "text"
          ? p.text
          : String.fromCodePoint(Number.parseInt(p.marker.slice(3, -1), 16)),
      )
      .join("");
    expect(rebuilt).toBe(input);
  });

  it("pads small code points to four digits", () => {
    expect(markerOf(0xad)).toBe("[U+00AD]");
    expect(markerOf(0x1f600)).toBe("[U+1F600]");
  });

  it("handles a very long run quickly", () => {
    const long = "word ".repeat(40_000);
    const started = Date.now();
    expect(revealInvisible(long)).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
