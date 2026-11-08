import { describe, expect, it } from "vitest";
import { inspectDocx, parseDocx } from "../src/index.js";
import { buildDocx, para, run } from "./helpers.js";

// Text formatted so that a person cannot see it in Word is treated like text formatted as hidden:
// it is left out of the text a reviewer reads and it is counted, so the file can be reported. Only
// direct formatting on the run is read; a colour or size that comes from a style is not seen.

const SECRET = "ZQWHT Notwithstanding Section 4, the obligations are perpetual.";
const withProps = (rPr: string, inner = "", para_ = ""): string =>
  para(run("4. Term. Two years. ") + run(`${SECRET}${inner}`, rPr) + para_);

async function read(body: string) {
  const buf = await buildDocx(body);
  return {
    text: (await parseDocx(buf)).paragraphs.map((p) => p.text).join("\n"),
    hidden: (await inspectDocx(buf)).hiddenRuns,
  };
}

describe("text a reader cannot see", () => {
  it.each([
    ["white text on the page", '<w:color w:val="FFFFFF"/>'],
    ["white text in lower case", '<w:color w:val="ffffff"/>'],
    ["white text from the theme", '<w:color w:val="000000" w:themeColor="background1"/>'],
    [
      "white text with white shading",
      '<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:fill="FFFFFF"/>',
    ],
    [
      "text the colour of its shading",
      '<w:color w:val="1F2937"/><w:shd w:val="clear" w:fill="1f2937"/>',
    ],
    ["black text on black highlight", '<w:color w:val="000000"/><w:highlight w:val="black"/>'],
    ["text one point high", '<w:sz w:val="2"/>'],
    ["text under two points high", '<w:sz w:val="3"/>'],
    ["text squeezed to a hundredth of its width", '<w:w w:val="1"/>'],
    ["text with its letters pulled onto each other", '<w:spacing w:val="-1000"/>'],
  ])("leaves out %s, and counts it as hidden", async (_name, rPr) => {
    const { text, hidden } = await read(withProps(rPr));
    expect(text).toBe("4. Term. Two years. ");
    expect(text).not.toContain("ZQWHT");
    expect(hidden).toBe(1);
  });

  it.each([
    ["ordinary text", ""],
    ["white text on a dark highlight", '<w:color w:val="FFFFFF"/><w:highlight w:val="black"/>'],
    [
      "white text on dark run shading",
      '<w:color w:val="FFFFFF"/><w:shd w:val="clear" w:fill="1F2937"/>',
    ],
    [
      "solid shading in another colour",
      '<w:color w:val="FFFFFF"/><w:shd w:val="solid" w:color="1F2937" w:fill="auto"/>',
    ],
    ["dark text", '<w:color w:val="000000"/>'],
    ["automatic colour", '<w:color w:val="auto"/>'],
    ["a small but readable size", '<w:sz w:val="16"/>'],
    ["text two points high", '<w:sz w:val="4"/>'],
    ["slightly condensed text", '<w:spacing w:val="-20"/>'],
    ["wide text", '<w:spacing w:val="40"/>'],
    ["text at a third of its width", '<w:w w:val="33"/>'],
    ["bold, italic and red", '<w:b/><w:i/><w:color w:val="FF0000"/>'],
  ])("keeps %s", async (_name, rPr) => {
    const { text, hidden } = await read(withProps(rPr));
    expect(text).toContain("ZQWHT");
    expect(hidden).toBe(0);
  });

  it("keeps white text on a shaded paragraph or a shaded table cell", async () => {
    const white = '<w:color w:val="FFFFFF"/>';
    const shadedParagraph = para(
      run("Header words", white),
      '<w:shd w:val="clear" w:fill="1F2937"/>',
    );
    const shadedCell = `<w:tbl><w:tr><w:tc><w:tcPr><w:shd w:val="clear" w:fill="1F2937"/></w:tcPr>${para(run("Cell words", white))}</w:tc></w:tr></w:tbl>`;
    const { text, hidden } = await read(shadedParagraph + shadedCell + para(run("Plain.")));
    expect(text).toContain("Header words");
    expect(text).toContain("Cell words");
    expect(hidden).toBe(0);
  });

  it("still hides white text in a table cell that has no shading", async () => {
    const cell = `<w:tbl><w:tr><w:tc><w:tcPr/>${para(run(SECRET, '<w:color w:val="FFFFFF"/>'))}</w:tc></w:tr></w:tbl>`;
    const { text, hidden } = await read(cell + para(run("Plain.")));
    expect(text).not.toContain("ZQWHT");
    expect(hidden).toBe(1);
  });

  it("counts each run once and reads the visible words around it", async () => {
    const body = para(
      run("Pay ") +
        run("one", '<w:sz w:val="2"/>') +
        run("two", '<w:color w:val="FFFFFF"/>') +
        run("now.") +
        run("three", "<w:vanish/>"),
    );
    const { text, hidden } = await read(body);
    expect(text).toBe("Pay now.");
    expect(hidden).toBe(3);
  });

  it("does not read a style, so a colour or size set there is not seen", async () => {
    const { text, hidden } = await read(para(run("Visible words.", '<w:rStyle w:val="Faint"/>')));
    expect(text).toBe("Visible words.");
    expect(hidden).toBe(0);
  });

  it("treats a switched-off or unreadable value as absent", async () => {
    for (const rPr of [
      '<w:sz w:val="x"/>',
      "<w:sz/>",
      '<w:w w:val="abc"/>',
      '<w:spacing w:val="wide"/>',
      "<w:color/>",
    ]) {
      const { text, hidden } = await read(withProps(rPr));
      expect(text, rPr).toContain("ZQWHT");
      expect(hidden, rPr).toBe(0);
    }
  });
});
