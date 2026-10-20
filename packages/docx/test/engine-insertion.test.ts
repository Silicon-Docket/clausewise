import { describe, expect, it } from "vitest";
import { applyRedline, type Edit } from "../src/index.js";
import { annotationIds, buildDocx, para, run, views } from "./helpers.js";

const date = new Date("2026-03-01T12:00:00Z");

const edit = (start: number, end: number, replacement: string, paragraphId = "p:0"): Edit => ({
  paragraphId,
  start,
  end,
  replacement,
});

async function apply(body: string, edits: Edit[], minimize = false) {
  const buf = await buildDocx(body);
  const result = await applyRedline(buf, { edits }, { date, minimize });
  return {
    result,
    accepted: await views(result.buffer, "accepted"),
    rejected: await views(result.buffer, "rejected"),
  };
}

describe("an insertion beside another edit that starts at the same offset", () => {
  const text = "Hello world and more.";

  it("replacement and insertion at the start of the paragraph", async () => {
    const { result, accepted, rejected } = await apply(para(run(text)), [
      edit(0, 5, "Howdy"),
      edit(0, 0, "Oh, "),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["Oh, Howdy world and more."]);
    expect(rejected).toEqual([text]);
  });

  it("gives the same result whichever order the edits arrive in", async () => {
    const { result, accepted, rejected } = await apply(para(run(text)), [
      edit(0, 0, "Oh, "),
      edit(0, 5, "Howdy"),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["Oh, Howdy world and more."]);
    expect(rejected).toEqual([text]);
  });

  it("an insertion that only appears once the edit is trimmed", async () => {
    const { result, accepted, rejected } = await apply(
      para(run(text)),
      [edit(0, 5, "Howdy"), edit(0, 11, "Oh, Hello world")],
      true,
    );
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["Oh, Howdy world and more."]);
    expect(rejected).toEqual([text]);
  });

  it("deleting the whole paragraph text and inserting at its start", async () => {
    const { result, accepted, rejected } = await apply(para(run("Hello.")), [
      edit(0, 6, ""),
      edit(0, 0, "X"),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["X"]);
    expect(rejected).toEqual(["Hello."]);
  });

  it("after a hyperlink, where the text before the position cannot be edited", async () => {
    const body = para(`<w:hyperlink r:id="rId9">${run("Link")}</w:hyperlink>` + run(" per month"));
    const { result, accepted, rejected } = await apply(body, [
      edit(4, 8, " each"),
      edit(4, 4, ","),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["Link, each month"]);
    expect(rejected).toEqual(["Link per month"]);
  });

  it("after a field result", async () => {
    const field =
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF a </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r>${run("4.2")}` +
      `<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const { result, accepted, rejected } = await apply(para(field + run(" applies now")), [
      edit(3, 11, " governs"),
      edit(3, 3, ","),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["4.2, governs now"]);
    expect(rejected).toEqual(["4.2 applies now"]);
  });

  it("after an existing tracked insertion by someone else", async () => {
    const body = para(
      '<w:ins w:id="5" w:author="Other" w:date="2026-01-01T00:00:00Z">' +
        run("Sixty") +
        "</w:ins>" +
        run(" days"),
    );
    const { result, accepted } = await apply(body, [edit(5, 10, " weeks"), edit(5, 5, " (60)")]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }]);
    expect(accepted).toEqual(["Sixty (60) weeks"]);
  });

  it("an insertion between two replacements that touch it", async () => {
    const { result, accepted, rejected } = await apply(para(run("abcdefghij")), [
      edit(0, 5, "X"),
      edit(5, 10, "Y"),
      edit(5, 5, "-"),
    ]);
    expect(result.edits).toEqual([{ applied: true }, { applied: true }, { applied: true }]);
    expect(accepted).toEqual(["X-Y"]);
    expect(rejected).toEqual(["abcdefghij"]);
  });

  it("a run of insertions and deletions at every boundary of a short paragraph", async () => {
    const edits: Edit[] = [];
    for (let i = 0; i <= 6; i += 2) {
      edits.push(edit(i, i, `<${i}>`));
      if (i < 6) edits.push(edit(i, i + 2, ""));
    }
    const { result, accepted, rejected } = await apply(para(run("abcdef")), edits);
    expect(result.edits.every((o) => o.applied)).toBe(true);
    expect(accepted).toEqual(["<0><2><4><6>"]);
    expect(rejected).toEqual(["abcdef"]);
  });

  it("keeps every revision id unique", async () => {
    const { result } = await apply(para(run(text)), [edit(0, 5, "Howdy"), edit(0, 0, "Oh, ")]);
    const ids = await annotationIds(result.buffer);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
