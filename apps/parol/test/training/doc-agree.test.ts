import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plainStrong } from "../../src/server/views/training.js";
import { QUICKSTART_STEPS, TRAINING_STEPS } from "../../src/training/index.js";
import { ROOT } from "../integration/pipeline.js";

/**
 * Document 8 and the code say the same thing (package W2.8). The ten steps of the quickstart and
 * the seven steps of the training exercise are written once, in `src/training`, and the document
 * repeats them. This test reads the document and fails when the two differ, whichever one was
 * changed: the ten step texts, and the Task, What it teaches and Answer key columns of the table.
 * It compares words, after the marks of the markup (bold, backticks) and the white space of a
 * wrapped line are taken out. The document's other columns and paragraphs are not compared.
 */

const DOC = readFileSync(join(ROOT, "docs", "parol", "08-pilot-and-enablement.md"), "utf8");

/** What a reader sees: no bold or code marks, white space collapsed. */
const plain = (text: string): string =>
  text.replaceAll("**", "").replaceAll("`", "").replace(/\s+/g, " ").trim();

/** The text of one `## ` section, up to the next one. */
function sectionOf(heading: string): string {
  const start = DOC.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`document 8 has no section "${heading}"`);
  const from = start + 1;
  const next = DOC.indexOf("\n## ", from + 3);
  return DOC.slice(from, next === -1 ? undefined : next);
}

/** The numbered items of the list in a section: an item runs on over the indented lines after it. */
function numberedItems(section: string): Map<number, string> {
  const items = new Map<number, string>();
  let current: number | null = null;
  for (const line of section.split("\n")) {
    const start = /^(\d+)\. (.*)$/.exec(line);
    if (start !== null) {
      current = Number(start[1]);
      items.set(current, start[2] as string);
    } else if (current !== null && /^ {2,}\S/.test(line)) {
      items.set(current, `${items.get(current)} ${line.trim()}`);
    } else {
      current = null;
    }
  }
  return items;
}

/** The rows of the table whose first cell is a step number, as their cells. */
function tableRows(section: string): Map<number, string[]> {
  const rows = new Map<number, string[]>();
  for (const line of section.split("\n")) {
    if (!/^\| \d+ +\|/.test(line)) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    rows.set(Number(cells[0]), cells);
  }
  return rows;
}

describe("document 8, the quickstart", () => {
  const items = numberedItems(sectionOf("Quickstart"));

  it("holds the ten steps, numbered 1 to 10", () => {
    expect([...items.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  for (const step of QUICKSTART_STEPS)
    it(`step ${step.n} says what the page says`, () => {
      expect(plain(items.get(step.n) ?? "")).toBe(plain(plainStrong(step.text)));
    });

  it("keeps the bold of the page: the same words are bold in the document", () => {
    const bold = (text: string): string[] =>
      [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
    for (const step of QUICKSTART_STEPS)
      expect(bold(items.get(step.n) ?? "").map(plain), `step ${step.n}`).toEqual(
        bold(step.text).map(plain),
      );
  });
});

describe("document 8, the training exercise", () => {
  const rows = tableRows(sectionOf("Training exercise (20 minutes)"));

  it("has a table of seven steps, each with a step number, a task, what it teaches, a key and a note on today", () => {
    expect([...rows.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const [n, cells] of rows) expect(cells, `step ${n}`).toHaveLength(5);
  });

  for (const step of TRAINING_STEPS)
    it(`step ${step.n}: the task, what it teaches and the answer key are the code's`, () => {
      const cells = rows.get(step.n) ?? [];
      expect(plain(cells[1] ?? ""), "task").toBe(plain(step.task));
      expect(plain(cells[2] ?? ""), "teaches").toBe(plain(step.teaches));
      expect(plain(cells[3] ?? ""), "key").toBe(plain(step.key));
    });

  it("says in the last column that each step is supported, and gives the limit where there is one", () => {
    for (const [n, cells] of rows) expect(cells[4], `step ${n}`).toMatch(/^\*\*Supported/);
  });
});
